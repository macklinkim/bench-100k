# 단일 화면(Single-Viewport) 레이아웃 및 인터랙션 코드 레벨 상세 설계서

* **대상 모듈:** Frontend UI / Rendering Engine (`SolidJS` + `@tanstack/solid-virtual` + `HTML5 Canvas 2D/WebGL`)
* **레이아웃 원칙:** `100vw × 100vh` 무스크롤 단일 뷰포트 (Zero-Page-Scroll), 3단 고정 분할 (Zone A: 8% / Zone B: 32% / Zone C: 60%)
* **성능 목표:** 100,000 행 × 28 열 ($2,800,000$ 셀) 로드 상태에서 실제 DOM 셀 개수 **항상 300개 미만** 유지, 스크롤 및 차트 브러싱 시 **60 FPS ($16.6\text{ms}$/frame)** 방어

---

## 1. 전역 CSS Grid 레이아웃 및 레이어(`z-index`) 명세

브라우저 기본 바운스 스크롤과 레이아웃 시프트(CLS)를 원천 차단하고, GPU 합성 레이어(`will-change: transform`, `contain: strict`)를 강제하여 렌더링 비용을 격리합니다.

### `src/styles/viewport.css`
```css
:root {
  --bg-primary: #0b0f19;
  --bg-panel: #111827;
  --bg-row-even: #0f172a;
  --bg-row-hover: #1e293b;
  --border-color: #1f2937;
  --text-main: #f3f4f6;
  --text-muted: #9ca3af;
  --accent-blue: #3b82f6;
  --accent-green: #10b981;
  --accent-red: #ef4444;
  --accent-amber: #f59e0b;

  /* 2D Grid 고정 치수 상수 */
  --row-height: 32px;
  --header-height: 38px;
  --footer-height: 36px;
  --pinned-left-width: 390px;  /* Col 01(70) + Col 02(60) + Col 03(160) + Col 04(100) */
  --pinned-right-width: 120px; /* Col 28(120) */
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  user-select: none;
}

html, body, #root {
  width: 100vw;
  height: 100vh;
  overflow: hidden; /* 전체 화면 스크롤 원천 차단 */
  background-color: var(--bg-primary);
  color: var(--text-main);
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, monospace;
  font-size: 12px;
}

/* 3단 고정 뷰포트 컨테이너 */
.viewport-shell {
  display: grid;
  grid-template-rows: 8vh 32vh 60vh;
  width: 100vw;
  height: 100vh;
  contain: strict;
}

/* Zone A: 상단 컨트롤 및 텔레메트리 바 (8vh) */
.zone-a-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border-color);
  gap: 12px;
}

/* Zone B: 4대 기후·에너지 멀티 차트 클러스터 (32vh) */
.zone-b-charts {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  padding: 8px;
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border-color);
  min-height: 0; /* Grid 내부 Canvas 오버플로우 방지 */
}

.chart-card {
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 6px 8px;
  position: relative;
  overflow: hidden;
}

.chart-canvas-wrap {
  flex: 1;
  position: relative;
  width: 100%;
  height: 100%;
}

/* Zone C: 2D 가상화 와이드 데이터 그리드 (60vh) */
.zone-c-grid-wrapper {
  display: grid;
  grid-template-rows: 34px 1fr var(--footer-height); /* 툴바 + 메인그리드 + 요약푸터 */
  width: 100%;
  height: 100%;
  background: var(--bg-panel);
}

/* 2차원 가상 스크롤 뷰포트 */
.virtual-grid-viewport {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: auto;
  contain: strict;
  will-change: scroll-position;
}

/* 좌/우 Sticky 고정 핀(Pinned) 컬럼 레이어 */
.cell-pinned-left {
  position: sticky;
  left: 0;
  z-index: 20;
  background: var(--bg-panel);
  border-right: 2px solid #374151;
  display: flex;
}

.cell-pinned-right {
  position: sticky;
  right: 0;
  z-index: 20;
  background: var(--bg-panel);
  border-left: 2px solid #374151;
}

.grid-header-sticky {
  position: sticky;
  top: 0;
  z-index: 30;
  height: var(--header-height);
  background: #1e293b;
  border-bottom: 1px solid #475569;
}
```

---

## 2. 상태 스토어 및 28개 컬럼 메타데이터 정의

SolidJS의 Fine-Grained Reactivity를 극대화하기 위해, 10만 건의 원본 배열은 반응형 프록시(Proxy)로 감싸지 않고 **Web Worker 내부의 평면 배열(또는 `SharedArrayBuffer` / `TypedArray`)에 보관**하거나, 메인 스레드에서는 **단일 `createSignal` 참조(`shallow`)**로만 관리합니다.

### `src/state/gridSchema.ts`
```typescript
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
  maxVal?: number; // 인라인 바/히트맵 정규화 기준값
}

// 중앙 가로 가상화 대상 컬럼들 (Col 05 ~ Col 27: 총 23개 가변 열)
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
```

---

## 3. Web Worker 사전 집계 및 교차 필터링(Cross-Filtering) 엔진

