# Grounding migration procedure

The grounding migration report is an inventory only. It separates unprovisioned, OFF, legacy-local, external-v1, and inconsistent cohort records, and reports recommended actions. A recommendation does not change a task, put it on hold, activate enforcement, or authorize a rollout.

Run the compiled inventory through the deployment entry point only with an explicitly supplied migration database URL:

```sh
GROUNDING_MIGRATION_DATABASE_URL='postgresql://…' node scripts/grounding-deployment-check.mjs --inventory-only
```

The entry point accepts an optional `--project <project-id-or-slug>` filter. It fails closed for every other argument, requires the compiled report, bounds output, and emits no activation action. Its output includes an explicit `activation.status: "blocked"`; a successful read-only report, zero counts, package version, or caller-provided value is never rollout approval.

Before an authorized migration, capture a backup and restore it into an isolated database. Run the inventory on the restored data and exercise the additive schema with both existing and upgraded consumers. Record the actual release versions, writer identities, backup/restore evidence, and results in the deployment record; do not place environment-specific measurements in this document.

Legacy phase data needs a separately validated migration rule. The inventory treats the pinned legacy wrapper's `complete` phase as compatible with claim evaluation; it still flags malformed and impossible phase data. Phase compatibility does not prove a successful evaluated outcome. The inventory cannot repair state and is not a safe hold. Do not use `OFF`, task metadata, malformed cohort rows, or a report recommendation as a maintenance state. A migration requires an audited, authorized conversion that preserves history, invalidates active attempts atomically, and has enforceable writer exclusion before it can claim a safe hold.

Activation remains blocked until the runtime composes the trusted receipt service, selects a cohort for new protected tasks, excludes older writing instances, and has separate operator evidence for host policy, state, and key isolation. The local separated-process qualification of the producer protocol is useful compatibility evidence only; it is not physical two-host or operating-system isolation proof.
