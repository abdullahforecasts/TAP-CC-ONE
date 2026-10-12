import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8 } from './bytes.js';
import { DS_GENESIS, DS_RECORD } from './constants.js';

export function sha256(bytes: Uint8Array): Uint8Array {
  return nobleSha256(bytes);
}

/** Domain separator: UTF-8 bytes of the label followed by a single 0x00 byte. */
export function ds(label: string): Uint8Array {
  return concatBytes(utf8(label), new Uint8Array([0]));
}

const DS_GENESIS_BYTES = ds(DS_GENESIS);
const DS_RECORD_BYTES = ds(DS_RECORD);

/** genesis = SHA-256(DS("CLG1/genesis") || canonical(header)) */
export function genesisHash(canonicalHeader: Uint8Array): Uint8Array {
  return sha256(concatBytes(DS_GENESIS_BYTES, canonicalHeader));
}

/** H(rec) = SHA-256(DS("CLG1/record") || canonical(rec)) */
export function recordHash(canonicalRecord: Uint8Array): Uint8Array {
  return sha256(concatBytes(DS_RECORD_BYTES, canonicalRecord));
}
