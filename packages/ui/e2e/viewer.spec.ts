/**
 * End-to-end test of the built viewer bundle in Chromium, served with the same content security
 * policy as a VS Code webview: the conformance vectors, the demo session, every tab, interval
 * replay, and the time to open a long session.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { contentHash, toHex } from '@tap/core';
import { LogLoader } from '../src/model/load.js';
import { frameAt } from '../src/model/playback.js';
import { demoLog } from '../test/support/demoLog.js';
import { startServer } from './server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const vectors = path.join(here, '..', '..', '..', 'spec', 'vectors');
const shots = process.env.TAP_SHOTS_DIR;

let server: Awaited<ReturnType<typeof startServer>>;
test.beforeAll(async () => {
  server = await startServer(dist);
});
test.afterAll(async () => {
  await server.close();
});

/** Opens the viewer and records CSP violations and uncaught errors. */
async function open(page: Page): Promise<{ problems: string[] }> {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  await page.goto(server.url);
  return { problems };
}

async function post(page: Page, msg: Record<string, unknown>): Promise<void> {
  await page.evaluate((m) => window.postMessage(m, '*'), msg);
}

function readSubmission(dir: string): Array<{ path: string; content: number[] }> {
  if (!fs.existsSync(dir)) return [];
  const out: Array<{ path: string; content: number[] }> = [];
  const walk = (d: string, prefix: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), `${prefix}${e.name}/`);
      else out.push({ path: prefix + e.name, content: [...fs.readFileSync(path.join(d, e.name))] });
    }
  };
  walk(dir, '');
  return out;
}

test('shows the verdict of every conformance vector without errors', async ({ page }) => {
  const { problems } = await open(page);
  for (const name of fs
    .readdirSync(vectors)
    .filter((n) => /^\d{3}-/.test(n))
    .sort()) {
    const dir = path.join(vectors, name);
    const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8')) as {
      verdict: string;
    };
    const bytes = [...fs.readFileSync(path.join(dir, 'log.codelog'))];
    const submission = readSubmission(path.join(dir, 'submission'));
    await page.evaluate(
      ({ bytes, submission, name }) =>
        window.postMessage(
          {
            type: 'log',
            title: name,
            bytes: new Uint8Array(bytes),
            ...(submission.length
              ? {
                  submission: submission.map((f) => ({ path: f.path, content: new Uint8Array(f.content) })),
                  comparedWith: 'the submitted files',
                }
              : {}),
          },
          '*',
        ),
      { bytes, submission, name },
    );
    await expect(page.locator('h1')).toHaveText(name);
    const text = {
      INTACT: 'Intact',
      INTACT_WITH_WARNINGS: 'Intact, with warnings',
      NOT_INTACT: 'Not intact',
    }[expected.verdict]!;
    await expect(page.getByTestId('verdict'), name).toHaveText(text);
    // Every tab renders.
    for (const tab of ['replay', 'timeline', 'composition', 'events', 'about', 'history']) {
      await page.getByTestId(`tab-${tab}`).click();
    }
  }
  expect(problems).toEqual([]);
});

