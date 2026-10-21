/**
 * Records real answers from the timestamp services the extension uses, for the tests in
 * test/real.test.ts, and adds the FreeTSA root (and any intermediate CA a TSA leaves out of its
 * tokens) to roots/. Run it on a computer with normal internet access:
 *
 *   pnpm --filter @tap/anchor real             # TSAs, FreeTSA root, a pending OpenTimestamps proof
 *   pnpm --filter @tap/anchor real --upgrade   # a few hours later: complete the OpenTimestamps proof
 *
 * Then run `pnpm --filter @tap/anchor roots` and the tests. Only a fixed SHA-256 digest is sent.
 */
import { createHash, X509Certificate } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toHex } from '@tap/core';
import { type HttpClient, requestRfc3161, submitOts, upgradeOts } from '../src/client.js';
import { nodeHttpClient } from '../src/node-http.js';
import { parseOts, summarizeOts } from '../src/ots.js';
import { parseToken, verifyTimestampToken } from '../src/rfc3161.js';
import { type Certificate, parseCertificate, pemToDer } from '../src/x509.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootsDir = path.join(here, '..', 'roots');
const outDir = path.join(here, '..', 'test', 'fixtures', 'real');
const manifestPath = path.join(outDir, 'manifest.json');

const TSAS = ['https://freetsa.org/tsr', 'http://timestamp.digicert.com', 'http://timestamp.sectigo.com'];
const CALENDARS = [
  'https://alice.btc.calendar.opentimestamps.org',
  'https://bob.btc.calendar.opentimestamps.org',
  'https://finney.calendar.eternitywall.com',
];
const FREETSA_ROOT_URL = 'https://freetsa.org/files/cacert.pem';
/** SHA-256 of cacert.pem as published by FreeTSA (the certificate fingerprint is A6:37:9E:...:AA:BC). */
const FREETSA_ROOT_SHA256 = '2151b61137ffa86bf664691ba67e7da0b19f98c758e3d228d5d8ebf27e044438';
const BLOCK_APIS = ['https://blockstream.info/api', 'https://mempool.space/api'];

export interface RealManifest {
  digest: string;
  recorded: string;
  tsas: Array<{ url: string; file: string; genTime: string; path: string[] }>;
  ots?: { calendar: string; pending: string; upgraded?: string; height?: number; header?: string };
}

const digest = new Uint8Array(createHash('sha256').update('TAP-CC-ONE real fixture').digest());

// The same client the extension uses (fetch() times out on slow IPv6/IPv4 fallback).
const http: HttpClient = nodeHttpClient({ timeoutMs: 30_000, maxBytes: 4 * 1024 * 1024 });

async function get(url: string): Promise<Uint8Array> {
  const res = await http(url, { method: 'GET', headers: {} });
  if (res.status !== 200) throw new Error(`${url} answered HTTP ${res.status}`);
  return res.body;
}

/** The underlying network error (codes of every address tried, for connection failures). */
function why(e: unknown): string {
  const err = e as Error & { code?: string; errors?: Array<{ code?: string; address?: string }> };
  const parts = [err.message, err.code].filter(Boolean);
  if (err.errors) parts.push(err.errors.map((x) => `${x.address ?? '?'} ${x.code ?? ''}`).join(', '));
  return parts.join(' ') || String(e);
}

