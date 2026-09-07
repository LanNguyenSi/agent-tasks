# Grounding receipt v1 consumer contract

`backend/src/services/grounding-receipt.ts` verifies the producer's signed `grounding-receipt/v1` bytes offline. Callers supply the server-recorded attempt context, a nonempty allowlisted issuer/key trust entry, and the server clock. A successful return is documentary `agent_asserted` evidence only; it does not authorize a task transition.

The test corpus is pinned to producer revision `0884c4054c446648aaaf44e2fe9eef5dff5648cf` and independently pins the manifest SHA-256 in `PIN.json`. Verify it without any producer checkout:

```sh
node scripts/grounding-receipt-contract.mjs check
```

Refreshing it is an explicit reviewable operation against a local producer Git repository and reads the pinned revision's Git objects, never its working tree:

```sh
node scripts/grounding-receipt-contract.mjs sync --producer /path/to/agent-grounding
```

The verifier does not read environment variables or key files, import a wrapper/ledger/harness key, fetch keys, or make network requests. Key rotation is expressed by adding a separately scoped trusted `(issuer, kid)` entry; revocation marks that exact entry `revoked`.
