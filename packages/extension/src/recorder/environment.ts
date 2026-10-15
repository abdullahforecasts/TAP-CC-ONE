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
