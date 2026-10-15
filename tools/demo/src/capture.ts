/**
 * Opens a recorded project in the real viewer bundle (packages/ui/dist, served with the VS Code
 * webview's content security policy) in Chromium and saves screenshots and screen recordings.
 * Nothing on screen is drawn by this script: it only clicks, scrolls and waits.
 *
 *   tsx --conditions=source tools/demo/src/capture.ts <project folder> <output folder>
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type BrowserContext, chromium, type Page } from '@playwright/test';
import { verifyLog } from '@tap/core';
import { startServer } from '../../../packages/ui/e2e/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', '..', '..', 'packages', 'ui', 'dist');
const project = path.resolve(process.argv[2] ?? 'project');
const out = path.resolve(process.argv[3] ?? 'capture');
const shotsDir = path.join(out, 'screenshots');
const videoDir = path.join(out, 'videos');
const rawDir = path.join(out, '.raw-video');
for (const d of [shotsDir, videoDir, rawDir]) fs.mkdirSync(d, { recursive: true });

interface SubFile {
  path: string;
  content: Uint8Array;
}
const logBytes = new Uint8Array(fs.readFileSync(path.join(project, '.tap', 'log.codelog')));
function readSubmission(dir: string, prefix = ''): SubFile[] {
  const files: SubFile[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.tap') continue;
    if (e.isDirectory()) files.push(...readSubmission(path.join(dir, e.name), `${prefix}${e.name}/`));
    else
      files.push({ path: prefix + e.name, content: new Uint8Array(fs.readFileSync(path.join(dir, e.name))) });
  }
  return files;
}
const submission = readSubmission(project);

const server = await startServer(dist);
const browser: Browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
);
const problems: string[] = [];

async function newContext(
  opts: { height?: number; video?: boolean; dark?: boolean } = {},
): Promise<BrowserContext> {
  const viewport = { width: 1280, height: opts.height ?? 1000 };
  return browser.newContext({
    viewport,
    deviceScaleFactor: opts.video ? 1 : 1.5,
    timezoneId: 'Asia/Karachi',
    locale: 'en-GB',
    colorScheme: opts.dark ? 'dark' : 'light',
    ...(opts.video ? { recordVideo: { dir: rawDir, size: viewport } } : {}),
  });
}

/** Opens the viewer and hands it the log the way the extension does (postMessage). */
async function openLog(
  ctx: BrowserContext,
  bytes: Uint8Array,
  files: SubFile[] | undefined,
  title: string,
): Promise<Page> {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${title}: page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`${title}: console: ${m.text()}`);
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) =>
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  await page.goto(server.url);
  await page.evaluate(
    ({ bytes, files, title }) =>
      window.postMessage(
        {
          type: 'log',
          title,
          bytes: new Uint8Array(bytes),
          ...(files
            ? {
                submission: files.map((f) => ({ path: f.path, content: new Uint8Array(f.content) })),
                comparedWith: 'the files in this folder',
              }
            : {}),
        },
        '*',
      ),
    { bytes: [...bytes], files: files?.map((f) => ({ path: f.path, content: [...f.content] })), title },
  );
  await page.getByTestId('verdict').waitFor();
  return page;
}

const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(shotsDir, `${name}.png`), fullPage: true });
const shotOf = (page: Page, selector: string, name: string) =>
  page
    .locator(selector)
    .first()
    .screenshot({ path: path.join(shotsDir, `${name}.png`) });

async function selectFile(page: Page, file: string): Promise<void> {
  await page.getByTestId('tab-replay').click();
  await resetHeight(page);
  await page.locator('.replay select').first().selectOption({ label: file });
  await page.waitForTimeout(300);
}

