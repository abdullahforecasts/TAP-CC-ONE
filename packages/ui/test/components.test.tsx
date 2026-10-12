// @vitest-environment happy-dom
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyLog } from '@tap/core';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/components/App.js';
import { shares } from '../src/components/Composition.js';
import { arrivalSummary, pasteSummary } from '../src/components/SaveHistory.js';
import { buildAxis } from '../src/components/Timeline.js';
import { Engine } from '../src/engine.js';
import { fmtDuration, fmtPct } from '../src/format.js';
import type { ViewData } from '../src/model/types.js';
import { onHostMessage, resetStore, status, tab, view } from '../src/store.js';
import { demoLog } from './support/demoLog.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function demoView(): ViewData {
  const engine = new Engine();
  const res = engine.handle({ type: 'load', bytes: demoLog().bytes });
  if (res.type !== 'view') throw new Error(res.message);
  return res.data;
}

let root: HTMLElement;
beforeEach(() => {
  resetStore();
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
});

function show(data: ViewData) {
  act(() => {
    view.value = data;
    render(<App />, root);
  });
}

function click(el: Element | null | undefined) {
  if (!el) throw new Error('element not found');
  act(() => {
    (el as HTMLElement).click();
  });
}

describe('viewer components', () => {
  it('shows the verdict, the checklist and Save History with diffs', () => {
    show(demoView());
    expect(root.querySelector('[data-testid="verdict"]')?.textContent).toBe('Intact, with warnings');
    const checks = [...root.querySelectorAll('.check')].map((c) => c.className);
    expect(checks).toEqual([
      'check pass',
      'check pass',
      'check pass',
      'check warn',
      'check pass',
      'check none',
    ]);
    const entries = root.querySelectorAll('[data-testid="history-entry"]');
    expect(entries).toHaveLength(4);
    expect(entries[1]!.textContent).toContain('notes.txt (now TODO.txt)');
    click(entries[2]!.querySelector('.entry-head'));
    const diff = entries[2]!.querySelector('[data-testid="diff"]')!;
    const added = [...diff.querySelectorAll('.dl.add .code')].map((l) => l.textContent);
    expect(added).toContain('if __name__ == "__main__":');
    expect(entries[2]!.textContent).toContain('internal copy from util.py');
    expect(entries[2]!.querySelector('[data-testid="replay-interval"]')?.textContent).toMatch(
      /Replay \d\d:\d\d:\d\d → /,
    );
  });

  it('renders code as text, never as markup', () => {
    const data = demoView();
    // A file whose content looks like HTML must show up literally.
    data.model.events.push({ seq: 1, t: 0, category: 'note', label: '<img src=x onerror=alert(1)>' });
    show(data);
    act(() => {
      tab.value = 'events';
    });
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('<img src=x onerror=alert(1)>');
    const src = path.join(here, '..', 'src');
    const files = fs
      .readdirSync(src, { recursive: true })
      .map(String)
      .filter((f) => /\.(ts|tsx)$/.test(f));
    for (const f of files) {
      const text = fs.readFileSync(path.join(src, f), 'utf8');
      expect(text, f).not.toMatch(/innerHTML|dangerouslySetInnerHTML|insertAdjacentHTML|document\.write/);
    }
  });

  it('switches between every panel', () => {
    show(demoView());
    for (const id of ['timeline', 'composition', 'events', 'about', 'history'] as const) {
      act(() => {
        tab.value = id;
      });
      expect(root.querySelector('main')!.children.length, id).toBeGreaterThan(0);
    }
    act(() => {
      tab.value = 'events';
    });
    expect(root.querySelectorAll('[data-testid="event"]').length).toBeGreaterThan(10);
    // Turning a filter off hides that kind of event.
    const pastes = root.querySelector('.chip input') as HTMLInputElement;
    const before = root.querySelectorAll('[data-testid="event"]').length;
    click(pastes);
    expect(root.querySelectorAll('[data-testid="event"]').length).toBe(before - 2);
  });

  it('loads through the host protocol without a worker (fallback)', async () => {
    act(() => {
      render(<App />, root);
    });
    expect(root.textContent).toContain('Open a log');
    onHostMessage({ type: 'log', bytes: demoLog().bytes, title: 'hello' });
    expect(status.value.state).toBe('loading');
    await new Promise((r) => setTimeout(r, 50));
    expect(status.value.state).toBe('ready');
    act(() => {});
    expect(root.querySelector('h1')?.textContent).toBe('hello');
    onHostMessage({ type: 'error', message: 'boom' });
    expect(status.value).toEqual({ state: 'error', message: 'boom' });
  });
});

describe('composition maths', () => {
  it('shares are percentages of non-whitespace characters and add up to 100', () => {
    const data = demoView();
    const report = verifyLog(demoLog().bytes);
    expect(data.model.composition).toEqual(report.composition);
    const parts = shares(data.model.composition);
    expect(parts.reduce((n, p) => n + p.pct, 0)).toBeCloseTo(100, 6);
    expect(parts.reduce((n, p) => n + p.nonWs, 0)).toBe(data.model.composition.nonWs);
    expect(parts.map((p) => p.origin)).toEqual(['typed', 'internal-copy', 'paste', 'bulk']);
  });

  it('summarises how code arrived between saves', () => {
    const since = demoView().model.history[1]!.since!;
    expect(arrivalSummary(since)).toBe('pasted 48% · internal copy 47% · typed 6%');
    expect(pasteSummary(since)).toBe(
      '2 pastes, 7 lines; internal copy from util.py; 1 from outside the workspace',
    );
    const empty = { ...since, byOrigin: {}, pastes: [], edits: 0 };
    expect(arrivalSummary(empty)).toBe('no changes');
    expect(pasteSummary(empty)).toBeUndefined();
    expect(arrivalSummary({ ...empty, edits: 3 })).toBe('whitespace only');
  });

  it('formats small and large shares and durations sensibly', () => {
    expect(fmtPct(1, 1000)).toBe('<1%');
    expect(fmtPct(999, 1000)).toBe('>99%');
    expect(fmtPct(0, 0)).toBe('0%');
    expect(fmtDuration(40_000)).toBe('40 s');
    expect(fmtDuration(52 * 60_000)).toBe('52 min');
    expect(fmtDuration(65 * 60_000)).toBe('1 h 05 min');
    expect(fmtDuration(50 * 3600_000)).toBe('2 days 2 h');
  });

  it('draws long quiet periods as breaks on the timeline axis', () => {
    const h = 3600_000;
    const m = 60_000;
    const axis = buildAxis([0, 5 * m, 9 * m, 24 * h, 24 * h + 8 * m], 1000);
    expect(axis.segments).toHaveLength(2);
    const xs = [0, 4 * m, 9 * m, 12 * h, 24 * h, 24 * h + 8 * m].map(axis.x);
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThanOrEqual(xs[i - 1]!);
    expect(axis.x(24 * h + 8 * m)).toBeCloseTo(1000, 0);
    // Both active periods are drawn to the same scale: 9 and 8 minutes.
    expect(axis.segments[0]!.width / axis.segments[1]!.width).toBeCloseTo(9 / 8, 6);
  });
});
