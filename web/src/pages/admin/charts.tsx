import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { RateLimitWindow } from '../../../../shared/codex.js';
import { limitSeverity } from '../../codexStatus';
import { fmtCompact, fmtDateTime, fmtRelative, fmtWindow } from '../../format';
import { useI18n } from '../../i18n';
import { Icon } from '../../icons';

/** Usage-limit meter: blue fill, warning ≥70 %, critical ≥90 % (always with icon + text). */
export function LimitMeter({ label, window: w }: { label: string; window: RateLimitWindow }) {
  const { t, lang } = useI18n();
  const pct = Math.max(0, Math.min(100, w.usedPercent));
  const sev = limitSeverity(pct);
  return (
    <div className={`meter ${sev}`}>
      <div className="m-top">
        <span>
          {label} · {t('codex.limitWindow', { duration: fmtWindow(t, w.windowDurationMins) })}
        </span>
        <span className="m-value">
          {sev ? <Icon name="alert" size={14} /> : null}
          {t('codex.limitUsed', { percent: Math.round(pct) })}
        </span>
      </div>
      <div className="m-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={label}>
        <div className="m-fill" style={{ width: `${pct}%` }} />
      </div>
      {w.resetsAt ? <div className="m-sub">{t('codex.limitResets', { time: fmtRelative(lang, t, w.resetsAt * 1000) })}</div> : null}
    </div>
  );
}

function niceMax(v: number): number {
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= v) return m * pow;
  return 10 * pow;
}

interface TipState {
  x: number;
  y: number;
  content: ReactNode;
}

function Tooltip({ tip, width }: { tip: TipState | null; width: number }) {
  if (!tip) return null;
  // Keep the box inside the chart near either edge.
  const x = Math.min(Math.max(tip.x, 70), width - 70);
  return (
    <div className="tooltip" style={{ left: x, top: tip.y, transform: 'translate(-50%, calc(-100% - 10px))' }}>
      {tip.content}
    </div>
  );
}

function TableToggle({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 6 }}>
      <button type="button" className="link-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? t('chart.hideTable') : t('chart.showTable')}
      </button>
      {open ? <div className="table-wrap" style={{ marginTop: 6 }}>{children}</div> : null}
    </div>
  );
}

const H = 220;
const PAD = { top: 12, right: 12, bottom: 28, left: 40 };

