---
status: pending
priority: p2
issue_id: '316'
tags: [code-review, security, lsps2, pr-150]
dependencies: []
---

# Add freshness gate at `executeJitBuy` entry

## Problem Statement

`getJitQuote` rejects quotes with `<30s` remaining at quote time, but `executeJitBuy` does NOT re-check `validUntil` at entry. After Phase A returns, the user may dwell on the Review screen indefinitely. If `validUntil` lapses before they tap Generate Payment Request, `buyChannel` may either:

- Be rejected by the LSP (safe — no commitment), or
- Be accepted on best-effort terms (unsafe — wallet bound to potentially worse pricing it never re-displayed).

The plan deferred the proper "60s on-tap freshness window + 'Fee updated' banner" mechanic to PR 2. A minimal entry-time gate in `executeJitBuy` would close most of the risk in this PR without the full re-quote machinery.

## Findings

- **File**: `src/ldk/context.tsx:295-360` (`executeJitBuy`)
- **File**: `src/ldk/context.tsx:228-235` (existing 30s gate at quote time)
- **Identified by**: security-sentinel (P2-C)
- Plan section: "Phase 4: Stale quote re-fetch + lifecycle hooks" (deferred to PR 2)

## Proposed Solutions

### Option A: Reject expired quotes at `executeJitBuy` entry (Recommended for this PR)

```ts
// At executeJitBuy entry, after signal check:
if (new Date(quote.params.validUntil).getTime() < Date.now()) {
  throw new JitQuoteFreshnessError('Quote expired before commit')
}
```

- The `'jit-error'` UI shows the user that the quote went stale
- `handleErrorRetry` re-runs Phase A → fresh quote
- **Pros**: Closes the dwell-too-long hole; ~3 LOC
- **Cons**: Doesn't have the smooth "Fee updated" UX (reserved for PR 2)
- **Effort**: Tiny

### Option B: Wait for PR 2's full re-quote-on-tap mechanic

- Document the gap; let PR 2 land the 60s window + banner
- **Pros**: Single coherent UX
- **Cons**: Hole stays open in this PR

### Option C: Silent re-quote at `executeJitBuy` entry

- If `validUntil` lapsed, silently fetch a fresh quote against the same LSP, compare fee, proceed if unchanged
- **Pros**: Smooth UX
- **Cons**: Approaches Phase 4 scope; defeats the point of deferring

## Recommended Action

(Filled during triage — Option A balances scope vs. safety)

## Technical Details

- **Affected files**: `src/ldk/context.tsx`

## Acceptance Criteria

- [ ] `executeJitBuy` rejects with `JitQuoteFreshnessError` when `validUntil < now` at entry
- [ ] `'jit-error'` UI surfaces the freshness failure with "Try again" CTA
- [ ] Test: mock a quote with stale `validUntil`, assert `executeJitBuy` throws and `buyChannel` is not called
- [ ] `pnpm test` and `pnpm lint` pass

## Work Log

(Empty)

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/150
- Plan section: "Phase 4: Stale quote re-fetch"
