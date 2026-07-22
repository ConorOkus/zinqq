---
title: 'Fix missing abort controller in fetchAndRouteInvoice and negative guard in satsToBtcString'
category: logic-errors
date: 2026-03-23
tags:
  - abort-controller
  - cancellation
  - bigint
  - bip21
  - lightning
  - send-flow
  - input-validation
severity: medium
components:
  - src/pages/Send.tsx
  - src/onchain/bip321.ts
related_todos:
  - 158-pending-p2-fetchandrouteinvoice-missing-abort-controller
  - 163-pending-p2-satstobctstring-negative-guard
---

## Problem

Two independent bugs in the zinqq Lightning wallet frontend, both classified P2:

**1. fetchAndRouteInvoice missing abort controller (`src/pages/Send.tsx`)**

When a user navigated the LNURL payment flow via the amount step (`handleAmountNext`), `fetchAndRouteInvoice` read `resolveAbortRef.current` to obtain an AbortController. However, when invoked from the amount step rather than from `resolveAddress`, no controller had been assigned to the ref — it was `null`. The fetch therefore ran without an abort signal and could not be cancelled by the user (e.g. by pressing back or navigating away).

**2. satsToBtcString negative guard (`src/onchain/bip321.ts`)**

`satsToBtcString` produced malformed BTC amount strings for negative `bigint` inputs. For example, `-1n` would yield `"0.-0000001"` instead of throwing. This silently produced an invalid BIP-21 URI amount field.

## Root Cause

**1.** The abort controller was only created inside `resolveAddress`. `fetchAndRouteInvoice` assumed that code path had always run first, but the LNURL flow can call `fetchAndRouteInvoice` directly from `handleAmountNext` without going through `resolveAddress`, leaving `resolveAbortRef.current` as `null`. Optional chaining (`controller?.signal`) masked the null at the call site rather than fixing it.

**2.** JavaScript bigint modulo preserves the sign of the dividend. `(-1n % 100_000_000n)` evaluates to `-1n`, not `99_999_999n`. The function constructed the fractional part from this result directly, producing a string with a negative sign embedded in the middle of the number.

## Solution

**1.** Move AbortController creation to the top of `fetchAndRouteInvoice`. Abort any existing controller first (covering the case where a prior fetch is in flight), then assign a fresh one to the ref before the fetch begins. Remove all optional chaining on `controller` since it is now guaranteed non-null within the function.

```typescript
// Before
const controller = resolveAbortRef.current
// ... later
const invoiceStr = await fetchLnurlInvoice(callback, amountMsat, controller?.signal)
// ... catch
if (controller?.signal.aborted) return

// After
resolveAbortRef.current?.abort()
const controller = new AbortController()
resolveAbortRef.current = controller
// ... later
const invoiceStr = await fetchLnurlInvoice(callback, amountMsat, controller.signal)
// ... catch
if (controller.signal.aborted) return
```

**2.** Add an explicit guard at the start of `satsToBtcString` that throws a `RangeError` for any negative input, failing loudly rather than silently emitting a malformed string.

```typescript
if (sats < 0n) throw new RangeError('satsToBtcString: negative input')
```

A test case covering the negative input path was added alongside the fix.

## Verification

- All 18 bip21 tests pass, including the new negative-input test case
- TypeScript compiles clean with no errors
- CI passed on PR #42; merged to main

## Related Documentation

- `docs/solutions/design-patterns/react-send-flow-amount-first-state-machine.md` — documents the Send.tsx state machine and ref patterns
- `docs/solutions/integration-issues/bdk-wasm-onchain-send-patterns.md` (Section 7) — fixed-point parsing in bip21.ts
- `docs/solutions/integration-issues/qr-scanner-camera-send-flow-integration.md` — covers the `handleAmountNext` path where the abort controller bug was exposed
- `docs/solutions/integration-issues/bip321-unified-uri-bolt11-invoice-generation.md` — BIP 21 URI construction on the receive side

## Cross-References

- **PR #42** — this fix
- **Todo #149** (complete) — LNURL invoice amount validation, same `fetchAndRouteInvoice` function
- **Todo #157** (pending) — production CORS strategy for LNURL, same flow
- **Todo #164** (pending) — extract `buildBip321Uri` utility, same bip321.ts module

## Prevention

### Missing AbortController (ref-before-set pattern)

- Async functions that need cancellation should create their own `AbortController` internally rather than depending on external state set up by callers
- Flag any function that reads from a `useRef` without a null-check guard when the ref is set conditionally
- For every async function, write at least one test that invokes it without the surrounding setup a happy-path test assumes

### Negative bigint modulo (sign-preserving `%` operator)

- Flag any use of `%` on a value whose sign is not statically guaranteed non-negative, especially on `bigint` types
- Formatting functions that convert numeric types to strings should throw on invalid input rather than producing silently wrong output
- For every numeric formatting utility, include a test case with `-1n` and assert it either throws or produces correct output

## Key Takeaways

1. **Refs are shared state, not initialization guarantees.** A `useRef` set in one code path is invisible to another that runs independently. Own the resource in the function that uses it.

2. **JavaScript `%` is remainder, not modulo.** `(-1n) % 100_000_000n === -1n`, not `99_999_999n`. Any formatting that assumes non-negative remainders is wrong for negative input.

3. **Silent wrong output is worse than a thrown error.** Both bugs produced no runtime exception — they produced wrong values. Prefer loud failures in utility functions.

4. **Call-site diversity is a forcing function for assumptions.** The abort controller bug only became possible because multiple call sites existed. When a function gains a second call site, review all assumptions about external state being pre-initialized.