test('Save History, interval replay and every panel on a realistic session', async ({ page }) => {
  const { problems } = await open(page);
  const demo = demoLog();
  await page.getByTestId('open-log').setInputFiles({
    name: 'two-sum.codelog',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(demo.bytes),
  });
  await expect(page.getByTestId('verdict')).toHaveText('Intact, with warnings');
  const entries = page.getByTestId('history-entry');
  await expect(entries).toHaveCount(4);
  await expect(entries.nth(0)).toContainText('main.py');
  await expect(entries.nth(0)).toContainText('#3');
  await expect(entries.nth(2)).toContainText('SAVE ×2 + RUN');
  await expect(entries.nth(2)).toContainText('exit 0');

  // Expand main.py #2: the diff shows the pasted lines as text.
  await entries.nth(2).locator('.entry-head').click();
  await expect(entries.nth(2)).toContainText('internal copy from util.py');
  await expect(entries.nth(2).getByTestId('diff')).toContainText('if __name__ == "__main__":');
  if (shots) await page.screenshot({ path: path.join(shots, 'part3-save-history.png'), fullPage: true });

  // Replay that interval: it must stop exactly at the saved content.
  const loader = new LogLoader();
  loader.reset(demo.bytes);
  const model = loader.model();
  const entry = model.history.filter((h) => h.kind === 'save')[1]!;
  const expectedText = frameAt(model.tracks.find((t) => t.f === entry.f)!, entry.toIndex!).text;
  await entries.nth(2).getByTestId('replay-interval').click();
  await page.locator('select').nth(1).selectOption('64');
  await expect(page.getByTestId('replay-status')).toContainText(`Change ${entry.toIndex} of`, {
    timeout: 30_000,
  });
  await expect(page.getByTestId('play')).toHaveText('▶ Play');
  const shown = await page
    .locator('.cm-content')
    .evaluate((el) => [...el.querySelectorAll('.cm-line')].map((l) => l.textContent ?? '').join('\n'));
  expect(shown).toBe(expectedText);
  const save = model.history.filter((h) => h.kind === 'save')[1]!;
  expect(save.seq).toBe(entry.seq);
  expect(toHex(contentHash(shown))).toBe(toHex(contentHash(expectedText)));
  if (shots) {
    await page.screenshot({ path: path.join(shots, 'part3-replay.png'), fullPage: true });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: path.join(shots, 'part3-replay-dark.png'), fullPage: true });
    await page.emulateMedia({ colorScheme: 'light' });
  }

  await page.getByTestId('tab-timeline').click();
  await expect(page.getByTestId('timeline')).toBeVisible();
  if (shots) await page.screenshot({ path: path.join(shots, 'part3-timeline.png'), fullPage: true });
  await page.getByTestId('tab-composition').click();
  await expect(page.locator('.composition figcaption')).toContainText('Final code');
  if (shots) await page.screenshot({ path: path.join(shots, 'part3-composition.png'), fullPage: true });
  await page.getByTestId('tab-events').click();
  await expect(
    page.getByTestId('event').filter({ hasText: 'read_ints copied from my own util.py' }),
  ).toHaveCount(1);
  if (shots) await page.screenshot({ path: path.join(shots, 'part3-events.png'), fullPage: true });
  await page.getByTestId('tab-about').click();
  await expect(page.locator('.sessions tbody tr')).toHaveCount(2);
  await expect(page.locator('.about')).toContainText('GitHub.copilot');
  if (shots) await page.screenshot({ path: path.join(shots, 'part3-about.png'), fullPage: true });
  expect(problems).toEqual([]);
});

test('live refresh appends new blocks', async ({ page }) => {
  const { problems } = await open(page);
  const demo = demoLog();
  const half = Math.floor(demo.bytes.length / 2);
  await post(page, { type: 'log', bytes: demo.bytes.slice(0, half), title: 'live' });
  await expect(page.getByTestId('verdict')).toBeVisible();
  const before = await page.getByTestId('history-entry').count();
  await post(page, { type: 'append', bytes: demo.bytes.slice(half) });
  await expect(page.getByTestId('history-entry')).toHaveCount(4);
  expect(before).toBeLessThan(4);
  expect(problems).toEqual([]);
});

test('opens a long session quickly', async ({ page }) => {
  await open(page);
  // About 3 hours of typing at 180 ms per keystroke.
  const big = demoLog(560);
  const started = Date.now();
  await post(page, { type: 'log', bytes: big.bytes, title: 'long session' });
  await expect(page.getByTestId('history-entry').first()).toBeVisible({ timeout: 30_000 });
  const ms = Date.now() - started;
  console.log(`long session: ${(big.bytes.length / 1024).toFixed(0)} KB opened in ${ms} ms`);
  expect(ms).toBeLessThan(Number(process.env.TAP_OPEN_BUDGET_MS ?? 4000));
  // Scrubbing to arbitrary positions stays fast (keyframes).
  await page.getByTestId('tab-replay').click();
  await page.locator('.replay select').first().selectOption({ label: 'main.py' });
  const scrubber = page.getByTestId('scrubber');
  const t0 = Date.now();
  for (const v of ['5000', '100', '40000', '20000', '59000']) await scrubber.fill(v);
  await expect(page.getByTestId('replay-status')).toContainText('Change');
  console.log(`5 scrubber jumps in ${Date.now() - t0} ms`);
});
