/**
 * A small in-memory stand-in for the `vscode` module, implementing the parts of the API the
 * extension uses with VS Code's semantics (events, documents with offsets, dirty state, saves,
 * reloads from disk, file watchers, commands, state stores, secret storage).
 *
 * It lets the whole extension (activation, commands, status bar, FolderSession wiring) run in
 * unit tests. Real-editor behaviour is covered separately by the integration tests that run in
 * VS Code itself (test-integration/).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

type Listener<T> = (e: T) => unknown;

export class EventEmitter<T> {
  private listeners = new Set<Listener<T>>();
  event = (listener: Listener<T>): Disposable => {
    this.listeners.add(listener);
    return new Disposable(() => this.listeners.delete(listener));
  };
  fire(e: T): void {
    for (const l of [...this.listeners]) l(e);
  }
  get count(): number {
    return this.listeners.size;
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export class Disposable {
  constructor(private readonly fn: () => unknown = () => {}) {}
  dispose(): void {
    this.fn();
  }
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly fsPath: string,
  ) {}
  static file(p: string): Uri {
    return new Uri('file', path.resolve(p));
  }
  static from(parts: { scheme: string; path: string }): Uri {
    return new Uri(parts.scheme, parts.path);
  }
  get path(): string {
    return this.fsPath.split(path.sep).join('/');
  }
  toString(): string {
    return `${this.scheme}://${this.path}`;
  }
}

export class RelativePattern {
  constructor(
    readonly base: unknown,
    readonly pattern: string,
  ) {}
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum TextDocumentChangeReason {
  Undo = 1,
  Redo = 2,
}

export const version = '1.105.0-fake';

// ---------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------

export interface FakeChange {
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

export class TextDocument {
  isClosed = false;
  isDirty = false;
  constructor(
    readonly uri: Uri,
    private text: string,
  ) {}
  getText(): string {
    return this.text;
  }
  /** Applies simultaneous changes (relative to the current text). */
  apply(changes: FakeChange[]): void {
    const sorted = [...changes].sort((a, b) => a.rangeOffset - b.rangeOffset);
    let out = '';
    let pos = 0;
    for (const c of sorted) {
      out += this.text.slice(pos, c.rangeOffset) + c.text;
      pos = c.rangeOffset + c.rangeLength;
    }
    this.text = out + this.text.slice(pos);
  }
  setText(text: string): void {
    this.text = text;
  }
}

const emitters = {
  change: new EventEmitter<{
    document: TextDocument;
    contentChanges: FakeChange[];
    reason: TextDocumentChangeReason | undefined;
  }>(),
  willSave: new EventEmitter<{ document: TextDocument }>(),
  didSave: new EventEmitter<TextDocument>(),
  open: new EventEmitter<TextDocument>(),
  create: new EventEmitter<{ files: Uri[] }>(),
  delete: new EventEmitter<{ files: Uri[] }>(),
  rename: new EventEmitter<{ files: Array<{ oldUri: Uri; newUri: Uri }> }>(),
  folders: new EventEmitter<{ added: WorkspaceFolder[]; removed: WorkspaceFolder[] }>(),
  windowState: new EventEmitter<{ focused: boolean }>(),
  debugStart: new EventEmitter<{ id: string; name: string; workspaceFolder?: WorkspaceFolder }>(),
  debugEnd: new EventEmitter<{ id: string; name: string }>(),
  taskStart: new EventEmitter<{ execution: { task: { name: string; scope: unknown } } }>(),
  taskEnd: new EventEmitter<{
    execution: { task: { name: string; scope: unknown } };
    exitCode: number | undefined;
  }>(),
  extensions: new EventEmitter<void>(),
};

export interface WorkspaceFolder {
  uri: Uri;
  name: string;
  index: number;
}

class FileSystemWatcher extends Disposable {
  readonly create = new EventEmitter<Uri>();
  readonly change = new EventEmitter<Uri>();
  readonly delete = new EventEmitter<Uri>();
  onDidCreate = this.create.event;
  onDidChange = this.change.event;
  onDidDelete = this.delete.event;
  constructor(readonly root: string) {
    super(() => watchers.delete(this));
  }
}
const watchers = new Set<FileSystemWatcher>();

const configuration = new Map<string, unknown>();

