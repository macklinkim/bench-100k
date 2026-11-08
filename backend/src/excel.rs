use rust_xlsxwriter::{XlsxError, Format, Workbook};

use crate::store::GLOBAL_STORE;

pub fn generate_excel_buffer(continent_filter: Option<&str>) -> Result<Vec<u8>, XlsxError> {
    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();

    let header_format = Format::new()
        .set_bold()
        .set_background_color(0x1E293B)
        .set_font_color(0xFFFFFF);

    let headers = [
        "ID", "ISO", "Country", "Period", "Continent", "Income",
        "Population", "GDP", "GDP per capita", "CO2 (Mt)", "Renewables %", "Temp Impact (°C)",
    ];
    for (col_idx, h) in headers.iter().enumerate() {
        sheet.write_string_with_format(0, col_idx as u16, *h, &header_format)?;
    }

    let rows = GLOBAL_STORE
        .iter()
        .filter(|r| continent_filter.is_none_or(|c| c.is_empty() || r.continent == c))
        .take(50_000); // Excel size / latency guard

    for (row_idx, r) in rows.enumerate() {
        let row = (row_idx + 1) as u32;
        sheet
            .write_number(row, 0, r.record_id)?
            .write_string(row, 1, r.iso_code)?
            .write_string(row, 2, r.country)?
            .write_string(row, 3, r.period_str)?
            .write_string(row, 4, r.continent)?
            .write_string(row, 5, r.income_group)?
            .write_number(row, 6, r.population as f64)?
            .write_number(row, 7, r.gdp)?
            .write_number(row, 8, r.gdp_per_capita)?
            .write_number(row, 9, r.co2)?
            .write_number(row, 10, r.renewables_share)?
            .write_number(row, 11, r.temp_change_ghg)?;
    }

    workbook.save_to_buffer()
}
