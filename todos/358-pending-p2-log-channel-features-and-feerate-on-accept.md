---
status: pending
priority: p2
issue_id: '358'
tags: [code-review, observability, ldk, fix-lqwd-channel-acceptance]
dependencies: []
---

# Log channel features (anchors, announce flag) and negotiated feerate at `OpenChannelRequest` accept

## Problem Statement

After this branch lowers `MinAllowedNonAnchorChannelRemoteFee` to 253 sat/kW and disables `force_announced_channel_preference`, we lose visibility into:

1. Whether LQwD is actually opening at the proposed 253 sat/kW or at a healthier rate. If LQwD silently regresses to literal 1 sat/vB during a congestion event, we'll only learn after a force-close fails to confirm.
2. Whether accepted channels have `option_anchors_zero_fee_htlc_tx` (anchor) or not — critical because non-anchor force-closes have no CPFP escape valve.
3. Whether the LSP is opening announced or unannounced channels — relevant because we set `option_scid_alias` (`init.ts:141`) for SCID privacy; an announced channel undermines that intent.

Today, `event-handler.ts:641` only logs `tempChannelId` on accept.

## Findings

- security-sentinel P3-2 (no telemetry on accepted commitment feerate)
- architecture-strategist P2 (announce flag may degrade SCID alias intent — log to verify)

## Proposed Solutions

**Option A — Log negotiated channel features at accept**

In `src/ldk/traits/event-handler.ts:640-645`, before logging "accepted 0-conf from LSP", surface from the `Event_OpenChannelRequest` event:

- `channel_type` features (anchors? scid alias?)
- `push_msat`, `funding_satoshis`
- `channel_flags & 1` (announce bit)
- The proposed `feerate_per_kw`

Log structure: `console.log('[LDK Event] OpenChannelRequest accepted', { tempChannelId, hasAnchors, announced, feerateSatKw, fundingSat })`.

- Pros: Cheap; immediate visibility into LSP behaviour drift.
- Cons: Fields must be reachable from the WASM-bound event — verify the bindings expose them.
- Effort: Small.
- Risk: None.

**Option B — Sentry breadcrumb**

If `captureError`-style telemetry exists, emit a breadcrumb instead of a console log so it's persisted with crash reports.

- Pros: Persists across the user's sessions.
- Cons: Adds noise to telemetry pipeline.
- Effort: Small.
- Risk: None.

## Recommended Action

(filled during triage — Option A as a minimum, Option B if telemetry pipeline already exists)

## Technical Details

- **Affected files:** `src/ldk/traits/event-handler.ts:625-655`

## Acceptance Criteria

- [ ] Accept-path log line records anchor flag, announce flag, and `feerate_per_kw`
- [ ] Manually confirmed LQwD's actual values match expectations (anchors=false, announced=?, feerate=?)
- [ ] Megalith open path also exercised to confirm anchor channels are still detected

## Work Log

_(empty)_

## Resources

- Branch: `fix/lqwd-channel-acceptance`
- Call site: `src/ldk/traits/event-handler.ts:625`
