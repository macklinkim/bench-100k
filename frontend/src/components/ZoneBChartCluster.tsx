import { createEffect } from 'solid-js';
import type { ChartData, ContinentAgg } from '../state/gridSchema';

const YEAR_MIN = 1750;
const YEAR_MAX = 2025;

interface ChartClusterProps {
  chartData: () => ChartData | null;
  onYearBrush: (range: [number, number] | undefined) => void;
  onContinentClick: (continent: string | null) => void;
  selectedContinent: () => string | null;
}

function sizeCanvas(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')!;
  const w = (canvas.width = canvas.clientWidth);
  const h = (canvas.height = canvas.clientHeight);
  return { ctx, w, h };
}

export function ZoneBChartCluster(props: ChartClusterProps) {
  let lineCanvas!: HTMLCanvasElement;
  let histCanvas!: HTMLCanvasElement;
  let barCanvas!: HTMLCanvasElement;
  let scatterCanvas!: HTMLCanvasElement;

  let isBrushing = false;
  let brushStartX = 0;

  createEffect(() => {
    const data = props.chartData();
    if (!data) return;
    drawTimeSeries(lineCanvas, data.yearlySeries);
    drawHistogram(histCanvas, data.histBins);
    drawEnergyMix(barCanvas, data.continentAgg, props.selectedContinent());
    drawScatter(scatterCanvas, data.scatterPoints);
  });

  // Chart 4: write pixels straight into an ImageData buffer
  function drawScatter(canvas: HTMLCanvasElement, pts: Float32Array) {
    const { ctx, w, h } = sizeCanvas(canvas);
    if (!w || !h) return;
    const imgData = ctx.createImageData(w, h);
    const buf32 = new Uint32Array(imgData.data.buffer);

    const count = pts.length / 2;
    for (let i = 0; i < count; i++) {
      // log-scale x (gdp per capita), linear y (co2 per capita, 0~35t)
      const x = Math.min(w - 2, Math.max(1, Math.floor((Math.log10(pts[i * 2] + 100) / 5.2) * w)));
      const y = Math.min(h - 2, Math.max(1, h - Math.floor((pts[i * 2 + 1] / 35) * h)));
      buf32[y * w + x] = 0xaa_fa_a5_60; // ABGR little-endian = #60a5fa, alpha 0xaa
    }
    ctx.putImageData(imgData, 0, 0);
  }

  // x axis is the fixed YEAR_MIN..YEAR_MAX range so the brush maps 1:1 to years
  function drawTimeSeries(canvas: HTMLCanvasElement, series: ChartData['yearlySeries']) {
    const { ctx, w, h } = sizeCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    if (!series.length) return;

    const xOf = (year: number) => ((year - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * w;
    let maxCo2 = 1;
    for (const [, v] of series) if (v.co2 > maxCo2) maxCo2 = v.co2;

    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    series.forEach(([year, val], idx) => {
      const x = xOf(year);
      const y = h - (val.co2 / maxCo2) * (h - 16) - 8;
      idx === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = '#6b7280';
    ctx.font = '10px monospace';
    for (const yr of [1800, 1900, 2000]) ctx.fillText(String(yr), xOf(yr) - 12, h - 1);
  }

  function drawHistogram(canvas: HTMLCanvasElement, bins: Uint32Array) {
    const { ctx, w, h } = sizeCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    let maxBin = 1;
    for (const v of bins) if (v > maxBin) maxBin = v;
    const barW = w / bins.length;

    bins.forEach((val, idx) => {
      const barH = (val / maxBin) * (h - 14);
      ctx.fillStyle = idx > 15 ? '#ef4444' : '#10b981';
      ctx.fillRect(idx * barW + 1, h - barH, barW - 2, barH);
    });
  }

  function drawEnergyMix(canvas: HTMLCanvasElement, agg: ContinentAgg, activeCont: string | null) {
    const { ctx, w, h } = sizeCanvas(canvas);
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
      <div class="chart-card">
        <div style={{ display: 'flex', 'justify-content': 'space-between', 'margin-bottom': '4px' }}>
          <strong>1. 글로벌 CO2 추이 (드래그: 연도필터)</strong>
          <button onClick={() => props.onYearBrush(undefined)} style={{ 'font-size': '10px' }}>초기화</button>
        </div>
        <div class="chart-canvas-wrap">
          <canvas
            ref={lineCanvas}
            style={{ cursor: 'crosshair' }}
            onMouseDown={(e) => { isBrushing = true; brushStartX = e.offsetX; }}
            onMouseUp={(e) => {
              if (!isBrushing) return;
              isBrushing = false;
              const w = lineCanvas.clientWidth || 1;
              const toYear = (x: number) => Math.round(YEAR_MIN + (x / w) * (YEAR_MAX - YEAR_MIN));
              const y1 = toYear(Math.min(brushStartX, e.offsetX));
              const y2 = toYear(Math.max(brushStartX, e.offsetX));
              if (y2 - y1 >= 2) props.onYearBrush([y1, y2]);
            }}
            onMouseLeave={() => { isBrushing = false; }}
          />
        </div>
      </div>

      <div class="chart-card">
        <strong>2. 전력 탄소집약도 분포 (25 Bins)</strong>
        <div class="chart-canvas-wrap">
          <canvas ref={histCanvas} />
        </div>
      </div>

      <div class="chart-card">
        <strong>3. 대륙별 화석/원전/재생 비중 (클릭 필터)</strong>
        <div class="chart-canvas-wrap">
          <canvas
            ref={barCanvas}
            style={{ cursor: 'pointer' }}
            onClick={(e) => {
              const keys = Object.keys(props.chartData()?.continentAgg || {});
              const rowH = Math.min(28, (barCanvas.clientHeight - 10) / (keys.length || 1));
              const target = keys[Math.floor((e.offsetY - 6) / rowH)];
              if (target) props.onContinentClick(props.selectedContinent() === target ? null : target);
            }}
          />
        </div>
      </div>

      <div class="chart-card">
        <strong>4. 1인당 GDP vs CO2 (Pixel Buffer 산점도)</strong>
        <div class="chart-canvas-wrap">
          <canvas ref={scatterCanvas} />
        </div>
      </div>
    </section>
  );
}
