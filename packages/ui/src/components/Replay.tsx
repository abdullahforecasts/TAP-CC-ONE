import { ChangeSet, EditorState, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, lineNumbers } from '@codemirror/view';
import type { Origin, SpanList } from '@tap/core';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { fmtCount, fmtDateTime, ORIGIN_HELP, ORIGIN_LABEL, ORIGIN_ORDER } from '../format.js';
import { delayBefore, frameAt, spanListOf } from '../model/playback.js';
import type { FileTrack, LogModel } from '../model/types.js';
import { replayRequest } from '../store.js';

const SPEEDS = [1, 2, 4, 8, 16, 32, 64];
/** Origins that are not highlighted (the common case would drown everything else). */
const PLAIN = new Set<Origin>(['typed', 'preexisting']);

const setMarks = StateEffect.define<DecorationSet>();
const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const e of tr.effects) if (e.is(setMarks)) next = e.value;
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Nonce for inline <style> elements, from <meta name="tap-style-nonce"> (set by the host). */
function styleNonce(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="tap-style-nonce"]')?.content ?? '';
}

const markCache = new Map<Origin, Decoration>();
function markFor(origin: Origin): Decoration {
  let mark = markCache.get(origin);
  if (!mark) {
    mark = Decoration.mark({ class: `o-${origin}`, attributes: { title: ORIGIN_LABEL[origin] } });
    markCache.set(origin, mark);
  }
  return mark;
}

function decorations(spans: SpanList): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  let pos = 0;
  for (const span of spans.toArray()) {
    if (!PLAIN.has(span.origin) && span.len > 0) builder.add(pos, pos + span.len, markFor(span.origin));
    pos += span.len;
  }
  return builder.finish();
}

/** What the editor currently shows. */
interface Shown {
  f: number;
  index: number;
  spans: SpanList;
}

