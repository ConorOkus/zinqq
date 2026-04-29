---
status: cancelled
priority: p2
issue_id: '261'
tags: [code-review, payjoin, testing]
dependencies: []
---

# Payjoin test coverage gaps: Stasis→Progress, session timeout, sleep abort path

## Problem Statement

`payjoin.test.ts` ships 7 tests but doesn't cover three production-relevant paths:

1. **Stasis → Progress transition** — the most common production case (receiver doesn't reply on first poll). The mock harness's `outcomes` queue supports this but no test exercises it. Production polling has never been tested end-to-end against the mock.

2. **Session timeout** — the composed signal fires from the inner 45s `setTimeout`, not from `ctx.signal`. The discrimination logic at `payjoin.ts:235-238` (`ctx.signal.aborted ? 'backgrounded' : 'timeout'`) is currently untested.

3. **`sleep()` own abort path** — timer cleared, listener removed when signal fires mid-sleep. Use fake timers.

## Findings

- **kieran-typescript-reviewer P2 #12**: enumerated the three gaps.

## Proposed Solutions

### Option 1 (recommended) — Three new tests using fake timers

Add to `payjoin.test.ts`:

```ts
// 1. Stasis → Progress
it('polls through Stasis to Progress and returns the eventual proposal', async () => {
  // outcomes: [{ tag: 'Stasis' }, { tag: 'Stasis' }, { tag: 'Progress', psbtBase64: '...' }]
  // assert calls to fetch >= 3, final result is the proposal
})

// 2. Session timeout
it('throws PayjoinFallback("timeout") when the 45s session ceiling fires', async () => {
  vi.useFakeTimers()
  // start tryPayjoinSend, advance fake timers past 45s, expect 'timeout' (not 'backgrounded')
})

// 3. sleep abort
it('sleep() cleans up timer and listener when signal fires mid-sleep', async () => {
  // use fake timers, abort signal, assert timer was cleared
})
```

- Pros: covers paths the production flow actually exercises; catches regressions on the timeout/backgrounded discrimination.
- Cons: need to introduce fake timers in the test (vitest supports this).

## Recommended Action

Option 1.

## Technical Details

- Affected file: `src/onchain/payjoin/payjoin.test.ts`
- Use `vi.useFakeTimers()` / `vi.advanceTimersByTimeAsync(ms)` for the timeout test

## Acceptance Criteria

- [ ] Stasis → Progress test passes
- [ ] Session timeout test passes (with fake timers)
- [ ] sleep abort path test passes (or merged into session timeout)
- [ ] Total test count goes from 7 to ≥10

## Work Log

## Resources

- PR #143

## Cancelled

2026-04-29 — Payjoin integration removed (chore/remove-payjoin). Reopen if Payjoin is re-integrated.
