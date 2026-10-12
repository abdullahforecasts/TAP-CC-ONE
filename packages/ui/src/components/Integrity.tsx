import type { Finding, Stage, VerifyReport } from '@tap/core';
import { useState } from 'preact/hooks';

const ROWS: Array<{ stage: Stage; label: string }> = [
  { stage: 'parse', label: 'File structure' },
  { stage: 'chain', label: 'Hash chain' },
  { stage: 'signatures', label: 'Signed checkpoints' },
  { stage: 'anchors', label: 'Independent timestamps' },
  { stage: 'replay', label: 'Replay of every change' },
  { stage: 'submission', label: 'Matches the files' },
];

type RowState = 'pass' | 'warn' | 'fail' | 'none';

const RANK: Record<Finding['severity'], number> = { info: 0, pass: 1, warn: 2, fail: 3 };

function rowState(findings: Finding[]): { state: RowState; finding?: Finding } {
  let worst: Finding | undefined;
  for (const f of findings) if (!worst || RANK[f.severity] > RANK[worst.severity]) worst = f;
  if (!worst) return { state: 'none' };
  if (worst.severity === 'info') return { state: 'pass', finding: worst };
  return { state: worst.severity, finding: worst };
}

const ICON: Record<RowState, string> = { pass: '✓', warn: '!', fail: '✗', none: '–' };

export const VERDICT_TEXT: Record<VerifyReport['verdict'], string> = {
  INTACT: 'Intact',
  INTACT_WITH_WARNINGS: 'Intact, with warnings',
  NOT_INTACT: 'Not intact',
};

export function Integrity({
  report,
  comparedWith,
}: {
  report: VerifyReport;
  comparedWith?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const verdictClass = report.verdict === 'INTACT' ? 'ok' : report.verdict === 'NOT_INTACT' ? 'bad' : 'warn';
  return (
    <section class="integrity" aria-label="Integrity">
      <div class="integrity-head">
        <span class={`verdict ${verdictClass}`} data-testid="verdict">
          {VERDICT_TEXT[report.verdict]}
        </span>
        <span class="muted">
          {report.recordCount.toLocaleString('en-US')} records · {report.stats.sessions} session
          {report.stats.sessions === 1 ? '' : 's'}
          {report.stats.recoveries > 0 &&
            ` · ${report.stats.recoveries} recovered crash${report.stats.recoveries === 1 ? '' : 'es'}`}
          {report.stats.resyncs > 0 &&
            ` · ${report.stats.resyncs} re-synchronisation${report.stats.resyncs === 1 ? '' : 's'}`}
        </span>
        <button type="button" class="link" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Hide all findings' : 'All findings'}
        </button>
      </div>
      <ul class="checklist">
        {ROWS.map(({ stage, label }) => {
          const { state, finding } = rowState(report.findings.filter((f) => f.stage === stage));
          const text =
            stage === 'submission' && state === 'none'
              ? 'No files to compare with'
              : (finding?.message ?? (state === 'none' ? 'Not checked' : ''));
          return (
            <li key={stage} class={`check ${state}`} title={text}>
              <span class="check-icon" aria-hidden="true">
                {ICON[state]}
              </span>
              <span class="check-label">
                {stage === 'submission' && comparedWith ? `Matches ${comparedWith}` : label}
              </span>
              <span class="check-text">{text}</span>
            </li>
          );
        })}
      </ul>
      {open && (
        <ul class="findings">
          {report.findings.map((f, i) => (
            <li key={i} class={`finding ${f.severity}`}>
              <code>{f.code}</code> {f.message}
              {f.seq !== undefined && <span class="muted"> (record {f.seq})</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
