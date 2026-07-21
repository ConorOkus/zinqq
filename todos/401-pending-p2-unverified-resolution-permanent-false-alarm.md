---
status: pending
priority: p2
issue_id: '401'
tags: [code-review, close-records, reconcile, ux-trust, pr-172]
dependencies: []
---

# `resolved_unverified` can be permanently wrong when BDK sync lags — and nothing ever upgrades it

## Problem Statement

Reconcile's unverified branch fires once the closing tx has 6 confs but
`txConfirmedInWallet` is false. If the closing tx pays the wallet but BDK simply hasn't
indexed it yet (fresh restore, scan lag while Esplora tip data is current), the record gets
`completedAt` + `resolution: 'unverified'` — and because completed records are excluded
from all pending filters, reconciliation never revisits it. The merge rule "verified
absorbs unverified" can never trigger. Permanent "this wallet couldn't verify receiving the
funds" warning for a close that actually paid the user. Funds unaffected; trust damaged.

## Findings

- security-sentinel MEDIUM #3: `src/ldk/close-records/reconcile.ts:224-239` with the
  quiescence filters at `:88,136`.
- Positive-evidence rules for `verified` were confirmed sound — this is only about the
  unverified terminal being too eager and too final.

## Proposed Solutions

### Option A: Let reconcile re-check `resolved_unverified` records for receipt

Include them in the pass (cheap: wallet lookup only, no Esplora), upgrade to `verified` on
receipt. Effort: Small. Risk: none — upgrade is monotonic and matches the merge rule.

### Option B: Require N consecutive receipt-less passes before marking unverified

Dwell counter (in-memory) delays the terminal state past BDK sync lag. Effort: Small.
Risk: slightly delayed terminal state.

## Recommended Action

(Triage — A and B compose well.)

## Technical Details

- **Affected files**: `src/ldk/close-records/reconcile.ts`, `reconcile.test.ts`.

## Acceptance Criteria

- [ ] A record marked unverified upgrades to verified once BDK indexes the receipt
- [ ] Test: complete-unverified → wallet later confirms tx → verified

## Work Log

- 2026-07-21: Filed from /ce:review of PR #172 (security-sentinel).

## Additional evidence (2026-07-21 verification pass)

security-sentinel's fund-safety verification of de9ccc57 found two more concrete windows
where terminal-unverified is wrong and never heals:

1. **Sweep-in-flight at the dwell boundary**: the `ldk_spendable_outputs` entry is deleted
   at BROADCAST (`sweep.ts:163`), so an unconfirmed sweep defeats both the
   pendingSpendables gate and the receipt check; it confirms one block later into a record
   already frozen unverified.
2. **Monitor-replay race on reopen**: after a long-offline reopen, a reconcile tick can run
   before monitors finish replaying `SpendableOutputs`, so pendingSpendables is empty and
   the dwell branch fires; the sweep lands afterward.
3. **LDK monitor claim txs** (justice/HTLC claims paying `get_destination_script` directly)
   are wallet-received but never enter `record.txs` — those records can only end
   unverified despite verifiable receipt.

Natural fix shape: let `recordSweepResult` and/or reconcile upgrade a completed-unverified
record to verified when a confirmed wallet receipt is later attributable (the merge rule
"verified absorbs unverified" already supports it).
