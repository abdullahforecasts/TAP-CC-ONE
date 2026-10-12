/** Viewer state (Preact signals) and the connection to the parsing worker. */
import { signal } from '@preact/signals';
import { Engine } from './engine.js';
import type { ViewData } from './model/types.js';
import type { HostMessage, ViewerMessage, WorkerRequest, WorkerResponse } from './protocol.js';

export type Tab = 'history' | 'replay' | 'timeline' | 'composition' | 'events' | 'about';

export interface ReplayRequest {
  f: number;
  /** Start position (events applied) and, for interval replays, where to stop. */
  from: number;
  to?: number;
  autoplay: boolean;
  /** Distinguishes repeated requests for the same position. */
  nonce: number;
}

export interface Status {
  state: 'idle' | 'loading' | 'ready' | 'error';
  message?: string;
  /** Time the last parse/verify took. */
  ms?: number;
}

export const view = signal<ViewData | undefined>(undefined);
export const status = signal<Status>({ state: 'idle' });
export const title = signal('');
export const tab = signal<Tab>('history');
export const replayRequest = signal<ReplayRequest | undefined>(undefined);

let nonce = 0;
export function openReplay(f: number, from: number, to?: number, autoplay = false): void {
  const req: ReplayRequest = { f, from, autoplay, nonce: ++nonce };
  if (to !== undefined) req.to = to;
  replayRequest.value = req;
  tab.value = 'replay';
}

// ---- worker ----------------------------------------------------------------------------------

type WorkerFactory = () => Worker;
let factory: WorkerFactory | undefined;
let worker: Worker | undefined;
let engine: Engine | undefined;
/** Requests since the last load, replayed into the fallback engine if the worker fails. */
let sent: WorkerRequest[] = [];

/** Sets how the worker is created (the bundle passes the inline worker; tests pass nothing). */
export function useWorkerFactory(f: WorkerFactory | undefined): void {
  factory = f;
}

function receive(res: WorkerResponse): void {
  if (res.type === 'error') {
    status.value = { state: 'error', message: res.message };
    postToHost({ type: 'status', state: 'error', message: res.message });
    return;
  }
  view.value = res.data;
  status.value = { state: 'ready', ms: res.ms };
  postToHost({
    type: 'status',
    state: 'ready',
    verdict: res.data.report.verdict,
    entries: res.data.model.history.length,
  });
}

function fallBack(): void {
  worker?.terminate();
  worker = undefined;
  engine = new Engine();
  let last: WorkerResponse | undefined;
  for (const req of sent) last = engine.handle(req);
  if (last) receive(last);
}

function send(req: WorkerRequest): void {
  if (req.type === 'load') sent = [];
  sent.push(req);
  status.value = { ...status.value, state: view.value ? status.value.state : 'loading' };
  if (!worker && !engine) {
    try {
      if (!factory) throw new Error('no worker');
      worker = factory();
      worker.onmessage = (e: MessageEvent<WorkerResponse>) => receive(e.data);
      worker.onerror = (e) => {
        e.preventDefault();
        fallBack();
      };
    } catch {
      engine = new Engine();
    }
  }
  if (worker) worker.postMessage(req);
  else {
    const local = engine!;
    setTimeout(() => receive(local.handle(req)), 0);
  }
}

// ---- host ------------------------------------------------------------------------------------

interface VsCodeApi {
  postMessage(message: ViewerMessage): void;
}
let host: VsCodeApi | undefined;

export function connectHost(api: VsCodeApi | undefined): void {
  host = api;
}

export function postToHost(message: ViewerMessage): void {
  host?.postMessage(message);
}

export function isInEditor(): boolean {
  return host !== undefined;
}

/** Handles a message from the extension host (or the standalone page). */
export function onHostMessage(msg: HostMessage): void {
  switch (msg.type) {
    case 'log': {
      if (msg.title !== undefined) title.value = msg.title;
      const req: WorkerRequest = { type: 'load', bytes: msg.bytes };
      if (msg.submission) req.submission = msg.submission;
      if (msg.comparedWith !== undefined) req.comparedWith = msg.comparedWith;
      status.value = { state: 'loading' };
      send(req);
      break;
    }
    case 'append': {
      const req: WorkerRequest = { type: 'append', bytes: msg.bytes };
      if (msg.submission) req.submission = msg.submission;
      if (msg.comparedWith !== undefined) req.comparedWith = msg.comparedWith;
      send(req);
      break;
    }
    case 'submission':
      send({ type: 'submission', submission: msg.submission, comparedWith: msg.comparedWith });
      break;
    case 'error':
      status.value = { state: 'error', message: msg.message };
      postToHost({ type: 'status', state: 'error', message: msg.message });
      break;
  }
}

/** Resets everything (tests). */
export function resetStore(): void {
  worker?.terminate();
  worker = undefined;
  engine = undefined;
  sent = [];
  view.value = undefined;
  status.value = { state: 'idle' };
  title.value = '';
  tab.value = 'history';
  replayRequest.value = undefined;
}
