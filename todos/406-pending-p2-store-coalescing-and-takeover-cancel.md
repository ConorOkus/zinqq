---
status: pending
priority: p2
issue_id: '406'
tags: [code-review, close-records, persistence, vss, pr-172]
dependencies: []
---

# Close-records write chain lacks coalescing and tab-takeover cancellation

## Problem Statement

Every `upsertCloseRecord` enqueues a full IDB+VSS persist of the whole map — one reconcile
pass can emit several redundant full-map VSS PUTs per tick (exactly what
`createSerialPersister`'s leading+trailing coalescing exists for). And unlike
`known-peers.ts`/`persist-cm.ts`, the chain has no `cancel()` on wallet takeover: a stale
tab keeps writing VSS forever, and the custom conflict path bypasses the takeover-grace
handling in `vss-write.ts`. Monotonic merge makes this data-safe (a stale tab can't destroy
facts), but it diverges from the tab-takeover discipline.

## Findings

- architecture-strategist P2 #6: `src/ldk/close-records/store.ts:116-122` (chain),
  `:88-110` (custom conflict path — plan-sanctioned, keep the merge).
- The bespoke fetch-merge-rewrite on 409 must stay (blob-LWW would lose the other device's
  facts) — only the scheduling/cancellation shell should align with codebase persisters.

## Proposed Solutions

### Option A: Drive `persistLocked` through `createSerialPersister` + cancel on shutdown

Keep the sync map + custom merge; the persister provides coalescing and a cancel hook wired
into LdkContext `shutdown()` / takeover teardown. Effort: Medium. Risk: low (persist
semantics unchanged, just scheduled).

### Option B: Minimal — dirty-flag coalescing inside the existing chain + cancel flag

~20 lines, no new dependency on the persister's shape. Effort: Small. Risk: low.

## Recommended Action

(Triage)

## Technical Details

- **Affected files**: `src/ldk/close-records/store.ts`, `src/ldk/context.tsx` (teardown
  wiring), `store.test.ts`.

## Acceptance Criteria

- [ ] N rapid upserts produce ≤2 VSS PUTs (leading + trailing)
- [ ] After `shutdown()`/takeover, the store issues no further VSS writes

## Work Log

- 2026-07-21: Filed from /ce:review of PR #172 (architecture-strategist).
