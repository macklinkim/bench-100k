import { decode } from '@msgpack/msgpack';
import type { ClimateRecord, ContinentAgg, FilterCriteria } from '../state/gridSchema';
import { COLUMN_KEYS, cloneForTransfer, rowAt, toColumns } from '../state/columns';
import type { Columns } from '../state/columns';

let cols: Columns = { length: 0, num: {}, codes: {}, dicts: {} };
let years: Uint16Array = new Uint16Array(0); // year per row, derived once per load
let activeIndices: Uint32Array = new Uint32Array(0);

self.onmessage = async (e: MessageEvent) => {
  const { type, payload } = e.data;

  if (type === 'FETCH_AND_LOAD') {
    try {
      const t0 = performance.now();
      const res = await fetch(payload.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const serverSerializeMs = Number(res.headers.get('X-Server-Serialize-Ms') || 0);
      const buf = await res.arrayBuffer();
      const netMs = performance.now() - t0;

      const t1 = performance.now();
      const positional = payload.format === 'msgpack'; // msgpack rows are arrays in COLUMN_KEYS order
      const rows = positional ? (decode(new Uint8Array(buf)) as unknown[][]) : JSON.parse(new TextDecoder().decode(buf));
      cols = toColumns(rows, positional);
      const parseMs = performance.now() - t1;

      const periodYear = cols.dicts.period_str!.map((p) => parseInt(p.slice(0, 4), 10));
      const pc = cols.codes.period_str!;
      years = new Uint16Array(cols.length);
      for (let i = 0; i < cols.length; i++) years[i] = periodYear[pc[i]];

      runFilterAndAggregate(payload.criteria || {}, {
        serverSerializeMs,
        netMs,
        parseMs,
        payloadBytes: buf.byteLength,
      });
    } catch (err) {
      self.postMessage({ type: 'ERROR', message: String(err) });
    }
  }

  if (type === 'APPLY_FILTER') {
    runFilterAndAggregate(payload.criteria);
  }

  if (type === 'EXPORT_DELIMITED') {
    const { delimiter, filename } = payload;
    const t0 = performance.now();
    const blob = buildDelimitedBlob(delimiter);
    const exportMs = performance.now() - t0;
    self.postMessage({ type: 'EXPORT_READY', url: URL.createObjectURL(blob), filename, exportMs, bytes: blob.size });
  }
};

function runFilterAndAggregate(criteria: FilterCriteria, netStats?: Record<string, number>) {
  const tStart = performance.now();
  const total = cols.length;
  const tempIndices = new Uint32Array(total);
  let matchCount = 0;

  const co2 = cols.num.co2!, renew = cols.num.renewables_share!, intensity = cols.num.carbon_intensity!;
  const fossil = cols.num.fossil_share!, nuclear = cols.num.nuclear_share!, temp = cols.num.temp_change_ghg!;
  const contCodes = cols.codes.continent!, contDict = cols.dicts.continent!;
  const countryCodes = cols.codes.country!, isoCodes = cols.codes.iso_code!;

  let sumCo2 = 0;
  let sumRenewables = 0;
  let sumIntensity = 0;

  const histBins = new Uint32Array(25); // Chart 2: 0 ~ 1000 gCO2/kWh
  const contCount = new Float64Array(contDict.length); // Chart 3, indexed by continent code
  const contFossil = new Float64Array(contDict.length);
  const contNuclear = new Float64Array(contDict.length);
  const contRenew = new Float64Array(contDict.length);
  const yearCo2 = new Float64Array(2100); // Chart 1, indexed by year
  const yearTemp = new Float64Array(2100);
  const yearCount = new Uint32Array(2100);

  // filters resolved against the small dictionaries once, not per row
  const [minY, maxY] = criteria.yearRange || [1750, 2030];
  const contWanted = criteria.continent ? contDict.indexOf(criteria.continent) : -2; // -2 = no filter, -1 = no match
  const q = criteria.searchQuery?.trim().toLowerCase() || '';
  const countryOk = cols.dicts.country!.map((s) => !q || s.toLowerCase().includes(q));
  const isoOk = cols.dicts.iso_code!.map((s) => !q || s.toLowerCase().includes(q));

  for (let i = 0; i < total; i++) {
    const year = years[i];
    if (year < minY || year > maxY) continue;
    const c = contCodes[i];
    if (contWanted !== -2 && c !== contWanted) continue;
    if (q && !countryOk[countryCodes[i]] && !isoOk[isoCodes[i]]) continue;

    tempIndices[matchCount++] = i;

    sumCo2 += co2[i];
    sumRenewables += renew[i];
    sumIntensity += intensity[i];

    const binIdx = Math.min(24, Math.floor((intensity[i] / 1000) * 25));
    if (binIdx >= 0) histBins[binIdx]++;

    contCount[c]++;
    contFossil[c] += fossil[i];
    contNuclear[c] += nuclear[i];
    contRenew[c] += renew[i];

    yearCo2[year] += co2[i];
    yearTemp[year] += temp[i];
    yearCount[year]++;
  }

  activeIndices = tempIndices.slice(0, matchCount);

  if (criteria.sortKey) {
    const key = criteria.sortKey;
    const dir = criteria.sortDir === 'desc' ? -1 : 1;
    const codes = cols.codes[key];
    let values: ArrayLike<number>;
    if (codes) {
      // string column: compare precomputed alphabetical rank of each dict entry
      const dict = cols.dicts[key]!;
      const rank = new Uint16Array(dict.length);
      dict.map((s, id) => [s, id] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).forEach(([, id], r) => (rank[id] = r));
      const v = new Uint16Array(total);
      for (let i = 0; i < total; i++) v[i] = rank[codes[i]];
      values = v;
    } else {
      values = cols.num[key]!;
    }
    activeIndices.sort((a, b) => (values[a] - values[b]) * dir || a - b);
  }

  const gdpPc = cols.num.gdp_per_capita!, co2Pc = cols.num.co2_per_capita!;
  const scatterPoints = new Float32Array(matchCount * 2); // Chart 4
  for (let i = 0; i < matchCount; i++) {
    const r = activeIndices[i];
    scatterPoints[i * 2] = gdpPc[r];
    scatterPoints[i * 2 + 1] = co2Pc[r];
  }

  const continentAgg: ContinentAgg = {};
  contDict.forEach((name, c) => {
    if (contCount[c]) continentAgg[name] = { count: contCount[c], fossil: contFossil[c], nuclear: contNuclear[c], renew: contRenew[c] };
  });
  const yearlySeries: [number, { co2: number; temp: number; count: number }][] = [];
  for (let y = 0; y < yearCount.length; y++) {
    if (yearCount[y]) yearlySeries.push([y, { co2: yearCo2[y], temp: yearTemp[y], count: yearCount[y] }]);
  }

  const filterMs = performance.now() - tStart;

  // transfer copies: the worker keeps its own buffers for later filters / exports
  const indicesOut = activeIndices.slice();
  const transfer: ArrayBuffer[] = [indicesOut.buffer, histBins.buffer, scatterPoints.buffer];
  let columnsOut: Columns | undefined;
  if (netStats) {
    const [c, buffers] = cloneForTransfer(cols);
    columnsOut = c;
    transfer.push(...buffers);
  }

  self.postMessage(
    {
      type: 'DATA_SYNCHRONIZED',
      columns: columnsOut, // only on (re)load; zero-copy transfer, no structured clone of 300k objects
      activeIndices: indicesOut,
      summary: {
        filteredCount: matchCount,
        sumCo2,
        avgRenewables: matchCount ? sumRenewables / matchCount : 0,
        avgIntensity: matchCount ? sumIntensity / matchCount : 0,
      },
      charts: { yearlySeries, histBins, continentAgg, scatterPoints },
      telemetry: { ...netStats, filterMs },
    },
    transfer
  );
}

// chunked (10k rows) CSV/TSV builder with UTF-8 BOM, over the current filtered/sorted view
function buildDelimitedBlob(sep: string): Blob {
  const chunks: BlobPart[] = ['﻿' + COLUMN_KEYS.join(sep) + '\n'];
  let batch = '';

  for (let i = 0; i < activeIndices.length; i++) {
    const r: ClimateRecord = rowAt(cols, activeIndices[i]);
    batch += `${r.record_id}${sep}${r.iso_code}${sep}"${r.country}"${sep}${r.period_str}${sep}${r.continent}${sep}${r.income_group}${sep}${r.population}${sep}${r.gdp}${sep}${r.gdp_per_capita}${sep}${r.co2}${sep}${r.co2_per_capita}${sep}${r.co2_growth_prct}${sep}${r.co2_per_gdp}${sep}${r.total_ghg}${sep}${r.methane}${sep}${r.nitrous_oxide}${sep}${r.coal_co2}${sep}${r.oil_co2}${sep}${r.gas_co2}${sep}${r.cement_co2}${sep}${r.primary_energy_twh}${sep}${r.energy_per_capita}${sep}${r.renewables_share}${sep}${r.fossil_share}${sep}${r.nuclear_share}${sep}${r.solar_wind_twh}${sep}${r.carbon_intensity}${sep}${r.temp_change_ghg}\n`;

    if (i % 10000 === 9999) {
      chunks.push(batch);
      batch = '';
    }
  }
  if (batch) chunks.push(batch);

  const mime = sep === '\t' ? 'text/tab-separated-values;charset=utf-8' : 'text/csv;charset=utf-8';
  return new Blob(chunks, { type: mime });
}
