---
status: pending
priority: p3
issue_id: '322'
tags: [code-review, refactor, architecture, ldk, peer-management]
dependencies: []
---

# Extract `LdkNode.isPeerConnected(pubkey)` helper — three duplicated `list_peers().some(...)` call sites

## Problem Statement

The pattern

```ts
node.peerManager.list_peers().some((p) => bytesToHex(p.get_counterparty_node_id()) === pubkey)
```

now appears in three places:

- `src/ldk/context.tsx` — `getJitQuote` Step 0 (the new
  `alreadyConnected` closure, both pre-check and post-failure race
  re-check)
- `src/ldk/context.tsx:817-823` — `sendBolt12Payment` peer presence
  check
- (Implicit) `src/ldk/context.tsx:531-554` — `connectAndTrack`
  reconciliation (different shape, same intent)

Each call site re-implements the byte-conversion + linear scan and
imports `bytesToHex` from `../utils` for that single line. The
`LdkNode` interface (`src/ldk/init.ts`) does not expose a method
that answers "is this pubkey currently a peer?" — callers reach
through `peerManager.list_peers()` directly, leaking an LDK-rs
binding detail.

This is pure refactor — no behavior change.

## Findings

- Identified by: architecture-strategist during /ce:review of LSPS2
  fix (2026-05-07)
- Severity P3: code quality, not a bug. The duplication is small (3
  lines × 3 sites) but it sits exactly on the abstraction boundary
  we should be defending: `LdkNode` should be the API surface for
  "questions about LDK state", not raw `peerManager.list_peers()`.
- Adding a helper also creates a clean upgrade point for a future
  `isPeerReadyForOnion(pubkey)` that checks `init_features` (see
  architecture-strategist's P2 note about the difference between
  noise-handshake-complete and LSPS2-onion-ready).

## Proposed Solutions

### Option A — Add `isPeerConnected` on `LdkNode` (recommended)

Add a method to `LdkNode` (`src/ldk/init.ts`):

```ts
isPeerConnected(pubkeyHex: string): boolean {
  return this.peerManager
    .list_peers()
    .some((p) => bytesToHex(p.get_counterparty_node_id()) === pubkeyHex)
}
```

Replace each call site with `node.isPeerConnected(pubkey)`. Drop
the now-orphaned `bytesToHex` import from `context.tsx` if it isn't
used for anything else.

- **Pros**: Single source of truth. Clean upgrade path for
  `isPeerReadyForOnion` later. Removes a `bytesToHex` import from
  the quote flow. Trivial diff.
- **Cons**: Adds one method to `LdkNode` — interface grows by one.
- **Effort**: Small (~20 minutes).
- **Risk**: None — semantics-preserving rename.

### Option B — Standalone helper in `src/ldk/peers/`

```ts
// src/ldk/peers/is-peer-connected.ts
export function isPeerConnected(peerManager: PeerManager, pubkeyHex: string): boolean { ... }
```

Same de-duplication but doesn't grow `LdkNode`'s API.

- **Pros**: Doesn't expand the LdkNode interface.
- **Cons**: Callers still need to thread `node.peerManager` to the
  helper; doesn't really hide the LDK-rs binding. Also forces a
  separate import.
- **Effort**: Small.
- **Risk**: None.

### Option C — Leave as-is

Three copies is on the edge of "rule of three" for extraction; some
codebases hold this line until a fourth caller appears.

- **Pros**: Zero churn.
- **Cons**: Doesn't reduce coupling on the LDK-rs binding. Any
  future "ready for onion" upgrade has to be applied in three
  places.
- **Effort**: None.
- **Risk**: Cosmetic.

## Recommended Action

Option A. The third call site is the trigger; LdkNode is already
the wrapper meant to hide the LDK-rs binding. Defer the
`isPeerReadyForOnion` upgrade to a follow-up — current callers
don't need it and over-engineering is worse than de-duping.

## Technical Details

- **Affected files**:
  - `src/ldk/init.ts` (add method to LdkNode)
  - `src/ldk/context.tsx` (3 call sites)
  - Possibly `src/ldk/init.test.ts` for a one-line method test
- **Tests**: One unit test on `LdkNode.isPeerConnected` —
  empty-list returns false, matching pubkey returns true,
  non-matching returns false

## Acceptance Criteria

- [ ] `LdkNode.isPeerConnected(pubkeyHex: string): boolean` exists
      and is implemented in terms of `peerManager.list_peers()`
- [ ] All three call sites in `context.tsx` use the new method
- [ ] No `peerManager.list_peers().some(...)` patterns remain
      elsewhere (grep clean)
- [ ] One direct unit test on the new method
- [ ] Existing failover tests still pass without changes
- [ ] `pnpm test` and `pnpm lint` pass

## Work Log

(Empty)

## Resources

- Identified during: /ce:review of in-progress LSPS2 + LQwD-port
  fix (2026-05-07)
- Future upgrade path: `isPeerReadyForOnion(pubkey)` checking
  `init_features` for LSPS2-onion-message support — file separately
  if/when needed.
