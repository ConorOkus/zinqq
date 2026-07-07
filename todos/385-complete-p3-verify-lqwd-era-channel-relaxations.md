---
status: complete
priority: p3
issue_id: '385'
tags: [code-review, ldk, channel-config, security, tech-debt, pr-167]
dependencies: []
---

# Verify (or retire) LQwD-era channel relaxations now that Megalith is the sole LSP

## Problem Statement

Two wallet-global LDK relaxations were adopted specifically for LQwD's behavior
(PR #162) and retained after LQwD removal, with comments genericized from "LQwD
diverges" to "some LSPs diverge." Their concrete justification left with LQwD, so
they are now defensive settings outliving their documented cause. Flagged by
security (B), simplicity (#5), architecture (#5), and learnings reviewers.

## Findings

- `src/ldk/user-config.ts:37` — `set_force_announced_channel_preference(false)`.
  **Security-relevant**: relaxes a handshake safety check (accepts a peer whose
  announce preference differs from ours) with no currently-known LSP requiring it.
- `src/ldk/traits/fee-estimator.ts:18` — `MinAllowedNonAnchorChannelRemoteFee = 253`
  sat/kW floor. Accepting a very low remote commitment feerate risks slow
  force-close confirmation. (Note: 253 ≈ LDK's absolute 1 sat/vB floor, so only
  mildly LQwD-specific.)
- Both are wallet-global (apply to every peer/channel), not scoped to the LSP.
- These are permissive _relaxations_, so removing them blind risks breaking Megalith
  channel opens if Megalith shares the behavior — do NOT strip without verification.

Related doc (now flagged partially-superseded):
`docs/solutions/integration-issues/ldk-lqwd-announce-preference-and-non-anchor-feerate-floor.md`.

## Proposed Solutions

### Option A: Verify against Megalith, then tighten or re-document

Observe a real Megalith JIT channel open. If Megalith opens unannounced with
standard/anchor feerates, remove the unneeded relaxation(s) to tighten the
handshake. If it needs them, restore a concrete, Megalith-named rationale in the
comments and the solution doc. Effort: Small (once a live open can be observed).

### Option B: Keep as-is, documented as defensive

Leave both; note explicitly they are retained defensively pending verification.
Zero runtime cost, but leaves a security-relevant relaxation unjustified. Effort:
Trivial.

## Recommended Action

(Triage) Option A — this LSP swap is the right moment to re-validate; prioritize the
`force_announced_channel_preference` check (security-relevant) over the feerate floor.

## Technical Details

- **Affected files**: `src/ldk/user-config.ts`, `src/ldk/traits/fee-estimator.ts`,
  and the related solution doc.

## Acceptance Criteria

- [ ] Each setting is confirmed needed for Megalith (with a named rationale) or
      removed.
- [ ] If removed, a real Megalith JIT receive still opens the channel and forwards.

## Work Log

- 2026-07-07: Filed from `/ce:review` (delta review) of PR #167. Requires a live
  Megalith channel open to verify — deferred to when that's observable.
- 2026-07-07: Resolved via Option B (documented as defensive). Both settings
  (`user-config.ts` announce-preference, `fee-estimator.ts` 253 sat/kW floor) now
  carry a comment: "Originally added for LQwD (removed); retained defensively —
  verify against Megalith before tightening." The tighten path (Option A) remains
  available if a live Megalith open shows either is unnecessary — reopen this todo
  if so. Not removing blind: they are permissive relaxations, so stripping them
  could break Megalith channel opens.
