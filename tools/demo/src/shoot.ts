/**
 * Screenshots of any recorded folder in the real viewer bundle: every panel, and the final
 * state of every file in Replay (tall enough to show the whole file).
 *
 *   tsx --conditions=source tools/demo/src/shoot.ts <folder with .tap/> <output folder>
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';
import { startServer } from '../../../packages/ui/e2e/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', '..', '..', 'packages', 'ui', 'dist');
const project = path.resolve(process.argv[2] ?? '.');
const out = path.resolve(process.argv[3] ?? 'shots');
fs.mkdirSync(out, { recursive: true });

const bytes = [...fs.readFileSync(path.join(project, '.tap', 'log.codelog'))];
const files: Array<{ path: string; content: number[] }> = [];
const walk = (dir: string, prefix = '') => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.tap') continue;
    if (e.isDirectory()) walk(path.join(dir, e.name), `${prefix}${e.name}/`);
    else files.push({ path: prefix + e.name, content: [...fs.readFileSync(path.join(dir, e.name))] });
  }
};
walk(project);

const server = await startServer(dist);
const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
);
const page: Page = await browser.newPage({
  viewport: { width: 1280, height: 1000 },
  deviceScaleFactor: 1.5,
  timezoneId: 'Asia/Karachi',
});
const problems: string[] = [];
page.on('pageerror', (e) => problems.push(e.message));
await page.goto(server.url);
await page.evaluate(
  ({ bytes, files, title }) =>
    window.postMessage(
      {
        type: 'log',
        title,
        bytes: new Uint8Array(bytes),
        submission: files.map((f) => ({ path: f.path, content: new Uint8Array(f.content) })),
        comparedWith: 'the files in this folder',
      },
      '*',
    ),
  { bytes, files, title: path.basename(project) },
);
await page.getByTestId('verdict').waitFor();
for (const tab of ['history', 'timeline', 'composition', 'events', 'about']) {
  await page.getByTestId(`tab-${tab}`).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, `${tab}.png`), fullPage: true });
}
await page.getByTestId('tab-replay').click();
const options = await page.locator('.replay select').first().locator('option').allTextContents();
for (const [i, label] of options.entries()) {
  await page.locator('.replay select').first().selectOption({ index: i });
  await page.waitForTimeout(300);
  await page.locator('.code-view').evaluate((el) => {
    (el as HTMLElement).style.height = '';
  });
  for (let k = 0; k < 6; k++) {
    const changed = await page.locator('.code-view').evaluate((el) => {
      const g = el.querySelectorAll('.cm-lineNumbers .cm-gutterElement');
      const count = Number(g[g.length - 1]?.textContent ?? '40');
      const h = el.querySelector<HTMLElement>('.cm-line')?.getBoundingClientRect().height ?? 18;
      const want = `${Math.ceil(count * h) + 16}px`;
      const box = el as HTMLElement;
      if (box.style.height === want) return false;
      box.style.height = want;
      return true;
    });
    if (!changed) break;
    await page.waitForTimeout(120);
  }
  await page.locator('.cm-scroller').evaluate((el) => {
    el.scrollTop = 0;
  });
  const name = label.replace(/[^\w.-]+/g, '_');
  await page.locator('.replay').screenshot({ path: path.join(out, `replay-${i + 1}-${name}.png`) });
}
await browser.close();
await server.close();
console.log(problems.length ? problems.join('\n') : `ok: ${options.join(' | ')}`);
