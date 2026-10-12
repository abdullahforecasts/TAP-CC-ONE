/**
 * Serves the viewer bundle like a VS Code webview does: no inline scripts or styles allowed,
 * workers only from blob: URLs.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';

/** Same policy as the extension's webview (see packages/extension/src/vscode/viewerPanel.ts). */
export function csp(nonce: string): string {
  return `default-src 'none'; script-src 'self'; style-src 'self' 'nonce-${nonce}'; img-src 'self' data:; font-src 'self'; worker-src blob:;`;
}

const page = (nonce: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>TAP-CC-ONE viewer</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="tap-style-nonce" content="${nonce}">
<link rel="icon" href="data:,"><link rel="stylesheet" href="viewer.css"></head>
<body><div id="app"></div><script src="viewer.js"></script></body></html>`;

export async function startServer(dist: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const name = (req.url ?? '/').split('?')[0]!.replace(/^\/+/, '');
    const nonce = randomBytes(16).toString('base64');
    const headers = { 'Content-Security-Policy': csp(nonce), 'Cache-Control': 'no-store' };
    if (name === '' || name === 'index.html') {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page(nonce));
      return;
    }
    if (name === 'viewer.js' || name === 'viewer.css') {
      const type = name.endsWith('.js') ? 'text/javascript' : 'text/css';
      res.writeHead(200, { ...headers, 'Content-Type': type });
      res.end(fs.readFileSync(path.join(dist, name)));
      return;
    }
    res.writeHead(404, headers);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
