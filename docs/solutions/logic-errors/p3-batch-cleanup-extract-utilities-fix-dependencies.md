---
title: 'Batch P3 cleanup: extract shared utilities, fix dependency inversions, propagate errors'
category: logic-errors
date: 2026-03-27
tags:
  - refactoring
  - technical-debt
  - code-extraction
  - dependency-management
  - documentation
components:
  - onchain
  - ldk
  - lnurl
  - components
  - pages
severity: low
resolution_type: cleanup
---

## Problem

The zinqq codebase had accumulated ~90 pending P3 cleanup todos. Many (61) were already resolved in code but had stale `status: pending` frontmatter. The remaining quick wins involved:

- **Code duplication**: numpad digit reducer copied in 3 files, `isVssConflict` in 2 files, BIP 21 URI construction inline
- **Inverted dependency**: `src/ldk/payment-input.ts` importing `LnurlPayMetadata` from `src/lnurl/resolve-lnurl.ts`
- **Swallowed errors**: `resolveBip353` catching and discarding `AbortError`
- **Missing documentation**: `VSS_PROXY_TARGET` not in `.env.example`, `pnpm preview` proxy gap undocumented

## Root Cause

Code duplication and dependency inversions accumulated during rapid feature development. Todo tracking fell out of sync as fixes were applied across PRs without updating todo status.

## Solution

### 1. buildBip21Uri extraction

Extracted 12-line inline BIP 21 URI construction from Receive.tsx into `src/onchain/bip21.ts`:

```typescript
export function buildBip21Uri({ address, amountSats, invoice }: BuildBip21Options): string
```

Complements existing `parseBip21`. Added 8 unit tests including round-trip validation. Parameter `invoice` typed as `string | null` to match React state conventions.

### 2. numpadDigitReducer extraction

Same 6-line digit reducer duplicated in Send.tsx, OpenChannel.tsx, Receive.tsx. Extracted to `src/components/numpad-reducer.ts`:

```typescript
export function numpadDigitReducer(prev: string, key: NumpadKey, maxDigits?: number): string
```

**Key detail**: Must live in a separate file from `Numpad.tsx` — exporting non-component functions from a component file triggers Vite's fast refresh warning, which fails the CI build step.

### 3. isVssConflict extraction

Identical check in `persist.ts` and `persist-cm.ts`:

```typescript
err instanceof VssError && err.errorCode === ErrorCode.CONFLICT_EXCEPTION
```

Extracted to `src/ldk/storage/vss-client.ts` alongside the `VssError` class.

### 4. LnurlPayMetadata dependency fix

`payment-input.ts` (ldk layer) was importing from `resolve-lnurl.ts` (lnurl layer) — an inverted dependency. Moved `LnurlPayMetadata` interface to `payment-input.ts`. The `resolve-lnurl.ts` module now imports and re-exports from there.

### 5. AbortError propagation in resolveBip353

`resolveBip353` swallowed all fetch errors including `AbortError` (returned null). Added guard before the catch-all:

```typescript
catch (err) {
  if (err instanceof DOMException && err.name === 'AbortError') throw err
  return null
}
```

This matches `resolveLnurlPay` which already re-threw `AbortError`.

### 6. Documentation additions

- Added `VSS_PROXY_TARGET=http://localhost:8080` to `.env.example`
- Added comment in `src/ldk/config.ts` noting `/__vss_proxy/vss` path requires Vite dev or Vercel rewrite
- Added JSDoc on phantom `lnurl` variant in `ParsedPaymentInput`

### 7. Todo status sync

Batch-updated 61 todos with "complete" in filename but `status: pending` in frontmatter.

## Prevention Strategies

1. **Extract on second occurrence**: If a function appears in 2+ files, extract before merge. Don't wait for a third copy.
2. **Enforce layer boundaries**: Consider adding ESLint `import/no-restricted-paths` to forbid ldk/ imports from lnurl/.
3. **Always re-throw AbortError**: Any function accepting `signal?: AbortSignal` that catches errors must re-throw `AbortError`. Create a shared `isAbortError` guard utility.
4. **Run `pnpm format` before commit**: Prettier failures are the most common CI blocker. A pre-commit hook would catch these locally.
5. **Use feature branches**: Never push directly to main — always create a branch and open a PR so CI runs before merge.
6. **Vite fast refresh rule**: Non-component exports (utility functions, constants, types) must live in separate files from React component files.

## Related Documentation

- [BIP 321 unified URI construction](../integration-issues/bip321-unified-uri-bolt11-invoice-generation.md) — original inline BIP 21 implementation
- [AbortController and BigInt sign fixes](abort-controller-and-bigint-sign-fixes.md) — related AbortError propagation work
- [VSS dual-write persistence](../design-patterns/vss-dual-write-persistence-with-version-conflict-resolution.md) — context for isVssConflict extraction
- [Vercel staging VSS proxy](../infrastructure/vercel-staging-vss-serverless-proxy.md) — context for VSS_PROXY_TARGET documentation
