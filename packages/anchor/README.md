# @tap/anchor

RFC 3161 and OpenTimestamps clients and token verification for TAP-CC-ONE (Part 4).

- `requestRfc3161`, `submitOts`, `upgradeOts`: the network side, given any `HttpClient`. Only the
  32-byte digest (and values derived from it) is sent.
- `verifyTimestampToken`: checks an RFC 3161 token: imprint, CMS signature (RSA PKCS #1 v1.5 and
  PSS, ECDSA P-256/384/521), ESS signing-certificate binding, timeStamping usage, and the chain to a
  trusted root at the token's time. Synchronous, no WebCrypto, so it runs the same in the extension
  and in the viewer.
- `parseOts`, `serializeOts`, `summarizeOts`, `checkBitcoinHeader`: OpenTimestamps proofs.
- `createAnchorVerifier()`: plugs into `verifyLog(bytes, { anchorVerifier })` from `@tap/core`.
- `@tap/anchor/testing`: a deterministic test TSA and calendar (never trusted by default).

The token format and the verification rules are in `spec/log-format-v1.md` §6.4 and §9 stage 4.
Providers, trusted roots and how to record real answers: `docs/anchoring-providers.md`.

```
pnpm --filter @tap/anchor roots           # regenerate src/roots.generated.ts from roots/
pnpm --filter @tap/anchor roots --check   # CI: stale or expired roots
pnpm --filter @tap/anchor real            # record real TSA and calendar answers (needs internet)
```

Interoperability: `test/fixtures/openssl/` holds tokens made by OpenSSL (RSA, ECDSA P-384, RSA-PSS
chain), and OpenSSL verifies the test TSA's tokens.
