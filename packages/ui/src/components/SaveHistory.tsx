import type { Origin } from '@tap/core';
import { useMemo, useState } from 'preact/hooks';
import { fmtCount, fmtDateTime, fmtDuration, fmtPct, fmtTime, ORIGIN_LABEL } from '../format.js';
import { diffTexts } from '../model/diff.js';
import { frameAt } from '../model/playback.js';
import type { HistoryEntry, IntervalStats, LogModel, RunInfo } from '../model/types.js';
import { openReplay } from '../store.js';
import { DiffView } from './DiffView.js';

/** "typed 97% · pasted 3%" from inserted non-whitespace characters by origin. */
export function arrivalSummary(since: IntervalStats): string {
  const entries = Object.entries(since.byOrigin) as Array<[Origin, number]>;
  const total = entries.reduce((n, [, v]) => n + v, 0);
  if (total === 0) return since.edits > 0 ? 'whitespace only' : 'no changes';
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([origin, v]) => `${ORIGIN_LABEL[origin]} ${fmtPct(v, total)}`)
    .join(' · ');
}

export function pasteSummary(since: IntervalStats): string | undefined {
  if (since.pastes.length === 0) return undefined;
  const lines = since.pastes.reduce((n, p) => n + p.lines, 0);
  const sources = [...new Set(since.pastes.filter((p) => p.copiedFrom).map((p) => p.copiedFrom!))];
  const outside = since.pastes.filter((p) => p.origin === 'paste').length;
  const parts = [
    `${since.pastes.length} paste${since.pastes.length === 1 ? '' : 's'}, ${lines} line${lines === 1 ? '' : 's'}`,
  ];
  if (sources.length) parts.push(`internal copy from ${sources.join(', ')}`);
  if (outside) parts.push(`${outside} from outside the workspace`);
  return parts.join('; ');
}

function runText(run: RunInfo): string {
  const name = run.name ? ` "${run.name}"` : '';
  const result =
    run.exit === undefined ? (run.endSeq === undefined ? 'running' : 'ended') : `exit ${run.exit}`;
  return `${run.kind}${name}: ${result}`;
}

function Entry({ entry, model, showPath }: { entry: HistoryEntry; model: LogModel; showPath: boolean }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const track = entry.f === undefined ? undefined : model.tracks.find((t) => t.f === entry.f);
  const current = entry.f === undefined ? undefined : model.files.find((f) => f.f === entry.f)?.path;
  const diff = useMemo(() => {
    if (!open || !track || entry.fromIndex === undefined || entry.toIndex === undefined) return undefined;
    return diffTexts(frameAt(track, entry.fromIndex).text, frameAt(track, entry.toIndex).text);
  }, [open, track, entry.fromIndex, entry.toIndex]);
  const failed = entry.runs.some((r) => r.exit !== undefined && r.exit !== 0);
  const kinds = [
    entry.kind === 'save' ? `SAVE${entry.repeats ? ` ×${entry.repeats + 1}` : ''}` : '',
    entry.runs.length ? `RUN${entry.runs.length > 1 ? ` ×${entry.runs.length}` : ''}` : '',
  ]
    .filter(Boolean)
    .join(' + ');
  const since = entry.since;
  const fromT = since ? entry.t - since.durationMs : entry.t;

  return (
    <li class={`entry ${open ? 'open' : ''}`} data-testid="history-entry">
      <button type="button" class="entry-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        {showPath && entry.path && (
          <span class="path">
            {entry.path}
            {current && current !== entry.path && <span class="muted"> (now {current})</span>}
          </span>
        )}
        {entry.number !== undefined && <span class="num">#{entry.number}</span>}
        <span class="time">{fmtDateTime(entry.t)}</span>
        <span class="kinds">{kinds}</span>
        {entry.added !== undefined && (
          <span class="delta">
            (<span class="add">+{entry.added}</span> <span class="del">−{entry.removed}</span>)
          </span>
        )}
        {entry.runs.length > 0 && (
          <span class={`run ${failed ? 'failed' : 'passed'}`}>{entry.runs.map(runText).join(', ')}</span>
        )}
        {since && <span class="arrival muted">{arrivalSummary(since)}</span>}
      </button>
      {open && (
        <div class="entry-body">
          {since && (
            <p>
              Since {entry.number === 1 ? 'the file entered the log' : 'the last save'}:{' '}
              {fmtDuration(since.durationMs)} (active {fmtDuration(since.activeMs)}) · {fmtCount(since.edits)}{' '}
              change{since.edits === 1 ? '' : 's'} · {fmtCount(since.insertedChars)} characters inserted,{' '}
              {fmtCount(since.deletedChars)} deleted
            </p>
          )}
          {since && (
            <p>
              How it arrived: {arrivalSummary(since)}
              {pasteSummary(since) && <span class="muted"> ({pasteSummary(since)})</span>}
            </p>
          )}
          {entry.kind === 'run' && <p>{entry.runs.map(runText).join(', ')}</p>}
          {diff && <DiffView diff={diff} maxLines={full ? undefined : 60} />}
          <div class="actions">
            {track && entry.fromIndex !== undefined && entry.toIndex !== undefined && (
              <button
                type="button"
                onClick={() => openReplay(track.f, entry.fromIndex!, entry.toIndex!, true)}
                data-testid="replay-interval"
              >
                ▶ Replay {fmtTime(fromT)} → {fmtTime(entry.t)}
              </button>
            )}
            {diff && diff.hunks.reduce((n, h) => n + h.lines.length, 0) > 60 && (
              <button type="button" onClick={() => setFull(!full)}>
                {full ? 'Show less' : 'Show full diff'}
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

export function SaveHistory({ model }: { model: LogModel }) {
  const [file, setFile] = useState<number | 'all'>('all');
  const entries = useMemo(
    () =>
      model.history
        .filter((h) => file === 'all' || h.f === file)
        .slice()
        .reverse(),
    [model.history, file],
  );
  const files = model.files.filter((f) => model.history.some((h) => h.f === f.f));
  return (
    <section class="history" aria-label="Save History">
      <div class="toolbar">
        <label>
          File{' '}
          <select
            value={String(file)}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              setFile(v === 'all' ? 'all' : Number(v));
            }}
          >
            <option value="all">All files</option>
            {files.map((f) => (
              <option key={f.f} value={String(f.f)}>
                {f.path}
                {f.deleted ? ' (deleted)' : ''}
              </option>
            ))}
          </select>
        </label>
        <span class="muted">
          {entries.length} entr{entries.length === 1 ? 'y' : 'ies'}, newest first. A save with no changes is
          folded into the one before it.
        </span>
      </div>
      {entries.length === 0 ? (
        <p class="empty">No saves recorded yet. Save a file and it will appear here.</p>
      ) : (
        <ol class="entries">
          {entries.map((e) => (
            <Entry key={e.id} entry={e} model={model} showPath={file === 'all'} />
          ))}
        </ol>
      )}
    </section>
  );
}
