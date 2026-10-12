import { utf8 } from './bytes.js';
import { sha256 } from './hash.js';

/**
 * Comparison normalisation (spec §7): strip one leading BOM, turn every run of CRs directly before
 * an LF into nothing (so "\r\n" and "\r\r\n" become "\n"), then turn remaining lone CRs into LF.
 * Nothing else changes: no trimming, no Unicode normalisation.
 *
 * Collapsing CR runs (not just one CR) makes the result stable under the CRLF<->LF conversions
 * that Git and editors apply: normalize(convert(x)) === normalize(x) for any text x.
 */
export function normalizeText(text: string): string {
  const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return noBom.replace(/\r+\n/g, '\n').replace(/\r/g, '\n');
}

/** SHA-256 of the UTF-8 encoding of the normalised text. */
export function contentHash(text: string): Uint8Array {
  return sha256(utf8(normalizeText(text)));
}

/** Dominant line ending of a document: 'crlf' if it contains any CRLF, else 'lf'. */
export function detectEol(text: string): 'lf' | 'crlf' {
  return text.includes('\r\n') ? 'crlf' : 'lf';
}

/** True when the string contains no lone UTF-16 surrogates. */
export function isWellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Replaces lone surrogates with U+FFFD (same result as String.prototype.toWellFormed). */
export function toWellFormed(text: string): string {
  if (isWellFormed(text)) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i]! + text[i + 1]!;
        i++;
      } else {
        out += '�';
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      out += '�';
    } else {
      out += text[i]!;
    }
  }
  return out;
}

export function countCodePoints(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

const WS = /\s/u;

/** Number of non-whitespace UTF-16 code units in a string. */
export function countNonWhitespace(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (!WS.test(text[i]!)) n++;
  return n;
}
