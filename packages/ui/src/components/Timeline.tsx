import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { fmtDateTime, fmtDuration, fmtTime } from '../format.js';
import { indexAfterSeq } from '../model/playback.js';
import type { LogModel, Marker, Range } from '../model/types.js';
import { openReplay } from '../store.js';

/** Quiet periods longer than this are drawn as a short break instead of to scale. */
const BREAK_MS = 10 * 60_000;
const BREAK_PX = 22;
const LABEL_W = 132;
const LANE_H = 22;

const LANES = [
  { id: 'typing', label: 'Typing (per minute)' },
  { id: 'paste', label: 'Pastes & bulk' },
  { id: 'run', label: 'Runs' },
  { id: 'save', label: 'Saves' },
  { id: 'external', label: 'Outside the editor' },
  { id: 'note', label: 'Notes' },
  { id: 'pause', label: 'Paused' },
  { id: 'unfocused', label: 'Window not focused' },
  { id: 'anchor', label: 'Timestamps' },
] as const;

interface Segment {
  from: number;
  to: number;
  x: number;
  width: number;
}

/** Piecewise time axis: active periods to scale, long quiet periods as fixed-width breaks. */
export function buildAxis(times: number[], width: number): { segments: Segment[]; x: (t: number) => number } {
  const sorted = [...times].sort((a, b) => a - b);
  const clusters: Array<{ from: number; to: number }> = [];
  for (const t of sorted) {
    const last = clusters.at(-1);
    if (last && t - last.to <= BREAK_MS) last.to = t;
    else clusters.push({ from: t, to: t });
  }
  const minSpan = 60_000;
  const total = clusters.reduce((n, c) => n + Math.max(minSpan, c.to - c.from), 0);
  const usable = Math.max(50, width - Math.max(0, clusters.length - 1) * BREAK_PX);
  const scale = total > 0 ? usable / total : 0;
  let x = 0;
  const segments = clusters.map((c, i) => {
    const w = Math.max(minSpan, c.to - c.from) * scale;
    const seg = { from: c.from, to: c.to, x: x + (i > 0 ? BREAK_PX : 0), width: w };
    x = seg.x + w;
    return seg;
  });
  const at = (t: number): number => {
    if (segments.length === 0) return 0;
    let lo = 0;
    let hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segments[mid]!.from <= t) lo = mid;
      else hi = mid - 1;
    }
    const s = segments[lo]!;
    if (t < s.from) return s.x;
    if (t > s.to) return lo + 1 < segments.length ? s.x + s.width + BREAK_PX / 2 : s.x + s.width;
    return s.x + (t - s.from) * scale;
  };
  return { segments, x: at };
}

function laneY(id: (typeof LANES)[number]['id']): number {
  return LANES.findIndex((l) => l.id === id) * LANE_H + 24;
}

