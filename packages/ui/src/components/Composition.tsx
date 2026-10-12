import type { Composition as Comp, Origin } from '@tap/core';
import { fmtCount, fmtPct, ORIGIN_HELP, ORIGIN_LABEL, ORIGIN_ORDER } from '../format.js';
import type { ViewData } from '../model/types.js';

/** Non-whitespace characters by origin, as percentages (design §10.3: whitespace is not counted). */
export function shares(c: Comp): Array<{ origin: Origin; nonWs: number; pct: number }> {
  return ORIGIN_ORDER.map((origin) => ({ origin, nonWs: c.byOrigin[origin]?.nonWs ?? 0 }))
    .filter((s) => s.nonWs > 0)
    .map((s) => ({ ...s, pct: c.nonWs > 0 ? (100 * s.nonWs) / c.nonWs : 0 }));
}

export function CompositionBar({ composition, label }: { composition: Comp; label: string }) {
  const parts = shares(composition);
  return (
    <figure class="composition">
      <figcaption>
        {label}: {fmtCount(composition.nonWs)} non-whitespace characters
      </figcaption>
      <div
        class="bar"
        role="img"
        aria-label={parts
          .map((p) => `${ORIGIN_LABEL[p.origin]} ${fmtPct(p.nonWs, composition.nonWs)}`)
          .join(', ')}
      >
        {parts.map((p) => (
          <span
            key={p.origin}
            class={`seg o-${p.origin}`}
            style={{ width: `${p.pct}%` }}
            title={`${ORIGIN_LABEL[p.origin]}: ${fmtPct(p.nonWs, composition.nonWs)}`}
          />
        ))}
      </div>
      <ul class="legend">
        {parts.map((p) => (
          <li key={p.origin} title={ORIGIN_HELP[p.origin]}>
            <span class={`swatch o-${p.origin}`} /> {ORIGIN_LABEL[p.origin]}{' '}
            {fmtPct(p.nonWs, composition.nonWs)}
          </li>
        ))}
      </ul>
    </figure>
  );
}

const COLUMNS: Origin[] = ['typed', 'internal-copy', 'paste', 'bulk', 'preexisting', 'external'];

export function Composition({ data }: { data: ViewData }) {
  const { model, report } = data;
  const final = report.composition ?? model.composition;
  const matched = report.findings.some((f) => f.stage === 'submission' && f.severity === 'pass');
  const live = model.files.filter((f) => !f.deleted && f.composition);
  return (
    <section class="composition-panel" aria-label="Composition">
      <CompositionBar
        composition={final}
        label={
          matched && data.comparedWith
            ? `Final code (${data.comparedWith})`
            : 'Final code (all recorded files)'
        }
      />
      <table class="files">
        <thead>
          <tr>
            <th>File</th>
            <th class="num">Characters</th>
            {COLUMNS.map((o) => (
              <th key={o} class="num" title={ORIGIN_HELP[o]}>
                {ORIGIN_LABEL[o]}
              </th>
            ))}
            <th class="num">other</th>
          </tr>
        </thead>
        <tbody>
          {live.map((f) => {
            const c = f.composition!;
            const shown = COLUMNS.reduce((n, o) => n + (c.byOrigin[o]?.nonWs ?? 0), 0);
            return (
              <tr key={f.f}>
                <td class="path">{f.path}</td>
                <td class="num">{fmtCount(c.nonWs)}</td>
                {COLUMNS.map((o) => (
                  <td key={o} class="num">
                    {c.byOrigin[o]?.nonWs ? fmtPct(c.byOrigin[o]!.nonWs, c.nonWs) : ''}
                  </td>
                ))}
                <td class="num">{c.nonWs - shown > 0 ? fmtPct(c.nonWs - shown, c.nonWs) : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p class="muted">
        Shares count non-whitespace characters of the final text by how they arrived, so indentation and blank
        lines do not inflate any share. Text brought back by undo/redo counts as "undo/redo". These are facts
        about how the code was written, for a person to interpret — not a judgement.
      </p>
    </section>
  );
}