async function showWholeFile(page: Page): Promise<void> {
  // The editor box is 60% of the window and scrolls to the last change. For a still picture,
  // make the box as tall as the file (an inline style set from script; the page's CSP allows it).
  await page.locator('.cm-scroller').evaluate((el) => {
    el.scrollTop = 0;
  });
  // CodeMirror only draws the lines in view, so grow the box until the last line number stops changing.
  for (let i = 0; i < 6; i++) {
    const changed = await page.locator('.code-view').evaluate((el) => {
      const gutters = el.querySelectorAll('.cm-lineNumbers .cm-gutterElement');
      const count = Number(gutters[gutters.length - 1]?.textContent ?? '40');
      const lineH = el.querySelector<HTMLElement>('.cm-line')?.getBoundingClientRect().height ?? 18;
      const height = `${Math.ceil(count * lineH) + 16}px`;
      const box = el as HTMLElement;
      if (box.style.height === height) return false;
      box.style.height = height;
      return true;
    });
    if (!changed) break;
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(150);
  await page.locator('.cm-scroller').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForTimeout(200);
}

async function resetHeight(page: Page): Promise<void> {
  await page.locator('.code-view').evaluate((el) => {
    (el as HTMLElement).style.height = '';
  });
}

/** Expands the Save History entry for `file` whose text contains `text`. */
async function expandEntry(page: Page, file: string, text: string | RegExp) {
  await page.getByTestId('tab-history').click();
  const entry = page.getByTestId('history-entry').filter({ hasText: file }).filter({ hasText: text }).first();
  await entry.locator('.entry-head').click();
  await entry.getByTestId('diff').waitFor();
  return entry;
}

const TITLE = 'Student Management System (C++) — 3 sessions';

// ---------------------------------------------------------------- screenshots
{
  const ctx = await newContext({ height: 1000 });
  const page = await openLog(ctx, logBytes, submission, TITLE);
  await shot(page, '01-save-history-overview');
  await shotOf(page, '.integrity', '02-integrity-verdict');

  const paste = await expandEntry(page, 'storage.cpp', 'pasted from outside');
  await paste.screenshot({ path: path.join(shotsDir, '03-history-storage-pasted-from-outside.png') });
  const copy = await expandEntry(page, 'course.cpp', 'copied from own files');
  await copy.screenshot({ path: path.join(shotsDir, '04-history-course-copied-from-own-file.png') });
  const ai = await expandEntry(page, 'enrollment.cpp', 'tool / AI');
  await ai.screenshot({ path: path.join(shotsDir, '05-history-enrollment-copilot-inserts.png') });
  const ext = await expandEntry(page, 'storage.cpp', 'outside the editor');
  await ext.screenshot({ path: path.join(shotsDir, '06-history-storage-claude-code-outside-editor.png') });
  await page.getByTestId('tab-history').click();
  await shot(page, '07-save-history-expanded');

  await page.getByTestId('tab-timeline').click();
  await page.getByTestId('timeline').waitFor();
  await shot(page, '20-timeline');
  await page.getByTestId('tab-composition').click();
  await shot(page, '21-composition');
  await page.getByTestId('tab-events').click();
  await shot(page, '22-events-all');
  // Only the categories about where text came from.
  for (const label of ['Runs', 'Notes', 'Files', 'Sessions', 'Pauses', 'Integrity']) {
    await page.locator('.filters label').filter({ hasText: label }).first().click();
  }
  await shot(page, '23-events-pastes-ai-outside-only');
  await page.getByTestId('tab-about').click();
  await shot(page, '24-about-sessions-and-ai-extensions');
  await ctx.close();
}

// Replay close-ups of the final state of each file, tall enough to show the whole file.
{
  const ctx = await newContext({ height: 1000 });
  const page = await openLog(ctx, logBytes, submission, TITLE);
  const files: Array<[string, string]> = [
    ['storage.cpp', '10-replay-storage.cpp-red-paste-orange-claude-code'],
    ['course.cpp', '11-replay-course.cpp-yellow-own-file-copy'],
    ['enrollment.h', '12-replay-enrollment.h-purple-kilo-code'],
    ['enrollment.cpp', '13-replay-enrollment.cpp-purple-copilot'],
    ['main.cpp', '14-replay-main.cpp-copilot-branch'],
    ['report.cpp', '15-replay-report.cpp-orange-claude-code-file'],
    ['student.cpp', '16-replay-student.cpp-all-typed'],
  ];
  for (const [file, name] of files) {
    await selectFile(page, file);
    await showWholeFile(page);
    await shotOf(page, '.replay', name);
  }
  // course.h at the moment the wrong line was typed, before the undo.
  await selectFile(page, 'course.h');
  const status = page.getByTestId('replay-status');
  const scrub = page.getByTestId('scrubber');
  const max = Number(await scrub.getAttribute('max'));
  for (let i = max; i > 0; i--) {
    await scrub.fill(String(i));
    if ((await status.textContent())?.includes('undo')) {
      await scrub.fill(String(i - 1));
      break;
    }
  }
  await showWholeFile(page);
  await shotOf(page, '.replay', '17-replay-course.h-before-undo');
  await ctx.close();
}

// Dark theme.
{
  const ctx = await newContext({ height: 1000, dark: true });
  const page = await openLog(ctx, logBytes, submission, TITLE);
  await selectFile(page, 'storage.cpp');
  await showWholeFile(page);
  await shotOf(page, '.replay', '30-dark-replay-storage.cpp');
  await page.getByTestId('tab-composition').click();
  await shot(page, '31-dark-composition');
  await page.getByTestId('tab-history').click();
  await shot(page, '32-dark-save-history');
  await ctx.close();
}

// Tampering: one byte changed in the middle of the log.
const tampered = logBytes.slice();
const at = Math.floor(tampered.length / 2);
tampered[at] = tampered[at]! ^ 0x01;
fs.mkdirSync(path.join(out, 'log'), { recursive: true });
{
  const ctx = await newContext({ height: 1000 });
  const page = await openLog(ctx, tampered, submission, `${TITLE} — one byte changed at offset ${at}`);
  await shot(page, '40-tampered-log-one-byte-flipped');
  await ctx.close();
  const r = verifyLog(tampered, {
    submission: submission.map((f) => ({ path: f.path, content: f.content })),
  });
  fs.writeFileSync(
    path.join(out, 'log', 'verify-tampered-one-byte.txt'),
    `One bit flipped at byte ${at} of ${tampered.length}\n\nVerdict: ${r.verdict}\n${r.findings
      .map((f) => `  [${f.severity}] ${f.code}${f.seq !== undefined ? ` @${f.seq}` : ''}: ${f.message}`)
      .join('\n')}\n`,
  );
}

// Submission edited after the session: the student changes storage.cpp without the recorder.
{
  const edited = submission.map((f) =>
    f.path === 'storage.cpp'
      ? {
          path: f.path,
          content: new TextEncoder().encode(
            new TextDecoder()
              .decode(f.content)
              .replace('continue;  // skip malformed lines', 'continue;  // my own error handling'),
          ),
        }
      : f,
  );
  const ctx = await newContext({ height: 1000 });
  const page = await openLog(ctx, logBytes, edited, `${TITLE} — storage.cpp edited after the session`);
  await shot(page, '41-submission-edited-after-session');
  await ctx.close();
  const r = verifyLog(logBytes, { submission: edited });
  fs.writeFileSync(
    path.join(out, 'log', 'verify-submission-edited.txt'),
    `storage.cpp edited after the session (one comment changed)\n\nVerdict: ${r.verdict}\n${r.findings
      .map((f) => `  [${f.severity}] ${f.code}${f.seq !== undefined ? ` @${f.seq}` : ''}: ${f.message}`)
      .join('\n')}\n`,
  );
}

// ---------------------------------------------------------------- videos
const videos: string[] = [];
async function record(name: string, height: number, body: (page: Page) => Promise<void>): Promise<void> {
  const ctx = await newContext({ height, video: true });
  const page = await openLog(ctx, logBytes, submission, TITLE);
  await body(page);
  await page.waitForTimeout(1500);
  const video = page.video()!;
  await ctx.close();
  const dest = path.join(rawDir, `${name}.webm`);
  await video.saveAs(dest);
  await video.delete();
  videos.push(name);
  console.log(`video: ${name}`);
}

async function playFromStart(page: Page, file: string, speed: string): Promise<void> {
  await selectFile(page, file);
  await page.locator('.replay select').nth(1).selectOption(speed);
  await page.getByTestId('scrubber').fill('0');
  await page.waitForTimeout(800);
  await page.getByTestId('play').click();
  await page.getByTestId('play').filter({ hasText: 'Play' }).waitFor({ timeout: 300_000 });
}

const REPLAYS: Array<[string, string]> = [
  ['student.h', 'replay-64x-01-student.h'],
  ['course.cpp', 'replay-64x-02-course.cpp-own-file-copy'],
  ['course.h', 'replay-64x-03-course.h-typo-and-undo'],
  ['enrollment.h', 'replay-64x-04-enrollment.h-kilo-code'],
  ['enrollment.cpp', 'replay-64x-05-enrollment.cpp-copilot'],
  ['storage.cpp', 'replay-64x-06-storage.cpp-paste-and-claude-code'],
  ['report.cpp', 'replay-64x-07-report.cpp-claude-code-file'],
  ['main.cpp', 'replay-64x-08-main.cpp'],
];
for (const [file, name] of REPLAYS) await record(name, 1000, (page) => playFromStart(page, file, '64'));

await record('replay-8x-storage.cpp-slower', 1000, (page) => playFromStart(page, 'storage.cpp', '8'));

await record('interval-replay-64x-storage.cpp-save', 1000, async (page) => {
  const entry = await expandEntry(page, 'storage.cpp', 'pasted from outside');
  await page.waitForTimeout(1200);
  await entry.getByTestId('replay-interval').click();
  await page.locator('.replay select').nth(1).selectOption('64');
  await page.getByTestId('play').filter({ hasText: 'Play' }).waitFor({ timeout: 300_000 });
});

await record('tour-all-panels', 1000, async (page) => {
  const pause = () => page.waitForTimeout(1800);
  await pause();
  const entry = await expandEntry(page, 'storage.cpp', 'pasted from outside');
  await entry.scrollIntoViewIfNeeded();
  await pause();
  for (const tab of ['timeline', 'composition', 'events', 'about']) {
    await page.getByTestId(`tab-${tab}`).click();
    await pause();
    await page.mouse.wheel(0, 600);
    await pause();
  }
  await selectFile(page, 'storage.cpp');
  await showWholeFile(page);
  await pause();
});

fs.writeFileSync(path.join(out, '.videos.json'), JSON.stringify(videos));
await browser.close();
await server.close();
fs.writeFileSync(
  path.join(out, 'log', 'viewer-console-problems.txt'),
  problems.length ? `${problems.join('\n')}\n` : 'No CSP violations, page errors or console errors.\n',
);
console.log(problems.length ? problems.join('\n') : 'no CSP violations or page errors');
