export interface ClimateRecord {
  record_id: number;          // Col 01
  iso_code: string;           // Col 02
  country: string;            // Col 03
  period_str: string;         // Col 04
  continent: string;          // Col 05
  income_group: string;       // Col 06
  population: number;         // Col 07
  gdp: number;                // Col 08
  gdp_per_capita: number;     // Col 09
  co2: number;                // Col 10
  co2_per_capita: number;     // Col 11
  co2_growth_prct: number;    // Col 12
  co2_per_gdp: number;        // Col 13
  total_ghg: number;          // Col 14
  methane: number;            // Col 15
  nitrous_oxide: number;      // Col 16
  coal_co2: number;           // Col 17
  oil_co2: number;            // Col 18
  gas_co2: number;            // Col 19
  cement_co2: number;         // Col 20
  primary_energy_twh: number; // Col 21
  energy_per_capita: number;  // Col 22
  renewables_share: number;   // Col 23
  fossil_share: number;       // Col 24
  nuclear_share: number;      // Col 25
  solar_wind_twh: number;     // Col 26
  carbon_intensity: number;   // Col 27
  temp_change_ghg: number;    // Col 28
}

// shared by App (sender) and worker (receiver)
export interface FilterCriteria {
  yearRange?: [number, number];
  continent?: string | null;
  searchQuery?: string;
  sortKey?: keyof ClimateRecord | null;
  sortDir?: 'asc' | 'desc';
}

export interface Summary {
  filteredCount: number;
  sumCo2: number;
  avgRenewables: number;
  avgIntensity: number;
}

export type ContinentAgg = Record<string, { count: number; fossil: number; nuclear: number; renew: number }>;

export interface ChartData {
  yearlySeries: [number, { co2: number; temp: number; count: number }][];
  histBins: Uint32Array;
  continentAgg: ContinentAgg;
  scatterPoints: Float32Array;
}

export type CellRenderType =
  | 'pin-id'
  | 'badge-iso'
  | 'text-bold'
  | 'mono'
  | 'tag-continent'
  | 'badge-income'
  | 'number-comma'
  | 'currency-abbr'
  | 'bar-co2'
  | 'delta-percent'
  | 'heatmap-fossil'
  | 'gauge-share'
  | 'warn-intensity'
  | 'pin-temp-impact';

export interface ColumnDef {
  index: number;
  key: keyof ClimateRecord;
  label: string;
  group: 'ID' | 'MACRO' | 'GHG' | 'SOURCES' | 'ENERGY' | 'IMPACT';
  width: number;
  pinned?: 'left' | 'right';
  renderType: CellRenderType;
  maxVal?: number; // normalization ceiling for in-cell bars / heatmaps
}

// Center horizontally-virtualized columns (Col 05 ~ Col 27: 23 columns)
export const SCROLLABLE_COLUMNS: ColumnDef[] = [
  { index: 4,  key: 'continent',          label: '대륙',           group: 'MACRO',   width: 100, renderType: 'tag-continent' },
  { index: 5,  key: 'income_group',       label: '소득수준',       group: 'MACRO',   width: 110, renderType: 'badge-income' },
  { index: 6,  key: 'population',         label: '인구수',         group: 'MACRO',   width: 120, renderType: 'number-comma' },
  { index: 7,  key: 'gdp',                label: '실질 GDP',       group: 'MACRO',   width: 110, renderType: 'currency-abbr' },
  { index: 8,  key: 'gdp_per_capita',     label: '1인당 GDP',      group: 'MACRO',   width: 110, renderType: 'currency-abbr' },
  { index: 9,  key: 'co2',                label: '총 CO2 (Mt)',    group: 'GHG',     width: 140, renderType: 'bar-co2', maxVal: 12000 },
  { index: 10, key: 'co2_per_capita',     label: '1인당 CO2 (t)',  group: 'GHG',     width: 130, renderType: 'bar-co2', maxVal: 35 },
  { index: 11, key: 'co2_growth_prct',    label: 'CO2 증감률',     group: 'GHG',     width: 110, renderType: 'delta-percent' },
  { index: 12, key: 'co2_per_gdp',        label: 'GDP당 CO2',      group: 'GHG',     width: 110, renderType: 'number-comma' },
  { index: 13, key: 'total_ghg',          label: '총 온실가스',    group: 'GHG',     width: 120, renderType: 'number-comma' },
  { index: 14, key: 'methane',            label: '메탄 (Mt)',      group: 'GHG',     width: 105, renderType: 'number-comma' },
  { index: 15, key: 'nitrous_oxide',      label: '아산화질소',     group: 'GHG',     width: 105, renderType: 'number-comma' },
  { index: 16, key: 'coal_co2',           label: '석탄 CO2',       group: 'SOURCES', width: 115, renderType: 'heatmap-fossil', maxVal: 8000 },
  { index: 17, key: 'oil_co2',            label: '석유 CO2',       group: 'SOURCES', width: 115, renderType: 'heatmap-fossil', maxVal: 4000 },
  { index: 18, key: 'gas_co2',            label: '가스 CO2',       group: 'SOURCES', width: 115, renderType: 'heatmap-fossil', maxVal: 3000 },
  { index: 19, key: 'cement_co2',         label: '시멘트 CO2',     group: 'SOURCES', width: 110, renderType: 'number-comma' },
  { index: 20, key: 'primary_energy_twh', label: '1차 에너지(TWh)',group: 'ENERGY',  width: 130, renderType: 'number-comma' },
  { index: 21, key: 'energy_per_capita',  label: '1인당 에너지',   group: 'ENERGY',  width: 120, renderType: 'number-comma' },
  { index: 22, key: 'renewables_share',   label: '재생에너지 비중',group: 'ENERGY',  width: 140, renderType: 'gauge-share' },
  { index: 23, key: 'fossil_share',       label: '화석연료 비중',  group: 'ENERGY',  width: 140, renderType: 'gauge-share' },
  { index: 24, key: 'nuclear_share',      label: '원자력 비중',    group: 'ENERGY',  width: 130, renderType: 'gauge-share' },
  { index: 25, key: 'solar_wind_twh',     label: '태양광+풍력',    group: 'ENERGY',  width: 120, renderType: 'number-comma' },
  { index: 26, key: 'carbon_intensity',   label: '탄소집약도(g)',  group: 'IMPACT',  width: 125, renderType: 'warn-intensity' },
];