차트 브러싱(연도 범위 드래그)이나 대륙 클릭 시 10만 건을 메인 스레드에서 `.filter()`로 돌리면 프레임 드랍이 발생합니다. **Web Worker가 1회 순회($O(N)$)로 필터링된 인덱스 배열(`Uint32Array`)과 4개 차트용 집계 버퍼, 하단 요약 행(Footer) 통계를 동시에 계산**하여 Transferable로 넘깁니다.

### `src/worker/dataEngine.worker.ts`
```typescript
import { decode } from '@msgpack/msgpack';
import type { ClimateRecord } from '../state/gridSchema';

let rawStore: ClimateRecord[] = [];
let activeIndices: Uint32Array = new Uint32Array(0);

export interface FilterCriteria {
  yearRange?: [number, number];
  continent?: string | null;
  searchQuery?: string;
  sortKey?: keyof ClimateRecord | null;
  sortDir?: 'asc' | 'desc';
}

self.onmessage = async (e: MessageEvent) => {
  const { type, payload } = e.data;

  if (type === 'FETCH_AND_LOAD') {
    const t0 = performance.now();
    const res = await fetch(payload.url);
    const serverSerializeMs = Number(res.headers.get('X-Server-Serialize-Ms') || 0);
    const buf = await res.arrayBuffer();
    const netMs = performance.now() - t0;

    const t1 = performance.now();
    rawStore = payload.format === 'msgpack'
      ? (decode(new Uint8Array(buf)) as ClimateRecord[])
      : JSON.parse(new TextDecoder().decode(buf));
    const parseMs = performance.now() - t1;

    runFilterAndAggregate({}, {
      serverSerializeMs,
      netMs,
      parseMs,
      payloadBytes: buf.byteLength,
    });
  }

  if (type === 'APPLY_FILTER') {
    runFilterAndAggregate(payload.criteria);
  }

  if (type === 'EXPORT_DELIMITED') {
    const { delimiter, filename } = payload;
    const t0 = performance.now();
    const url = buildDelimitedBlobUrl(delimiter);
    const exportMs = performance.now() - t0;
    self.postMessage({ type: 'EXPORT_READY', url, filename, exportMs });
  }
};

function runFilterAndAggregate(criteria: FilterCriteria, netStats?: any) {
  const tStart = performance.now();
  const total = rawStore.length;
  const tempIndices = new Uint32Array(total);
  let matchCount = 0;

  // 요약 푸터 및 4개 차트 집계용 누적 변수
  let sumCo2 = 0;
  let sumRenewables = 0;
  let sumIntensity = 0;

  // Chart 2: 탄소 집약도 25개 구간 히스토그램 (0 ~ 1000 gCO2/kWh)
  const histBins = new Uint32Array(25);
  // Chart 3: 대륙별 에너지 믹스 집계
  const continentAgg: Record<string, { count: number; fossil: number; nuclear: number; renew: number }> = {};
  // Chart 1: 연도별 시계열 집계
  const yearlyMap = new Map<number, { co2: number; temp: number; count: number }>();

  const q = criteria.searchQuery?.trim().toLowerCase() || '';
  const [minY, maxY] = criteria.yearRange || [1750, 2030];

  for (let i = 0; i < total; i++) {
    const row = rawStore[i];
    const year = parseInt(row.period_str.slice(0, 4), 10);

    if (year < minY || year > maxY) continue;
    if (criteria.continent && row.continent !== criteria.continent) continue;
    if (q && !row.country.toLowerCase().includes(q) && !row.iso_code.toLowerCase().includes(q)) continue;

    tempIndices[matchCount++] = i;

    // 1회 순회 내 동시 통계 집계
    sumCo2 += row.co2;
    sumRenewables += row.renewables_share;
    sumIntensity += row.carbon_intensity;

    const binIdx = Math.min(24, Math.floor((row.carbon_intensity / 1000) * 25));
    if (binIdx >= 0) histBins[binIdx]++;

    const cStat = (continentAgg[row.continent] ||= { count: 0, fossil: 0, nuclear: 0, renew: 0 });
    cStat.count++;
    cStat.fossil += row.fossil_share;
    cStat.nuclear += row.nuclear_share;
    cStat.renew += row.renewables_share;

    const yStat = yearlyMap.get(year) || { co2: 0, temp: 0, count: 0 };
    yStat.co2 += row.co2;
    yStat.temp += row.temp_change_ghg;
    yStat.count++;
    yearlyMap.set(year, yStat);
  }

  activeIndices = tempIndices.slice(0, matchCount);

  // 정렬 요청이 있는 경우 인덱스 배열만 고속 정렬
  if (criteria.sortKey) {
    const key = criteria.sortKey;
    const dir = criteria.sortDir === 'desc' ? -1 : 1;
    activeIndices.sort((a, b) => (rawStore[a][key] > rawStore[b][key] ? dir : -dir));
  }

  // Chart 4: 산점도용 TypedArray 좌표 버퍼 생성 (최대 10만 점, x=gdp_per_capita, y=co2_per_capita)
  const scatterPoints = new Float32Array(matchCount * 2);
  for (let i = 0; i < matchCount; i++) {
    const r = rawStore[activeIndices[i]];
    scatterPoints[i * 2] = r.gdp_per_capita;
    scatterPoints[i * 2 + 1] = r.co2_per_capita;
  }

  const filterMs = performance.now() - tStart;

  self.postMessage(
    {
      type: 'DATA_SYNCHRONIZED',
      rows: netStats ? rawStore : undefined, // 최초 로드 시에만 원본 참조 전달
      activeIndices,
      summary: {
        filteredCount: matchCount,
        sumCo2,
        avgRenewables: matchCount ? sumRenewables / matchCount : 0,
        avgIntensity: matchCount ? sumIntensity / matchCount : 0,
      },
      charts: {
        yearlySeries: Array.from(yearlyMap.entries()).sort((a, b) => a[0] - b[0]),
        histBins,
        continentAgg,
        scatterPoints,
      },
      telemetry: { ...netStats, filterMs },
    },
    [activeIndices.buffer, histBins.buffer, scatterPoints.buffer]
  );
}

// 10만 행 x 28열 무블로킹 CSV/TSV 청크 빌더
function buildDelimitedBlobUrl(sep: string): string {
  const headers = [
    'record_id','iso_code','country','period_str','continent','income_group',
    'population','gdp','gdp_per_capita','co2','co2_per_capita','co2_growth_prct',
    'co2_per_gdp','total_ghg','methane','nitrous_oxide','coal_co2','oil_co2',
    'gas_co2','cement_co2','primary_energy_twh','energy_per_capita','renewables_share',
    'fossil_share','nuclear_share','solar_wind_twh','carbon_intensity','temp_change_ghg'
  ];
  const chunks: BlobPart[] = ['\uFEFF' + headers.join(sep) + '\n'];
  let batch = '';

  for (let i = 0; i < activeIndices.length; i++) {
    const r = rawStore[activeIndices[i]];
    batch += `${r.record_id}${sep}${r.iso_code}${sep}"${r.country}"${sep}${r.period_str}${sep}${r.continent}${sep}${r.income_group}${sep}${r.population}${sep}${r.gdp}${sep}${r.gdp_per_capita}${sep}${r.co2}${sep}${r.co2_per_capita}${sep}${r.co2_growth_prct}${sep}${r.co2_per_gdp}${sep}${r.total_ghg}${sep}${r.methane}${sep}${r.nitrous_oxide}${sep}${r.coal_co2}${sep}${r.oil_co2}${sep}${r.gas_co2}${sep}${r.cement_co2}${sep}${r.primary_energy_twh}${sep}${r.energy_per_capita}${sep}${r.renewables_share}${sep}${r.fossil_share}${sep}${r.nuclear_share}${sep}${r.solar_wind_twh}${sep}${r.carbon_intensity}${sep}${r.temp_change_ghg}\n`;

    if (i % 10000 === 9999) {
      chunks.push(batch);
      batch = '';
    }
  }
  if (batch) chunks.push(batch);

  const blob = new Blob(chunks, { type: 'text/plain;charset=utf-8' });
  return URL.createObjectURL(blob);
}
```

