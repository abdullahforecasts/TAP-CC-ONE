/**
 * Viewer entry point. In VS Code it talks to the extension host through acquireVsCodeApi();
 * opened as a plain page it offers a file picker (and accepts the same messages, for tests).
 */
import { render } from 'preact';
import { App, openFile } from './components/App.js';
import type { HostMessage } from './protocol.js';
import { connectHost, onHostMessage, postToHost, useWorkerFactory } from './store.js';
import { createWorker } from './workerFactory.js';
import './styles.css';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

useWorkerFactory(createWorker);
const api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
connectHost(api);

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  if (msg && typeof msg === 'object' && 'type' in msg) onHostMessage(msg);
});

if (!api) {
  // Standalone page: dropping a .codelog file anywhere opens it.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (file) void openFile(file);
  });
}

const root = document.getElementById('app') ?? document.body.appendChild(document.createElement('div'));
render(<App />, root);
postToHost({ type: 'ready' });
