# Timestamp providers

TAP-CC-ONE timestamps each checkpoint with outside services so that the times in a log do not
depend on the student's clock (design.md §9). This page lists the services, what is sent to them,
and the root certificates the verifier trusts.

## What is sent

Only the 32-byte SHA-256 hash of a checkpoint record. For an RFC 3161 request that hash is wrapped
in a standard TimeStampReq with a random 8-byte nonce. For an OpenTimestamps calendar the hash is
posted as is, and later upgrades ask for values derived from it. No code, file names, user names or
other data are sent. A hash cannot be turned back into the log.

## Services used by default

| Service | URL | Kind | Notes |
|---|---|---|---|
| FreeTSA | `https://freetsa.org/tsr` | RFC 3161 | Free service run by an individual. Root certificate published at `https://freetsa.org/files/cacert.pem`. |
| DigiCert | `http://timestamp.digicert.com` | RFC 3161 | Free public timestamping service used for code signing. Chains to DigiCert Trusted Root G4. |
| Sectigo | `http://timestamp.sectigo.com` | RFC 3161 | Free public timestamping service used for code signing. Sectigo asks automated clients to wait at least 15 seconds between requests. Chains to USERTrust RSA Certification Authority. |
| OpenTimestamps (alice, bob) | `https://alice.btc.calendar.opentimestamps.org`, `https://bob.btc.calendar.opentimestamps.org` | OpenTimestamps | Public calendars; proofs reach a Bitcoin block after a few hours. |
| Eternity Wall (finney) | `https://finney.calendar.eternitywall.com` | OpenTimestamps | Public calendar. |

Two of the three TSAs are asked per round, in turn, plus one calendar. A round happens every
10 minutes while there is new work (`tap.anchoring.intervalSec`), and at every pause, stop and
export. One computer therefore sends at most a few requests per hour to each service, well within
the 15-second rule.

DigiCert and Sectigo answer over plain HTTP. That is normal for RFC 3161: the token is signed, so
it cannot be changed in transit, and its nonce ties it to our request.

A token that does not verify with the bundled roots is not written to the log; the recorder asks
another TSA instead. So a TSA that changes its certificate chain costs a request, not a warning in
every student's log. Check with `pnpm --filter @tap/anchor real` (below) after any such change.

## Trusted roots

The verifier (extension and viewer) trusts only these roots for RFC 3161 tokens. They are bundled in
`packages/anchor/roots/` and compiled into `src/roots.generated.ts` by
`pnpm --filter @tap/anchor roots`; CI runs `roots --check`, which fails when a root has expired or
the generated file is stale, and warns two years before a root expires.

| Root | SHA-256 fingerprint | Valid to | Source |
|---|---|---|---|
| DigiCert Trusted Root G4 | `55:2F:7B:DC:F1:A7:AF:9E:6C:E6:72:01:7F:4F:12:AB:F7:72:40:C7:8E:76:1A:C2:03:D1:D9:D2:0A:C8:99:88` | 2038-01-15 | Mozilla CA bundle (via Node) |
| USERTrust RSA Certification Authority | `E7:93:C9:B0:2F:D8:AA:13:E2:1C:31:22:8A:CC:B0:81:19:64:3B:74:9C:89:89:64:B1:74:6D:46:C3:D4:CB:D2` | 2038-01-18 | Mozilla CA bundle (via Node) |
| FreeTSA root (`www.freetsa.org`) | `A6:37:9E:7C:EC:C0:5F:AA:3C:BF:07:60:13:D7:45:E3:27:BB:BA:A3:8C:0B:9A:F2:24:69:D4:70:1D:18:AA:BC` | 2041-03-07 | `https://freetsa.org/files/cacert.pem` (file SHA-256 `2151b611...7e044438`), added by `pnpm --filter @tap/anchor real` after checking the file hash |

`roots/intermediates/` may hold intermediate CA certificates that a TSA leaves out of its tokens
(for example a cross-signed timestamping root). They are only used to build a chain; trust still has
to end at one of the roots above. The `real` script adds one automatically when a token's chain is
missing a link that its AIA "CA Issuers" address provides and the completed chain ends at a bundled
root.

Revocation is not checked: TSA certificates are rarely revoked, and checking would need the network
at verification time.

## Recording real answers

The cloud CI cannot reach these services, so real answers are recorded once on a normal computer:

```
npx pnpm@10.28.0 --filter @tap/anchor real             # TSAs, FreeTSA root, pending OpenTimestamps proof
npx pnpm@10.28.0 --filter @tap/anchor roots            # regenerate src/roots.generated.ts
npx pnpm@10.28.0 test                                  # test/real.test.ts now runs
# about 3 hours later:
npx pnpm@10.28.0 --filter @tap/anchor real --upgrade   # complete the OpenTimestamps proof
```

The answers go to `packages/anchor/test/fixtures/real/` and are committed. `test/real.test.ts`
checks each token with the bundled roots, and the completed OpenTimestamps proof against the
Bitcoin block header (fetched from blockstream.info or mempool.space and checked against its
block hash).

## Bitcoin block headers

The verifier gets an OpenTimestamps proof's time from the Bitcoin block header. The extension does
not download headers yet, so a completed proof is shown as "in Bitcoin block N" without a time; the
RFC 3161 tokens give the times. A later release (the teacher's batch checker) can fetch and cache
headers.