export function Replay({ model }: { model: LogModel }) {
  const tracks = useMemo(
    () => model.tracks.filter((t) => t.events.length > 0).sort((a, b) => (a.path < b.path ? -1 : 1)),
    [model.tracks],
  );
  const request = replayRequest.value;
  const [f, setF] = useState<number | undefined>(request?.f ?? tracks[0]?.f);
  const track: FileTrack | undefined = tracks.find((t) => t.f === f) ?? tracks[0];
  const [pos, setPos] = useState(request?.from ?? track?.events.length ?? 0);
  const [stopAt, setStopAt] = useState<number | undefined>(request?.to);
  const [playing, setPlaying] = useState(request?.autoplay ?? false);
  const [speed, setSpeed] = useState(8);
  const [skipIdle, setSkipIdle] = useState(true);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView>();
  const shown = useRef<Shown>();

  // A new request from Save History, the timeline or the events list.
  useEffect(() => {
    if (!request) return;
    setF(request.f);
    setPos(request.from);
    setStopAt(request.to);
    setPlaying(request.autoplay);
  }, [request?.nonce]);

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: '',
        extensions: [
          // Offsets in the log count every character, including '\r'; keep CodeMirror counting the same way.
          EditorState.lineSeparator.of('\n'),
          // CodeMirror adds its base styles in a <style> element; the page's CSP allows it by nonce.
          EditorView.cspNonce.of(styleNonce()),
          lineNumbers(),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          marksField,
        ],
      }),
    });
    editor.current = view;
    return () => {
      view.destroy();
      editor.current = undefined;
      shown.current = undefined;
    };
  }, []);

  // Show `pos` of `track`: apply the events in between when moving forward a little,
  // otherwise jump to the nearest keyframe.
  useEffect(() => {
    const view = editor.current;
    if (!view || !track) return;
    const target = Math.min(pos, track.events.length);
    const cur = shown.current;
    let last: number | undefined;
    if (cur && cur.f === track.f && target >= cur.index && target - cur.index <= 5000) {
      let changes = ChangeSet.empty(view.state.doc.length);
      for (let i = cur.index; i < target; i++) {
        const e = track.events[i]!;
        const step = ChangeSet.of({ from: e.off, to: e.off + e.del, insert: e.ins }, changes.newLength);
        changes = changes.compose(step);
        cur.spans.remove(e.off, e.del);
        cur.spans.insert(e.off, e.ins.length, e.origin, e.seq);
        last = e.off + e.ins.length;
      }
      cur.index = target;
      view.dispatch({
        changes,
        effects: [
          setMarks.of(decorations(cur.spans)),
          ...(last === undefined ? [] : [EditorView.scrollIntoView(last, { y: 'center' })]),
        ],
      });
    } else {
      const frame = frameAt(track, target);
      const spans = spanListOf(frame.spans);
      shown.current = { f: track.f, index: target, spans };
      const e = track.events[target - 1];
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: frame.text },
        effects: [
          setMarks.of(decorations(spans)),
          ...(e
            ? [EditorView.scrollIntoView(Math.min(e.off + e.ins.length, frame.text.length), { y: 'center' })]
            : []),
        ],
      });
    }
  }, [track, pos]);

  // Playback: advance by as many events as fit in one animation frame of log time.
  useEffect(() => {
    if (!playing || !track) return;
    const end = Math.min(stopAt ?? track.events.length, track.events.length);
    if (pos >= end) {
      setPlaying(false);
      return;
    }
    let next = pos;
    let wait = 0;
    do {
      next++;
      wait += delayBefore(track, next - 1, speed, skipIdle);
    } while (next < end && wait < 16);
    const timer = setTimeout(() => setPos(next), Math.min(wait, 1000));
    return () => clearTimeout(timer);
  }, [playing, pos, track, speed, skipIdle, stopAt]);

  if (!track) return <p class="empty">No file changes recorded yet.</p>;

  const event = track.events[pos - 1];
  const end = track.events.length;
  return (
    <section class="replay" aria-label="Replay">
      <div class="toolbar">
        <label>
          File{' '}
          <select
            value={String(track.f)}
            onChange={(e) => {
              const next = tracks.find((t) => t.f === Number((e.target as HTMLSelectElement).value));
              setPlaying(false);
              setStopAt(undefined);
              setF(next?.f);
              setPos(next?.events.length ?? 0);
            }}
          >
            {tracks.map((t) => (
              <option key={t.f} value={String(t.f)}>
                {t.path}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => {
            if (!playing && pos >= (stopAt ?? end)) {
              setStopAt(undefined);
              if (pos >= end) setPos(0);
            }
            setPlaying(!playing);
          }}
          data-testid="play"
        >
          {playing ? '❚❚ Pause' : '▶ Play'}
        </button>
        <label>
          Speed{' '}
          <select
            value={String(speed)}
            onChange={(e) => setSpeed(Number((e.target as HTMLSelectElement).value))}
          >
            {SPEEDS.map((s) => (
              <option key={s} value={String(s)}>
                {s}×
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={skipIdle}
            onChange={(e) => setSkipIdle((e.target as HTMLInputElement).checked)}
          />{' '}
          Skip idle time
        </label>
        {stopAt !== undefined && <span class="muted">Stops at change {fmtCount(stopAt)}</span>}
      </div>
      <input
        class="scrubber"
        type="range"
        min={0}
        max={end}
        value={pos}
        aria-label="Position in the file's history"
        onInput={(e) => {
          setPlaying(false);
          setPos(Number((e.target as HTMLInputElement).value));
        }}
        data-testid="scrubber"
      />
      <div class="replay-status" data-testid="replay-status">
        Change {fmtCount(pos)} of {fmtCount(end)}
        {event && (
          <>
            {' '}
            · {fmtDateTime(event.t)} · {ORIGIN_LABEL[event.origin]}
            {event.copiedFrom ? ` from ${event.copiedFrom}` : ''}
          </>
        )}
      </div>
      <div class="code-view" ref={host} data-testid="code-view" />
      <ul class="legend">
        {ORIGIN_ORDER.filter((o) => !PLAIN.has(o)).map((o) => (
          <li key={o} title={ORIGIN_HELP[o]}>
            <span class={`swatch o-${o}`} /> {ORIGIN_LABEL[o]}
          </li>
        ))}
        <li class="muted">Typed text and text already there are not highlighted.</li>
      </ul>
    </section>
  );
}
