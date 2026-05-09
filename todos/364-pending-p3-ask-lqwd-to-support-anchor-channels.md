---
status: pending
priority: p3
issue_id: '364'
tags: [code-review, lsp, lqwd, upstream, fix-lqwd-channel-acceptance]
dependencies: []
---

# Upstream: ask LQwD to negotiate `option_anchors_zero_fee_htlc_tx`

## Problem Statement

The fix on `fix/lqwd-channel-acceptance` is a workaround. The proper architectural answer is for LQwD to support anchor channels (as Megalith does). Anchor channels are designed for exactly this case: low pre-signed commitment fees + CPFP fee bumping at force-close. Without anchors, the new 253 sat/kW non-anchor floor leaves the wallet exposed to mempool-eviction risk during congestion (see todo #359).

This todo tracks the upstream ask so the workaround doesn't quietly become permanent architecture.

## Findings

- architecture-strategist P3 (track "ask LQwD for anchors" follow-up)
- learnings-researcher (LSP compatibility matrix pattern)

## Proposed Solutions

**Action items:**

1. Email LQwD operations / open a support ticket asking when `option_anchors_zero_fee_htlc_tx` will be supported on the Germany endpoint.
2. If supported in a known release, set a calendar reminder to re-test, drop `MinAllowedNonAnchorChannelRemoteFee` back to 2500, and re-enable `force_announced_channel_preference(true)` if their announce-flag handling also normalises.
3. If not on the roadmap, evaluate whether to:
   - Stay on this workaround (status quo)
   - Replace LQwD as primary with another anchor-supporting LSP
   - Make the wallet refuse non-anchor LSPs once another anchor-capable provider is available (todo #362)

## Recommended Action

(filled during triage)

## Technical Details

- **Affected files:** none (process / communication)

## Acceptance Criteria

- [ ] Ticket / email sent to LQwD
- [ ] Response logged in this todo's Work Log
- [ ] Decision recorded: stay / migrate / refuse non-anchor LSPs

## Work Log

_(empty)_

## Resources

- Branch: `fix/lqwd-channel-acceptance`
- LQwD reference: `~/.claude/projects/-Users-conor-Projects-zinq/memory/reference_lqwd_lsp.md`
- Discovery endpoint: `https://germany.lqwd.tech/api/v1/get_info`
