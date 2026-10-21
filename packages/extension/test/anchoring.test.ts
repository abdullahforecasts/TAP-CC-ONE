import { createAnchorVerifier, parseTimeStampReq, verifyTimestampToken } from '@tap/anchor';
import { TEST_CALENDAR, testBitcoinUpgrade, testPendingOts, testTsa } from '@tap/anchor/testing';
import { type AnchorBody, toHex, verifyLog } from '@tap/core';
import { describe, expect, it } from 'vitest';
import { AnchorService, type AnchorServiceDeps } from '../src/anchoring/anchorService.js';
import { Sim } from './support/sim.js';

const tsa = testTsa();

/** Test doubles: a clock, a network that can be switched off, a queue file in memory. */
function harness(options: { online?: boolean; untrusted?: string } = {}) {
  const state = {
    now: Date.UTC(2026, 9, 21, 9, 0, 0),
    online: options.online ?? true,
    file: undefined as string | undefined,
  };
  const requests: string[] = [];
  const deps: AnchorServiceDeps = {
    now: () => state.now,
    random: (n) => new Uint8Array(n).fill(7),
    load: () => state.file,
    save: (json) => {
      state.file = json;
    },
    log: () => {},
    config: () => ({
      enabled: true,
      tsas: ['http://tsa-a.test', 'http://tsa-b.test', 'http://tsa-c.test'],
      calendars: [TEST_CALENDAR],
    }),
    http: async (url, init) => {
      requests.push(`${init.method} ${url}`);
      if (!state.online) throw new Error('getaddrinfo ENOTFOUND');
      if (url.startsWith('http://tsa-')) {
        // Echo a token for the requested digest and nonce.
        const req = parseTimeStampReq(init.body!);
        // The `untrusted` TSA signs with a certificate that does not chain to the test root.
        const opts = url === options.untrusted ? { viaIntermediate: true } : {};
        return {
          status: 200,
          body: tsa.response(
            tsa.token({ digest: req.digest, genTime: state.now + 1000, nonce: req.nonce!, ...opts }),
          ),
        };
      }
      if (url.endsWith('/digest')) return { status: 200, body: testPendingOts(init.body!).token };
      return { status: 404, body: new Uint8Array() };
    },
    checkToken: (token, digest) => verifyTimestampToken(token, digest, tsa.roots),
  };
  return { state, requests, deps };
}

function sink() {
  const written: AnchorBody[] = [];
  return {
    written,
    appendAnchor: async (b: AnchorBody) => {
      written.push(b);
      return true;
    },
  };
}

