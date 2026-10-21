import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeHttpClient } from '../src/node-http.js';

let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/big') {
        res.end(Buffer.alloc(2048));
      } else if (req.url === '/slow') {
        setTimeout(() => res.end('late'), 500);
      } else {
        res.writeHead(201, { 'Content-Type': 'application/octet-stream' });
        res.end(Buffer.concat([Buffer.from(`${req.method} ${req.headers['content-type']} `), ...chunks]));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('node http client', () => {
  it('posts a body and returns status and bytes', async () => {
    const client = nodeHttpClient();
    const res = await client(`${base}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/timestamp-query' },
      body: new Uint8Array([65, 66]),
    });
    expect(res.status).toBe(201);
    expect(Buffer.from(res.body).toString()).toBe('POST application/timestamp-query AB');
  });

  it('enforces the size limit and the timeout', async () => {
    const client = nodeHttpClient({ maxBytes: 1024, timeoutMs: 200 });
    await expect(client(`${base}/big`, { method: 'GET', headers: {} })).rejects.toThrow(/too large/);
    await expect(client(`${base}/slow`, { method: 'GET', headers: {} })).rejects.toThrow(/did not answer/);
    await expect(client('ftp://example.invalid/', { method: 'GET', headers: {} })).rejects.toThrow(
      /unsupported/,
    );
  });
});
