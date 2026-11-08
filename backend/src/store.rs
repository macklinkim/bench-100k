//! In-memory booster: synthetic OWID-shaped climate/energy dataset.
//!
//! 100 countries x 250 years (1775..=2024) = 25,000 annual base points,
//! linearly interpolated to 12 months = 300,000 rows. Order is
//! (country, year, month), so `step_by(6)` = half-yearly 50k and
//! `step_by(3)` = quarterly 100k without storing extra copies.
//!
//! ponytail: values come from a deterministic per-country model, not the real
//! OWID CSVs. Upgrade path: preprocess owid-co2 + owid-energy into a zstd
//! asset and fill the annual `Base` array from it instead of `annual_base`.

use std::collections::HashMap;
use std::sync::LazyLock;

use crate::model::ClimateRecord;

pub const FIRST_YEAR: u32 = 1775;
pub const LAST_YEAR: u32 = 2024;
const YEARS: usize = (LAST_YEAR - FIRST_YEAR + 1) as usize;

// (iso, country, continent, income group, population in 2024 [millions])
#[rustfmt::skip]
const COUNTRIES: [(&str, &str, &str, &str, f64); 100] = [
    ("KOR","South Korea","Asia","High",51.7), ("JPN","Japan","Asia","High",124.0),
    ("CHN","China","Asia","Upper-Mid",1410.0), ("IND","India","Asia","Lower-Mid",1430.0),
    ("IDN","Indonesia","Asia","Upper-Mid",278.0), ("PAK","Pakistan","Asia","Lower-Mid",240.0),
    ("BGD","Bangladesh","Asia","Lower-Mid",172.0), ("VNM","Vietnam","Asia","Lower-Mid",99.0),
    ("THA","Thailand","Asia","Upper-Mid",72.0), ("PHL","Philippines","Asia","Lower-Mid",115.0),
    ("MYS","Malaysia","Asia","Upper-Mid",34.0), ("SGP","Singapore","Asia","High",5.9),
    ("SAU","Saudi Arabia","Asia","High",33.0), ("IRN","Iran","Asia","Lower-Mid",89.0),
    ("IRQ","Iraq","Asia","Upper-Mid",45.0), ("TUR","Turkey","Asia","Upper-Mid",85.0),
    ("ISR","Israel","Asia","High",9.8), ("ARE","United Arab Emirates","Asia","High",9.5),
    ("KAZ","Kazakhstan","Asia","Upper-Mid",20.0), ("UZB","Uzbekistan","Asia","Lower-Mid",36.0),
    ("MNG","Mongolia","Asia","Lower-Mid",3.4), ("NPL","Nepal","Asia","Lower-Mid",30.0),
    ("LKA","Sri Lanka","Asia","Lower-Mid",22.0), ("QAT","Qatar","Asia","High",2.7),
    ("KWT","Kuwait","Asia","High",4.3),
    ("DEU","Germany","Europe","High",84.0), ("FRA","France","Europe","High",68.0),
    ("GBR","United Kingdom","Europe","High",68.0), ("ITA","Italy","Europe","High",59.0),
    ("ESP","Spain","Europe","High",48.0), ("POL","Poland","Europe","High",37.0),
    ("NLD","Netherlands","Europe","High",17.9), ("BEL","Belgium","Europe","High",11.7),
    ("SWE","Sweden","Europe","High",10.5), ("NOR","Norway","Europe","High",5.5),
    ("FIN","Finland","Europe","High",5.6), ("DNK","Denmark","Europe","High",5.9),
    ("AUT","Austria","Europe","High",9.1), ("CHE","Switzerland","Europe","High",8.8),
    ("CZE","Czechia","Europe","High",10.9), ("PRT","Portugal","Europe","High",10.4),
    ("GRC","Greece","Europe","High",10.4), ("ROU","Romania","Europe","Upper-Mid",19.0),
    ("UKR","Ukraine","Europe","Lower-Mid",37.0), ("RUS","Russia","Europe","Upper-Mid",144.0),
    ("HUN","Hungary","Europe","High",9.6), ("IRL","Ireland","Europe","High",5.2),
    ("USA","United States","North America","High",335.0), ("CAN","Canada","North America","High",39.0),
    ("MEX","Mexico","North America","Upper-Mid",128.0), ("GTM","Guatemala","North America","Upper-Mid",18.0),
    ("CUB","Cuba","North America","Upper-Mid",11.0), ("DOM","Dominican Republic","North America","Upper-Mid",11.3),
    ("HND","Honduras","North America","Lower-Mid",10.6), ("CRI","Costa Rica","North America","Upper-Mid",5.2),
    ("PAN","Panama","North America","High",4.4), ("JAM","Jamaica","North America","Upper-Mid",2.8),
    ("BRA","Brazil","South America","Upper-Mid",216.0), ("ARG","Argentina","South America","Upper-Mid",46.0),
    ("COL","Colombia","South America","Upper-Mid",52.0), ("CHL","Chile","South America","High",19.6),
    ("PER","Peru","South America","Upper-Mid",34.0), ("VEN","Venezuela","South America","Upper-Mid",28.0),
    ("ECU","Ecuador","South America","Upper-Mid",18.0), ("BOL","Bolivia","South America","Lower-Mid",12.4),
    ("PRY","Paraguay","South America","Upper-Mid",6.9), ("URY","Uruguay","South America","High",3.4),
    ("NGA","Nigeria","Africa","Lower-Mid",224.0), ("ETH","Ethiopia","Africa","Low",127.0),
    ("EGY","Egypt","Africa","Lower-Mid",113.0), ("COD","DR Congo","Africa","Low",102.0),
    ("ZAF","South Africa","Africa","Upper-Mid",60.0), ("KEN","Kenya","Africa","Lower-Mid",55.0),
    ("TZA","Tanzania","Africa","Lower-Mid",67.0), ("DZA","Algeria","Africa","Upper-Mid",46.0),
    ("SDN","Sudan","Africa","Low",48.0), ("MAR","Morocco","Africa","Lower-Mid",38.0),
    ("UGA","Uganda","Africa","Low",48.0), ("AGO","Angola","Africa","Lower-Mid",37.0),
    ("GHA","Ghana","Africa","Lower-Mid",34.0), ("MOZ","Mozambique","Africa","Low",34.0),
    ("MDG","Madagascar","Africa","Low",30.0), ("CIV","Cote d'Ivoire","Africa","Lower-Mid",29.0),
    ("CMR","Cameroon","Africa","Lower-Mid",28.0), ("NER","Niger","Africa","Low",27.0),
    ("MLI","Mali","Africa","Low",23.0), ("ZMB","Zambia","Africa","Lower-Mid",20.0),
    ("SEN","Senegal","Africa","Lower-Mid",18.0), ("ZWE","Zimbabwe","Africa","Lower-Mid",16.6),
    ("TUN","Tunisia","Africa","Lower-Mid",12.4), ("LBY","Libya","Africa","Upper-Mid",6.9),
    ("BWA","Botswana","Africa","Upper-Mid",2.7),
    ("AUS","Australia","Oceania","High",26.6), ("NZL","New Zealand","Oceania","High",5.2),
    ("PNG","Papua New Guinea","Oceania","Lower-Mid",10.3), ("FJI","Fiji","Oceania","Upper-Mid",0.93),
    ("SLB","Solomon Islands","Oceania","Lower-Mid",0.74), ("VUT","Vanuatu","Oceania","Lower-Mid",0.33),
    ("WSM","Samoa","Oceania","Lower-Mid",0.22), ("TON","Tonga","Oceania","Upper-Mid",0.1),
];

