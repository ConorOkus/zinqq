---
status: complete
priority: p1
issue_id: '305'
tags: [code-review, security, lsps2, pr-150]
dependencies: []
---

# Tautological `params.promise` self-check in `executeJitBuy`

## Problem Statement

`executeJitBuy` snapshots `quote.params.promise` before issuing `buyChannel`, then asserts the snapshotted value still matches `quote.params.promise` after the BOLT11 invoice is signed. Both reads come from the same `quote.params` object reference held in a local variable — the assertion can only fire if our own code mutates `quote.params.promise` between the two reads, which it doesn't. As written, the check is dead defense-in-depth that **looks** like protection against an LSP swapping params at buy time but provides none.

## Findings

- **File**: `src/ldk/context.tsx`, lines 303–305 (snapshot) and 339–341 (assertion)
- **Identified by**: security-sentinel (P1-A), code-simplicity-reviewer (#7)
- The comment at `:301` calls this "Defense-in-depth" but it cannot detect any realistic attack vector
- `BuyResponse` (`src/ldk/lsps2/types.ts:42-46`) does NOT contain a `promise`/`fee` echo, so a real check would have to re-derive the fee from the buy response and compare against `quote.openingFeeMsat`
- The misleading comment may give future maintainers and security reviewers a false sense of coverage

## Proposed Solutions

### Option A: Remove the assertion + comment (Recommended)

- Delete lines 303–305 and 339–341 plus the explanatory comment
- The plan's intent (post-display fee inflation protection) is genuinely impossible at this layer — the LSP signs the params via `promise`, so it can't change them at `buyChannel` time without invalidating the signature
- **Pros**: Removes misleading code; ~10 LOC saved
- **Cons**: Loses the _appearance_ of a check
- **Effort**: Small
- **Risk**: Low

### Option B: Replace with a real check

- After `buyChannel`, re-derive the fee using `calculateOpeningFee(quote.amountMsat, quote.params)` and assert it equals `quote.openingFeeMsat`
- Still tautological since both come from the same `quote` — but at least exercises the math
- **Pros**: Looks more like a check
- **Cons**: Still no real coverage; the actual hole is at HTLC claim time (see todo 306)
- **Effort**: Small

## Recommended Action

(Filled during triage)

## Technical Details

- **Affected files**: `src/ldk/context.tsx`
- **Components**: LSPS2 buy phase

## Acceptance Criteria

- [ ] Misleading snapshot/assertion removed OR replaced with a check that exercises non-trivial logic
- [ ] No comment claims protection that the code doesn't provide
- [ ] `pnpm test` and `pnpm lint` pass

## Work Log

- **2026-05-06** — Resolved via Option A (remove the assertion + comment). Deleted `snapshotPromise` and the post-buy equality check in `executeJitBuy`. The `snapshotFee` local was redundant with `quote.openingFeeMsat` and now reads directly. ~10 LOC removed; no test changes needed because the assertion was unreachable. PR #150 commit `6e07bd9`.

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/150
- Plan: `docs/plans/2026-05-06-001-feat-lsps2-receive-review-screen-plan.md`
