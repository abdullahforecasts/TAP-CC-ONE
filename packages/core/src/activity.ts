/**
 * Stage 7 "activity" (0.3.3): how the code was written around the edits: AI availability and the
 * student's declared choice, time away from the editor, things open outside the recorded folder,
 * terminals that could not be monitored, recorder settings, and terminal output that later
 * appeared in the code. None of this is a verdict: it points a human reviewer at what to check.
 */

import { bytesEqual as bytesSame } from './bytes.js';
import { Kind } from './constants.js';
import type { AiChoice, AiState, AnyRecord, Asset, AssetKind, OpenItem, RecordingMode } from './records.js';

export interface ActivityPeriod {
  from: number;
  to: number;
}

export interface OutsideOpen {
  k: OpenItem['k'];
  name: string;
  /** Milliseconds it was shown in an editor group. */
  visibleMs: number;
  /** Milliseconds it was open at all. */
  openMs: number;
  /** A panel of an AI extension (0.3.5). */
  ai?: boolean;
}

export interface TerminalReuse {
  /** RUN_END record holding the output. */
  seq: number;
  t: number;
  cmd: string;
  /** Code lines of the output that later appeared in the files. */
  lines: number;
  /** Code lines in the output. */
  outputLines: number;
  files: string[];
  /** Up to 5 of the matching lines, as printed. */
  sample: string[];
  /** When the lines were found in the files. */
  foundAt: number;
}

/** A file in the folder that is not recorded as text: an image, a PDF... (0.3.4). */
export interface AssetActivity {
  p: string;
  k: AssetKind;
  n: number;
  h?: Uint8Array;
  /** In a folder TAP does not record as text (.tap/, build output...): likely code (0.3.5). */
  skipped?: boolean;
  /** When it appeared: during recording (op add), or between sessions (found at a session start). */
  added?: number;
  addedSeq?: number;
  /** It appeared while recording was off. */
  addedOffline?: boolean;
  /** When it was deleted, if it was. */
  deleted?: number;
  /** Times its content changed during recording. */
  changes: number;
  /** Milliseconds it was shown in an editor tab. */
  visibleMs: number;
  /** It was already there when the first session started. */
  initial: boolean;
}

export interface ModeSwitch {
  t: number;
  seq: number;
  from: RecordingMode | undefined;
  to: RecordingMode;
}

export interface SettingChange {
  t: number;
  seq: number;
  key: string;
  from: unknown;
  to: unknown;
}

export interface ActivitySummary {
  /** Declared AI choice per session, in order (sessions without the field are skipped). */
  aiChoices: AiChoice[];
  /** Periods when AI assistance was available (on). */
  aiOn: ActivityPeriod[];
  /**
   * Periods when an assistant that can write files was available (Copilot or VS Code AI on, or an
   * agent extension; not completion-only tools such as IntelliCode) (0.3.5).
   */
  agentOn: ActivityPeriod[];
  /** Periods after AI was declared off (by the student or the course policy). */
  declaredOff: ActivityPeriod[];
  /** Periods away from the editor window (FOCUS off). */
  away: ActivityPeriod[];
  awayMs: number;
  outside: OutsideOpen[];
  unmonitoredTerminals: string[];
  terminalCommands: number;
  terminalOutside: number;
  terminalWithOutput: number;
  terminalReuse: TerminalReuse[];
  settingsChanges: SettingChange[];
  /** Recording mode of each session that had one (0.3.4). */
  modes: RecordingMode[];
  modeSwitches: ModeSwitch[];
  /** Files in the folder that are not recorded as text (0.3.4). */
  assets: AssetActivity[];
  /** Extensions installed or enabled after recording started (0.3.5). */
  extensionsAdded: ExtensionAdded[];
  /** Extensions that provide a terminal of their own, seen at any time (0.3.5). */
  terminalExtensions: string[];
  /** Panels of AI extensions shown in an editor tab (0.3.5). */
  aiPanels: OutsideOpen[];
  /** Extensions exam mode disabled, as last recorded (0.3.5). */
  blocked: string[];
}

export interface ExtensionAdded {
  t: number;
  seq: number;
  id: string;
  kind: 'ai' | 'terminal' | 'other';
  /** Found at a session start: installed while recording was off. */
  offline: boolean;
}