/** Calendars reachable now (only to report; the extension tries the next one on failure). */
async function probeCalendars(): Promise<void> {
  for (const calendar of CALENDARS) {
    try {
      const res = await http(calendar, { method: 'GET', headers: {} });
      console.log(`${new URL(calendar).hostname}: reachable (HTTP ${res.status})`);
    } catch (e) {
      console.log(`${new URL(calendar).hostname}: FAILED ${why(e)}`);
    }
  }
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

function loadPems(dir: string): Certificate[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.pem'))
    .flatMap((f) => pemToDer(fs.readFileSync(path.join(dir, f), 'utf8')))
    .map(parseCertificate);
}

function toPem(der: Uint8Array): string {
  const b64 = Buffer.from(der).toString('base64');
  return `-----BEGIN CERTIFICATE-----\n${b64.replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END CERTIFICATE-----\n`;
}

async function freetsaRoot(): Promise<void> {
  const file = path.join(rootsDir, 'freetsa-root.pem');
  if (fs.existsSync(file)) {
    console.log('FreeTSA root: already in roots/');
    return;
  }
  const pem = new TextDecoder().decode(await get(FREETSA_ROOT_URL));
  const cert = new X509Certificate(pem);
  const certHash = cert.fingerprint256.replace(/:/g, '').toLowerCase();
  const fileHash = createHash('sha256').update(pem).digest('hex');
  if (certHash !== FREETSA_ROOT_SHA256 && fileHash !== FREETSA_ROOT_SHA256) {
    throw new Error(
      `FreeTSA root fingerprint ${certHash} (file ${fileHash}) does not match ${FREETSA_ROOT_SHA256}: not adding it`,
    );
  }
  fs.writeFileSync(file, `${cert.toString().trim()}\n`);
  console.log(`FreeTSA root: added (${cert.subject.replace(/\n/g, ', ')}, valid to ${cert.validTo})`);
}

/** Follows the AIA "CA Issuers" link of the last certificate on an untrusted path. */
async function fetchMissingIssuer(token: Uint8Array): Promise<Uint8Array | undefined> {
  const certs = parseToken(token).certificates;
  for (const c of certs) {
    const x = new X509Certificate(c.der);
    const uri = x.infoAccess?.match(/CA Issuers - URI:(\S+)/)?.[1];
    if (!uri || certs.some((o) => Buffer.from(o.subject).equals(Buffer.from(c.issuer)))) continue;
    console.log(`    fetching the missing issuer of "${c.subjectName}" from ${uri}`);
    const body = await get(uri);
    // .crt files are DER (sometimes PEM); .p7c bundles are not handled here.
    const text = new TextDecoder().decode(body);
    return text.includes('BEGIN CERTIFICATE') ? pemToDer(text)[0] : body;
  }
  return undefined;
}

async function recordTsas(manifest: RealManifest): Promise<void> {
  const roots = loadPems(rootsDir);
  const intermediatesDir = path.join(rootsDir, 'intermediates');
  // Services already recorded are kept, so the script can be run again for the ones that failed.
  const todo = TSAS.filter((url) => !manifest.tsas.some((t) => t.url === url));
  for (const url of todo) {
    const host = new URL(url).hostname;
    try {
      const token = await requestRfc3161(http, url, digest, crypto.getRandomValues(new Uint8Array(8)));
      const file = `${slug(host)}.tst`;
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, file), token);
      let check = verifyTimestampToken(token, digest, roots, loadPems(intermediatesDir));
      if (check.status === 'untrusted') {
        const issuer = await fetchMissingIssuer(token);
        if (issuer) {
          const extra = parseCertificate(issuer);
          const retry = verifyTimestampToken(token, digest, roots, [...loadPems(intermediatesDir), extra]);
          if (retry.status === 'valid') {
            fs.mkdirSync(intermediatesDir, { recursive: true });
            fs.writeFileSync(path.join(intermediatesDir, `${slug(extra.subjectName)}.pem`), toPem(issuer));
            console.log(`    added intermediate "${extra.subjectName}" to roots/intermediates/`);
            check = retry;
          }
        }
      }
      const genTime = new Date(check.genTime ?? 0).toISOString();
      console.log(`${host}: ${check.status} ${genTime} via ${(check.path ?? []).join(' <- ')}`);
      if (check.status !== 'valid') {
        console.log(`    problem: ${check.problem}: ${check.message}`);
        for (const c of parseToken(token).certificates) {
          console.log(`    certificate: ${c.subjectName} (issuer bytes ${toHex(c.issuer).slice(0, 24)}...)`);
        }
        continue;
      }
      manifest.tsas.push({ url, file, genTime, path: check.path ?? [] });
    } catch (e) {
      console.log(`${host}: FAILED ${why(e)}`);
    }
    // Sectigo asks scripts to wait at least 15 seconds between requests.
    if (url !== todo[todo.length - 1]) await new Promise((r) => setTimeout(r, 16_000));
  }
}

