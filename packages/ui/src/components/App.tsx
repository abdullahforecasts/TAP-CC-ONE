import { isInEditor, onHostMessage, status, type Tab, tab, title, view } from '../store.js';
import { About } from './About.js';
import { Composition } from './Composition.js';
import { Events } from './Events.js';
import { Integrity } from './Integrity.js';
import { Replay } from './Replay.js';
import { SaveHistory } from './SaveHistory.js';
import { Timeline } from './Timeline.js';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'history', label: 'Save History' },
  { id: 'replay', label: 'Replay' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'composition', label: 'Composition' },
  { id: 'events', label: 'Events' },
  { id: 'about', label: 'About this log' },
];

export async function openFile(file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  onHostMessage({ type: 'log', bytes, title: file.name });
}

function Start() {
  const st = status.value;
  if (isInEditor()) {
    return (
      <div class="start">
        {st.state === 'error' ? <p class="problem">{st.message}</p> : <p class="muted">Reading the log…</p>}
      </div>
    );
  }
  return (
    <div class="start">
      <h1>TAP-CC-ONE log viewer</h1>
      <p>
        Open a <code>.codelog</code> file to see its save history, replay it and check that it is intact.
      </p>
      <p class="muted">The file is read in this page only; nothing is uploaded.</p>
      <label class="button">
        Open a log…
        <input
          type="file"
          accept=".codelog"
          data-testid="open-log"
          onChange={(e) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (file) void openFile(file);
          }}
        />
      </label>
      {st.state === 'loading' && <p class="muted">Reading the log…</p>}
      {st.state === 'error' && <p class="problem">{st.message}</p>}
    </div>
  );
}

export function App() {
  const data = view.value;
  if (!data) return <Start />;
  const { model, report } = data;
  const current = tab.value;
  const heading = title.value || model.header?.label || 'Authorship log';
  return (
    <div class="app">
      <header class="top">
        <h1>{heading}</h1>
        <span class="muted">
          {model.header?.label && title.value && `${model.header.label} · `}
          {status.value.state === 'loading'
            ? 'updating…'
            : status.value.ms !== undefined
              ? `read in ${status.value.ms} ms`
              : ''}
        </span>
      </header>
      <Integrity
        report={report}
        comparedWith={data.comparedWith}
        readable={{ records: model.recordCount, sessions: model.sessions.length }}
      />
      {model.problem && (
        <p class="problem" role="alert">
          Part of the log could not be read: {model.problem}. Everything before that point is shown.
        </p>
      )}
      <div class="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={current === t.id}
            class={current === t.id ? 'active' : ''}
            onClick={() => {
              tab.value = t.id;
            }}
            data-testid={`tab-${t.id}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <main role="tabpanel">
        {current === 'history' && <SaveHistory model={model} />}
        {current === 'replay' && <Replay model={model} />}
        {current === 'timeline' && <Timeline model={model} />}
        {current === 'composition' && <Composition data={data} />}
        {current === 'events' && <Events model={model} />}
        {current === 'about' && <About data={data} />}
      </main>
    </div>
  );
}
