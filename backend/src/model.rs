use serde::{Deserialize, Serialize};

// Repeated strings are interned as `&'static str` (16B each, no per-row heap
// allocation) to keep 300k rows around ~55MB instead of ~90MB with `String`.
// Field ORDER is the msgpack wire format (positional arrays): keep it in sync
// with frontend/src/state/columns.ts COLUMN_KEYS.
#[derive(Clone, Serialize)]
pub struct ClimateRecord {
    pub record_id: u32,             // Col 01
    pub iso_code: &'static str,     // Col 02
    pub country: &'static str,      // Col 03
    pub period_str: &'static str,   // Col 04
    pub continent: &'static str,    // Col 05
    pub income_group: &'static str, // Col 06
    pub population: u64,            // Col 07
    pub gdp: f64,                   // Col 08
    pub gdp_per_capita: f64,        // Col 09
    pub co2: f32,                   // Col 10
    pub co2_per_capita: f32,        // Col 11
    pub co2_growth_prct: f32,       // Col 12
    pub co2_per_gdp: f32,           // Col 13
    pub total_ghg: f32,             // Col 14
    pub methane: f32,               // Col 15
    pub nitrous_oxide: f32,         // Col 16
    pub coal_co2: f32,              // Col 17
    pub oil_co2: f32,               // Col 18
    pub gas_co2: f32,               // Col 19
    pub cement_co2: f32,            // Col 20
    pub primary_energy_twh: f32,    // Col 21
    pub energy_per_capita: f32,     // Col 22
    pub renewables_share: f32,      // Col 23
    pub fossil_share: f32,          // Col 24
    pub nuclear_share: f32,         // Col 25
    pub solar_wind_twh: f32,        // Col 26
    pub carbon_intensity: f32,      // Col 27
    pub temp_change_ghg: f32,       // Col 28
}

#[derive(Deserialize)]
pub struct FetchQuery {
    pub rows: Option<usize>,    // 50000 | 100000 | 300000
    pub format: Option<String>, // "msgpack" | "json"
    pub ticket: Option<String>, // from POST /api/session (Turnstile)
}

#[derive(Deserialize)]
pub struct ExportQuery {
    pub continent: Option<String>,
    pub ticket: Option<String>,
}

#[derive(Deserialize)]
pub struct SessionRequest {
    pub token: String, // Turnstile response token
}
