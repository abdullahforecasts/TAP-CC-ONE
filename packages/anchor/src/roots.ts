import { INTERMEDIATE_PEMS, ROOT_PEMS } from './roots.generated.js';
import { type Certificate, parseCertificate, pemToDer } from './x509.js';

let roots: Certificate[] | undefined;
let intermediates: Certificate[] | undefined;

/** The bundled trusted TSA roots (parsed once). */
export function trustedRoots(): Certificate[] {
  roots ??= ROOT_PEMS.flatMap(pemToDer).map(parseCertificate);
  return roots;
}

/** Bundled intermediate CAs some TSAs leave out of their tokens (parsed once). Not trusted alone. */
export function trustedIntermediates(): Certificate[] {
  intermediates ??= INTERMEDIATE_PEMS.flatMap(pemToDer).map(parseCertificate);
  return intermediates;
}

/** Parses extra roots (PEM text), e.g. a test TSA's root. */
export function rootsFromPem(pem: string): Certificate[] {
  return pemToDer(pem).map(parseCertificate);
}