async function recordOts(manifest: RealManifest): Promise<void> {
  if (manifest.ots) {
    console.log(
      `OpenTimestamps: pending proof from ${new URL(manifest.ots.calendar).hostname} already recorded`,
    );
    return;
  }
  for (const calendar of CALENDARS) {
    try {
      const token = await submitOts(http, calendar, digest);
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'ots-pending.ots'), token);
      manifest.ots = { calendar, pending: 'ots-pending.ots' };
      console.log(`${new URL(calendar).hostname}: pending OpenTimestamps proof recorded`);
      console.log('    run again with --upgrade in about 3 hours to complete it');
      return;
    } catch (e) {
      console.log(`${new URL(calendar).hostname}: FAILED ${why(e)}`);
    }
  }
}

async function blockHeader(height: number): Promise<Uint8Array> {
  for (const api of BLOCK_APIS) {
    try {
      const hash = new TextDecoder().decode(await get(`${api}/block-height/${height}`)).trim();
      const hex = new TextDecoder().decode(await get(`${api}/block/${hash}/header`)).trim();
      const header = new Uint8Array(Buffer.from(hex, 'hex'));
      if (header.length !== 80) throw new Error('header is not 80 bytes');
      // The block hash is the reversed double SHA-256 of the header.
      const h = createHash('sha256').update(createHash('sha256').update(header).digest()).digest();
      if (Buffer.from(h).reverse().toString('hex') !== hash)
        throw new Error('header does not match its hash');
      return header;
    } catch (e) {
      console.log(`    ${api}: ${(e as Error).message}`);
    }
  }
  throw new Error(`could not get the header of block ${height}`);
}

async function upgrade(manifest: RealManifest): Promise<void> {
  if (!manifest.ots) throw new Error('no pending proof recorded yet: run without --upgrade first');
  const pending = new Uint8Array(fs.readFileSync(path.join(outDir, manifest.ots.pending)));
  const up = await upgradeOts(http, pending, digest, CALENDARS);
  if (!up.complete) {
    console.log('The calendar has not reached a Bitcoin block yet. Try again in an hour or two.');
    return;
  }
  const height = summarizeOts(parseOts(up.token, digest)).bitcoin[0]!.height;
  const header = await blockHeader(height);
  fs.writeFileSync(path.join(outDir, 'ots-upgraded.ots'), up.token);
  manifest.ots = { ...manifest.ots, upgraded: 'ots-upgraded.ots', height, header: toHex(header) };
  console.log(`OpenTimestamps proof completed in Bitcoin block ${height}`);
}

async function main(): Promise<void> {
  const manifest: RealManifest = fs.existsSync(manifestPath)
    ? (JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as RealManifest)
    : { digest: toHex(digest), recorded: '', tsas: [] };
  if (process.argv.includes('--upgrade')) {
    await upgrade(manifest);
  } else {
    await freetsaRoot().catch((e: unknown) => console.log(`FreeTSA root: FAILED ${why(e)}`));
    await recordTsas(manifest);
    await recordOts(manifest);
    await probeCalendars();
    manifest.recorded ||= new Date().toISOString();
  }
  if (manifest.tsas.length === 0 && !manifest.ots) {
    console.log('\nNothing was recorded (no internet access?).');
    process.exit(1);
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\nWrote ${path.relative(process.cwd(), manifestPath)}. Next: pnpm --filter @tap/anchor roots`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
