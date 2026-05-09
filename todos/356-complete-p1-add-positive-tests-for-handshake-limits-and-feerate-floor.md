---
status: complete
priority: p1
issue_id: '356'
tags: [code-review, ldk, tests, fix-lqwd-channel-acceptance]
dependencies: []
---

# Add positive tests for `force_announced_channel_preference(false)` and the new 253 sat/kW non-anchor floor

## Problem Statement

The `fix/lqwd-channel-acceptance` branch makes two behavioural changes:
1. `src/ldk/init.ts:163` — `handshakeLimits.set_force_announced_channel_preference(false)`
2. `src/ldk/traits/fee-estimator.ts:22` — `MinAllowedNonAnchorChannelRemoteFee: 253`

Neither change has a positive test asserting the contract:
- `init-recovery.test.ts:205` only mocks the new setter (so init doesn't crash) — it does **not** assert it was called with `false`.
- `fee-estimator.test.ts` covers `UrgentOnChainSweep` and `MaximumFeeEstimate` but has zero cases for `MinAllowedNonAnchorChannelRemoteFee` or `MinAllowedAnchorChannelRemoteFee`.

A future refactor that "tidies" either value back to its old default would not be caught by any test, and we'd be back to LQwD channel opens failing in production.

## Findings

- kieran-typescript-reviewer P1 (test coverage gap on `createUserConfig`)
- kieran-typescript-reviewer P1 (no regression test for the 253 floor)

## Proposed Solutions

**Option A — Assert calls on the existing init mock**

In `init-recovery.test.ts`, capture the `handshakeLimits` mock and assert `expect(handshakeLimits.set_force_announced_channel_preference).toHaveBeenCalledWith(false)` after init. Apply the same pattern to other config setters that lack assertions (`set_trust_own_funding_0conf(true)`, `set_negotiate_anchors_zero_fee_htlc_tx(true)`).

- Pros: Localises the contract to the file that already owns the LDK mock; no new export.
- Cons: `init-recovery.test.ts` is already large and not focused on config.
- Effort: Small.
- Risk: None.

**Option B — Extract `createUserConfig` and unit-test it directly**

Export `createUserConfig` from `init.ts` (or a thin `getHandshakeConfigSpec()` returning a plain record) and add a new `createUserConfig.test.ts` with one assertion per setter.

- Pros: Tightest contract; easiest to read; survives future refactors of init flow.
- Cons: Adds a small public surface to `init.ts`.
- Effort: Small.
- Risk: None.

**Option C — Add fee-estimator regression tests**

In `fee-estimator.test.ts`, add cases pinning both `MinAllowed*ChannelRemoteFee` to `253` when the cache returns near-zero, and one case where esplora rate exceeds the floor.

- Pros: Catches accidental regression of the magic number.
- Cons: None — should ship regardless of A vs B.
- Effort: Small.
- Risk: None.

## Recommended Action

(filled during triage — likely Option A + Option C as a single small follow-up PR)

## Technical Details

- **Affected files:** `src/ldk/init-recovery.test.ts`, `src/ldk/traits/fee-estimator.test.ts`, optionally `src/ldk/init.ts` (export)

## Acceptance Criteria

- [ ] Test asserts `set_force_announced_channel_preference` is called with `false`
- [ ] Test asserts `MinAllowedNonAnchorChannelRemoteFee` returns `253` from `computeFeeRateSatKw` under low cache
- [ ] Test asserts `MinAllowedAnchorChannelRemoteFee` still returns `253` (regression guard for the prior PR #102 fix)

## Work Log

- 2026-05-08: Resolved on `fix/lqwd-channel-acceptance` (Option B + Option C combined).
  - Extracted `createUserConfig` to `src/ldk/user-config.ts` (only depends on `lightningdevkit`'s `UserConfig`) so it can be unit-tested without mocking `init.ts`'s full dependency chain. `init.ts` re-imports it; both call sites untouched.
  - Added `src/ldk/user-config.test.ts` with 7 tests (one per setter), including the LQwD regression guard: `expect(set_force_announced_channel_preference).toHaveBeenCalledWith(false)`.
  - Added 2 cases to `src/ldk/traits/fee-estimator.test.ts`: floor-pinning regression guards for both `MinAllowedAnchorChannelRemoteFee` and `MinAllowedNonAnchorChannelRemoteFee` at 253 sat/kW under near-zero esplora rates.
  - All 480 tests pass; typecheck + lint clean.

## Resources

- Branch: `fix/lqwd-channel-acceptance`
- Prior fix: `docs/solutions/integration-issues/ldk-anchor-channel-feerate-floor-fix.md` (PR #102)
- LDK source of "announcement preference" check: `lightning::ln::channel`
