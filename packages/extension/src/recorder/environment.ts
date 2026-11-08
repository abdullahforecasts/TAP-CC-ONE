/**
 * Extensions that can insert AI-generated code. Their presence is disclosed in SESSION_START so a
 * reader of the log knows which assistants were enabled (design §6.1). Matching is by
 * case-insensitive extension id.
 */
export const AI_ASSIST_EXTENSIONS: readonly string[] = [
  'github.copilot',
  'github.copilot-chat',
  'codeium.codeium',
  'tabnine.tabnine-vscode',
  'amazonwebservices.amazon-q-vscode',
  'amazonwebservices.aws-toolkit-vscode',
  'continue.continue',
  'sourcegraph.cody-ai',
  'supermaven.supermaven',
  'saoudrizwan.claude-dev',
  'kilocode.kilo-code',
  'rooveterinaryinc.roo-cline',
  'anthropic.claude-code',
  'openai.chatgpt',
  'google.geminicodeassist',
  'blackboxapp.blackbox',
  'blackboxapp.blackboxagent',
  'bito.bito',
  'codegpt.codegpt',
  'danielsanmedium.dscodegpt',
  'visualstudioexptteam.vscodeintellicode',
  'askcodi.askcodi-vscode',
  'qodo.qodo-gen',
  'codium.codium',
  'tabby.vscode-tabby',
  'pieces.pieces-vscode',
  // Local-model assistants (Ollama, llama.cpp, LM Studio and similar).
  'rjmacarthy.twinny',
  'ex3ndr.llama-coder',
  '10nates.ollama-autocoder',
  'privy.privy-vscode',
  'huggingface.huggingface-vscode',
];

const AI_SET = new Set(AI_ASSIST_EXTENSIONS);

/** AI-assist extension ids among the given installed, enabled extension ids (sorted). */
export function detectAiExtensions(installedIds: Iterable<string>): string[] {
  const found = new Set<string>();
  for (const id of installedIds) if (AI_SET.has(id.toLowerCase())) found.add(id.toLowerCase());
  return [...found].sort();
}

export const LIVE_SHARE_ID = 'ms-vsliveshare.vsliveshare';

/** Short, stable name of the editor application (vscode, cursor, vscodium, windsurf...). */
export function normaliseAppName(appName: string): string {
  const name = appName.toLowerCase();
  if (name.includes('cursor')) return 'cursor';
  if (name.includes('windsurf')) return 'windsurf';
  if (name.includes('vscodium')) return 'vscodium';
  if (name.includes('insiders')) return 'vscode-insiders';
  if (name.includes('visual studio code') || name === 'code') return 'vscode';
  return name.replace(/[^a-z0-9.-]+/g, '-').slice(0, 100) || 'unknown';
}

/** Whether an extension id is a known AI assistant (case-insensitive). */
export function isAiExtension(id: string): boolean {
  return AI_SET.has(id.toLowerCase());
}

/** Raw editor state that decides whether AI could show or insert code (G1, G3). */
export interface AiInputs {
  /** editor.inlineSuggest.enabled */
  inlineSuggest: boolean;
  /** chat.disableAIFeatures */
  disableAiFeatures: boolean;
  /** github.copilot.enable["*"] (true when unset) */
  copilotEnabled: boolean;
  /** Ids of AI-assist extensions that are installed and enabled. */
  installed: string[];
  /** Ids of AI-assist extensions that are active right now. */
  active: string[];
}

/**
 * AI counts as available when AI features are not turned off (chat.disableAIFeatures) and an AI
 * assistant is installed. `inline` says whether ghost-text suggestions can appear as well.
 */
export function aiStateOf(i: AiInputs): { on: boolean; inline: boolean; chat: boolean; active: string[] } {
  const chat = !i.disableAiFeatures;
  const assistant = i.installed.length > 0;
  const copilotOnly = assistant && i.installed.every((id) => id.startsWith('github.copilot'));
  const inline = chat && assistant && i.inlineSuggest && !(copilotOnly && !i.copilotEnabled);
  return { on: chat && assistant, inline, chat, active: [...i.active].sort() };
}

/** Workspace-folder settings that turn AI features off (G2, G4). */
export const AI_OFF_SETTINGS: ReadonlyArray<[section: string, key: string, value: unknown]> = [
  ['editor', 'inlineSuggest.enabled', false],
  ['chat', 'disableAIFeatures', true],
  ['github.copilot', 'enable', { '*': false }],
];

/** Workspace-folder settings that turn editor code suggestions off (exam policy "suggestions": "off"). */
export const SUGGESTIONS_OFF_SETTINGS: ReadonlyArray<[section: string, key: string, value: unknown]> = [
  ['editor', 'wordBasedSuggestions', 'off'],
  ['editor', 'snippetSuggestions', 'none'],
  ['editor', 'tabCompletion', 'off'],
  ['editor', 'suggest.showSnippets', false],
];
