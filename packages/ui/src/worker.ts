/// <reference lib="webworker" />
import { Engine } from './engine.js';
import type { WorkerRequest } from './protocol.js';

const engine = new Engine();
const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  scope.postMessage(engine.handle(event.data));
};