describe('anchor service', () => {
  const d = new Uint8Array(32).fill(1);

  it('timestamps a checkpoint with two TSAs in turn and one calendar', async () => {
    const h = harness();
    const s = new AnchorService(h.deps);
    const out = sink();
    s.register('log1', out);
    s.anchor('log1', 5, d);
    expect(await s.waitFor('log1', 5, 5000)).toBe(2);
    await s.process();
    expect(out.written.map((w) => `${w.type}:${w.src}:${w.status}`).sort()).toEqual([
      `ots:${TEST_CALENDAR}:pending`,
      'rfc3161:http://tsa-a.test:complete',
      'rfc3161:http://tsa-b.test:complete',
    ]);
    expect(s.outstanding('log1')).toBe(0);
    s.anchor('log1', 9, d);
    await s.waitFor('log1', 9, 5000);
    expect(out.written.filter((w) => w.ck === 9 && w.type === 'rfc3161').map((w) => w.src)).toEqual([
      'http://tsa-b.test',
      'http://tsa-c.test',
    ]);
  });

  it('drops a token that would not verify and asks another TSA', async () => {
    const h = harness({ untrusted: 'http://tsa-a.test' });
    const s = new AnchorService(h.deps);
    const out = sink();
    s.register('log1', out);
    s.anchor('log1', 5, d);
    expect(await s.waitFor('log1', 5, 5000)).toBe(2);
    expect(
      out.written
        .filter((w) => w.type === 'rfc3161')
        .map((w) => w.src)
        .sort(),
    ).toEqual(['http://tsa-b.test', 'http://tsa-c.test']);
    // With no other TSA left to try, the request is given up instead of retried for days.
    const h2 = harness({ untrusted: 'http://tsa-a.test' });
    h2.deps.config = () => ({
      enabled: true,
      tsas: ['http://tsa-a.test', 'http://tsa-b.test'],
      calendars: [],
    });
    const s2 = new AnchorService(h2.deps);
    const out2 = sink();
    s2.register('log1', out2);
    s2.anchor('log1', 5, d);
    expect(await s2.waitFor('log1', 5, 5000)).toBe(2);
    expect(out2.written.map((w) => w.src)).toEqual(['http://tsa-b.test']);
    expect(s2.outstanding()).toBe(0);
  });

  it('moves an OpenTimestamps submission to the next calendar when one is unreachable', async () => {
    const h = harness();
    h.deps.config = () => ({
      enabled: true,
      tsas: ['http://tsa-a.test'],
      calendars: ['https://down.test.invalid', TEST_CALENDAR],
    });
    const http = h.deps.http;
    h.deps.http = async (url, init) => {
      if (url.startsWith('https://down.test.invalid')) throw new Error('fetch failed');
      return http(url, init);
    };
    const s = new AnchorService(h.deps);
    const out = sink();
    s.register('log1', out);
    s.anchor('log1', 5, d);
    await s.process();
    expect(out.written.filter((w) => w.type === 'ots')).toEqual([]);
    h.state.now += 60 * 60_000;
    await s.process();
    expect(out.written.filter((w) => w.type === 'ots').map((w) => w.src)).toEqual([TEST_CALENDAR]);
  });

  it('queues while offline, survives a restart, and delivers when back online', async () => {
    const h = harness({ online: false });
    const s1 = new AnchorService(h.deps);
    s1.anchor('log1', 3, d);
    await s1.process();
    expect(s1.outstanding('log1')).toBe(3);
    expect(JSON.parse(h.state.file!).jobs[0].lastError).toMatch(/ENOTFOUND/);
    // Restart: a new service reads the queue file.
    const s2 = new AnchorService(h.deps);
    expect(s2.outstanding()).toBe(3);
    h.state.online = true;
    await s2.process();
    expect(s2.outstanding()).toBe(3); // still in backoff
    h.state.now += 60 * 60_000;
    await s2.process();
    // Network done, but no log is open to take the records yet.
    expect(s2.outstanding()).toBe(3);
    const out = sink();
    s2.register('log1', out);
    await s2.process();
    expect(out.written.filter((w) => w.type === 'rfc3161')).toHaveLength(2);
    expect(s2.outstanding()).toBe(0);
  });

  it('switches to another TSA after a failure', async () => {
    const h = harness();
    const base = h.deps.http;
    h.deps.http = async (url, init) =>
      url.includes('tsa-a') ? { status: 503, body: new Uint8Array() } : base(url, init);
    const s = new AnchorService(h.deps);
    const out = sink();
    s.register('log1', out);
    s.anchor('log1', 1, d);
    await s.waitFor('log1', 1, 5000);
    expect(
      out.written
        .filter((w) => w.type === 'rfc3161')
        .map((w) => w.src)
        .sort(),
    ).toEqual(['http://tsa-b.test', 'http://tsa-c.test']);
  });

  it('upgrades a pending OpenTimestamps proof when the calendar has it in a block', async () => {
    const h = harness();
    const s = new AnchorService(h.deps);
    const out = sink();
    s.register('log1', out);
    s.anchor('log1', 2, d);
    await s.waitFor('log1', 2, 5000);
    await s.process();
    const { commitment } = testPendingOts(d);
    const { upgrade } = testBitcoinUpgrade(commitment, 920_000, h.state.now);
    const base = h.deps.http;
    h.deps.http = async (url, init) =>
      url.endsWith(`/timestamp/${toHex(commitment)}`) ? { status: 200, body: upgrade } : base(url, init);
    await s.process();
    expect(out.written.some((w) => w.type === 'ots' && w.status === 'upgraded')).toBe(false); // first try after 2 h
    h.state.now += 3 * 3_600_000;
    await s.process();
    expect(out.written.filter((w) => w.type === 'ots').map((w) => w.status)).toEqual(['pending', 'upgraded']);
    expect(s.outstanding()).toBe(0);
  });

  it('tries upgrades at once when asked (session start, export)', async () => {
    const h = harness();
    const s = new AnchorService(h.deps);
    s.register('log1', sink());
    s.anchor('log1', 2, d);
    await s.waitFor('log1', 2, 5000);
    await s.process();
    h.requests.length = 0;
    s.upgradeNow('log1');
    await s.process();
    expect(h.requests).toEqual([`GET ${TEST_CALENDAR}/timestamp/${toHex(testPendingOts(d).commitment)}`]);
  });

  it('does nothing when anchoring is turned off', () => {
    const h = harness();
    h.deps.config = () => ({ enabled: false, tsas: ['http://tsa-a.test'], calendars: [] });
    const s = new AnchorService(h.deps);
    s.anchor('log1', 1, d);
    expect(s.outstanding()).toBe(0);
  });
});

describe('recorder and anchoring', () => {
  it('anchors the newest checkpoint, writing one only when something changed', async () => {
    const sim = new Sim();
    sim.host.disk.set('a.c', '');
    await sim.start();
    sim.open('a.c');
    sim.type('a.c', 0, 'int x;');
    const ck1 = await sim.recorder.checkpointNow();
    expect(ck1).toBeDefined();
    const again = await sim.recorder.checkpointNow();
    expect(again!.s).toBe(ck1!.s);
    expect(
      await sim.recorder.appendAnchor({
        ck: ck1!.s,
        d: ck1!.hash,
        type: 'rfc3161',
        src: 'http://tsa.test',
        tok: tsa.token({ digest: ck1!.hash, genTime: ck1!.t + 500 }),
        status: 'complete',
      }),
    ).toBe(true);
    // An anchor is not activity: no new checkpoint.
    expect((await sim.recorder.checkpointNow())!.s).toBe(ck1!.s);
    await sim.recorder.stop();
    expect(
      await sim.recorder.appendAnchor({
        ck: 0,
        d: ck1!.hash,
        type: 'rfc3161',
        src: 'x',
        tok: new Uint8Array(1),
        status: 'complete',
      }),
    ).toBe(false);
    const report = verifyLog(sim.bytes, { anchorVerifier: createAnchorVerifier({ roots: tsa.roots }) });
    expect(report.anchoring?.anchoredCheckpoints).toBe(1);
    expect(report.findings.filter((f) => f.stage === 'anchors').map((f) => f.code)).toEqual(['ANCHORS_OK']);
  });
});