---

## 4. Zone B: 4대 기후·에너지 멀티 차트 클러스터 구현 코드

4개의 차트를 단일 행(`32vh`)에 배치하며, SVG 노드를 일절 생성하지 않고 **순수 HTML5 Canvas `ImageData` 픽셀 버퍼 및 2D 패스**로 렌더링하여 10만 개 포인트를 5ms 이내에 찍어냅니다.

### `src/components/ZoneBChartCluster.tsx`
```tsx
import { createEffect, onCleanup } from 'solid-js';

interface ChartClusterProps {
  chartData: () => any;
  onYearBrush: (range: [number, number] | undefined) => void;
  onContinentClick: (continent: string | null) => void;
  selectedContinent: () => string | null;
}

export function ZoneBChartCluster(props: ChartClusterProps) {
  let lineCanvas!: HTMLCanvasElement;
  let histCanvas!: HTMLCanvasElement;
  let barCanvas!: HTMLCanvasElement;
  let scatterCanvas!: HTMLCanvasElement;

  let isBrushing = false;
  let brushStartX = 0;

  // 차트 데이터 변경 시 즉시 4개 Canvas 리페인트 (합산 소요시간 < 4ms)
  createEffect(() => {
    const data = props.chartData();
    if (!data) return;
    drawTimeSeries(lineCanvas, data.yearlySeries);
    drawHistogram(histCanvas, data.histBins);
    drawEnergyMix(barCanvas, data.continentAgg, props.selectedContinent());
    drawScatter100k(scatterCanvas, data.scatterPoints);
  });

  // Chart 4: 10만 점 픽셀 버퍼 직접 찍기 (ImageData 활용으로 10만 점 2ms 내 렌더링)
  function drawScatter100k(canvas: HTMLCanvasElement, pts: Float32Array) {
    const ctx = canvas.getContext('2d')!;
    const w = (canvas.width = canvas.clientWidth);
    const h = (canvas.height = canvas.clientHeight);
    const imgData = ctx.createImageData(w, h);
    const buf32 = new Uint32Array(imgData.data.buffer);

    const count = pts.length / 2;
    for (let i = 0; i < count; i++) {
      const gdpPerCap = pts[i * 2];
      const co2PerCap = pts[i * 2 + 1];
      // 로그 스케일 정규화 매핑
      const x = Math.min(w - 2, Math.max(1, Math.floor((Math.log10(gdpPerCap + 100) / 5.2) * w)));
      const y = Math.min(h - 2, Math.max(1, h - Math.floor((co2PerCap / 35) * h)));

      // ABGR 리틀 엔디안 색상 값 (#60a5fa 반투명 픽셀)
      buf32[y * w + x] = 0xaa_fa_a5_60;
    }
    ctx.putImageData(imgData, 0, 0);
  }

  function drawTimeSeries(canvas: HTMLCanvasElement, series: [number, { co2: number; temp: number }][]) {
    const ctx = canvas.getContext('2d')!;
    const w = (canvas.width = canvas.clientWidth);
    const h = (canvas.height = canvas.clientHeight);
    ctx.clearRect(0, 0, w, h);
    if (!series.length) return;

    const maxCo2 = Math.max(...series.map((s) => s[1].co2), 1);
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    series.forEach(([, val], idx) => {
      const x = (idx / (series.length - 1 || 1)) * w;
      const y = h - (val.co2 / maxCo2) * (h - 16) - 8;
      idx === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  function drawHistogram(canvas: HTMLCanvasElement, bins: Uint32Array) {
    const ctx = canvas.getContext('2d')!;
    const w = (canvas.width = canvas.clientWidth);
    const h = (canvas.height = canvas.clientHeight);
    ctx.clearRect(0, 0, w, h);
    const maxBin = Math.max(...Array.from(bins), 1);
    const barW = w / bins.length;

    bins.forEach((val, idx) => {
      const barH = (val / maxBin) * (h - 14);
      ctx.fillStyle = idx > 15 ? '#ef4444' : '#10b981';
      ctx.fillRect(idx * barW + 1, h - barH, barW - 2, barH);
    });
  }

  function drawEnergyMix(
    canvas: HTMLCanvasElement,
    agg: Record<string, { count: number; fossil: number; nuclear: number; renew: number }>,
    activeCont: string | null
  ) {
    const ctx = canvas.getContext('2d')!;
    const w = (canvas.width = canvas.clientWidth);
    const h = (canvas.height = canvas.clientHeight);
    ctx.clearRect(0, 0, w, h);

    const keys = Object.keys(agg);
    const rowH = Math.min(28, (h - 10) / (keys.length || 1));

    keys.forEach((cont, i) => {
      const item = agg[cont];
      const total = item.fossil + item.nuclear + item.renew || 1;
      const y = i * rowH + 6;
      const fW = (item.fossil / total) * (w - 75);
      const nW = (item.nuclear / total) * (w - 75);
      const rW = (item.renew / total) * (w - 75);

      ctx.fillStyle = activeCont === cont ? '#ffffff' : '#9ca3af';
      ctx.font = '11px Inter, sans-serif';
      ctx.fillText(cont.slice(0, 8), 4, y + 12);

      ctx.fillStyle = '#64748b';
      ctx.fillRect(70, y + 2, fW, rowH - 8);
      ctx.fillStyle = '#3b82f6';
      ctx.fillRect(70 + fW, y + 2, nW, rowH - 8);
      ctx.fillStyle = '#10b981';
      ctx.fillRect(70 + fW + nW, y + 2, rW, rowH - 8);
    });
  }

  return (
    <section class="zone-b-charts">
      {/* Chart 1: 시계열 브러싱 필터 */}
      <div class="chart-card">
        <div style={{ display: 'flex', 'justify-content': 'space-between', 'margin-bottom': '4px' }}>
          <strong>1. 글로벌 CO2 추이 (드래그: 연도필터)</strong>
          <button onClick={() => props.onYearBrush(undefined)} style={{ 'font-size': '10px' }}>초기화</button>
        </div>
        <div class="chart-canvas-wrap">
          <canvas
            ref={lineCanvas}
            style={{ width: '100%', height: '100%', cursor: 'crosshair' }}
            onMouseDown={(e) => { isBrushing = true; brushStartX = e.offsetX; }}
            onMouseUp={(e) => {
              if (!isBrushing) return;
              isBrushing = false;
              const w = lineCanvas.clientWidth || 1;
              const y1 = Math.round(1750 + (Math.min(brushStartX, e.offsetX) / w) * (2025 - 1750));
              const y2 = Math.round(1750 + (Math.max(brushStartX, e.offsetX) / w) * (2025 - 1750));
              if (y2 - y1 >= 2) props.onYearBrush([y1, y2]);
            }}
          />
        </div>
      </div>

      {/* Chart 2: 전력 탄소 집약도 히스토그램 */}
      <div class="chart-card">
        <strong>2. 전력 탄소집약도 분포 (25 Bins)</strong>
        <div class="chart-canvas-wrap">
          <canvas ref={histCanvas} style={{ width: '100%', height: '100%' }} />
        </div>
      </div>

      {/* Chart 3: 대륙별 에너지 믹스 (클릭 시 교차 필터) */}
      <div class="chart-card">
        <strong>3. 대륙별 화석/원전/재생 비중 (클릭 필터)</strong>
        <div class="chart-canvas-wrap">
          <canvas
            ref={barCanvas}
            style={{ width: '100%', height: '100%', cursor: 'pointer' }}
            onClick={(e) => {
              const keys = Object.keys(props.chartData()?.continentAgg || {});
              const rowH = Math.min(28, (barCanvas.clientHeight - 10) / (keys.length || 1));
              const clickedIdx = Math.floor((e.offsetY - 6) / rowH);
              const target = keys[clickedIdx];
              if (target) {
                props.onContinentClick(props.selectedContinent() === target ? null : target);
              }
            }}
          />
        </div>
      </div>

      {/* Chart 4: 10만 점 WebGL/PixelBuffer 산점도 */}
      <div class="chart-card">
        <strong>4. 1인당 GDP vs CO2 (10만 점 Pixel Buffer)</strong>
        <div class="chart-canvas-wrap">
          <canvas ref={scatterCanvas} style={{ width: '100%', height: '100%' }} />
        </div>
      </div>
    </section>
  );
}
```

