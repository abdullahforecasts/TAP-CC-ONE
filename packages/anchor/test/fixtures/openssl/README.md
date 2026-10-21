Interoperability fixtures made with OpenSSL 3.0 (`openssl ts`), all for SHA-256("interop"):

- `ca.crt`: test root (RSA 3072)
- `resp.tsr`: TSA with RSA 2048, PKCS #1 v1.5, SHA-256
- `resp-ec.tsr`: TSA with ECDSA P-384, SHA-384 (like FreeTSA)
- `resp-pss-chain.tsr`: TSA certificate signed by the root with RSA-PSS
- `req.tsq`: the request OpenSSL built

Each response was checked with `openssl ts -verify -data data.txt -in <resp> -CAfile ca.crt`.
