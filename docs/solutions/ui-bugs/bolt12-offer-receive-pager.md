---
title: 'Add swipeable BOLT 12 offer QR pager to receive screen'
category: ui-bugs
date: 2026-04-01
tags:
  - bolt12
  - bip21
  - bip321
  - receive
  - qr-code
  - lightning
  - pager
  - lno
components:
  - src/pages/Receive.tsx
  - src/onchain/bip321.ts
  - src/onchain/bip321.test.ts
  - src/pages/Home.tsx
severity: medium
related_prs:
  - '#73'
  - '#72'
  - '#71'
---

## Problem

The BOLT 12 offer — a reusable, static Lightning payment code — was buried three levels deep in Settings > Advanced > BOLT 12 Offer. Most users never discovered it. The receive screen showed a single QR code (a unified BIP 321 URI combining on-chain address + Lightning invoice) with no indication that a reusable payment option existed.

## Root Cause

Three independent sub-problems had to be solved together:

1. **Pager integration**: The existing receive screen had a single QR `<div>` with no scroll container. Wrapping it in a swipeable pager required restructuring the layout without breaking the existing amount-entry, JIT-negotiation, and success states.

2. **BIP 21 URI spec compliance for BOLT 12**: The correct query parameter name for a BOLT 12 offer in a BIP 21 URI is `lno`, not `b12` (which was initially used). The `buildBip321Uri` function also required `address` as a mandatory field, but a standalone BOLT 12 URI should omit the on-chain address entirely, producing `bitcoin:?lno=<offer>`.

3. **JIT flow guard**: LSPS2 does not support BOLT 12, so the pager's second page must be hidden during JIT flow. The guard had to be derived from two independent pieces of state (`bolt12Offer` availability + `needsAmount`), and `activeQrPage` had to reset back to `'unified'` if the BOLT 12 page disappeared mid-session.

## Solution

### 1. Swipeable pager with CSS snap scrolling

A horizontal scroll container with `snap-x snap-mandatory` provides native swipe physics — no JS animation library needed.

```tsx
type QrPage = 'unified' | 'bolt12'

const [activeQrPage, setActiveQrPage] = useState<QrPage>('unified')
const scrollRef = useRef<HTMLDivElement>(null)

const handleScroll = useCallback(() => {
  const el = scrollRef.current
  if (!el || el.clientWidth === 0) return // guard: zero clientWidth during layout
  const page = Math.round(el.scrollLeft / el.clientWidth)
  setActiveQrPage(page === 1 ? 'bolt12' : 'unified')
}, [])
```

```tsx
<div
  ref={scrollRef}
  className="flex snap-x snap-mandatory overflow-x-auto scrollbar-none"
  onScroll={handleScroll}
>
  {/* Page 1: Unified BIP 321 QR */}
  <div className="flex w-full shrink-0 snap-center justify-center">...</div>
  {/* Page 2: BOLT 12 Offer QR */}
  {showBolt12 && <div className="flex w-full shrink-0 snap-center justify-center">...</div>}
</div>
```

Decorative dot indicators use `<span aria-hidden="true">` — not interactive buttons.

### 2. BIP 21 URI wrapping with `lno` parameter

Made `address` optional in `buildBip321Uri` and added the `lno` field per the BIP 21 BOLT 12 extension:

```typescript
export interface BuildBip321Options {
  address?: string // now optional — BOLT 12-only URIs omit it
  amountSats?: bigint
  invoice?: string | null
  lno?: string | null // BOLT 12 offer parameter per BIP 21
}
```

Usage in Receive.tsx:

- Unified QR includes `lno` when BOLT 12 is available: `lno: showBolt12 ? bolt12Offer : null`
- Standalone BOLT 12 QR omits the address: `buildBip321Uri({ lno: bolt12Offer })`

### 3. JIT flow guard and page reset

```typescript
const showBolt12 = bolt12Offer && !needsAmount

useEffect(() => {
  if (!showBolt12) setActiveQrPage('unified')
}, [showBolt12])
```

### 4. Cleanup

Deleted the now-redundant standalone `Bolt12Offer.tsx` page (65 lines), its test file (93 lines), the Advanced Settings entry, and the `/bolt12-offer` route.

## Code Review Findings (P1-P3)

All addressed in commit `fc1b886`:

| Priority | Issue                                                                                        | Fix                                                          |
| -------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| P1       | `activeQrPage` not reset when BOLT 12 page disappears — stale state causes wrong `copyValue` | Added `useEffect` to reset to `'unified'` when `!showBolt12` |
| P2       | No unit tests for `lno` parameter in BIP 321 URIs                                            | Added 6 tests to `bip321.test.ts`                            |
| P2       | Dead files `Bolt12Offer.tsx` / `Bolt12Offer.test.tsx` left in tree                           | Deleted                                                      |
| P2       | `handleScroll` divides by zero when `clientWidth === 0`                                      | Added early-return guard                                     |
| P3       | Redundant `showBolt12 && bolt12Uri` double guard                                             | Simplified to `showBolt12`                                   |
| P3       | Dot indicators were `<button>` with tiny touch targets                                       | Changed to `<span aria-hidden="true">`                       |

## Prevention Strategies

1. **Read the BIP/BOLT spec before writing any URI parameter name.** The initial `b12` parameter name required two fix commits to correct to `lno`. Link the relevant spec to the PR description before writing code.

2. **Guard async-dependent UI at design time.** When a UI element is conditionally rendered based on async state, immediately ask: "what happens to any index or cursor pointing into this element if it disappears?" Write the reset effect in the same commit as the feature.

3. **Guard scroll math against zero `clientWidth`.** Scroll containers can briefly have zero width during mount or CSS transitions. Any division by a DOM measurement should treat zero as invalid input.

4. **Delete orphaned files at the PR that removes their purpose.** Don't leave dead files for a follow-up cleanup.

5. **Prefer decorative indicators over interactive buttons** for scroll-based carousels unless user research shows tap navigation is needed.

## Test Recommendations

- Assert `lno=` appears in URI output (and `b12` does NOT)
- Assert `buildBip321Uri({ lno: '...' })` produces `bitcoin:?lno=...` (no address)
- Assert parameter ordering: `amount → lightning → lno`
- Component test: scroll to page 2, trigger JIT path, assert reset to `'unified'`
- Component test: assert BOLT 12 pager is absent from DOM during JIT flow

## Related Documentation

- [BIP 321 unified URI + BOLT 11 invoice generation](../integration-issues/bip321-unified-uri-bolt11-invoice-generation.md)
- [BOLT 12 offer creation missing paths](../integration-issues/bolt12-offer-creation-missing-paths.md)
- [LSPS2 JIT receive effect dependencies](../integration-issues/lsps2-jit-receive-react-effect-dependencies.md)
- [Bottom sheet focus trap scroll lock](bottomsheet-focus-trap-scroll-lock.md)
- [BOLT 12 receive brainstorm](../../brainstorms/2026-03-19-bolt12-receive-brainstorm.md)
- [Receive UI tweaks brainstorm](../../brainstorms/2026-03-31-receive-ui-tweaks-brainstorm.md)
