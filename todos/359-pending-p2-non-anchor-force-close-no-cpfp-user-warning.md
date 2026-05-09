---
status: pending
priority: p2
issue_id: '359'
tags: [code-review, ldk, ux, force-close, fix-lqwd-channel-acceptance]
dependencies: []
---

# Non-anchor channels accepted from LQwD have no CPFP fee-bump path on force-close

## Problem Statement

`init.ts:147` still calls `set_negotiate_anchors_zero_fee_htlc_tx(true)`, but this branch implicitly accepts that LQwD declines anchor negotiation and falls back to non-anchor channels (otherwise the new 253 sat/kW non-anchor floor wouldn't matter).

Architectural consequence: the resulting channel has **no anchor outputs**. A pre-signed 1 sat/vB commitment tx cannot be CPFP-bumped in raw LDK without anchors — `BumpTransactionEventHandler` (init step 14) is a no-op for non-anchor closes. During a sustained mempool congestion event, the commitment tx may be evicted before confirming, leaving funds stuck until `to_self_delay` expires (typically 144+ blocks).

Mitigation context (why this is P2 not P1):
- LSPS2 JIT channel value is bounded to ~0.01 BTC (`max_payment_size_msat` in `lsps2/types.test.ts:152`).
- LSPS2 channels resolve **cooperatively** within seconds — force-close is the rare path.
- We trust the LSP via 0-conf, so the LSP has no incentive to grief the cooperative path.

But we still ship product to users who may hold balances on these channels.

## Findings

- architecture-strategist P1 (Non-anchor force-close has no CPFP escape valve)
- security-sentinel quantified the bound (P1 ruled out because of channel-value cap)

## Proposed Solutions

**Option A — User-visible "settlement may be slow" warning when only non-anchor channels are open**

In the wallet UI, surface a low-priority indicator (banner/toast) when the active inbound channel(s) lack anchors. Sets correct expectations without raising alarm.

- Pros: Cheap; mitigates by setting expectations.
- Cons: Adds a new UI element.
- Effort: Small-Medium.
- Risk: Low.

**Option B — Push back on LQwD upstream**

Open a ticket / email LQwD asking them to negotiate `option_anchors_zero_fee_htlc_tx`. Track in todo #364.

- Pros: Removes the underlying problem entirely.
- Cons: Out of our control timing-wise.
- Effort: Communication only.

**Option C — Per-LSP capability matrix to refuse new LSPs without anchors**

Codify "trusted LSP must support anchors" as a hard requirement going forward (see todo #362). Doesn't fix LQwD now but prevents future regressions.

- Pros: Prevents drift.
- Effort: Small (after #362).

## Recommended Action

(filled during triage — likely A + B in parallel)

## Technical Details

- **Affected files:** wallet UI (channel/balance views), `src/ldk/traits/event-handler.ts` (telemetry from #358 feeds the UI flag)

## Acceptance Criteria

- [ ] User sees an indicator when only non-anchor channels are open
- [ ] Indicator clears when an anchor channel is added
- [ ] Copy reviewed for accuracy (mention "on-chain settlement may take longer in extreme network congestion")

## Work Log

_(empty)_

## Resources

- Branch: `fix/lqwd-channel-acceptance`
- LSPS2 channel-value bound: `src/ldk/lsps2/types.test.ts:152`
- BumpTransactionEventHandler: see init.ts step 14
