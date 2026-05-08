---
status: pending
priority: p3
issue_id: '324'
tags: [code-review, documentation, lsps2]
dependencies: []
---

# Document that `list_peers()` truthiness ≠ LSPS2-onion-ready in `getJitQuote` Step 0 comment

## Problem Statement

The new Step 0 comment in `src/ldk/context.tsx` (post-fix, ~lines
227-231) explains _why_ we skip `connect()` when the peer is
already in `list_peers()`. It doesn't explain a related subtlety:
**`list_peers()` truthiness is not a liveness guarantee for
LSPS2 onion messages.**

Specifics:

- `peerManager.list_peers()` returns a peer once the noise
  handshake completes (`peer-connection.ts:113-124` resolves the
  connect promise on the same condition).
- LSPS2 RPC messages travel via onion; full delivery requires the
  `init` exchange to also be complete.
- Between noise-complete and init-complete there is a small window
  where `list_peers()` returns true but onion delivery may sit
  idle.
- Between any earlier connect and the LSPS2 RPC, the peer can
  also disconnect (mobile background, network drop) without our
  code re-checking.
- The `PHASE_A_PER_LSP_BUDGET_MS` 7s timeout is the safety net for
  both cases.

This was true in the old code too (the connect path resolved on
noise, not init). The new code doesn't regress it. But the new
comment block reads "we already have the peer, proceed" which a
future reader might misread as "and the peer is ready for LSPS2."

## Findings

- Identified by: architecture-strategist during /ce:review of
  LSPS2 fix (2026-05-07)
- Severity P3: pure documentation; no code change required
- Pre-existing TOCTOU bounded by 7s per-LSP budget — acceptable

## Proposed Solutions

### Option A — Append a sentence to the Step 0 comment (recommended)

Edit the comment block at `getJitQuote` Step 0 to add a final
sentence:

```ts
// Step 0: Ensure peer connection. Skip the connect() call when LDK
// already has the peer — `new_outbound_connection` rejects a duplicate
// and we'd uselessly fail through to fallback. This is the common case
// for the LSP we just ran a quote against, or one we auto-reconnected
// to on startup because of an existing channel.
//
// Note: `list_peers()` truthiness means the noise handshake is
// complete, NOT that the peer is ready for LSPS2 onion messages or
// still live at RPC time. The PHASE_A_PER_LSP_BUDGET_MS 7s timeout
// catches both stale entries and slow init exchanges.
```

- **Pros**: Documents a subtle invariant in-place where future
  readers will encounter it. Cheap.
- **Cons**: Comment grows by 4 lines.
- **Effort**: Small (~5 minutes).
- **Risk**: None.

### Option B — Add a check that uses `init_features`

If LDK exposes a way to ask "is this peer past init?" (via
`get_init_features()` on the peer), gate the skip on that as well.
Closes the small window between noise and init.

- **Pros**: Removes the small race window.
- **Cons**: More code; possibly LDK API churn; the 7s budget
  already absorbs the cost of waiting on init. Not worth it
  without evidence the race actually causes user-observable
  latency spikes.
- **Effort**: Medium.
- **Risk**: Low.

### Option C — Skip the doc

Trust readers to know LDK semantics.

- **Pros**: Zero work.
- **Cons**: Future readers won't know.

## Recommended Action

Option A. The comment is already there; appending one paragraph
costs nothing and prevents a misread. Defer Option B until there's
evidence of user-visible latency from the noise/init window.

## Technical Details

- **Affected files**: `src/ldk/context.tsx` (comment only, ~line
  227-231 in the post-fix layout)
- **Tests**: none — comment-only change

## Acceptance Criteria

- [ ] Step 0 comment notes that `list_peers()` truthiness ≠
      LSPS2-onion-ready
- [ ] Comment references the 7s per-LSP budget as the safety net
- [ ] `pnpm lint` passes (formatting check)

## Work Log

(Empty)

## Resources

- Identified during: /ce:review of in-progress LSPS2 + LQwD-port
  fix (2026-05-07)
- Related: future `LdkNode.isPeerReadyForOnion(pubkey)` upgrade
  path documented in `todos/322-*-extract-ldknode-ispeerconnected-helper.md`
