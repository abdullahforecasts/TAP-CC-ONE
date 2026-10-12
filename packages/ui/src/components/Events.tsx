import { useMemo, useState } from 'preact/hooks';
import { fmtCount, fmtDateTime } from '../format.js';
import { indexAfterSeq } from '../model/playback.js';
import type { EventCategory, LogEvent, LogModel } from '../model/types.js';
import { openReplay } from '../store.js';

const FILTERS: Array<{ id: EventCategory; label: string }> = [
  { id: 'paste', label: 'Pastes' },
  { id: 'bulk', label: 'Bulk inserts' },
  { id: 'external', label: 'Outside the editor' },
  { id: 'run', label: 'Runs' },
  { id: 'note', label: 'Notes' },
  { id: 'file', label: 'Files' },
  { id: 'session', label: 'Sessions' },
  { id: 'pause', label: 'Pauses' },
  { id: 'integrity', label: 'Integrity' },
];

export function Events({ model }: { model: LogModel }) {
  const [on, setOn] = useState<Set<EventCategory>>(new Set(FILTERS.map((f) => f.id)));
  const counts = useMemo(() => {
    const c = new Map<EventCategory, number>();
    for (const e of model.events) c.set(e.category, (c.get(e.category) ?? 0) + 1);
    return c;
  }, [model.events]);
  const shown = model.events.filter((e) => on.has(e.category));
  const toggle = (id: EventCategory) => {
    const next = new Set(on);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOn(next);
  };
  const replay = (e: LogEvent) => {
    const track = model.tracks.find((t) => t.f === e.f);
    if (track) openReplay(track.f, indexAfterSeq(track, e.seq));
  };
  return (
    <section class="events" aria-label="Events">
      <fieldset class="filters">
        <legend class="visually-hidden">Show</legend>
        {FILTERS.map((f) => (
          <label key={f.id} class={`chip ${on.has(f.id) ? 'on' : ''}`}>
            <input type="checkbox" checked={on.has(f.id)} onChange={() => toggle(f.id)} /> {f.label}{' '}
            <span class="muted">{counts.get(f.id) ?? 0}</span>
          </label>
        ))}
      </fieldset>
      <ol class="event-list">
        {shown.map((e, i) => (
          <li key={i} class={`event ${e.category} ${e.tone ?? 'normal'}`} data-testid="event">
            <span class="time">{fmtDateTime(e.t)}</span>
            <span class="cat">{FILTERS.find((f) => f.id === e.category)?.label}</span>
            <span class="label">
              {e.label}
              {e.chars !== undefined && <span class="muted"> · {fmtCount(e.chars)} characters</span>}
              {e.detail && <span class="muted"> · {e.detail}</span>}
            </span>
            {e.f !== undefined && model.tracks.some((t) => t.f === e.f && t.events.length > 0) && (
              <button type="button" class="link" onClick={() => replay(e)}>
                Replay here
              </button>
            )}
          </li>
        ))}
      </ol>
      {shown.length === 0 && <p class="empty">No events of the selected kinds.</p>}
    </section>
  );
}
