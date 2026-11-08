mod excel;
mod model;
mod store;

use std::io::Write;
use std::sync::OnceLock;
use std::time::Instant;

use axum::{
    body::Bytes,
    extract::Query,
    http::{header, HeaderMap, HeaderName, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use tower_http::compression::CompressionLayer;
use tower_http::cors::{Any, CorsLayer};

use crate::excel::generate_excel_buffer;
use crate::model::{ClimateRecord, ExportQuery, FetchQuery};
use crate::store::GLOBAL_STORE;

const SERIALIZE_HEADER: &str = "x-server-serialize-ms";
const CACHE_HEADER: &str = "x-cache";

#[tokio::main]
async fn main() {
    // force LazyLock init at boot, not on first request
    println!(">>> Rust Climate Bench Backend Initialized (Store Size: {})", GLOBAL_STORE.len());

    // Pre-build the frontend's default response (100k msgpack) BEFORE listening.
    // Cloud Run (request-based billing) throttles CPU outside requests, so a
    // background warm-up after bind would starve; startup gets full CPU.
    for enc in [Enc::Zstd, Enc::Gzip] {
        let slot = &CACHE[4 + enc as usize]; // volume 1 (100k), msgpack
        if let Ok((raw, ms)) = serialize(1, false) {
            if let Ok(body) = compress(&raw, enc) {
                slot.get_or_init(|| (Bytes::from(body), ms));
            }
        }
    }
    println!(">>> Cache warmed (100k msgpack zstd+gzip)");

    let app = Router::new()
        .route("/health", get(|| async { "OK" }))
        .route("/api/records", get(get_records_handler))
        .route("/api/export/xlsx", get(export_xlsx_handler))
        .layer(CompressionLayer::new())
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_headers(Any)
                .allow_methods(Any)
                .expose_headers([HeaderName::from_static(SERIALIZE_HEADER), HeaderName::from_static(CACHE_HEADER)]),
        );

    let port = std::env::var("PORT").unwrap_or_else(|_| "8000".into());
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await.unwrap();
    println!(">>> Listening on http://0.0.0.0:{port}");
    axum::serve(listener, app).await.unwrap();
}

// ponytail: fixed cap of 2 concurrent heavy responses to fit a 512MB instance
// (each 300k msgpack response peaks ~75MB incl. compression). Raise with RAM.
static HEAVY: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

// Volumes = (rows, stride over the (country, year, month)-ordered store):
// half-yearly / quarterly / monthly. Requests snap to one of these, which keeps
// the compressed-response cache bounded.
const VOLUMES: [(usize, usize); 3] = [(50_000, 6), (100_000, 3), (300_000, 1)];

#[derive(Clone, Copy)]
enum Enc {
    Zstd,
    Gzip,
}

/// Compressed responses, built once on first request. The data never changes, and
/// on 0.1 vCPU compressing 100k rows takes ~3s (zstd) / ~7s (gzip) per request.
/// Index: volume * 4 + json * 2 + encoding. Value: (body, original serialize ms).
static CACHE: [OnceLock<(Bytes, f64)>; 12] = [const { OnceLock::new() }; 12];

fn serialize(vol: usize, json: bool) -> Result<(Vec<u8>, f64), String> {
    let (rows, step) = VOLUMES[vol];
    let slice: Vec<&ClimateRecord> = GLOBAL_STORE.iter().step_by(step).take(rows).collect();
    let t0 = Instant::now();
    let body = if json {
        serde_json::to_vec(&slice).map_err(|e| e.to_string())?
    } else {
        // positional: each row is a 28-element array in ClimateRecord field order,
        // no repeated field names (2.3x smaller, ~4x faster to decode than to_vec_named).
        // The frontend relies on that order (frontend/src/state/columns.ts COLUMN_KEYS).
        rmp_serde::to_vec(&slice).map_err(|e| e.to_string())?
    };
    Ok((body, t0.elapsed().as_secs_f64() * 1000.0))
}

fn compress(raw: &[u8], enc: Enc) -> Result<Vec<u8>, String> {
    match enc {
        Enc::Zstd => zstd::encode_all(raw, 3).map_err(|e| e.to_string()),
        Enc::Gzip => {
            let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            gz.write_all(raw).and_then(|_| gz.finish()).map_err(|e| e.to_string())
        }
    }
}

async fn get_records_handler(Query(q): Query<FetchQuery>, req_headers: HeaderMap) -> Response {
    let json = q.format.as_deref() == Some("json");
    let wanted = q.rows.unwrap_or(100_000);
    let mut vol = VOLUMES.iter().position(|&(r, _)| wanted <= r).unwrap_or(VOLUMES.len() - 1);
    if json {
        vol = vol.min(1); // JSON is ~4x larger than msgpack; 300k JSON would buffer ~200MB
    }
    // ponytail: substring match, ignores q-values. Browsers send both anyway.
    let accept = req_headers.get(header::ACCEPT_ENCODING).and_then(|v| v.to_str().ok()).unwrap_or("");
    let enc = if accept.contains("zstd") {
        Some(Enc::Zstd)
    } else if accept.contains("gzip") {
        Some(Enc::Gzip)
    } else {
        None
    };
    let slot = enc.map(|e| &CACHE[vol * 4 + json as usize * 2 + e as usize]);
    let hit = slot.is_some_and(|s| s.get().is_some());

    let _permit = if hit {
        None
    } else {
        match HEAVY.acquire().await {
            Ok(p) => Some(p),
            Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
        }
    };
    // CPU-heavy: keep it off the async workers so /health stays responsive
    let result = tokio::task::spawn_blocking(move || -> Result<(Bytes, f64), String> {
        match (slot, enc) {
            (Some(slot), Some(enc)) => {
                if let Some(v) = slot.get() {
                    return Ok(v.clone());
                }
                let (raw, ms) = serialize(vol, json)?;
                let body = Bytes::from(compress(&raw, enc)?);
                Ok(slot.get_or_init(|| (body, ms)).clone())
            }
            _ => serialize(vol, json).map(|(raw, ms)| (Bytes::from(raw), ms)),
        }
    })
    .await;

    let (body, serialize_ms) = match result {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    let mut headers = HeaderMap::new();
    let content_type = if json { "application/json" } else { "application/x-msgpack" };
    headers.insert(header::CONTENT_TYPE, content_type.parse().unwrap());
    headers.insert(SERIALIZE_HEADER, format!("{serialize_ms:.3}").parse().unwrap());
    headers.insert(CACHE_HEADER, if hit { "HIT" } else { "MISS" }.parse().unwrap());
    headers.insert(header::VARY, "accept-encoding".parse().unwrap());
    if let Some(enc) = enc {
        // already encoded: CompressionLayer leaves responses with Content-Encoding alone
        let name = match enc {
            Enc::Zstd => "zstd",
            Enc::Gzip => "gzip",
        };
        headers.insert(header::CONTENT_ENCODING, name.parse().unwrap());
    }
    (StatusCode::OK, headers, body).into_response()
}

async fn export_xlsx_handler(Query(q): Query<ExportQuery>) -> Response {
    let Ok(_permit) = HEAVY.acquire().await else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let result = tokio::task::spawn_blocking(move || generate_excel_buffer(q.continent.as_deref())).await;
    match result {
        Ok(Ok(bytes)) => {
            let mut headers = HeaderMap::new();
            headers.insert(
                header::CONTENT_TYPE,
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".parse().unwrap(),
            );
            headers.insert(
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"owid_climate_export.xlsx\"".parse().unwrap(),
            );
            (StatusCode::OK, headers, bytes).into_response()
        }
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}