export const workspace = {
  workspaceFolders: [] as WorkspaceFolder[] | undefined,
  textDocuments: [] as TextDocument[],
  onDidChangeTextDocument: emitters.change.event,
  onWillSaveTextDocument: emitters.willSave.event,
  onDidSaveTextDocument: emitters.didSave.event,
  onDidOpenTextDocument: emitters.open.event,
  onDidCreateFiles: emitters.create.event,
  onDidDeleteFiles: emitters.delete.event,
  onDidRenameFiles: emitters.rename.event,
  onDidChangeWorkspaceFolders: emitters.folders.event,
  createFileSystemWatcher(pattern: RelativePattern): FileSystemWatcher {
    const base = pattern.base as WorkspaceFolder;
    const w = new FileSystemWatcher(base.uri.fsPath);
    watchers.add(w);
    return w;
  },
  getConfiguration(section: string) {
    return {
      get<T>(key: string, fallback?: T): T {
        const full = `${section}.${key}`;
        return (configuration.has(full) ? configuration.get(full) : fallback) as T;
      },
    };
  },
};

// ---------------------------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------------------------

export interface Message {
  kind: 'info' | 'warning' | 'error';
  text: string;
  items: string[];
}

class StatusBarItem {
  text = '';
  tooltip: string | undefined;
  command: string | undefined;
  name: string | undefined;
  backgroundColor: ThemeColor | undefined;
  visible = false;
  show() {
    this.visible = true;
  }
  hide() {
    this.visible = false;
  }
  dispose() {
    this.visible = false;
  }
}

class LogChannel {
  lines: string[] = [];
  info = (m: string) => this.lines.push(`info ${m}`);
  warn = (m: string) => this.lines.push(`warn ${m}`);
  error = (m: string) => this.lines.push(`error ${m}`);
  show() {}
  dispose() {}
}

export const ui = {
  messages: [] as Message[],
  /** Answer the next message/quick pick/input box with these values (FIFO). */
  answers: [] as Array<string | undefined>,
  statusItems: [] as StatusBarItem[],
  channels: [] as LogChannel[],
};

function answer(kind: Message['kind']) {
  return async (text: string, ...items: unknown[]) => {
    const labels = items.filter((i): i is string => typeof i === 'string');
    ui.messages.push({ kind, text, items: labels });
    return labels.length > 0 ? ui.answers.shift() : undefined;
  };
}

export const window = {
  state: { focused: true },
  onDidChangeWindowState: emitters.windowState.event,
  createStatusBarItem(): StatusBarItem {
    const item = new StatusBarItem();
    ui.statusItems.push(item);
    return item;
  },
  createOutputChannel(): LogChannel {
    const c = new LogChannel();
    ui.channels.push(c);
    return c;
  },
  showInformationMessage: answer('info'),
  showWarningMessage: answer('warning'),
  showErrorMessage: answer('error'),
  async showQuickPick<T extends { label: string }>(items: T[]): Promise<T | undefined> {
    const want = ui.answers.shift();
    return items.find((i) => i.label === want || i.label.includes(want ?? '\u0000'));
  },
  async showInputBox(options: {
    validateInput?: (v: string) => string | undefined;
  }): Promise<string | undefined> {
    const value = ui.answers.shift();
    if (value !== undefined && options.validateInput?.(value)) return undefined;
    return value;
  },
};

// ---------------------------------------------------------------------------------------------
// Env, commands, debug, tasks, extensions
// ---------------------------------------------------------------------------------------------

export const env = {
  appName: 'Visual Studio Code',
  sessionId: 'session-1',
  clipboard: {
    value: '',
    async readText(): Promise<string> {
      return env.clipboard.value;
    },
    async writeText(v: string): Promise<void> {
      env.clipboard.value = v;
    },
  },
};

const commandRegistry = new Map<string, (...args: unknown[]) => unknown>();
export const commands = {
  registerCommand(id: string, fn: (...args: unknown[]) => unknown): Disposable {
    if (commandRegistry.has(id)) throw new Error(`command ${id} already registered`);
    commandRegistry.set(id, fn);
    return new Disposable(() => commandRegistry.delete(id));
  },
  async executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
    const fn = commandRegistry.get(id);
    if (!fn) throw new Error(`command ${id} not found`);
    return fn(...args);
  },
};

export const debug = {
  onDidStartDebugSession: emitters.debugStart.event,
  onDidTerminateDebugSession: emitters.debugEnd.event,
};

export const tasks = {
  onDidStartTaskProcess: emitters.taskStart.event,
  onDidEndTaskProcess: emitters.taskEnd.event,
};

