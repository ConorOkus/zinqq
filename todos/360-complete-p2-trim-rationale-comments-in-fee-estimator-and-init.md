---
status: complete
priority: p2
issue_id: '360'
tags: [code-review, simplicity, comments, fix-lqwd-channel-acceptance]
dependencies: []
---

# Trim rationale comments in `fee-estimator.ts` and `init.ts`

## Problem Statement

Two new comments on this branch are over-long:

**`fee-estimator.ts:17-21`** — Five lines of rationale embedded in the `DEFAULT_FEE_RATES` record literal interrupt the table-like structure of the constant. The "force-close mempool eviction risk is acceptable" sentence editorialises about a tradeoff and conflates trust models (the comment appeals to 0-conf trust, but 0-conf trust covers funding-tx double-spend, not commitment-feerate floors — see security-sentinel P3-1).

**`init.ts:158-162`** — Four lines, but the "already trusted via `accept_inbound_channel_from_trusted_peer_0conf`" sentence is redundant trust-justification: the same point is made three lines above at `init.ts:144-146` for the anchor config.

Per CLAUDE.md: comments should explain non-obvious WHY, not editorialise on tradeoffs that belong in PR descriptions or solutions docs.

## Findings

- code-simplicity-reviewer P2 (`fee-estimator.ts` comment too long)
- code-simplicity-reviewer P2 (`init.ts` comment has redundant trust sentence)
- kieran-typescript-reviewer P2 (5-line rationale in record literal)
- security-sentinel P3-1 (rationale conflates 0-conf trust with feerate-floor purpose)

## Proposed Solutions

**`fee-estimator.ts:17-21`** — collapse to:

```ts
// LDK absolute minimum (1 sat/vB). LSPS2 LSPs that don't negotiate
// option_anchors_zero_fee_htlc_tx (LQwD as of 2026-05) propose ~253 sat/kW
// commitment fees that would otherwise be rejected.
// See docs/solutions/integration-issues/ldk-anchor-channel-feerate-floor-fix.md
[ConfirmationTarget.LDKConfirmationTarget_MinAllowedNonAnchorChannelRemoteFee]: 253,
```

**`init.ts:158-162`** — drop the trailing trust-justification sentence:

```ts
// LDK rejects channel opens whose announce flag differs from our default
// (`announce_for_forwarding=false`) with "announcement preference is
// different from ours". LQwD diverges; turn the check off.
handshakeLimits.set_force_announced_channel_preference(false)
```

Move the deeper tradeoff discussion (mempool eviction, JIT bounded value, etc.) to the solutions doc (see todo #363).

## Recommended Action

(filled during triage)

## Technical Details

- **Affected files:** `src/ldk/init.ts:158-162`, `src/ldk/traits/fee-estimator.ts:17-21`

## Acceptance Criteria

- [ ] Both comments capture the load-bearing constraint (LDK error string + LSP that triggers it) in ≤3 lines
- [ ] Tradeoff discussion lives in solutions doc, not source
- [ ] Removed sentence that conflates 0-conf trust with feerate-floor purpose

## Work Log

- 2026-05-08: Resolved on `fix/lqwd-channel-acceptance`.
  - `src/ldk/user-config.ts` (was `init.ts`) — trimmed 5-line announce-flag comment to 3 lines; dropped the redundant trust-justification sentence (the same point is made above for the anchor config).
  - `src/ldk/traits/fee-estimator.ts:17-20` — trimmed 5-line rationale to 3 lines focused on the load-bearing constraint (LSPS2 LSPs without anchors). The deeper tradeoff discussion is deferred to the solutions-doc update tracked in todo #363.

## Resources

- Branch: `fix/lqwd-channel-acceptance`
- CLAUDE.md commenting guidance
