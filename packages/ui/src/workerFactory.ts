// Bundled into the viewer as an inline (blob) worker: webviews only allow blob:/data: workers.
import ParseWorker from './worker.ts?worker&inline';

export function createWorker(): Worker {
  return new ParseWorker();
}
