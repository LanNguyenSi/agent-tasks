# Grounding receipt v1 consumer contract

`verifyGroundingReceipt` in `backend/src/services/grounding-receipt.ts` verifies signed `grounding-receipt/v1` bytes offline. Callers inject the server-recorded attempt context, the issuer/key trust store, and the server clock. Its only successful result is passing documentary `agent_asserted` evidence: receipt ID, assessment dossier digest, and evaluated/issued/expiry times. This does not authorize a task transition. There is no public signature-only success API.

Expected context must include audience, project/task/attempt IDs, a canonical unpadded base64url 32-byte nonce, positive context revision, exact workflow target (including nullable workflow ID), subject digest, session ID/revision, and the stored challenge creation/expiry times. Configuration is validated at runtime without coercion. Clock and challenge times are nonnegative safe integer epoch seconds; revisions are positive safe integers. Challenge expiry must be after creation and at most 24 hours later. Creation may be at most 60 seconds ahead of the injected clock.

Every trust record must contain token-shaped issuer/kid values, an Ed25519 public SPKI PEM, a profile digest, and nonempty explicit project-ID and audience lists. All records and keys are validated before selecting a key, including unused and revoked entries. Duplicate `(issuer, kid)` pairs make configuration unavailable. An empty store is valid but trusts no receipt. Rotation adds a separately scoped entry; revocation sets that exact entry's `revoked` boolean.

Verification follows this order: strict receipt syntax/schema/profile, complete local configuration and key validation, signature authentication, trust scope, exact context binding, freshness, then assessment outcome. Errors have a stable `GroundingReceiptVerificationError.code`:

| Code | Meaning |
| --- | --- |
| `grounding_receipt_invalid` | Malformed bytes, noncanonical payload, or invalid schema/value relationships |
| `grounding_receipt_unsupported` | Unsupported format, algorithm, schema version, subject kind, or policy profile |
| `grounding_verification_unavailable` | Missing or malformed local context, clock, trust configuration, or public key |
| `grounding_receipt_untrusted` | Unknown/revoked receipt key, bad signature, or project/audience/profile outside its trust scope |
| `grounding_receipt_mismatch` | Authenticated receipt differs from stored expected context |
| `grounding_receipt_stale` | Receipt or stored challenge expired, timestamp outside allowed skew, or receipt extends the stored challenge |
| `grounding_required` | Authenticated, bound and fresh assessment failed; `detail` is `assessment_failed` |

Evaluation and issuance may be at most 60 seconds before challenge creation or after the injected clock. Neither receipt nor challenge expiry receives a skew allowance: `now >= expiry` is stale. Receipt expiry may equal the stored challenge expiry but cannot exceed it. The producer profile separately requires evaluation ≤ issuance < expiry and at most 900 seconds from evaluation to receipt expiry. Signature, binding and freshness errors take precedence over a signed fail outcome.

The corpus is pinned to producer revision `0884c4054c446648aaaf44e2fe9eef5dff5648cf` and manifest SHA-256 `b8dd4a913b59cfc1195aba22518aef59736eefb3fa187cf24557f7c84ce68906`. Independent literal constants in `scripts/grounding-receipt-contract.mjs` anchor both values. Mutable `PIN.json` records those values and must match the constants; it is not the trust anchor. The offline check verifies exact manifest bytes, every specimen's length/digest, and the complete file inventory:

```sh
node scripts/grounding-receipt-contract.mjs check
```

Sync explicitly reads a local producer repository's pinned Git objects, independent of its working tree:

```sh
node scripts/grounding-receipt-contract.mjs sync --producer /path/to/agent-grounding --revision 0884c4054c446648aaaf44e2fe9eef5dff5648cf
```

Both commands accept `--target /path/to/fixture-dir`. Sync prepares and validates a unique temporary corpus before replacement. An existing target must be an empty directory or an intact previous corpus; unrelated directories and symlinks are rejected. To recover a damaged corpus, sync to a fresh destination and review the replacement. Changing the pinned version requires reviewing the literal constants and vendored bytes together. The executable has no pin override; helpers accept an injected pin for portable temporary-Git-repository tests.

The verifier reads no environment variables or key files, imports no wrapper/ledger/harness key, fetches no keys, and makes no network requests. The consumer tests use the vendored corpus and temporary local Git repositories; they require no producer checkout. Issuer isolation and rollout qualification remain separate work.
