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
 * AI counts as available when VS Code's own AI (Copilot, built-in chat) is not turned off by
 * chat.disableAIFeatures, or when ANY other AI extension is enabled: that setting does not reach
 * third-party assistants (Kilo Code, Cline, Continue, Codeium...), so their presence alone means
 * AI could be used (0.3.5). `inline` says whether ghost-text suggestions can appear as well.
 */
export function aiStateOf(i: AiInputs): { on: boolean; inline: boolean; chat: boolean; active: string[] } {
  const chat = !i.disableAiFeatures;
  const copilot = i.installed.filter((id) => id.startsWith('github.copilot'));
  const others = i.installed.filter((id) => !id.startsWith('github.copilot'));
  const copilotOn = chat && copilot.length > 0;
  const inline = i.inlineSuggest && ((copilotOn && i.copilotEnabled) || others.length > 0);
  return { on: copilotOn || others.length > 0, inline, chat, active: [...i.active].sort() };
}

/** What a VS Code extension tells about itself (its package.json). */
export interface ExtensionFacts {
  id: string;
  builtin: boolean;
  displayName?: string;
  description?: string;
  categories?: string[];
  keywords?: string[];
  /** contributes.chatParticipants / languageModelTools / languageModels */
  contributesAi?: boolean;
  /** contributes.terminal (terminal profiles) */
  contributesTerminal?: boolean;
}

/** Terminal extensions known to run commands outside VS Code's own terminal. */
export const TERMINAL_EXTENSIONS: readonly string[] = [
  'portaterm.portaterm',
  'teranis.terminal-tabs',
  'tyriar.terminal-tabs',
  'formulahendry.terminal',
  'jeff-hykin.better-terminal',
  'reloadedextensions.reloaded-terminal',
];
const TERMINAL_SET = new Set(TERMINAL_EXTENSIONS);

/** Publishers of language support whose terminal profiles are not a way around recording. */
const LANGUAGE_PUBLISHERS = new Set([
  'ms-vscode',
  'ms-python',
  'ms-toolsai',
  'ms-dotnettools',
  'ms-vscode-remote',
  'redhat',
  'vscjava',
  'golang',
  'rust-lang',
  'llvm-vs-code-extensions',
  'formulahendry',
  'danielpinto8zz6',
  'franneck94',
]);

const AI_WORDS =
  /\b(ai|llm|llms|gpt|chatgpt|openai|copilot|claude|anthropic|gemini|ollama|deepseek|mistral|codegen|agentic|ai-agent|autocomplete-ai)\b/i;

/**
 * Whether an extension is an AI assistant or a terminal of its own (0.3.5): the known lists, the
 * marketplace categories "AI" and "Chat", AI contributions (chat participants, language model
 * tools), AI keywords, and terminal profiles or a terminal-like name.
 */
export function toolKind(e: ExtensionFacts): 'ai' | 'terminal' | undefined {
  const id = e.id.toLowerCase();
  if (e.builtin || id === 'abdullahforecasts.tap-cc-one') return undefined;
  if (AI_SET.has(id)) return 'ai';
  if (TERMINAL_SET.has(id)) return 'terminal';
  const categories = (e.categories ?? []).map((c) => c.toLowerCase());
  if (categories.includes('ai') || categories.includes('chat') || e.contributesAi) return 'ai';
  const words = [...(e.keywords ?? []), e.displayName ?? ''].join(' ');
  if (AI_WORDS.test(words)) return 'ai';
  const publisher = id.split('.')[0] ?? '';
  if (!LANGUAGE_PUBLISHERS.has(publisher)) {
    const name = `${e.displayName ?? ''} ${id.split('.')[1] ?? ''}`;
    if (e.contributesTerminal || /term(inal)?\b|\bterm|\bpty\b|\bshell\b/i.test(name)) return 'terminal';
  }
  return undefined;
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
