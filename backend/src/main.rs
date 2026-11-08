mod excel;
mod model;
mod store;

use std::time::Instant;

use axum::{
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

#[tokio::main]
async fn main() {
    // force LazyLock init at boot, not on first request
    println!(">>> Rust Climate Bench Backend Initialized (Store Size: {})", GLOBAL_STORE.len());

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
                .expose_headers([HeaderName::from_static(SERIALIZE_HEADER)]),
        );

    let port = std::env::var("PORT").unwrap_or_else(|_| "8000".into());
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await.unwrap();
    println!(">>> Listening on http://0.0.0.0:{port}");
    axum::serve(listener, app).await.unwrap();
}

async fn get_records_handler(Query(q): Query<FetchQuery>) -> Response {
    let rows = q.rows.unwrap_or(100_000).min(GLOBAL_STORE.len());
    let json = q.format.as_deref() == Some("json");

    // CPU-heavy: keep it off the async workers so /health stays responsive
    let result = tokio::task::spawn_blocking(move || {
        // store is (country, year, month): stride picks half-yearly / quarterly / monthly
        let step = match rows {
            50_000 => 6,
            100_000 => 3,
            _ => 1,
        };
        let slice: Vec<&ClimateRecord> = GLOBAL_STORE.iter().step_by(step).take(rows).collect();

        let t0 = Instant::now();
        let body = if json {
            serde_json::to_vec(&slice).map_err(|e| e.to_string())
        } else {
            // positional: each row is a 28-element array in ClimateRecord field order,
            // no repeated field names (2.3x smaller, ~4x faster to decode than to_vec_named).
            // The frontend relies on that order (frontend/src/state/columns.ts COLUMN_KEYS).
            rmp_serde::to_vec(&slice).map_err(|e| e.to_string())
        };
        (body, t0.elapsed().as_secs_f64() * 1000.0)
    })
    .await;

    let (body, serialize_ms) = match result {
        Ok((Ok(body), ms)) => (body, ms),
        Ok((Err(e), _)) => return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    let mut headers = HeaderMap::new();
    let content_type = if json { "application/json" } else { "application/x-msgpack" };
    headers.insert(header::CONTENT_TYPE, content_type.parse().unwrap());
    headers.insert(SERIALIZE_HEADER, format!("{serialize_ms:.3}").parse().unwrap());
    (StatusCode::OK, headers, body).into_response()
}

async fn export_xlsx_handler(Query(q): Query<ExportQuery>) -> Response {
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
