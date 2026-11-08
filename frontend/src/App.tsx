import { createSignal, onCleanup, onMount, For, Show } from 'solid-js';
import type { ChartData, FilterCriteria, Summary } from './state/gridSchema';
import type { Columns } from './state/columns';
import { ZoneBChartCluster } from './components/ZoneBChartCluster';
import { ZoneCVirtualGrid } from './components/ZoneCVirtualGrid';
import { dropTicket, getTicket } from './turnstile';
import './styles/viewport.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';

type Format = 'msgpack' | 'json';
const DATASETS: { rows: number; format: Format; label: string }[] = [
  { rows: 50000, format: 'msgpack', label: '50k (반기)' },
  { rows: 100000, format: 'msgpack', label: '100k (분기·MsgPack)' },
  { rows: 100000, format: 'json', label: '100k (분기·JSON)' },
  { rows: 300000, format: 'msgpack', label: '300k (월간)' },
];

export default function App() {
  const [columns, setColumns] = createSignal<Columns | null>(null);
  const [activeIndices, setActiveIndices] = createSignal<Uint32Array>(new Uint32Array(0));
  const [chartData, setChartData] = createSignal<ChartData | null>(null);
  const [summary, setSummary] = createSignal<Summary>({ filteredCount: 0, sumCo2: 0, avgRenewables: 0, avgIntensity: 0 });
  const [telemetry, setTelemetry] = createSignal({ authMs: 0, serverSerializeMs: 0, netMs: 0, parseMs: 0, filterMs: 0, payloadBytes: 0, exportMs: 0, exportBytes: 0 });
  const [fps, setFps] = createSignal(60);
  const [domCellCount, setDomCellCount] = createSignal(0);
  const [loading, setLoading] = createSignal('');
  const [error, setError] = createSignal('');
  const [dataset, setDataset] = createSignal(1);
  // '#table' = table-only screen (charts hidden, grid takes the full height)
  const [tableOnly, setTableOnly] = createSignal(location.hash === '#table');
  const onHash = () => setTableOnly(location.hash === '#table');
  window.addEventListener('hashchange', onHash);
  onCleanup(() => window.removeEventListener('hashchange', onHash));

  const [criteria, setCriteria] = createSignal<FilterCriteria>({});
  const worker = new Worker(new URL('./worker/dataEngine.worker.ts', import.meta.url), { type: 'module' });

  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'DATA_SYNCHRONIZED') {
      if (msg.columns) setColumns(msg.columns);
      setActiveIndices(msg.activeIndices);
      setSummary(msg.summary);
      setChartData(msg.charts);
      setTelemetry((prev) => ({ ...prev, ...msg.telemetry }));
      setLoading('');
      setError('');
      retried = false;
      requestAnimationFrame(() => setDomCellCount(document.querySelectorAll('.grid-cell').length));
    }
    if (msg.type === 'EXPORT_READY') {
      setTelemetry((prev) => ({ ...prev, exportMs: msg.exportMs, exportBytes: msg.bytes }));
      setLoading('');
      const a = document.createElement('a');
      a.href = msg.url;
      a.download = msg.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(msg.url), 10_000); // immediate revoke can cancel the download
    }
    if (msg.type === 'ERROR') {
      // 401 = ticket unknown to the server (e.g. instance restarted): re-check once
      if (String(msg.message).includes('401') && !retried) {
        retried = true;
        dropTicket();
        fetchDataset(dataset());
        return;
      }
      setLoading('');
      setError(`데이터 로드 실패: ${msg.message} (백엔드 ${API_BASE} 실행 여부 확인)`);
    }
  };
  onCleanup(() => worker.terminate());

  let retried = false;
  const fetchDataset = async (idx: number) => {
    const { rows, format } = DATASETS[idx];
    setDataset(idx);
    setLoading('사람 확인 중...');
    let ticket: string;
    try {
      const t0 = performance.now();
      ticket = await getTicket();
      setTelemetry((prev) => ({ ...prev, authMs: performance.now() - t0 }));
    } catch (err) {
      setLoading('');
      setError(String(err));
      return;
    }
    setLoading(`${rows.toLocaleString()}건 ${format} 로딩 중...`);
    worker.postMessage({
      type: 'FETCH_AND_LOAD',
      payload: { url: `${API_BASE}/api/records?rows=${rows}&format=${format}&ticket=${ticket}`, format, criteria: criteria() },
    });
  };

  const updateFilter = (patch: Partial<FilterCriteria>) => {
    const next = { ...criteria(), ...patch };
    setCriteria(next);
    worker.postMessage({ type: 'APPLY_FILTER', payload: { criteria: next } });
  };

  const triggerExport = (ext: 'csv' | 'tsv' | 'xlsx') => {
    if (ext === 'xlsx') {
      getTicket().then(
        (ticket) => {
          // attachment response: the browser downloads it without leaving the page
          const a = document.createElement('a');
          a.href = `${API_BASE}/api/export/xlsx?continent=${encodeURIComponent(criteria().continent || '')}&ticket=${ticket}`;
          a.click();
        },
        (err) => setError(String(err))
      );
      return;
    }
    setLoading(`${ext.toUpperCase()} 생성 중...`);
    worker.postMessage({
      type: 'EXPORT_DELIMITED',
      payload: { delimiter: ext === 'csv' ? ',' : '\t', filename: `owid_climate_${summary().filteredCount}.${ext}` },
    });
  };

  onMount(() => {
    fetchDataset(1);

    let frames = 0;
    let lastTime = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      frames++;
      if (now - lastTime >= 1000) {
        setFps(frames);
        setDomCellCount(document.querySelectorAll('.grid-cell').length);
        frames = 0;
        lastTime = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    onCleanup(() => cancelAnimationFrame(raf));
  });

  const mb = (b: number) => (b / 1048576).toFixed(2);

  return (
    <main class="viewport-shell" classList={{ 'table-only': tableOnly() }}>
      {/* Zone A */}
      <header class="zone-a-topbar">
        <div style={{ display: 'flex', gap: '6px', 'align-items': 'center' }}>
          <button onClick={() => (location.hash = tableOnly() ? '' : 'table')}>
            {tableOnly() ? '◧ 대시보드' : '▤ 테이블 전용'}
          </button>
          <For each={DATASETS}>
            {(d, i) => (
              <button classList={{ active: dataset() === i() }} onClick={() => fetchDataset(i())}>
                {d.label}
              </button>
            )}
          </For>
          <input
            type="search"
            placeholder="국가명 / ISO 검색..."
            onInput={(e) => updateFilter({ searchQuery: e.currentTarget.value })}
            style={{ background: '#1f2937', color: '#fff', border: '1px solid #374151', padding: '4px 8px', width: '150px' }}
          />
        </div>

        <div style={{ display: 'flex', gap: '14px', 'font-family': 'monospace', 'white-space': 'nowrap' }}>
          <Show when={error() || loading()} fallback={
            <>
              <span>인증: <b>{telemetry().authMs.toFixed(0)}ms</b></span>
              <span>서버직렬화: <b>{telemetry().serverSerializeMs.toFixed(1)}ms</b></span>
              <span>전송량: <b>{mb(telemetry().payloadBytes)}MB</b></span>
              <span>네트워크: <b>{telemetry().netMs.toFixed(0)}ms</b></span>
              <span>워커파싱: <b>{telemetry().parseMs.toFixed(1)}ms</b></span>
              <span>필터/집계: <b>{telemetry().filterMs.toFixed(1)}ms</b></span>
              <Show when={telemetry().exportMs}>
                <span>추출: <b>{telemetry().exportMs.toFixed(0)}ms | {mb(telemetry().exportBytes)}MB</b></span>
              </Show>
            </>
          }>
            <span style={{ color: error() ? '#f87171' : '#fbbf24' }}>{error() || loading()}</span>
          </Show>
          <span>활성DOM셀: <b style={{ color: domCellCount() < 350 ? '#10b981' : '#ef4444' }}>{domCellCount()}개</b></span>
          <span style={{ color: fps() >= 55 ? '#10b981' : '#ef4444' }}><b>{fps()} FPS</b></span>
        </div>

        <div style={{ display: 'flex', gap: '6px' }}>
          <button onClick={() => triggerExport('csv')}>CSV 추출</button>
          <button onClick={() => triggerExport('tsv')}>TSV 추출</button>
          <button onClick={() => triggerExport('xlsx')}>Excel(.xlsx)</button>
        </div>
      </header>

      {/* Zone B (dashboard only) */}
      <Show when={!tableOnly()}>
        <ZoneBChartCluster
          chartData={chartData}
          selectedContinent={() => criteria().continent || null}
          onYearBrush={(yearRange) => updateFilter({ yearRange })}
          onContinentClick={(continent) => updateFilter({ continent })}
        />
      </Show>

      {/* Zone C */}
      <ZoneCVirtualGrid
        columns={columns}
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
