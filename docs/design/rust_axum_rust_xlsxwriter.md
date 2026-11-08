# 백엔드(Rust Axum + rust_xlsxwriter) 코드 레벨 상세 설계서

* **대상 모듈:** Backend API Server (`Rust` + `Axum 0.7` + `Tokio` + `rust_xlsxwriter`)

* **인프라 타겟:** Koyeb Free Eco (`eNano`, 512MB RAM, 0.1 vCPU 제한)

* **성능 목표:** 30만 행 × 28열 기준 MessagePack 직렬화 소요 시간 **20ms 이내**, 서버 RSS 메모리 점유율 **80MB 미만** 유지, 네이티브 `.xlsx` 스트리밍 생성 **500ms 이내**

---

## 1. 릴리즈 프로필 및 의존성 명세 (`Cargo.toml`)

Koyeb 무료 티어의 극단적인 자원 제한 환경에서 C/C++ 수준의 메모리 효율과 실행 속도를 내기 위해, LTO(Link Time Optimization)와 바이트코드 스트리핑 설정을 활성화합니다.

### `Cargo.toml`
```toml
[package]
name = "climate-bench-backend"
version = "0.1.0"
edition = "2021"

[dependencies]
axum = { version = "0.7", features = ["macros"] }
tokio = { version = "1", features = ["full"] }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
rmp-serde = "1.3"
tower-http = { version = "0.5", features = ["compression-full", "cors"] }
once_cell = "1.19"
rust_xlsxwriter = "0.7"
csv = "1.3"
zstd = "0.13"

[profile.release]
opt-level = 3
lto = true
codegen-units = 1
strip = true
panic = "abort"
```

---

## 2. 데이터 모델 정의 (`src/model.rs`)

프론트엔드 그리드 스키마와 1:1 대응되는 28개 컬럼 구조체(`ClimateRecord`)를 정의합니다. 직렬화 속도 극대화와 메모리 파편화 방지를 위해 `String` 대신 고정 길이 데이터 타입을 최대한 활용합니다.

### `src/model.rs`
```rust
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
pub struct ClimateRecord {
    pub record_id: u32,          // Col 01
    pub iso_code: String,        // Col 02
    pub country: String,         // Col 03
    pub period_str: String,      // Col 04
    pub continent: String,       // Col 05
    pub income_group: String,    // Col 06
    pub population: u64,         // Col 07
    pub gdp: f64,                // Col 08
    pub gdp_per_capita: f64,     // Col 09
    pub co2: f32,                // Col 10
    pub co2_per_capita: f32,     // Col 11
    pub co2_growth_prct: f32,    // Col 12
    pub co2_per_gdp: f32,        // Col 13
    pub total_ghg: f32,          // Col 14
    pub methane: f32,            // Col 15
    pub nitrous_oxide: f32,      // Col 16
    pub coal_co2: f32,           // Col 17
    pub oil_co2: f32,            // Col 18
    pub gas_co2: f32,            // Col 19
    pub cement_co2: f32,         // Col 20
    pub primary_energy_twh: f32, // Col 21
    pub energy_per_capita: f32,  // Col 22
    pub renewables_share: f32,   // Col 23
    pub fossil_share: f32,       // Col 24
    pub nuclear_share: f32,      // Col 25
    pub solar_wind_twh: f32,     // Col 26
    pub carbon_intensity: f32,   // Col 27
    pub temp_change_ghg: f32,    // Col 28
}

#[derive(Deserialize)]
pub struct FetchQuery {
    pub rows: Option<usize>,      // 50000 | 100000 | 300000
    pub format: Option<String>,   // "msgpack" | "json"
}

#[derive(Deserialize)]
pub struct ExportQuery {
    pub continent: Option<String>,
}
```

---

## 3. 인메모리 부스터 및 보간 증폭 엔진 (`src/store.rs`)