export const extensions = {
  all: [] as Array<{ id: string }>,
  getExtension(id: string) {
    return extensions.all.find((e) => e.id.toLowerCase() === id.toLowerCase());
  },
  onDidChange: emitters.extensions.event,
};

// ---------------------------------------------------------------------------------------------
// Test driver: behaves like a user and the file system
// ---------------------------------------------------------------------------------------------

class Memento {
  private map = new Map<string, unknown>();
  get<T>(key: string, fallback?: T): T | undefined {
    return (this.map.has(key) ? this.map.get(key) : fallback) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
}

export interface FakeContext {
  subscriptions: Array<{ dispose(): unknown }>;
  globalState: Memento;
  workspaceState: Memento;
  globalStorageUri: Uri;
  secrets: { get(k: string): Promise<string | undefined>; store(k: string, v: string): Promise<void> };
  extension: { packageJSON: { version: string } };
}

export const driver = {
  emitters,
  watchers,
  configuration,

  reset(): void {
    workspace.workspaceFolders = [];
    workspace.textDocuments = [];
    ui.messages.length = 0;
    ui.answers.length = 0;
    ui.statusItems.length = 0;
    ui.channels.length = 0;
    configuration.clear();
    commandRegistry.clear();
    extensions.all = [];
    env.clipboard.value = '';
    env.sessionId = 'session-1';
    window.state.focused = true;
    for (const e of Object.values(emitters)) e.dispose();
    watchers.clear();
  },

  context(storageDir: string, secretStore = new Map<string, string>()): FakeContext {
    return {
      subscriptions: [],
      globalState: new Memento(),
      workspaceState: new Memento(),
      globalStorageUri: Uri.file(storageDir),
      secrets: {
        async get(k) {
          return secretStore.get(k);
        },
        async store(k, v) {
          secretStore.set(k, v);
        },
      },
      extension: { packageJSON: { version: '0.1.0' } },
    };
  },

  addFolder(dir: string, name = path.basename(dir)): WorkspaceFolder {
    const folder = { uri: Uri.file(dir), name, index: workspace.workspaceFolders!.length };
    workspace.workspaceFolders!.push(folder);
    return folder;
  },

  open(file: string): TextDocument {
    const uri = Uri.file(file);
    let doc = workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath && !d.isClosed);
    if (doc) return doc;
    doc = new TextDocument(uri, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
    workspace.textDocuments.push(doc);
    emitters.open.fire(doc);
    return doc;
  },

  close(doc: TextDocument): void {
    doc.isClosed = true;
    workspace.textDocuments = workspace.textDocuments.filter((d) => d !== doc);
  },

  edit(doc: TextDocument, changes: FakeChange[], reason?: TextDocumentChangeReason): void {
    doc.apply(changes);
    doc.isDirty = true;
    emitters.change.fire({ document: doc, contentChanges: changes, reason });
  },

  type(doc: TextDocument, text: string, at = doc.getText().length): void {
    let pos = at;
    for (const ch of text) {
      driver.edit(doc, [{ rangeOffset: pos, rangeLength: 0, text: ch }]);
      pos += ch.length;
    }
  },

  async paste(doc: TextDocument, text: string, at = doc.getText().length): Promise<void> {
    await env.clipboard.writeText(text);
    driver.edit(doc, [{ rangeOffset: at, rangeLength: 0, text }]);
  },

  save(doc: TextDocument): void {
    emitters.willSave.fire({ document: doc });
    fs.writeFileSync(doc.uri.fsPath, doc.getText());
    doc.isDirty = false;
    emitters.didSave.fire(doc);
    driver.watch(doc.uri.fsPath, 'change');
  },

  /** Another program writes a file: clean open documents reload like in VS Code. */
  externalWrite(file: string, text: string): void {
    const existed = fs.existsSync(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    const doc = workspace.textDocuments.find((d) => d.uri.fsPath === path.resolve(file));
    if (doc && !doc.isDirty) {
      const old = doc.getText();
      doc.setText(text);
      emitters.change.fire({
        document: doc,
        contentChanges: [{ rangeOffset: 0, rangeLength: old.length, text }],
        reason: undefined,
      });
    }
    driver.watch(file, existed ? 'change' : 'create');
  },

  watch(file: string, kind: 'create' | 'change' | 'delete'): void {
    const abs = path.resolve(file);
    for (const w of watchers) if (abs.startsWith(w.root + path.sep)) w[kind].fire(Uri.file(abs));
  },
};
