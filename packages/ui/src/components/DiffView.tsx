import type { DiffResult } from '../model/diff.js';

/** Unified line diff. Code is rendered as text nodes only. */
export function DiffView({ diff, maxLines }: { diff: DiffResult; maxLines?: number | undefined }) {
  let budget = maxLines ?? Number.POSITIVE_INFINITY;
  let hidden = 0;
  const hunks = diff.hunks.map((hunk, i) => {
    const lines = hunk.lines.filter(() => {
      if (budget > 0) {
        budget--;
        return true;
      }
      hidden++;
      return false;
    });
    if (lines.length === 0) return null;
    return (
      <div class="hunk" key={i}>
        <div class="hunk-head">
          @@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
        </div>
        {lines.map((l, j) => (
          <div class={`dl ${l.op}`} key={j}>
            <span class="ln">{l.oldNo ?? ''}</span>
            <span class="ln">{l.newNo ?? ''}</span>
            <span class="sign">{l.op === 'add' ? '+' : l.op === 'remove' ? '−' : ' '}</span>
            <span class="code">{l.text}</span>
          </div>
        ))}
      </div>
    );
  });
  return (
    <div class="diff" data-testid="diff">
      {diff.hunks.length === 0 && <div class="muted">No changes.</div>}
      {diff.approximate && (
        <div class="muted">
          The file changed too much for a line-by-line comparison; changed regions are shown whole.
        </div>
      )}
      {hunks}
      {hidden > 0 && <div class="muted">… {hidden} more lines</div>}
    </div>
  );
}
