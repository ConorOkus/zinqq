---
status: cancelled
priority: p3
issue_id: '268'
tags: [code-review, payjoin, documentation, plan]
dependencies: []
---

# Codify deferred plan items in source comments

## Problem Statement

The plan (`docs/plans/2026-04-23-001-feat-payjoin-send-support-plan.md`) called for several items that were deferred in PR #143. The PR description mentions some, but the _source code_ doesn't enumerate what was deferred and why. Future maintainers re-deriving the gap is wasted time.

Deferred items that should be visible at the call site:

1. **Lookahead-aware `is_mine`** (plan §31, §270-275): plan called this exploitable. Code uses direct `wallet.is_mine()` without temporary lookahead extension. A receiver proposing an output at derivation index past `last_revealed + 25` (BDK default) returns `false` even though the script is ours.
2. **Atomic `claim()` sentinel** (plan §32): TOCTOU-safe single-writer pattern. Plan justified its absence in PR #143 because the implemented model never nests `buildSignBroadcast`, but the source has no comment saying so — future readers will think this is missing.
3. **`finalizeAndBroadcast(tx)` extraction** (plan §97): related to #2.
4. **P2WPKH 294-sat dust check** (plan §278): not in validator.
5. **Sender-input PSBT field preservation** (plan §283-291): see todo #267 — BDK API gap.
6. **Multi-relay fallback** (plan §418): code has a partial comment (`payjoin.ts:7-12`) but doesn't reference the plan.

## Findings

- **architecture-strategist #9**: "comment block at the top of `payjoin.ts` enumerating plan items deferred, with rationale per item and a follow-up TODO link."

## Proposed Solutions

### Option 1 (recommended) — Top-of-file comment block

Add to `payjoin.ts`:

```ts
/**
 * Deferred from plan (docs/plans/2026-04-23-001-feat-payjoin-send-support-plan.md):
 *
 * - Lookahead-aware is_mine (plan §31): receiver can hide ownership of an
 *   output past current keychain lookahead. Mitigation: see todo #XXX.
 * - Atomic claim() sentinel (plan §32): not load-bearing here because the
 *   implemented model never nests buildSignBroadcast — the hook throws,
 *   buildSignBroadcast catches and signs the original in the same call.
 * - P2WPKH 294-sat dust check (plan §278): PDK enforces; our validator skips.
 * - Sender-input PSBT field preservation (plan §283-291): blocked on BDK
 *   exposing PSBT input fields — see todo #267.
 * - Multi-relay fallback (plan §418): single relay first; revisit if
 *   production telemetry shows availability issues.
 */
```

- Pros: keeps scope-revisions visible at the layer where someone would re-derive the gap.
- Cons: comment can drift from todos; needs to be kept in sync.

## Recommended Action

Option 1. Cross-reference the relevant todo IDs once they're created.

## Technical Details

- Affected file: `src/onchain/payjoin/payjoin.ts` — top-of-file comment block

## Acceptance Criteria

- [ ] Comment block added with cross-references to specific todo numbers
- [ ] Each deferred item linked to either a follow-up todo or a justification

## Work Log

## Resources

- PR #143
- Plan: `docs/plans/2026-04-23-001-feat-payjoin-send-support-plan.md`
- Related todos: #259, #267, #268

## Cancelled

2026-04-29 — Payjoin integration removed (chore/remove-payjoin). Reopen if Payjoin is re-integrated.
