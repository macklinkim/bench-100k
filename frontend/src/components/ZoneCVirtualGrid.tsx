import { Index, createMemo } from 'solid-js';
import { createVirtualizer, observeElementRect } from '@tanstack/solid-virtual';
import { SCROLLABLE_COLUMNS } from '../state/gridSchema';
import type { ClimateRecord, ColumnDef, Summary } from '../state/gridSchema';
import { rowAt } from '../state/columns';
import type { Columns } from '../state/columns';

const PIN_LEFT = 390;
const PIN_RIGHT = 120;
const HEADER_H = 38;

interface GridProps {
  columns: () => Columns | null;
  activeIndices: () => Uint32Array;
  summary: () => Summary;
  onSort: (key: keyof ClimateRecord) => void;
}

export function ZoneCVirtualGrid(props: GridProps) {
  let scrollParentRef!: HTMLDivElement;

  // Rows. Overscan kept small so .grid-cell stays < 350 at 1080p.
  const rowVirtualizer = createVirtualizer({
    get count() {
      return props.activeIndices().length;
    },
    getScrollElement: () => scrollParentRef,
    estimateSize: () => 32,
    overscan: 2,
    // sticky header covers the top HEADER_H px
    observeElementRect: (inst, cb) => observeElementRect(inst, (r) => cb({ width: r.width, height: Math.max(0, r.height - HEADER_H) })),
  });

  // Center columns. Pinned sides cover PIN_LEFT + PIN_RIGHT px of the viewport,
  // so report only the real center width to avoid mounting hidden columns.
  const columnVirtualizer = createVirtualizer({
    horizontal: true,
    count: SCROLLABLE_COLUMNS.length,
    getScrollElement: () => scrollParentRef,
    estimateSize: (idx) => SCROLLABLE_COLUMNS[idx].width,
    overscan: 1,
    observeElementRect: (inst, cb) =>
      observeElementRect(inst, (r) => cb({ width: Math.max(0, r.width - PIN_LEFT - PIN_RIGHT), height: r.height })),
  });

  const totalWidth = () => PIN_LEFT + columnVirtualizer.getTotalSize() + PIN_RIGHT;
  const jumpToColumnGroup = (colIndex: number) => columnVirtualizer.scrollToIndex(colIndex, { align: 'start' });
  const jumpToRow = (rowIndex: number) =>
    rowVirtualizer.scrollToIndex(Math.max(0, Math.min(rowIndex, props.activeIndices().length - 1)), { align: 'start' });

  return (
    <section class="zone-c-grid-wrapper">
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

      <div ref={scrollParentRef} class="virtual-grid-viewport">
        {/* sticky header */}
        <div class="grid-header-sticky" style={{ display: 'flex', width: `${totalWidth()}px` }}>
          <div class="cell-pinned-left" style={{ width: `${PIN_LEFT}px`, height: `${HEADER_H}px`, 'align-items': 'center', background: '#1e293b', cursor: 'pointer', 'font-weight': 600 }}>
            <div style={{ width: '70px', padding: '0 8px' }} onClick={() => props.onSort('record_id')}>#ID ⇅</div>
            <div style={{ width: '60px', padding: '0 6px' }}>ISO</div>
            <div style={{ width: '160px', padding: '0 8px' }} onClick={() => props.onSort('country')}>국가명 ⇅</div>
            <div style={{ width: '100px', padding: '0 8px' }} onClick={() => props.onSort('period_str')}>연월 ⇅</div>
          </div>

          <div style={{ position: 'relative', width: `${columnVirtualizer.getTotalSize()}px`, height: `${HEADER_H}px` }}>
            <Index each={columnVirtualizer.getVirtualItems()}>
              {(vCol) => (
                <div
                  onClick={() => props.onSort(SCROLLABLE_COLUMNS[vCol().index].key)}
                  style={{
                    position: 'absolute', top: 0, left: 0,
                    width: `${vCol().size}px`, height: `${HEADER_H}px`,
                    transform: `translateX(${vCol().start}px)`,
                    display: 'flex', 'align-items': 'center', padding: '0 8px',
                    cursor: 'pointer', 'border-right': '1px solid #334155', 'font-weight': 600,
                    'white-space': 'nowrap', overflow: 'hidden',
                  }}
                >
                  {SCROLLABLE_COLUMNS[vCol().index].label} ⇅
                </div>
              )}
            </Index>
          </div>

          <div
            class="cell-pinned-right"
            onClick={() => props.onSort('temp_change_ghg')}
            style={{ width: `${PIN_RIGHT}px`, height: `${HEADER_H}px`, display: 'flex', 'align-items': 'center', padding: '0 8px', cursor: 'pointer', background: '#1e293b', 'font-weight': 600 }}
          >
            기온기여(°C) ⇅
          </div>
        </div>

        {/* body: Index reuses row/cell DOM nodes while scrolling instead of re-creating them */}
        <div style={{ position: 'relative', height: `${rowVirtualizer.getTotalSize()}px`, width: `${totalWidth()}px` }}>
          <Index each={rowVirtualizer.getVirtualItems()}>
            {(vRow) => {
              // build only this visible row's object, once per change (not per cell)
              const rec = createMemo(() => {
                const c = props.columns();
                const raw = props.activeIndices()[vRow().index];
                return c && raw !== undefined ? rowAt(c, raw) : undefined;
              });
              return (
                <div
                  style={{
                    position: 'absolute', top: 0, left: 0, width: '100%',
                    height: `${vRow().size}px`,
                    transform: `translateY(${vRow().start}px)`,
                    display: 'flex', 'border-bottom': '1px solid #1e293b',
                    background: vRow().index % 2 === 0 ? 'var(--bg-row-even)' : 'var(--bg-panel)',
                  }}
                >
                  <div class="cell-pinned-left" style={{ width: `${PIN_LEFT}px`, 'align-items': 'center', background: 'inherit' }}>
                    <div style={{ width: '70px', padding: '0 8px', color: '#64748b', 'font-family': 'monospace' }}>
                      #{String(rec()?.record_id ?? '').padStart(6, '0')}
                    </div>
                    <div style={{ width: '60px', padding: '0 6px' }}>
                      <span style={{ background: '#1e3a8a', padding: '2px 5px', 'border-radius': '3px', 'font-size': '10px' }}>{rec()?.iso_code}</span>
                    </div>
                    <div title={rec()?.country} style={{ width: '160px', padding: '0 8px', 'font-weight': 600, overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>
                      {rec()?.country}
                    </div>
                    <div style={{ width: '100px', padding: '0 8px', 'font-family': 'monospace', color: '#93c5fd' }}>{rec()?.period_str}</div>
                  </div>

                  <div style={{ position: 'relative', width: `${columnVirtualizer.getTotalSize()}px`, height: '100%' }}>
                    <Index each={columnVirtualizer.getVirtualItems()}>
                      {(vCol) => (
                        <div
                          class="grid-cell"
                          style={{
                            position: 'absolute', top: 0, left: 0,
                            width: `${vCol().size}px`, height: '100%',
                            transform: `translateX(${vCol().start}px)`,
                            display: 'flex', 'align-items': 'center', padding: '0 8px',
                            'border-right': '1px solid #1e293b', overflow: 'hidden', 'white-space': 'nowrap',
                          }}
                        >
                          {renderInCellGraphic(rec(), SCROLLABLE_COLUMNS[vCol().index])}
                        </div>
                      )}
                    </Index>
                  </div>

                  <div class="cell-pinned-right" style={{ width: `${PIN_RIGHT}px`, display: 'flex', 'align-items': 'center', 'justify-content': 'flex-end', padding: '0 8px', background: 'inherit' }}>
                    <span style={{ color: (rec()?.temp_change_ghg || 0) > 0.05 ? '#f87171' : '#34d399', 'font-weight': 700 }}>
                      +{(rec()?.temp_change_ghg || 0).toFixed(4)}°C
                    </span>
                  </div>
                </div>
              );
            }}
          </Index>
        </div>
      </div>

      <footer style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', padding: '0 16px', background: '#0f172a', 'border-top': '2px solid #334155', 'font-weight': 600 }}>
        <div>필터링된 총 레코드: <span style={{ color: '#60a5fa' }}>{props.summary().filteredCount.toLocaleString()}</span> 건</div>
        <div>누적 CO2 합계: <span style={{ color: '#f87171' }}>{props.summary().sumCo2.toLocaleString(undefined, { maximumFractionDigits: 1 })} Mt</span></div>
        <div>평균 재생에너지 비중: <span style={{ color: '#34d399' }}>{props.summary().avgRenewables.toFixed(2)}%</span></div>
        <div>평균 전력 탄소집약도: <span style={{ color: '#fbbf24' }}>{props.summary().avgIntensity.toFixed(1)} gCO2/kWh</span></div>
      </footer>
    </section>
  );
}

const CONTINENT_COLORS: Record<string, string> = {
  Asia: '#f472b6', Europe: '#60a5fa', 'North America': '#a78bfa',
  'South America': '#34d399', Africa: '#fbbf24', Oceania: '#22d3ee',
};

function currencyAbbr(v: number): string {
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${Math.round(v).toLocaleString()}`;
}

// in-cell micro visualizations
function renderInCellGraphic(row: ClimateRecord | undefined, col: ColumnDef) {
  if (!row) return null;
  const val = row[col.key];
  const num = Number(val);

  switch (col.renderType) {
    case 'bar-co2': {
      const pct = Math.min(100, Math.max(0, (num / (col.maxVal || 100)) * 100));
      return (
        <div style={{ width: '100%', position: 'relative', display: 'flex', 'align-items': 'center' }}>
          <div style={{ position: 'absolute', left: 0, height: '16px', width: `${pct}%`, background: 'rgba(239, 68, 68, 0.28)', 'border-radius': '2px' }} />
          <span style={{ position: 'relative', 'z-index': 1, 'margin-left': 'auto' }}>{num.toFixed(2)}</span>
        </div>
      );
    }
    case 'delta-percent':
      return (
        <span style={{ color: num > 0 ? '#ef4444' : '#10b981', 'margin-left': 'auto', 'font-weight': 600 }}>
          {num > 0 ? '▲ +' : '▼ '}{num.toFixed(2)}%
        </span>
      );
    case 'gauge-share': {
      const pct = Math.min(100, Math.max(0, num));
      const color = col.key === 'renewables_share' ? '#10b981' : col.key === 'fossil_share' ? '#6b7280' : '#3b82f6';
      return (
        <div style={{ width: '100%', display: 'flex', 'align-items': 'center', gap: '6px' }}>
          <div style={{ flex: 1, height: '6px', background: '#1f2937', 'border-radius': '3px', overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: color }} />
          </div>
          <span style={{ width: '42px', 'text-align': 'right' }}>{pct.toFixed(1)}%</span>
        </div>
      );
    }
    case 'heatmap-fossil': {
      const alpha = Math.min(0.65, num / (col.maxVal || 5000));
      return (
        <div style={{ width: '100%', 'text-align': 'right', background: `rgba(245, 158, 11, ${alpha})`, padding: '2px 4px', 'border-radius': '2px' }}>
          {num.toFixed(1)}
        </div>
      );
    }
    case 'currency-abbr':
      return <span style={{ 'margin-left': 'auto' }}>{currencyAbbr(num)}</span>;
    case 'tag-continent':
      return <span style={{ color: CONTINENT_COLORS[String(val)] || '#e5e7eb' }}>{String(val)}</span>;
    case 'badge-income':
      return <span style={{ border: '1px solid #475569', padding: '1px 6px', 'border-radius': '8px', 'font-size': '10px' }}>{String(val)}</span>;
    case 'warn-intensity':
      return (
        <span style={{ 'margin-left': 'auto', color: num > 600 ? '#f87171' : num > 300 ? '#fbbf24' : '#34d399' }}>
          {Math.round(num)} g/kWh
        </span>
      );
    default:
      return (
        <span style={{ 'margin-left': 'auto' }}>
          {num.toLocaleString(undefined, { maximumFractionDigits: num < 10 ? 3 : 1 })}
        </span>
      );
  }
}
