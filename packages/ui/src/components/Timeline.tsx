import type { VerifyReport } from '@tap/core';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { label as anchorLabel, STATUS_TEXT } from '../anchoring.js';
import { fmtDateTime, fmtDuration, fmtTime } from '../format.js';
import { indexAfterSeq } from '../model/playback.js';
import type { LogModel, Marker, Range } from '../model/types.js';
import { openReplay } from '../store.js';

/** Quiet periods longer than this are drawn as a short break instead of to scale. */
const BREAK_MS = 10 * 60_000;
const BREAK_PX = 22;
const LABEL_W = 132;
/** Room for one axis label ("10-12 20:05"). */
const AXIS_LABEL_W = 84;
const LANE_H = 22;

const LANES = [
  { id: 'typing', label: 'Typing (per minute)' },
  { id: 'paste', label: 'Pastes & tool/AI' },
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

interface AnchorMark {
  t: number;
  status: string;
  title: string;
}

/** Timestamps at their verified time (or, unverified, at the time they were written). */
function anchorMarks(model: LogModel, report: VerifyReport | undefined): AnchorMark[] {
  const anchors = report?.anchoring?.anchors;
  if (!anchors) {
    return model.timeline.markers
      .filter((m) => m.lane === 'anchor')
      .map((m) => ({ t: m.t, status: 'unverified', title: `${fmtDateTime(m.t)}: ${m.label}` }));
  }
  return anchors.map((a) => {
    const t = a.time ?? a.t;
    const who = anchorLabel(a);
    const title =
      a.time !== undefined
        ? `Checkpoint ${a.ck} timestamped by ${who}: everything before it existed by ${fmtDateTime(a.time)}`
        : `${fmtDateTime(a.t)}: timestamp for checkpoint ${a.ck} from ${who} (${STATUS_TEXT[a.status]})${a.message ? `: ${a.message}` : ''}`;
    return { t, status: a.status, title };
  });
}

export function Timeline({ model, report }: { model: LogModel; report?: VerifyReport | undefined }) {
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
  const anchors = useMemo(() => anchorMarks(model, report), [model, report]);
  const plotW = width - LABEL_W - 12;
  const axis = useMemo(() => {
    const times: number[] = [];
    for (const b of tl.activity) times.push(b.t, b.t + 60_000);
    for (const m of tl.markers) if (m.lane !== 'anchor') times.push(m.t);
    for (const a of anchors) times.push(a.t);
    for (const r of [...tl.pauses, ...tl.unfocused]) times.push(r.from, r.to);
    for (const s of tl.sessions) times.push(s.from, s.to);
    return buildAxis(times, plotW);
  }, [tl, anchors, plotW]);
  const maxChars = Math.max(1, ...tl.activity.map((b) => b.typed + b.pasted + b.bulk + b.other));
  const height = LANES.length * LANE_H + 40;
  const X = (t: number) => LABEL_W + axis.x(t);
  // Label each segment with its start time unless that would overlap a neighbouring label. Going
  // from the right keeps the latest day labelled; a label near the right edge ends at the edge.
  const labelAt = new Map<number, { x: number; end: boolean }>();
  let nextStart = Number.POSITIVE_INFINITY;
  for (let i = axis.segments.length - 1; i >= 0; i--) {
    const s = axis.segments[i]!;
    const end = s.x + AXIS_LABEL_W > plotW;
    const start = end ? plotW - AXIS_LABEL_W : s.x;
    if (start + AXIS_LABEL_W + 8 > nextStart && i > 0) continue;
    labelAt.set(i, { x: end ? plotW : s.x, end });
    nextStart = start;
  }

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
              {labelAt.has(i) && (
                <text
                  class="axis-label"
                  x={LABEL_W + labelAt.get(i)!.x}
                  y={12}
                  text-anchor={labelAt.get(i)!.end ? 'end' : 'start'}
                >
                  {fmtDateTime(s.from).slice(5, 16)}
                </text>
              )}
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
          {anchors.map((a, i) => {
            const x = X(a.t);
            const y = laneY('anchor');
            return (
              <g key={`a${i}`} class={`mark anchor ${a.status}`}>
                <path d={`M${x} ${y - 6} L${x + 5} ${y} L${x} ${y + 6} L${x - 5} ${y} Z`} />
                <title>{a.title}</title>
              </g>
            );
          })}
          {tl.markers.map((m, i) => {
            if (m.lane === 'anchor') return null;
            const lane = m.lane === 'bulk' ? 'paste' : m.lane;
            const x = X(m.t);
            const y = laneY(lane);
            const r =
              m.lane === 'paste' || m.lane === 'bulk' ? Math.min(8, 3 + Math.log10(1 + (m.value ?? 1))) : 4;
            const cls = `mark ${m.lane}${m.failed ? ' failed' : ''}${m.f !== undefined ? ' clickable' : ''}`;
            const shape =
              m.lane === 'save' ? (
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