/// Deterministic noise in [0, 1) (splitmix64).
fn noise(a: u64, b: u64) -> f64 {
    let mut z = a.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ b.wrapping_add(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    ((z ^ (z >> 31)) >> 11) as f64 / (1u64 << 53) as f64
}

fn smoothstep(lo: f64, hi: f64, x: f64) -> f64 {
    let t = ((x - lo) / (hi - lo)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Annual primitives that get interpolated; everything else is derived.
/// [pop_m, gdp_pc, co2_pc, coal_frac, oil_frac, renew_pct, nuclear_pct, cum_co2_mt, growth_pct]
type Base = [f64; 9];

fn annual_base(ci: usize, income: &str, pop_2024: f64) -> Vec<Base> {
    let c = ci as u64;
    let (gdp_2024, co2_2024, takeoff) = match income {
        "High" => (45_000.0, 8.0, 1880.0),
        "Upper-Mid" => (12_000.0, 5.0, 1950.0),
        "Lower-Mid" => (4_000.0, 1.8, 1970.0),
        _ => (1_200.0, 0.3, 1990.0),
    };
    let gdp_2024 = gdp_2024 * (0.6 + 0.8 * noise(c, 1));
    let co2_2024 = co2_2024 * (0.5 + noise(c, 2));
    let takeoff = takeoff + (noise(c, 3) - 0.5) * 30.0;
    let hydro = 1.0 + 14.0 * noise(c, 4);
    let renew_target = hydro + (5.0 + 45.0 * noise(c, 5));
    let nuclear_peak = if income != "Low" && noise(c, 6) > 0.55 { 5.0 + 30.0 * noise(c, 7) } else { 0.0 };
    let gdp_growth = 0.016 + 0.006 * noise(c, 8);
    let rich = income == "High";

    let mut out = Vec::with_capacity(YEARS + 1);
    let (mut cum, mut prev_co2) = (0.0, 0.0);
    // one extra year so December can interpolate toward the next January
    for y in FIRST_YEAR..=LAST_YEAR + 1 {
        let yf = y as f64;
        let back = 2024.0 - yf;
        let pop = (pop_2024 * (-0.009 * back).exp()).max(0.02);
        let gdp_pc = (gdp_2024 * (-gdp_growth * back).exp()).max(350.0);
        let dev = 1.0 / (1.0 + (-(yf - takeoff) / 18.0).exp());
        let hump = if rich { 1.0 + 0.6 * (-((yf - 1975.0) / 25.0).powi(2)).exp() } else { 1.0 };
        let jitter = 1.0 + 0.06 * (noise(c, 1000 + y as u64) - 0.5);
        let co2_pc = (co2_2024 * dev * hump * jitter).max(0.001);

        let coal = 0.95 - 0.5 * smoothstep(1900.0, 1990.0, yf) * (0.6 + 0.6 * noise(c, 9));
        let oil = (1.0 - coal) * 0.6;
        let renew = hydro * smoothstep(1890.0, 1960.0, yf)
            + (renew_target - hydro) * smoothstep(2000.0, 2024.0, yf);
        let nuclear = nuclear_peak * smoothstep(1965.0, 1990.0, yf);

        let co2 = co2_pc * pop;
        cum += co2;
        let growth = if prev_co2 > 0.0 { (co2 / prev_co2 - 1.0) * 100.0 } else { 0.0 };
        prev_co2 = co2;
        out.push([pop, gdp_pc, co2_pc, coal, oil, renew, nuclear, cum, growth]);
    }
    out
}

fn intern(cache: &mut HashMap<String, &'static str>, s: String) -> &'static str {
    *cache.entry(s).or_insert_with_key(|k| Box::leak(k.clone().into_boxed_str()))
}

fn build_record(id: u32, meta: &(&'static str, &'static str, &'static str, &'static str, f64), period: &'static str, b: &Base) -> ClimateRecord {
    let [pop_m, gdp_pc, co2_pc, coal_f, oil_f, renew, nuclear, cum, growth] = *b;
    let co2 = co2_pc * pop_m;
    let cement = co2 * 0.04;
    let coal = (co2 - cement) * coal_f;
    let oil = (co2 - cement) * oil_f;
    let gas = (co2 - cement - coal - oil).max(0.0);
    let methane = co2 * 0.18 + pop_m * 0.3;
    let n2o = methane * 0.3;
    let fossil = (100.0 - renew - nuclear).max(0.0);
    let energy_pc = 300.0 + co2_pc * 3600.0 / (fossil / 100.0).max(0.15); // kWh
    let primary = energy_pc * pop_m / 1000.0; // TWh
    let solar_wind = primary * renew / 100.0 * 0.5 * smoothstep(0.0, 1.0, (renew - 5.0) / 40.0);
    let population = (pop_m * 1e6) as u64;

    ClimateRecord {
        record_id: id,
        iso_code: meta.0,
        country: meta.1,
        period_str: period,
        continent: meta.2,
        income_group: meta.3,
        population,
        gdp: gdp_pc * population as f64,
        gdp_per_capita: gdp_pc,
        co2: co2 as f32,
        co2_per_capita: co2_pc as f32,
        co2_growth_prct: growth as f32,
        co2_per_gdp: (co2_pc * 1000.0 / gdp_pc) as f32,
        total_ghg: (co2 + methane + n2o) as f32,
        methane: methane as f32,
        nitrous_oxide: n2o as f32,
        coal_co2: coal as f32,
        oil_co2: oil as f32,
        gas_co2: gas as f32,
        cement_co2: cement as f32,
        primary_energy_twh: primary as f32,
        energy_per_capita: energy_pc as f32,
        renewables_share: renew as f32,
        fossil_share: fossil as f32,
        nuclear_share: nuclear as f32,
        solar_wind_twh: solar_wind as f32,
        carbon_intensity: (40.0 + fossil * 8.0) as f32,
        temp_change_ghg: (cum * 4.5e-7) as f32,
    }
}

pub static GLOBAL_STORE: LazyLock<Vec<ClimateRecord>> = LazyLock::new(|| {
    let mut periods = HashMap::new();
    let mut store = Vec::with_capacity(COUNTRIES.len() * YEARS * 12);
    let mut id = 1u32;

    for (ci, meta) in COUNTRIES.iter().enumerate() {
        let annual = annual_base(ci, meta.3, meta.4);
        for yi in 0..YEARS {
            let (a, b) = (&annual[yi], &annual[yi + 1]);
            for m in 0..12 {
                let t = m as f64 / 12.0;
                let mut v = [0.0; 9];
                for k in 0..9 {
                    v[k] = a[k] + (b[k] - a[k]) * t; // linear interpolation
                }
                let period = intern(&mut periods, format!("{}-{:02}", FIRST_YEAR as usize + yi, m + 1));
                store.push(build_record(id, meta, period, &v));
                id += 1;
            }
        }
    }
    store
});
