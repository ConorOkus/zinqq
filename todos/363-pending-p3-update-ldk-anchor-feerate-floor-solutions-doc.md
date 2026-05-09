---
status: pending
priority: p3
issue_id: '363'
tags: [code-review, docs, fix-lqwd-channel-acceptance]
dependencies: []
---

# Update or supersede `ldk-anchor-channel-feerate-floor-fix.md` (now stale)

## Problem Statement

`docs/solutions/integration-issues/ldk-anchor-channel-feerate-floor-fix.md:64,73-75` documents:

> No other changes needed. The `MinAllowedNonAnchorChannelRemoteFee` correctly remains at 2500.

> | `MinAllowedNonAnchorChannelRemoteFee` | Minimum we accept from peer on non-anchor channels | 2500 sat/kW (10 sat/vB) |

This is now contradicted by the change in this branch (non-anchor floor lowered to 253). Future readers will be misled.

Additionally, the rationale for the new value belongs in a solutions doc (referenced by todo #360 which trims the inline source comment), so we need a place to put it.

## Findings

- architecture-strategist P3 (stale documentation)
- code-simplicity-reviewer P2 (rationale should live in doc, not source)

## Proposed Solutions

**Option A — Update existing doc**

Edit `ldk-anchor-channel-feerate-floor-fix.md` to add a "2026-05 update" section explaining why the non-anchor floor was also lowered:

- LSP-specific: LQwD doesn't negotiate `option_anchors_zero_fee_htlc_tx`
- Bounded blast radius: LSPS2 channel value capped, cooperative settlement
- Risk acknowledged: no CPFP escape valve on force-close → see todo #359

**Option B — New doc supersedes old**

Create `docs/solutions/integration-issues/ldk-non-anchor-feerate-floor-fix.md` and add a "Superseded by" link at the top of the prior doc.

- Pros: Cleaner per-incident provenance.
- Cons: Two files to read.

**Option C — One umbrella doc**

Replace both with `docs/solutions/integration-issues/ldk-feerate-floor-strategy.md` covering both anchor and non-anchor floors and the LSP compatibility matrix.

- Pros: Single source of truth.
- Cons: More work.

## Recommended Action

(filled during triage — likely Option A as smallest)

## Technical Details

- **Affected files:** `docs/solutions/integration-issues/ldk-anchor-channel-feerate-floor-fix.md`, possibly new doc

## Acceptance Criteria

- [ ] Doc reflects current code values (both floors at 253)
- [ ] Doc explains the LQwD-specific reason
- [ ] Doc links the user-warning todo (#359) and capability-matrix todo (#362)

## Work Log

_(empty)_

## Resources

- Branch: `fix/lqwd-channel-acceptance`
