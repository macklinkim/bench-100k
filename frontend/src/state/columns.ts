import type { ClimateRecord } from './gridSchema';

// Wire order of the positional msgpack rows = Rust `ClimateRecord` field order.
export const COLUMN_KEYS: (keyof ClimateRecord)[] = [
  'record_id', 'iso_code', 'country', 'period_str', 'continent', 'income_group',
  'population', 'gdp', 'gdp_per_capita', 'co2', 'co2_per_capita', 'co2_growth_prct',
  'co2_per_gdp', 'total_ghg', 'methane', 'nitrous_oxide', 'coal_co2', 'oil_co2',
  'gas_co2', 'cement_co2', 'primary_energy_twh', 'energy_per_capita', 'renewables_share',
  'fossil_share', 'nuclear_share', 'solar_wind_twh', 'carbon_intensity', 'temp_change_ghg',
];

const STRING_KEYS = new Set<keyof ClimateRecord>(['iso_code', 'country', 'period_str', 'continent', 'income_group']);
const F64_KEYS = new Set<keyof ClimateRecord>(['population', 'gdp', 'gdp_per_capita']);

type NumArray = Uint32Array | Float64Array | Float32Array;

/**
 * Column store: one TypedArray per column. Strings are dictionary-encoded
 * (Uint16 code per row + small dict). ~114 bytes/row, and every buffer can be
 * transferred worker -> main thread without structured-clone cost.
 */
export interface Columns {
  length: number;
  num: Partial<Record<keyof ClimateRecord, NumArray>>;
  codes: Partial<Record<keyof ClimateRecord, Uint16Array>>;
  dicts: Partial<Record<keyof ClimateRecord, string[]>>;
}

/** rows: positional arrays (msgpack) or keyed objects (json). */
export function toColumns(rows: any[], positional: boolean): Columns {
  const n = rows.length;
  const cols: Columns = { length: n, num: {}, codes: {}, dicts: {} };

  COLUMN_KEYS.forEach((key, j) => {
    const get = positional ? (r: any) => r[j] : (r: any) => r[key];
    if (STRING_KEYS.has(key)) {
      const codes = new Uint16Array(n);
      const dict: string[] = [];
      const seen = new Map<string, number>();
      for (let i = 0; i < n; i++) {
        const s = get(rows[i]);
        let id = seen.get(s);
        if (id === undefined) seen.set(s, (id = dict.push(s) - 1));
        codes[i] = id;
      }
      cols.codes[key] = codes;
      cols.dicts[key] = dict;
    } else {
      const arr = key === 'record_id' ? new Uint32Array(n) : F64_KEYS.has(key) ? new Float64Array(n) : new Float32Array(n);
      for (let i = 0; i < n; i++) arr[i] = get(rows[i]);
      cols.num[key] = arr;
    }
  });
  return cols;
}

/** Materialize one row (grid shows ~30 at a time, CSV builder walks all). */
export function rowAt(cols: Columns, i: number): ClimateRecord {
  const r: any = {};
  for (const key of COLUMN_KEYS) {
    const codes = cols.codes[key];
    r[key] = codes ? cols.dicts[key]![codes[i]] : cols.num[key]![i];
  }
  return r as ClimateRecord;
}

/** Copy of all buffers + their list, for postMessage transfer. */
export function cloneForTransfer(cols: Columns): [Columns, ArrayBuffer[]] {
  const out: Columns = { length: cols.length, num: {}, codes: {}, dicts: cols.dicts };
  const buffers: ArrayBuffer[] = [];
  for (const [k, a] of Object.entries(cols.num)) {
    const c = a!.slice();
    out.num[k as keyof ClimateRecord] = c;
    buffers.push(c.buffer as ArrayBuffer);
  }
  for (const [k, a] of Object.entries(cols.codes)) {
    const c = a!.slice();
    out.codes[k as keyof ClimateRecord] = c;
    buffers.push(c.buffer as ArrayBuffer);
  }
  return [out, buffers];
}
