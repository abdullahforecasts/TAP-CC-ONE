import { fmtBytes, fmtCount, fmtDateTime, fmtDuration } from '../format.js';
import type { ViewData } from '../model/types.js';

export function About({ data }: { data: ViewData }) {
  const { model, report } = data;
  const keys = [...new Set(model.sessions.map((s) => s.key))];
  return (
    <section class="about" aria-label="About this log">
      <dl class="facts">
        <dt>Log ID</dt>
        <dd>
          <code>{model.header?.logId ?? '—'}</code>
        </dd>
        <dt>Created</dt>
        <dd>{model.header ? fmtDateTime(model.header.created) : '—'}</dd>
        {model.header?.label && (
          <>
            <dt>Label</dt>
            <dd>{model.header.label}</dd>
          </>
        )}
        <dt>Written by</dt>
        <dd>{model.header?.tool ?? '—'}</dd>
        <dt>Size</dt>
        <dd>
          {fmtBytes(report.size)} · {fmtCount(report.recordCount)} records in {fmtCount(report.blockCount)}{' '}
          block
          {report.blockCount === 1 ? '' : 's'}
        </dd>
        <dt>Signing key{keys.length === 1 ? '' : 's'}</dt>
        <dd>
          {keys.map((k) => (
            <div key={k}>
              <code>{k}</code>
            </div>
          ))}
          <div class="muted">
            Compare with "TAP: Show Key Fingerprint" on the computer that wrote the log. A signature shows the
            log was not changed after signing, not who typed it.
          </div>
        </dd>
      </dl>

      <h3>Settings that weaken the evidence</h3>
      {model.weakenings.length === 0 ? (
        <p>None — the recorder used its default settings.</p>
      ) : (
        <ul>
          {model.weakenings.map((w) => (
            <li key={w.setting}>
              <code>{w.setting}</code> = {w.value}: {w.why}
            </li>
          ))}
        </ul>
      )}

      <h3>Sessions</h3>
      <table class="sessions">
        <thead>
          <tr>
            <th>#</th>
            <th>Started</th>
            <th>Length</th>
            <th>Editor</th>
            <th>Recorder</th>
            <th>AI-assist extensions</th>
            <th>Ended</th>
          </tr>
        </thead>
        <tbody>
          {model.sessions.map((s) => (
            <tr key={s.index}>
              <td>{s.index}</td>
              <td>{fmtDateTime(s.t)}</td>
              <td>{s.endT !== undefined ? fmtDuration(s.endT - s.t) : '—'}</td>
              <td>
                {s.app} {s.vsc} ({s.os})
              </td>
              <td>{s.ext}</td>
              <td>{s.aiExt.length ? s.aiExt.join(', ') : 'none'}</td>
              <td>{s.endReason ?? 'without a clean end (crash or still open)'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p class="muted">
        The log records which AI-assist extensions were enabled; it cannot tell whether they were used, beyond
        the bulk insertions shown in the history.
      </p>
    </section>
  );
}
