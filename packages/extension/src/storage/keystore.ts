import * as fs from 'node:fs';
import * as path from 'node:path';
import { fromHex, generateKeyPair, type KeyPair, keyPairFromSeed, toHex } from '@tap/core';

/** The subset of VS Code SecretStorage the key store needs. */
export interface SecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
}

export const SECRET_KEY_NAME = 'tap.signingKey.v1';
const FILE_NAME = 'signing-key.hex';

export interface LoadedKey {
  key: KeyPair;
  source: 'secret-storage' | 'file';
  created: boolean;
}

/**
 * Loads the installation's Ed25519 signing key, creating it on first use (design §8.1).
 * The key lives in the OS keychain through VS Code SecretStorage. When that is unavailable
 * (some headless Linux setups), it falls back to a 0600 file in the extension's global storage.
 */
export async function loadOrCreateKey(secrets: SecretStore, fallbackDir: string): Promise<LoadedKey> {
  try {
    const stored = await secrets.get(SECRET_KEY_NAME);
    if (stored && /^[0-9a-f]{64}$/.test(stored)) {
      return { key: keyPairFromSeed(fromHex(stored)), source: 'secret-storage', created: false };
    }
    const fromFile = readKeyFile(fallbackDir);
    const key = fromFile ?? generateKeyPair();
    await secrets.store(SECRET_KEY_NAME, toHex(key.secretKey));
    // Read back: some secret stores accept writes but cannot persist them.
    const check = await secrets.get(SECRET_KEY_NAME);
    if (check !== toHex(key.secretKey)) throw new Error('secret storage did not keep the key');
    return { key, source: 'secret-storage', created: fromFile === undefined };
  } catch {
    const existing = readKeyFile(fallbackDir);
    if (existing) return { key: existing, source: 'file', created: false };
    const key = generateKeyPair();
    writeKeyFile(fallbackDir, key);
    return { key, source: 'file', created: true };
  }
}

function readKeyFile(dir: string): KeyPair | undefined {
  try {
    const hex = fs.readFileSync(path.join(dir, FILE_NAME), 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(hex) ? keyPairFromSeed(fromHex(hex)) : undefined;
  } catch {
    return undefined;
  }
}

function writeKeyFile(dir: string, key: KeyPair): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, FILE_NAME), toHex(key.secretKey), { mode: 0o600 });
}