/** Track the container's pixel width so the SVG is drawn 1:1 and text keeps its real size. */
function useWidth(ref: RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(640);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(Math.max(280, Math.round(el.clientWidth)));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/** Columns rounded at the data end only, square at the baseline. */
function columnPath(x: number, y: number, w: number, base: number): string {
  const h = base - y;
  if (h <= 0) return '';
  const r = Math.min(4, h, w / 2);
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
}

export function DailyColumns({ data }: { data: Array<{ day: string; requests: number; failed: number }> }) {
  const { t, lang } = useI18n();
  const wrap = useRef<HTMLDivElement>(null);
  const W = useWidth(wrap);
  const [tip, setTip] = useState<TipState | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(...data.map((d) => d.requests), 0));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const band = plotW / data.length;
  const barW = Math.min(24, band - 2);
  const base = PAD.top + plotH;
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const dayLabel = (d: string) => new Intl.DateTimeFormat(lang, { month: 'numeric', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
  const ticks = [0, max / 2, max];

  const show = (i: number, el: Element) => {
    const d = data[i]!;
    const box = wrap.current!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    setHover(i);
    setTip({
      x: r.left - box.left + r.width / 2,
      y: r.top - box.top,
      content: (
        <>
          <div className="muted">{dayLabel(d.day)}</div>
          <div className="t-row">
            <span className="t-value">{fmtCompact(lang, d.requests)}</span> {t('chart.requestsLabel')}
          </div>
          {d.failed ? (
            <div className="t-row">
              <span className="t-value">{d.failed}</span> {t('chart.failedLabel')}
            </div>
          ) : null}
        </>
      ),
    });
  };

  return (
    <div className="chart" ref={wrap} onPointerLeave={() => { setTip(null); setHover(null); }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('overview.daily')}>
        {ticks.map((v) => (
          <g key={v}>
            <line className={v === 0 ? 'baseline' : 'gridline'} x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} />
            <text className="tick" x={PAD.left - 6} y={y(v) + 4} textAnchor="end">
              {fmtCompact(lang, v)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = PAD.left + i * band + (band - barW) / 2;
          return (
            <g key={d.day}>
              <path className={`bar ${hover === i ? 'hover' : ''}`} d={columnPath(x, y(d.requests), barW, base)} />
              {(data.length - 1 - i) % (band < 34 ? 3 : 2) !== 0 ? null : (
                <text className="tick" x={x + barW / 2} y={H - 8} textAnchor="middle">
                  {dayLabel(d.day)}
                </text>
              )}
              <rect
                className="hit"
                x={PAD.left + i * band}
                y={PAD.top}
                width={band}
                height={plotH}
                tabIndex={0}
                aria-label={`${dayLabel(d.day)}: ${d.requests}`}
                onPointerMove={(e) => show(i, e.currentTarget)}
                onFocus={(e) => show(i, e.currentTarget)}
                onBlur={() => { setTip(null); setHover(null); }}
              />
            </g>
          );
        })}
      </svg>
      <Tooltip tip={tip} width={W} />
      <TableToggle>
        <table className="data">
          <thead>
            <tr>
              <th>{t('requests.time')}</th>
              <th>{t('adminTab.requests')}</th>
              <th>{t('overview.dailyFailed')}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.day}>
                <td>{dayLabel(d.day)}</td>
                <td className="num">{d.requests}</td>
                <td className="num">{d.failed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableToggle>
    </div>
  );
}

export function LimitLines({ points }: { points: Array<{ at: number; primary: number | null; secondary: number | null }> }) {
  const { t, lang } = useI18n();
  const wrap = useRef<HTMLDivElement>(null);
  const W = useWidth(wrap);
  const [tip, setTip] = useState<TipState | null>(null);
  const [cross, setCross] = useState<number | null>(null);
  if (points.length < 2) {
    return (
      <div className="chart" ref={wrap}>
        <p className="muted">{t('overview.noData')}</p>
      </div>
    );
  }
  const t0 = points[0]!.at;
  const t1 = points[points.length - 1]!.at;
  const plotW = W - PAD.left - PAD.right - 96; // room for end labels
  const plotH = H - PAD.top - PAD.bottom;
  const x = (at: number) => PAD.left + ((at - t0) / Math.max(1, t1 - t0)) * plotW;
  const y = (v: number) => PAD.top + plotH - (Math.min(100, Math.max(0, v)) / 100) * plotH;
  const series = [
    { key: 'primary' as const, label: t('codex.limitPrimary'), cls: '1' },
    { key: 'secondary' as const, label: t('codex.limitSecondary'), cls: '2' },
  ];
  const pathFor = (key: 'primary' | 'secondary') =>
    points
      .filter((p) => p[key] !== null)
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.at).toFixed(1)},${y(p[key]!).toFixed(1)}`)
      .join('');
  const lastOf = (key: 'primary' | 'secondary') => [...points].reverse().find((p) => p[key] !== null);
  const xTicks = [t0, t0 + (t1 - t0) / 2, t1];

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const svg = e.currentTarget.ownerSVGElement!;
    const r = svg.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(x(points[i]!.at) - vx) < Math.abs(x(points[best]!.at) - vx)) best = i;
    const p = points[best]!;
    const box = wrap.current!.getBoundingClientRect();
    setCross(best);
    setTip({
      x: (x(p.at) / W) * r.width + (r.left - box.left),
      y: (PAD.top / H) * r.height + (r.top - box.top) + 10,
      content: (
        <>
          <div className="muted">{fmtDateTime(lang, p.at)}</div>
          {series.map((s) => (
            <div className="t-row" key={s.key}>
              <span className="t-key" style={{ background: `var(--series-${s.cls})` }} />
              <span className="t-value">{p[s.key] === null ? '—' : `${Math.round(p[s.key]!)}%`}</span> {s.label}
            </div>
          ))}
        </>
      ),
    });
  };

  return (
    <div className="chart" ref={wrap}>
      <div className="legend">
        {series.map((s) => (
          <span key={s.key}>
            <i style={{ background: `var(--series-${s.cls})` }} />
            {s.label}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('overview.limitHistory')}>
        {[0, 50, 100].map((v) => (
          <g key={v}>
            <line className={v === 0 ? 'baseline' : 'gridline'} x1={PAD.left} x2={PAD.left + plotW} y1={y(v)} y2={y(v)} />
            <text className="tick" x={PAD.left - 6} y={y(v) + 4} textAnchor="end">
              {v}%
            </text>
          </g>
        ))}
        {xTicks.map((at, i) => (
          <text key={i} className="tick" x={x(at)} y={H - 8} textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}>
            {new Intl.DateTimeFormat(lang, { month: 'numeric', day: 'numeric', hour: '2-digit' }).format(at)}
          </text>
        ))}
        {cross !== null ? <line className="crosshair" x1={x(points[cross]!.at)} x2={x(points[cross]!.at)} y1={PAD.top} y2={PAD.top + plotH} /> : null}
        {series.map((s) => {
          const last = lastOf(s.key);
          return (
            <g key={s.key}>
              <path className={`line-${s.cls}`} d={pathFor(s.key)} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {last ? (
                <>
                  <circle className={`dot-${s.cls}`} cx={x(last.at)} cy={y(last[s.key]!)} r={4} />
                  <text className="end-label" x={x(last.at) + 8} y={y(last[s.key]!) + 4}>
                    {Math.round(last[s.key]!)}% {s.label}
                  </text>
                </>
              ) : null}
            </g>
          );
        })}
        <rect className="hit" x={PAD.left} y={PAD.top} width={plotW} height={plotH} onPointerMove={onMove} onPointerLeave={() => { setTip(null); setCross(null); }} />
      </svg>
      <Tooltip tip={tip} width={W} />
      <TableToggle>
        <table className="data">
          <thead>
            <tr>
              <th>{t('requests.time')}</th>
              <th>{t('codex.limitPrimary')}</th>
              <th>{t('codex.limitSecondary')}</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.at}>
                <td>{fmtDateTime(lang, p.at)}</td>
                <td className="num">{p.primary === null ? '—' : `${Math.round(p.primary)}%`}</td>
                <td className="num">{p.secondary === null ? '—' : `${Math.round(p.secondary)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableToggle>
    </div>
  );
}