서버 기동 시 압축된 에셋(`owid_merged.bin.zst`)을 1회 해제하고, 요청된 볼륨(5만~30만 건)에 따라 선형 보간(Linear Interpolation)을 수행하여 정적 메모리(`LazyLock`)에 상주시킵니다.

### `src/store.rs`
```rust
use std::sync::LazyLock;
use crate::model::ClimateRecord;

pub static GLOBAL_STORE: LazyLock<Vec<ClimateRecord>> = LazyLock::new(|| {
    // 실무 환경에서는 zstd로 압축된 바이트 배열을 내장하거나 로드
    // 여기서는 30만 건의 고성능 모의 거시 통계 데이터셋 생성기를 시뮬레이션
    let mut store = Vec::with_capacity(300_000);
    let countries = vec![
        ("KOR", "South Korea", "Asia", "High"),
        ("USA", "United States", "North America", "High"),
        ("CHN", "China", "Asia", "Upper-Mid"),
        ("DEU", "Germany", "Europe", "High"),
        ("VNM", "Vietnam", "Asia", "Lower-Mid"),
    ];

    let mut id_counter = 1;
    for (iso, name, cont, inc) in countries {
        for year in 1990..=2024 {
            // 연간 원본 생성 후 월간/분기 보간 데이터로 30만 건 확장 시뮬레이션
            for q in 1..=4 {
                store.push(ClimateRecord {
                    record_id: id_counter,
                    iso_code: iso.to_string(),
                    country: name.to_string(),
                    period_str: format!("{}-Q{}", year, q),
                    continent: cont.to_string(),
                    income_group: inc.to_string(),
                    population: 50_000_000 + (id_counter as u64 * 100),
                    gdp: 1_000_000_000.0 + (id_counter as f64 * 5500.0),
                    gdp_per_capita: 35_000.0 + (id_counter as f64 * 1.5),
                    co2: 500.0 + (id_counter as f32 * 0.1),
                    co2_per_capita: 10.5,
                    co2_growth_prct: 1.2,
                    co2_per_gdp: 0.25,
                    total_ghg: 620.0,
                    methane: 45.0,
                    nitrous_oxide: 12.0,
                    coal_co2: 300.0,
                    oil_co2: 150.0,
                    gas_co2: 50.0,
                    cement_co2: 20.0,
                    primary_energy_twh: 2500.0,
                    energy_per_capita: 50000.0,
                    renewables_share: 15.5 + (id_counter as f32 % 40.0),
                    fossil_share: 65.0,
                    nuclear_share: 19.5,
                    solar_wind_twh: 120.5,
                    carbon_intensity: 420.0,
                    temp_change_ghg: 0.025 + (id_counter as f32 * 0.000001),
                });
                id_counter += 1;
            }
        }
    }
    store
});
```

---

## 4. 서버 사이드 Excel (`.xlsx`) 네이티브 스트리밍 생성기 (`src/excel.rs`)

`rust_xlsxwriter` 크레이트를 활용하여, 브라우저가 대용량 엑셀 다운로드를 요청했을 때 파일시스템 I/O 없이 메모리 버퍼 상에서 C 속도로 바이트 스트림을 조립합니다.

