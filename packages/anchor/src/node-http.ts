/**
 * HttpClient on Node's http/https modules (for the extension and scripts; not for browsers).
 *
 * Node's fetch() gives up on a host with both IPv6 and IPv4 addresses when each connection attempt
 * takes longer than 250 ms ("ETIMEDOUT"), which is normal on long routes (for example from South
 * Asia to Europe), while curl and browsers connect fine. Here every address family gets
 * `familyTimeoutMs` before the next is tried. In VS Code, the http/https modules also follow the
 * user's proxy settings.
 */
import * as http from 'node:http';
import * as https from 'node:https';
import type { TcpNetConnectOpts } from 'node:net';
import type { HttpClient } from './client.js';

export interface NodeHttpOptions {
  /** Whole request, connect to last byte (default 20 s). */
  timeoutMs?: number;
  /** Largest answer accepted (default 1 MiB). */
  maxBytes?: number;
  /** Time each address (IPv6 or IPv4) gets to connect before the next is tried (default 2.5 s). */
  familyTimeoutMs?: number;
}

export function nodeHttpClient(options: NodeHttpOptions = {}): HttpClient {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const familyTimeoutMs = options.familyTimeoutMs ?? 2500;
  return (url, init) =>
    new Promise((resolve, reject) => {
      const u = new URL(url);
      const mod = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : undefined;
      if (!mod) {
        reject(new Error(`unsupported URL ${url}`));
        return;
      }
      let settled = false;
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.destroy();
        reject(e);
      };
      const headers: Record<string, string | number> = { ...init.headers };
      if (init.body) headers['Content-Length'] = init.body.length;
      const req = mod.request(
        u,
        // Socket options are passed on to net.connect by the agent (not in the http typings).
        {
          method: init.method,
          headers,
          autoSelectFamily: true,
          autoSelectFamilyAttemptTimeout: familyTimeoutMs,
        } as http.RequestOptions & TcpNetConnectOpts,
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > maxBytes) fail(new Error(`${url} sent an answer that is too large`));
            else chunks.push(c);
          });
          res.on('end', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ status: res.statusCode ?? 0, body: new Uint8Array(Buffer.concat(chunks)) });
          });
          res.on('error', fail);
        },
      );
      const timer = setTimeout(
        () => fail(new Error(`${url} did not answer within ${timeoutMs / 1000} s`)),
        timeoutMs,
      );
      req.on('error', fail);
      req.end(init.body ? Buffer.from(init.body) : undefined);
    });
}