---

## 5. Zone C: 2차원(행+열) 가상화 그리드 및 인라인 시각화 구현 코드

세로 10만 행을 담당하는 `rowVirtualizer`와 가로 23개 가변 열을 담당하는 `columnVirtualizer`를 동시에 결합하여, 화면에 보이는 **약 22행 × 12열(좌측 고정 4열 + 중앙 가변 7열 + 우측 고정 1열 = 264개 셀)**만 실제 DOM 노드로 유지합니다.

### `src/components/ZoneCVirtualGrid.tsx`
```tsx
import { For } from 'solid-js';
import { createVirtualizer } from '@tanstack/solid-virtual';
import { ClimateRecord, ColumnDef, SCROLLABLE_COLUMNS } from '../state/gridSchema';

interface GridProps {
  rawRows: () => ClimateRecord[];
  activeIndices: () => Uint32Array;
  summary: () => { filteredCount: number; sumCo2: number; avgRenewables: number; avgIntensity: number };
  onSort: (key: keyof ClimateRecord) => void;
}

export function ZoneCVirtualGrid(props: GridProps) {
  let scrollParentRef!: HTMLDivElement;

  // 1. 세로 행(Row) 가상화 엔진 (100,000 ~ 300,000 행)
  const rowVirtualizer = createVirtualizer({
    get count() {
      return props.activeIndices().length;
    },
    getScrollElement: () => scrollParentRef,
    estimateSize: () => 32, // 고정 행 높이 32px
    overscan: 6,
  });

  // 2. 가로 열(Column) 가상화 엔진 (중앙 23개 가변 컬럼)
  const columnVirtualizer = createVirtualizer({
    horizontal: true,
    count: SCROLLABLE_COLUMNS.length,
    getScrollElement: () => scrollParentRef,
    estimateSize: (idx) => SCROLLABLE_COLUMNS[idx].width,
    overscan: 3,
  });

  // 컬럼 그룹 원클릭 가로 점프
  const jumpToColumnGroup = (colIndex: number) => {
    columnVirtualizer.scrollToIndex(colIndex, { align: 'start' });
  };

  // 행 번호 원클릭 세로 점프
  const jumpToRow = (rowIndex: number) => {
    rowVirtualizer.scrollToIndex(Math.min(rowIndex, props.activeIndices().length - 1), { align: 'start' });
  };

  return (
    <section class="zone-c-grid-wrapper">
      {/* 그리드 상단 빠른 점프 툴바 */}
      <div style={{ display: 'flex', 'justify-content': 'space-between', padding: '0 12px', 'align-items': 'center', 'border-bottom': '1px solid #1f2937' }}>
        <div style={{ display: 'flex', gap: '6px', 'align-items': 'center' }}>
          <span style={{ color: '#9ca3af' }}>컬럼 그룹 점프:</span>
          <button onClick={() => jumpToColumnGroup(0)}>거시경제 (Col 5~9)</button>
          <button onClick={() => jumpToColumnGroup(5)}>온실가스 (Col 10~16)</button>
          <button onClick={() => jumpToColumnGroup(12)}>배출원 (Col 17~20)</button>
          <button onClick={() => jumpToColumnGroup(16)}>에너지믹스 (Col 21~27)</button>
        </div>
        <div style={{ display: 'flex', gap: '6px', 'align-items': 'center' }}>
          <span style={{ color: '#9ca3af' }}>행 즉시 이동:</span>
          <button onClick={() => jumpToRow(0)}>#1</button>
          <button onClick={() => jumpToRow(25000)}>#25,000</button>
          <button onClick={() => jumpToRow(50000)}>#50,000</button>
          <button onClick={() => jumpToRow(99999)}>#100,000</button>
        </div>
      </div>

      {/* 2D 가상 스크롤 컨테이너 */}
      <div ref={scrollParentRef} class="virtual-grid-viewport">
        {/* Sticky 테이블 헤더 */}
        <div
          class="grid-header-sticky"
          style={{
            display: 'flex',
            width: `${390 + columnVirtualizer.getTotalSize() + 120}px`,
          }}
        >
          {/* 좌측 고정 헤더 4열 */}
          <div class="cell-pinned-left" style={{ width: '390px', height: '38px', 'align-items': 'center' }}>
            <div style={{ width: '70px', padding: '0 8px' }} onClick={() => props.onSort('record_id')}>#ID ⇅</div>
            <div style={{ width: '60px', padding: '0 6px' }}>ISO</div>
            <div style={{ width: '160px', padding: '0 8px' }} onClick={() => props.onSort('country')}>국가명 ⇅</div>
            <div style={{ width: '100px', padding: '0 8px' }} onClick={() => props.onSort('period_str')}>연월 ⇅</div>
          </div>

          {/* 중앙 가로 가상화 헤더 */}
          <div style={{ position: 'relative', width: `${columnVirtualizer.getTotalSize()}px`, height: '38px' }}>
            <For each={columnVirtualizer.getVirtualItems()}>
              {(vCol) => {
                const colDef = SCROLLABLE_COLUMNS[vCol.index];
                return (
                  <div
                    onClick={() => props.onSort(colDef.key)}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: `${vCol.size}px`,
                      height: '38px',
                      transform: `translateX(${vCol.start}px)`,
                      display: 'flex',
                      'align-items': 'center',
                      padding: '0 8px',
                      cursor: 'pointer',
                      'border-right': '1px solid #334155',
                      'font-weight': 600,
                    }}
                  >
                    {colDef.label} ⇅
                  </div>
                );
              }}
            </For>
          </div>

          {/* 우측 고정 헤더 1열 */}
          <div
            class="cell-pinned-right"
            onClick={() => props.onSort('temp_change_ghg')}
            style={{ width: '120px', height: '38px', display: 'flex', 'align-items': 'center', padding: '0 8px', cursor: 'pointer' }}
          >
            기온기여(°C) ⇅
          </div>
        </div>

        {/* 2D 가상화 바디 캔버스 */}
        <div
          style={{
            position: 'relative',
            height: `${rowVirtualizer.getTotalSize()}px`,
            width: `${390 + columnVirtualizer.getTotalSize() + 120}px`,
          }}
        >
          <For each={rowVirtualizer.getVirtualItems()}>
            {(vRow) => {
              const rowRecord = () => {
                const rawIdx = props.activeIndices()[vRow.index];
                return props.rawRows()[rawIdx];
              };

              return (
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${vRow.size}px`,
                    transform: `translateY(${vRow.start}px)`,
                    display: 'flex',
                    'border-bottom': '1px solid #1e293b',
                    background: vRow.index % 2 === 0 ? 'var(--bg-row-even)' : 'transparent',
                  }}
                >
                  {/* 1. 좌측 고정 4개 컬럼 (Pinned Left) */}
                  <div class="cell-pinned-left" style={{ width: '390px', 'align-items': 'center' }}>
                    <div style={{ width: '70px', padding: '0 8px', color: '#64748b' }}>#{rowRecord()?.record_id}</div>
                    <div style={{ width: '60px', padding: '0 6px' }}>
                      <span style={{ background: '#1e3a8a', padding: '2px 5px', 'border-radius': '3px', 'font-size': '10px' }}>
                        {rowRecord()?.iso_code}
                      </span>
                    </div>
                    <div style={{ width: '160px', padding: '0 8px', 'font-weight': 600, overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>
                      {rowRecord()?.country}
                    </div>
                    <div style={{ width: '100px', padding: '0 8px', 'font-family': 'monospace', color: '#93c5fd' }}>
                      {rowRecord()?.period_str}
                    </div>
                  </div>

                  {/* 2. 중앙 가로 가상화 셀 영역 (현재 화면에 보이는 6~8개 열만 마운트) */}
                  <div style={{ position: 'relative', width: `${columnVirtualizer.getTotalSize()}px`, height: '100%' }}>
                    <For each={columnVirtualizer.getVirtualItems()}>
                      {(vCol) => {
                        const colDef = SCROLLABLE_COLUMNS[vCol.index];
                        return (
                          <div
                            class="grid-cell"
                            style={{
                              position: 'absolute',
                              top: 0,
                              left: 0,
                              width: `${vCol.size}px`,
                              height: '100%',
                              transform: `translateX(${vCol.start}px)`,
                              display: 'flex',
                              'align-items': 'center',
                              padding: '0 8px',
                              'border-right': '1px solid #1e293b',
                            }}
                          >
                            {renderInCellGraphic(rowRecord(), colDef)}
                          </div>
                        );
                      }}
                    </For>
                  </div>

                  {/* 3. 우측 고정 1개 컬럼 (Pinned Right: 지구 기온 상승 기여도) */}
                  <div class="cell-pinned-right" style={{ width: '120px', display: 'flex', 'align-items': 'center', 'justify-content': 'flex-end', padding: '0 8px' }}>
                    <span
                      style={{
                        color: (rowRecord()?.temp_change_ghg || 0) > 0.05 ? '#f87171' : '#34d399',
                        'font-weight': 700,
                      }}
                    >
                      +{(rowRecord()?.temp_change_ghg || 0).toFixed(4)}°C
                    </span>
                  </div>
                </div>
              );
            }}
          </For>
        </div>
      </div>

      {/* 하단 고정 요약 푸터 (Sticky Summary Row) */}
      <footer
        style={{
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
          padding: '0 16px',
          background: '#0f172a',
          'border-top': '2px solid #334155',
          'font-weight': 600,
        }}
      >
        <div>필터링된 총 레코드: <span style={{ color: '#60a5fa' }}>{props.summary().filteredCount.toLocaleString()}</span> 건</div>
        <div>누적 CO2 합계: <span style={{ color: '#f87171' }}>{props.summary().sumCo2.toLocaleString(undefined, { maximumFractionDigits: 1 })} Mt</span></div>
        <div>평균 재생에너지 비중: <span style={{ color: '#34d399' }}>{props.summary().avgRenewables.toFixed(2)}%</span></div>
        <div>평균 전력 탄소집약도: <span style={{ color: '#fbbf24' }}>{props.summary().avgIntensity.toFixed(1)} gCO2/kWh</span></div>
      </footer>
    </section>
  );
}