export function Timeline({ model }: { model: LogModel }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(Math.max(320, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const tl = model.timeline;
  const plotW = width - LABEL_W - 12;
  const axis = useMemo(() => {
    const times: number[] = [];
    for (const b of tl.activity) times.push(b.t, b.t + 60_000);
    for (const m of tl.markers) times.push(m.t);
    for (const r of [...tl.pauses, ...tl.unfocused]) times.push(r.from, r.to);
    for (const s of tl.sessions) times.push(s.from, s.to);
    return buildAxis(times, plotW);
  }, [tl, plotW]);
  const maxChars = Math.max(1, ...tl.activity.map((b) => b.typed + b.pasted + b.bulk + b.other));
  const height = LANES.length * LANE_H + 40;
  const X = (t: number) => LABEL_W + axis.x(t);

  const click = (m: Marker) => {
    if (m.f === undefined) return;
    const track = model.tracks.find((t) => t.f === m.f);
    if (track) openReplay(m.f, indexAfterSeq(track, m.seq));
  };
  const range = (r: Range, lane: 'pause' | 'unfocused', key: string) => (
    <rect
      key={key}
      class={`range ${lane}`}
      x={X(r.from)}
      y={laneY(lane) - 7}
      width={Math.max(2, X(r.to) - X(r.from))}
      height={14}
    >
      <title>
        {lane === 'pause' ? 'Recording paused' : 'Window not focused'}: {fmtTime(r.from)} – {fmtTime(r.to)} (
        {fmtDuration(r.to - r.from)})
      </title>
    </rect>
  );

  return (
    <section class="timeline" aria-label="Timeline" ref={box}>
      {tl.activity.length === 0 && tl.markers.length === 0 ? (
        <p class="empty">Nothing to show yet.</p>
      ) : (
        <svg width={width} height={height} role="img" aria-label="Timeline of the log" data-testid="timeline">
          {LANES.map((lane) => (
            <g key={lane.id}>
              <text class="lane-label" x={4} y={laneY(lane.id) + 4}>
                {lane.label}
              </text>
              <line class="lane-line" x1={LABEL_W} x2={width - 8} y1={laneY(lane.id)} y2={laneY(lane.id)} />
            </g>
          ))}
          {axis.segments.map((s, i) => (
            <g key={`seg${i}`}>
              <text class="axis-label" x={LABEL_W + s.x} y={12}>
                {fmtDateTime(s.from).slice(5, 16)}
              </text>
              {i > 0 && (
                <g class="break">
                  <line
                    x1={LABEL_W + s.x - BREAK_PX / 2}
                    x2={LABEL_W + s.x - BREAK_PX / 2}
                    y1={18}
                    y2={height - 10}
                  />
                  <title>{fmtDuration(s.from - axis.segments[i - 1]!.to)} with no activity</title>
                </g>
              )}
            </g>
          ))}
          {tl.activity.map((b) => {
            const total = b.typed + b.pasted + b.bulk + b.other;
            const h = Math.max(1, (16 * total) / maxChars);
            const y = laneY('typing') + 8;
            const w = Math.max(1, X(b.t + 60_000) - X(b.t) - 0.5);
            const part = (n: number) => (h * n) / total;
            let top = y;
            return (
              <g key={b.t}>
                {(['typed', 'pasted', 'bulk', 'other'] as const).map((k) => {
                  const ph = part(b[k]);
                  top -= ph;
                  return ph > 0 ? (
                    <rect key={k} class={`bar ${k}`} x={X(b.t)} y={top} width={w} height={ph} />
                  ) : null;
                })}
                <title>
                  {fmtTime(b.t)}: {b.typed} typed, {b.pasted} pasted, {b.bulk} bulk, {b.other} other
                  characters
                </title>
              </g>
            );
          })}
          {tl.pauses.map((r, i) => range(r, 'pause', `p${i}`))}
          {tl.unfocused.map((r, i) => range(r, 'unfocused', `u${i}`))}
          {tl.markers.map((m, i) => {
            const lane = m.lane === 'bulk' ? 'paste' : m.lane;
            const x = X(m.t);
            const y = laneY(lane);
            const r =
              m.lane === 'paste' || m.lane === 'bulk' ? Math.min(8, 3 + Math.log10(1 + (m.value ?? 1))) : 4;
            const cls = `mark ${m.lane}${m.failed ? ' failed' : ''}${m.f !== undefined ? ' clickable' : ''}`;
            const shape =
              m.lane === 'save' || m.lane === 'anchor' ? (
                <line x1={x} x2={x} y1={y - 7} y2={y + 7} />
              ) : m.lane === 'run' ? (
                <rect x={x - 4} y={y - 4} width={8} height={8} />
              ) : (
                <circle cx={x} cy={y} r={r} />
              );
            const tip = (
              <title>
                {fmtDateTime(m.t)}: {m.label}
              </title>
            );
            if (m.f === undefined) {
              return (
                <g key={i} class={cls}>
                  {shape}
                  {tip}
                </g>
              );
            }
            return (
              // biome-ignore lint/a11y/useSemanticElements: SVG has no <button>; the marker is focusable and handles Enter/Space.
              <g
                key={i}
                class={cls}
                role="button"
                tabIndex={0}
                onClick={() => click(m)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') click(m);
                }}
              >
                {shape}
                {tip}
              </g>
            );
          })}
        </svg>
      )}
      <p class="muted">
        Quiet periods longer than 10 minutes are drawn as breaks. Click a paste, save or outside change to
        replay the file from there.
      </p>
    </section>
  );
}