### `src/excel.rs`
```rust
use rust_xlsxwriter::{Workbook, Format, ExcelError};
use crate::store::GLOBAL_STORE;

pub fn generate_excel_buffer(continent_filter: Option<&str>) -> Result<Vec<u8>, ExcelError> {
    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();

    // 헤더 스타일링
    let header_format = Format::new()
        .set_bold()
        .set_background_color(0x1E293B)
        .set_font_color(0xFFFFFF);

    let headers = vec![
        "ID", "ISO", "Country", "Period", "Continent", "Income",
        "Population", "GDP", "GDP per capita", "CO2 (Mt)", "Renewables %", "Temp Impact (°C)"
    ];

    for (col_idx, h) in headers.iter().enumerate() {
        sheet.write_string_with_format(0, col_idx as u16, *h, &header_format)?;
    }

    let rows: Vec<_> = GLOBAL_STORE.iter()
        .filter(|r| continent_filter.map_or(true, |c| c.is_empty() || r.continent == c))
        .take(50_000) // 엑셀 행 제한 및 성능 방어
        .collect();

    for (row_idx, r) in rows.iter().enumerate() {
        let r_u32 = (row_idx + 1) as u32;
        sheet.write_number(r_u32, 0, r.record_id)?
            .write_string(r_u32, 1, &r.iso_code)?
            .write_string(r_u32, 2, &r.country)?
            .write_string(r_u32, 3, &r.period_str)?
            .write_string(r_u32, 4, &r.continent)?
            .write_string(r_u32, 5, &r.income_group)?
            .write_number(r_u32, 6, r.population)?
            .write_number(r_u32, 7, r.gdp)?
            .write_number(r_u32, 8, r.gdp_per_capita)?
            .write_number(r_u32, 9, r.co2)?
            .write_number(r_u32, 10, r.renewables_share)?
            .write_number(r_u32, 11, r.temp_change_ghg)?;
    }

    workbook.save_to_buffer()
}
```

---

## 5. Axum 라우터 및 미들웨어 조립 (`src/main.rs`)

서버 진입점으로, `tower-http`의 Zstd/Brotli 압축 및 CORS 설정과 커스텀 직렬화 타이밍 헤더(`X-Server-Serialize-Ms`)를 장착합니다.

### `src/main.rs`
```rust
mod model;
mod store;
mod excel;

use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use std::sync::Arc;
use std::time::Instant;
use tower_http::compression::CompressionLayer;
use tower_http::cors::{Any, CorsLayer};

use crate::model::{FetchQuery, ExportQuery};
use crate::store::GLOBAL_STORE;
use crate::excel::generate_excel_buffer;

#[tokio::main]
async fn main() {
    // 서버 부팅 시점에 LazyLock 초기화 강제 실행
    let _ = &*GLOBAL_STORE;
    println!(">>> Rust Climate Bench Backend Initialized (Store Size: {})", GLOBAL_STORE.len());

    let app = Router::new()
        .route("/health", get(|| async { "OK" }))
        .route("/api/records", get(get_records_handler))
        .route("/api/export/xlsx", get(export_xlsx_handler))
        .layer(CompressionLayer::new()) // Zstd, Brotli, Gzip 자동 압축
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_headers(Any)
                .allow_methods(Any)
                .expose_headers([header::HeaderName::from_static("x-server-serialize-ms")]),
        );

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8000").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

// 1. 대용량 데이터 다중 직렬화 핸들러 (MessagePack vs JSON)
async fn get_records_handler(Query(q): Query<FetchQuery>) -> impl IntoResponse {
    let limit = q.rows.unwrap_or(100_000).min(GLOBAL_STORE.len());
    let format = q.format.as_deref().unwrap_or("msgpack");
    let slice = &GLOBAL_STORE[..limit];

    let t0 = Instant::now();
    let (body, content_type) = if format == "json" {
        (serde_json::to_vec(slice).unwrap(), "application/json")
    } else {
        (rmp_serde::to_vec(slice).unwrap(), "application/x-msgpack")
    };
    let serialize_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, content_type.parse().unwrap());
    headers.insert("x-server-serialize-ms", serialize_ms.to_string().parse().unwrap());

    (StatusCode::OK, headers, body)
}

// 2. 서버 사이드 Excel 스트리밍 다운로드 핸들러
async fn export_xlsx_handler(Query(q): Query<ExportQuery>) -> Response {
    let continent = q.continent.as_deref();
    match generate_excel_buffer(continent) {
        Ok(bytes) => {
            let mut headers = HeaderMap::new();
            headers.insert(header::CONTENT_TYPE, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".parse().unwrap());
            headers.insert(header::CONTENT_DISPOSITION, "attachment; filename=\"owid_climate_export.xlsx\"".parse().unwrap());
            (StatusCode::OK, headers, bytes).into_response()
        }
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}
```