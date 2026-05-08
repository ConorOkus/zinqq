---
status: ready
priority: p2
issue_id: '344'
tags: [code-review, architecture, vss, persistence, pr-157]
dependencies: []
---

# Same race-condition class lives in `known-peers.ts` and `recovery-state.ts`

## Problem Statement

Architecture review found the same fire-and-forget + per-iteration-conflict-retry
pattern in three other modules besides `persist-cm.ts`:

- `src/ldk/storage/known-peers.ts:35-59` — `putKnownPeer` and `deleteKnownPeer`
  call `syncPeersToVss()` fire-and-forget. Two rapid peer events (e.g., JIT
  open + reconnect) will collide. The conflict-retry refetches once, then
  swallows.
- `src/ldk/recovery/recovery-state.ts:64-97` — module-level `let vssVersion = 0`
  bakes in a single-tab assumption. Same conflict pattern.
- `src/ldk/traits/persist.ts:88-131` — manifest only; this one has its own
  `manifestWriteChain` so it's already serialized. Correct as-is.

The scheduler in PR #157 is the **first correct** implementation. Without
extracting it, every future VSS-backed persister will reinvent the bug.

## Findings

- architecture-strategist P2 (with concrete file:line refs).
- learnings-researcher noted PR #114 also fought VSS 409s for a different
  cause (startup version cache seeding). This PR is the third 409 incident
  in the codebase — pattern is overdue for extraction.

## Proposed Solutions

### Option A — Extract `createSerialVssPersister<T>`

Generic factory that takes (key, vssClient, versionRef, encode) and returns a
`schedule(value: T): Promise<void>` with the coalesce + version-resolution
logic. Migrate `persist-cm.ts`, `known-peers.ts`, `recovery-state.ts` to use it.

- Pros: one canonical implementation; bugs fixed once.
- Cons: bigger diff; needs care to preserve call-site semantics.
- Effort: Medium-Large.
- Risk: Medium (touches three persistence modules).

### Option B — Apply scheduler to `known-peers.ts` only as a follow-up

Don't extract yet; just wrap `syncPeersToVss` in a scheduler closure now.
Accept duplication; revisit extraction when a 4th persister appears.

- Pros: smaller scope; preserves PR #157's narrow target.
- Cons: defers the cleanup; bug class still latent in `recovery-state.ts`.
- Effort: Small.
- Risk: Low.

### Option C — Document and defer

Capture the pattern in `docs/solutions/` and leave the other modules. Risky:
known-peers race is real and ships today.

## Recommended Action

(filled during triage)

## Technical Details

- **Affected files (B):** `src/ldk/storage/known-peers.ts`
- **Affected files (A):** above + `src/ldk/recovery/recovery-state.ts`, `src/ldk/storage/persist-cm.ts`, new `src/ldk/storage/serial-vss-persister.ts`
- **Verify:** does `known-peers` 409 ever surface in logs? (would confirm bug is live)

## Acceptance Criteria

- [ ] Decision made: extract abstraction now vs. apply scheduler to `known-peers` and defer
- [ ] If extracted: all three persisters migrated; old hand-written conflict retries removed
- [ ] If deferred: at minimum, `known-peers.ts` gets the scheduler treatment

## Work Log

### 2026-05-08 — Approved for work

**By:** Claude Triage System

**Actions:**

- Issue approved during triage session
- Status changed from pending → ready

**Learnings:**

- This is the third VSS 409 incident in the codebase. Pattern is overdue for extraction. Option B (apply scheduler to `known-peers.ts` only as immediate hardening) is the minimum bar; Option A (extract `createSerialVssPersister`) is the right structural fix and should be picked when work starts unless the diff is too disruptive.


## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/157
- `docs/solutions/design-patterns/vss-dual-write-persistence-with-version-conflict-resolution.md`
- `docs/solutions/logic-errors/vss-version-cache-startup-seeding-fix.md` (PR #114)