/** AI extensions that only complete code in the editor and do not write files themselves. */
const COMPLETION_ONLY = new Set([
  'visualstudioexptteam.vscodeintellicode',
  'supermaven.supermaven',
  'tabnine.tabnine-vscode',
  'codeium.codeium',
  'tabby.vscode-tabby',
  'ex3ndr.llama-coder',
  '10nates.ollama-autocoder',
  'huggingface.huggingface-vscode',
]);

/** Tab titles without the status marks some extensions put in front ("✓ Kilo Code"). */
export function tabTitle(name: string): string {
  return name.replace(/^[^\p{L}\p{N}._([<"'@#$~/\\-]+/u, '').trim() || name;
}

/** The recorder settings TAP ships with; anything weaker is reported. */
export const DEFAULT_RECORDER_SETTINGS = {
  'tap.record.focus': true,
  'tap.record.terminalCommands': true,
  'tap.anchoring.enabled': true,
  'tap.classify.clipboardCheckMinChars': 2,
  'tap.classify.bulkMinChars': 40,
  'tap.checkpoint.intervalSec': 300,
} as const;

/** Describes how a recorder setting value weakens recording, or undefined when it does not. */
export function weakenedSetting(key: string, value: unknown): string | undefined {
  switch (key) {
    case 'tap.record.focus':
      return value === false ? 'time away from the editor is not recorded' : undefined;
    case 'tap.record.terminalCommands':
      return value === false ? 'terminal commands are not recorded' : undefined;
    case 'tap.anchoring.enabled':
      return value === false ? 'independent timestamps are turned off' : undefined;
    case 'tap.classify.clipboardCheckMinChars':
      return typeof value === 'number' && value > 2
        ? `pastes shorter than ${value} characters look typed`
        : undefined;
    case 'tap.classify.bulkMinChars':
      return typeof value === 'number' && value > 40
        ? `insert threshold raised to ${value} (the verifier re-checks inserts itself)`
        : undefined;
    case 'tap.ignored':
      return typeof value === 'string' && value !== ''
        ? 'these weaker settings were set and TAP ignored them'
        : undefined;
    case 'tap.checkpoint.intervalSec':
      return typeof value === 'number' && value > 600 ? `checkpoints only every ${value} s` : undefined;
    default:
      return undefined;
  }
}

/** "0.3.2" < "0.3.10" etc. Non-numeric parts compare as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

const openKey = (o: OpenItem) => (o.in ? `in\u0000${o.name}` : `${o.k}\u0000${o.name}`);

/** Activity from the records alone (terminal reuse is added by the verifier's replay). */
export function summarizeActivity(records: readonly AnyRecord[]): ActivitySummary {
  const summary: ActivitySummary = {
    aiChoices: [],
    aiOn: [],
    agentOn: [],
    declaredOff: [],
    away: [],
    awayMs: 0,
    outside: [],
    unmonitoredTerminals: [],
    terminalCommands: 0,
    terminalOutside: 0,
    terminalWithOutput: 0,
    terminalReuse: [],
    settingsChanges: [],
    modes: [],
    modeSwitches: [],
    assets: [],
    extensionsAdded: [],
    terminalExtensions: [],
    aiPanels: [],
    blocked: [],
  };
  const end = records.length > 0 ? records[records.length - 1]!.t : 0;

  let aiOnSince: number | undefined;
  // AI counts as on when the recorded state says so, or when an AI extension other than Copilot is
  // enabled: chat.disableAIFeatures does not reach those, and recorders before 0.3.5 recorded
  // "off" for them in exam mode.
  let stateOn = false;
  let thirdParty = false;
  let agent = false;
  let agentSince: number | undefined;
  const update = (t: number) => {
    const on = stateOn || thirdParty;
    if (on && aiOnSince === undefined) aiOnSince = t;
    if (!on && aiOnSince !== undefined) {
      summary.aiOn.push({ from: aiOnSince, to: t });
      aiOnSince = undefined;
    }
    const agentNow = stateOn || agent;
    if (agentNow && agentSince === undefined) agentSince = t;
    if (!agentNow && agentSince !== undefined) {
      summary.agentOn.push({ from: agentSince, to: t });
      agentSince = undefined;
    }
  };
  const setAi = (state: AiState | undefined, t: number) => {
    if (!state) return;
    stateOn = state.on;
    update(t);
  };
  const setAiExt = (ids: readonly string[] | undefined, t: number) => {
    if (!ids) return;
    thirdParty = ids.some((id) => !id.toLowerCase().startsWith('github.copilot'));
    agent = ids.some(
      (id) => !id.toLowerCase().startsWith('github.copilot') && !COMPLETION_ONLY.has(id.toLowerCase()),
    );
    update(t);
  };
  const closeAi = (t: number) => {
    if (aiOnSince !== undefined) {
      summary.aiOn.push({ from: aiOnSince, to: t });
      aiOnSince = undefined;
    }
    if (agentSince !== undefined) {
      summary.agentOn.push({ from: agentSince, to: t });
      agentSince = undefined;
    }
  };

  let offSince: number | undefined;
  const setChoice = (choice: AiChoice, t: number) => {
    const off = choice === 'off' || choice === 'enforced-off';
    if (off && offSince === undefined) offSince = t;
    if (!off && offSince !== undefined) {
      summary.declaredOff.push({ from: offSince, to: t });
      offSince = undefined;
    }
  };
  const closeOff = (t: number) => {
    if (offSince !== undefined) summary.declaredOff.push({ from: offSince, to: t });
    offSince = undefined;
  };

  let awaySince: number | undefined;
  const closeAway = (t: number) => {
    if (awaySince !== undefined && t > awaySince) summary.away.push({ from: awaySince, to: t });
    awaySince = undefined;
  };

  // Open items outside the folder: current list, with times.
  const current = new Map<string, { item: OpenItem; since: number; visSince?: number }>();
  const totals = new Map<string, OutsideOpen>();
  const closeItem = (key: string, t: number) => {
    const c = current.get(key);
    if (!c) return;
    const tot = totals.get(key) ?? { k: c.item.k, name: c.item.name, visibleMs: 0, openMs: 0 };
    if (c.item.ai || isAiPanel(c.item.name)) tot.ai = true;
    tot.openMs += Math.max(0, t - c.since);
    if (c.visSince !== undefined) tot.visibleMs += Math.max(0, t - c.visSince);
    totals.set(key, tot);
    current.delete(key);
  };
  // Names of AI extensions seen in the log, to recognise their panels in older logs too.
  const aiNames = new Set<string>();
  const squash = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const isAiPanel = (name: string) => {
    const n = squash(name);
    for (const a of aiNames) if (a.length >= 4 && n.includes(a)) return true;
    return false;
  };
  const noteAi = (ids: readonly string[] | undefined) => {
    for (const id of ids ?? []) {
      const short = squash(id.split('.')[1] ?? id);
      if (short.length >= 4) aiNames.add(short);
    }
  };
  const setOpen = (raw: readonly OpenItem[], t: number) => {
    const items = raw.map((o) => (o.k === 'other' || o.k === 'web' ? { ...o, name: tabTitle(o.name) } : o));
    for (const item of items) {
      if (item.k === 'terminal' && item.mon === false && !summary.unmonitoredTerminals.includes(item.name)) {
        summary.unmonitoredTerminals.push(item.name);
      }
    }
    // Terminals are reported through their commands; only other things count as "open outside".
    // Files inside the folder that are not recorded as text count towards that file (0.3.4).
    const next = new Map(items.filter((o) => o.k !== 'terminal').map((o) => [openKey(o), o]));
    for (const key of [...current.keys()]) if (!next.has(key)) closeItem(key, t);
    for (const [key, item] of next) {
      const c = current.get(key);
      if (!c) {
        current.set(key, { item, since: t, ...(item.vis ? { visSince: t } : {}) });
        if (!totals.has(key)) totals.set(key, { k: item.k, name: item.name, visibleMs: 0, openMs: 0 });
      } else {
        if (item.vis && c.visSince === undefined) c.visSince = t;
        if (!item.vis && c.visSince !== undefined) {
          const tot = totals.get(key)!;
          tot.visibleMs += Math.max(0, t - c.visSince);
          delete c.visSince;
        }
        c.item = item;
      }
    }
  };
  const closeAllOpen = (t: number) => {
    for (const key of [...current.keys()]) closeItem(key, t);
  };

  // Files that are not recorded as text.
  const assets = new Map<string, AssetActivity>();
  let sessionIndex = 0;
  const assetSeen = (a: Asset, t: number, seq: number, initialList: boolean) => {
    const known = assets.get(a.p);
    if (a.op === 'delete') {
      if (known) known.deleted = t;
      return;
    }
    if (!known) {
      const entry: AssetActivity = { p: a.p, k: a.k, n: a.n, changes: 0, visibleMs: 0, initial: false };
      if (a.h) entry.h = a.h;
      if (a.skipped) entry.skipped = true;
      if (initialList && sessionIndex === 1) entry.initial = true;
      else {
        entry.added = t;
        entry.addedSeq = seq;
        if (initialList) entry.addedOffline = true;
      }
      assets.set(a.p, entry);
      return;
    }
    const changed = a.h && known.h ? !bytesSame(a.h, known.h) : a.n !== known.n;
    if (known.deleted !== undefined) {
      delete known.deleted;
      known.added = t;
      known.addedSeq = seq;
      if (initialList) known.addedOffline = true;
    } else if (changed) known.changes++;
    known.n = a.n;
    known.k = a.k;
    if (a.h) known.h = a.h;
  };
  const sessionAssets = (list: readonly Asset[], t: number, seq: number) => {
    const present = new Set(list.map((a) => a.p));
    if (sessionIndex > 1) {
      for (const a of assets.values()) if (a.deleted === undefined && !present.has(a.p)) a.deleted = t;
    }
    for (const a of list) assetSeen(a, t, seq, true);
  };
  let mode: RecordingMode | undefined;

  // Extensions: known set per kind, to report what was added (0.3.5).
  let known: { all: Set<string>; ai: Set<string>; term: Set<string> } | undefined;
  const termSeen = new Set<string>();
  const setExtensions = (
    b: { exts?: string[]; aiExt?: string[]; termExt?: string[] },
    t: number,
    seq: number,
    sessionStart: boolean,
  ) => {
    noteAi(b.aiExt);
    if (!b.exts && !b.aiExt && !b.termExt) return;
    for (const id of b.termExt ?? []) termSeen.add(id);
    const next = {
      all: new Set(b.exts ?? known?.all ?? []),
      ai: new Set(b.aiExt ?? known?.ai ?? []),
      term: new Set(b.termExt ?? known?.term ?? []),
    };
    for (const id of next.ai) next.all.add(id);
    for (const id of next.term) next.all.add(id);
    if (known) {
      for (const id of next.all) {
        if (known.all.has(id) || known.ai.has(id) || known.term.has(id)) continue;
        const kind = next.ai.has(id) ? 'ai' : next.term.has(id) ? 'terminal' : 'other';
        // A first exts list (older sessions recorded only AI extensions) is not "added".
        if (kind === 'other' && known.all.size === 0) continue;
        summary.extensionsAdded.push({ t, seq, id, kind, offline: sessionStart });
      }
    }
    known = next;
  };

  let settings: Record<string, unknown> = {};
  for (const rec of records) {
    switch (rec.k) {
      case Kind.SESSION_START: {
        closeAway(rec.t);
        closeAi(rec.t);
        closeAllOpen(rec.t);
        closeOff(rec.t);
        sessionIndex++;
        if (rec.b.mode) {
          if (mode !== undefined && mode !== rec.b.mode) {
            summary.modeSwitches.push({ t: rec.t, seq: rec.s, from: mode, to: rec.b.mode });
          }
          mode = rec.b.mode;
          summary.modes.push(rec.b.mode);
        }
        if (rec.b.assets) sessionAssets(rec.b.assets, rec.t, rec.s);
        setExtensions(rec.b, rec.t, rec.s, true);
        if (rec.b.blocked) summary.blocked = [...rec.b.blocked];
        if (rec.b.aiChoice) {
          summary.aiChoices.push(rec.b.aiChoice);
          setChoice(rec.b.aiChoice, rec.t);
        }
        stateOn = false;
        thirdParty = false;
        agent = false;
        setAi(rec.b.ai, rec.t);
        setAiExt(rec.b.aiExt, rec.t);
        settings = { ...(rec.b.settings ?? {}) };
        break;
      }
      case Kind.SESSION_END:
      case Kind.RECOVERY:
        closeAway(rec.t);
        closeAi(rec.t);
        closeOff(rec.t);
        closeAllOpen(rec.t);
        break;
      case Kind.FOCUS:
        if (!rec.b.on && awaySince === undefined) awaySince = rec.t;
        else if (rec.b.on) closeAway(rec.t);
        break;
      case Kind.ENV_CHANGE: {
        if (rec.b.aiChoice) {
          if (summary.aiChoices.length > 0) summary.aiChoices[summary.aiChoices.length - 1] = rec.b.aiChoice;
          else summary.aiChoices.push(rec.b.aiChoice);
          setChoice(rec.b.aiChoice, rec.t);
        }
        setAi(rec.b.ai, rec.t);
        setAiExt(rec.b.aiExt, rec.t);
        if (rec.b.open) setOpen(rec.b.open, rec.t);
        if (rec.b.mode && rec.b.mode !== mode) {
          summary.modeSwitches.push({ t: rec.t, seq: rec.s, from: mode, to: rec.b.mode });
          mode = rec.b.mode;
          if (summary.modes.length > 0) summary.modes[summary.modes.length - 1] = rec.b.mode;
          else summary.modes.push(rec.b.mode);
        }
        if (rec.b.assets) for (const a of rec.b.assets) assetSeen(a, rec.t, rec.s, false);
        setExtensions(rec.b, rec.t, rec.s, false);
        if (rec.b.blocked) summary.blocked = [...rec.b.blocked];
        if (rec.b.settings) {
          for (const [key, to] of Object.entries(rec.b.settings)) {
            const from = settings[key];
            if (JSON.stringify(from) !== JSON.stringify(to)) {
              summary.settingsChanges.push({ t: rec.t, seq: rec.s, key, from, to });
              settings[key] = to;
            }
          }
        }
        break;
      }
      case Kind.RUN_START:
        if (rec.b.kind === 'terminal') {
          summary.terminalCommands++;
          if (rec.b.outside) summary.terminalOutside++;
        }
        break;
      case Kind.RUN_END:
        if (rec.b.out !== undefined) summary.terminalWithOutput++;
        break;
      default:
        break;
    }
  }
  closeAway(end);
  closeAi(end);
  closeOff(end);
  closeAllOpen(end);
  summary.awayMs = summary.away.reduce((n, p) => n + (p.to - p.from), 0);
  // Files of the folder shown in a tab count towards that file, not as "outside".
  for (const [key, tot] of totals) {
    if (!key.startsWith('in\u0000')) continue;
    totals.delete(key);
    const a = assets.get(tot.name);
    if (a) a.visibleMs += tot.visibleMs;
  }
  const byShown = (a: OutsideOpen, b: OutsideOpen) => b.visibleMs - a.visibleMs || b.openMs - a.openMs;
  summary.aiPanels = [...totals.values()].filter((o) => o.ai).sort(byShown);
  summary.outside = [...totals.values()].filter((o) => !o.ai).sort(byShown);
  summary.terminalExtensions = [...termSeen].sort();
  summary.assets = [...assets.values()].sort((a, b) => a.p.localeCompare(b.p));
  return summary;
}

// ---------------------------------------------------------------------------------------------
// Terminal output that later appears in the code (D2)
// ---------------------------------------------------------------------------------------------

/** A line of code-looking output, whitespace removed. Short or prose-like lines are ignored. */
export function normalizeCodeLine(line: string): string | undefined {
  const n = line.replace(/\s+/g, '');
  if (n.length < 10) return undefined;
  if (!/[;{}()=<>[\]]/.test(n)) return undefined;
  return n;
}

export function codeLinesOf(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const n = normalizeCodeLine(line);
    if (n && !out.has(n)) out.set(n, line.trim());
  }
  return out;
}

/** AI may take this long to switch off after it is declared off (settings being applied). */
export const AI_OFF_GRACE_MS = 60_000;

/** Time AI was available while it was declared off, after the grace period, with the periods. */
export function aiOnWhileDeclaredOff(a: ActivitySummary): { ms: number; periods: ActivityPeriod[] } {
  const periods: ActivityPeriod[] = [];
  for (const on of a.aiOn) {
    for (const off of a.declaredOff) {
      const from = Math.max(on.from, off.from + AI_OFF_GRACE_MS);
      const to = Math.min(on.to, off.to);
      if (to > from) periods.push({ from, to });
    }
  }
  return { ms: periods.reduce((n, p) => n + (p.to - p.from), 0), periods };
}

/** Minimum matching lines (and share of the output's code lines) to report reuse. */
export const REUSE_MIN_LINES = 3;
export const REUSE_MIN_SHARE = 0.3;
/** Output is compared with the code for this long after it was printed. */
export const REUSE_WINDOW_MS = 90 * 60_000;