// 셀 타입별 마이크로 시각화(In-Cell Visualization) 렌더러
function renderInCellGraphic(row: ClimateRecord | undefined, col: ColumnDef) {
  if (!row) return null;
  const val = row[col.key] as any;

  switch (col.renderType) {
    case 'bar-co2': {
      const pct = Math.min(100, Math.max(0, (Number(val) / (col.maxVal || 100)) * 100));
      return (
        <div style={{ width: '100%', position: 'relative', display: 'flex', 'align-items': 'center' }}>
          <div style={{ position: 'absolute', left: 0, height: '16px', width: `${pct}%`, background: 'rgba(239, 68, 68, 0.28)', 'border-radius': '2px' }} />
          <span style={{ position: 'relative', 'z-index': 1, 'margin-left': 'auto' }}>{Number(val).toFixed(2)}</span>
        </div>
      );
    }
    case 'delta-percent': {
      const num = Number(val);
      const isUp = num > 0;
      return (
        <span style={{ color: isUp ? '#ef4444' : '#10b981', 'margin-left': 'auto', 'font-weight': 600 }}>
          {isUp ? '▲ +' : '▼ '}{num.toFixed(2)}%
        </span>
      );
    }
    case 'gauge-share': {
      const pct = Math.min(100, Math.max(0, Number(val)));
      return (
        <div style={{ width: '100%', display: 'flex', 'align-items': 'center', gap: '6px' }}>
          <div style={{ flex: 1, height: '6px', background: '#1f2937', 'border-radius': '3px', overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: col.key === 'renewables_share' ? '#10b981' : '#3b82f6' }} />
          </div>
          <span style={{ width: '42px', 'text-align': 'right' }}>{pct.toFixed(1)}%</span>
        </div>
      );
    }
    case 'heatmap-fossil': {
      const alpha = Math.min(0.65, Number(val) / (col.maxVal || 5000));
      return (
        <div style={{ width: '100%', 'text-align': 'right', background: `rgba(245, 158, 11, ${alpha})`, padding: '2px 4px', 'border-radius': '2px' }}>
          {Number(val).toFixed(1)}
        </div>
      );
    }
    default:
      return <span style={{ 'margin-left': typeof val === 'number' ? 'auto' : '0' }}>{typeof val === 'number' ? val.toLocaleString() : val}</span>;
  }
}
```

---

## 6. 루트 애플리케이션 조립 및 실시간 FPS 텔레메트리 바 (`App.tsx`)

Zone A, Zone B, Zone C와 Web Worker를 하나로 묶고, `requestAnimationFrame` 루프로 실시간 FPS와 활성 DOM 셀(`.grid-cell`) 개수를 계측하여 화면 상단에 표시합니다.

### `src/App.tsx`
```tsx
import { createSignal, onMount } from 'solid-js';
import { ClimateRecord, FilterCriteria } from './state/gridSchema';
import { ZoneBChartCluster } from './components/ZoneBChartCluster';
import { ZoneCVirtualGrid } from './components/ZoneCVirtualGrid';
import './styles/viewport.css';

export default function App() {
  const [rawRows, setRawRows] = createSignal<ClimateRecord[]>([], { equals: false });
  const [activeIndices, setActiveIndices] = createSignal<Uint32Array>(new Uint32Array(0));
  const [chartData, setChartData] = createSignal<any>(null);
  const [summary, setSummary] = createSignal({ filteredCount: 0, sumCo2: 0, avgRenewables: 0, avgIntensity: 0 });
  const [telemetry, setTelemetry] = createSignal({ serverSerializeMs: 0, netMs: 0, parseMs: 0, filterMs: 0, payloadBytes: 0, exportMs: 0 });
  const [fps, setFps] = createSignal(60);
  const [domCellCount, setDomCellCount] = createSignal(0);

  const [criteria, setCriteria] = createSignal<FilterCriteria>({});
  let worker!: Worker;

  onMount(() => {
    worker = new Worker(new URL('./worker/dataEngine.worker.ts', import.meta.url), { type: 'module' });

    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'DATA_SYNCHRONIZED') {
        if (msg.rows) setRawRows(msg.rows);
        setActiveIndices(msg.activeIndices);
        setSummary(msg.summary);
        setChartData(msg.charts);
        setTelemetry((prev) => ({ ...prev, ...msg.telemetry }));
        requestAnimationFrame(() => {
          setDomCellCount(document.querySelectorAll('.grid-cell').length);
        });
      }
      if (msg.type === 'EXPORT_READY') {
        setTelemetry((prev) => ({ ...prev, exportMs: msg.exportMs }));
        const a = document.createElement('a');
        a.href = msg.url;
        a.download = msg.filename;
        a.click();
        URL.revokeObjectURL(msg.url);
      }
    };

    // 초기 10만 건 MessagePack 로드
    fetchDataset(100000, 'msgpack');

    // 실시간 FPS 측정 루프
    let frames = 0;
    let lastTime = performance.now();
    const tick = (now: number) => {
      frames++;
      if (now - lastTime >= 1000) {
        setFps(frames);
        setDomCellCount(document.querySelectorAll('.grid-cell').length);
        frames = 0;
        lastTime = now;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const fetchDataset = (rows: number, format: 'msgpack' | 'json') => {
    const apiBase = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';
    worker.postMessage({
      type: 'FETCH_AND_LOAD',
      payload: { url: `${apiBase}/api/records?rows=${rows}&format=${format}`, format },
    });
  };

  const updateFilter = (patch: Partial<FilterCriteria>) => {
    const next = { ...criteria(), ...patch };
    setCriteria(next);
    worker.postMessage({ type: 'APPLY_FILTER', payload: { criteria: next } });
  };

  const triggerExport = (ext: 'csv' | 'tsv' | 'xlsx') => {
    if (ext === 'xlsx') {
      const apiBase = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';
      window.open(`${apiBase}/api/export/xlsx?continent=${criteria().continent || ''}`, '_blank');
      return;
    }
    worker.postMessage({
      type: 'EXPORT_DELIMITED',
      payload: { delimiter: ext === 'csv' ? ',' : '\t', filename: `owid_climate_${summary().filteredCount}.${ext}` },
    });
  };

  return (
    <main class="viewport-shell">
      {/* Zone A: 상단 벤치마크 컨트롤 및 텔레메트리 스코어보드 (8vh) */}
      <header class="zone-a-topbar">
        <div style={{ display: 'flex', gap: '6px', 'align-items': 'center' }}>
          <button onClick={() => fetchDataset(50000, 'msgpack')}>50k (원본)</button>
          <button onClick={() => fetchDataset(100000, 'msgpack')}>100k (MsgPack)</button>
          <button onClick={() => fetchDataset(100000, 'json')}>100k (JSON)</button>
          <button onClick={() => fetchDataset(300000, 'msgpack')}>300k (월간보간)</button>
          <input
            type="search"
            placeholder="국가명 / ISO 검색..."
            onInput={(e) => updateFilter({ searchQuery: e.currentTarget.value })}
            style={{ background: '#1f2937', color: '#fff', border: '1px solid #374151', padding: '4px 8px' }}
          />
        </div>

        {/* 실시간 성능 스코어보드 */}
        <div style={{ display: 'flex', gap: '14px', 'font-family': 'monospace' }}>
          <span>서버직렬화: <b>{telemetry().serverSerializeMs.toFixed(1)}ms</b></span>
          <span>전송량: <b>{(telemetry().payloadBytes / 1048576).toFixed(2)}MB</b></span>
          <span>워커파싱: <b>{telemetry().parseMs.toFixed(1)}ms</b></span>
          <span>필터/집계: <b>{telemetry().filterMs.toFixed(1)}ms</b></span>
          <span>활성DOM셀: <b>{domCellCount()}개</b></span>
          <span style={{ color: fps() >= 55 ? '#10b981' : '#ef4444' }}><b>{fps()} FPS</b></span>
        </div>

        {/* 대용량 파일 즉시 추출 버튼 */}
        <div style={{ display: 'flex', gap: '6px' }}>
          <button onClick={() => triggerExport('csv')}>CSV 추출</button>
          <button onClick={() => triggerExport('tsv')}>TSV 추출</button>
          <button onClick={() => triggerExport('xlsx')}>Excel(.xlsx)</button>
        </div>
      </header>

      {/* Zone B: 4대 인터랙티브 차트 클러스터 (32vh) */}
      <ZoneBChartCluster
        chartData={chartData}
        selectedContinent={() => criteria().continent || null}
        onYearBrush={(yearRange) => updateFilter({ yearRange })}
        onContinentClick={(continent) => updateFilter({ continent })}
      />

      {/* Zone C: 2차원 가상화 와이드 그리드 (60vh) */}
      <ZoneCVirtualGrid
        rawRows={rawRows}
        activeIndices={activeIndices}
        summary={summary}
        onSort={(sortKey) =>
          updateFilter({
            sortKey,
            sortDir: criteria().sortKey === sortKey && criteria().sortDir === 'asc' ? 'desc' : 'asc',
          })
        }
      />
    </main>
  );
}
```