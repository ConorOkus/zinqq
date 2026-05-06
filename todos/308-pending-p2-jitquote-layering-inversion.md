---
status: pending
priority: p2
issue_id: '308'
tags: [code-review, architecture, types, pr-150]
dependencies: []
---

# `JitQuote` import creates a layering inversion

## Problem Statement

`src/ldk/ldk-context.ts` (the type/seam module that defines `LdkContextValue`) now imports `JitQuote` from `./context` (the React provider implementation). The seam module should not depend on the implementation module — that's a layering inversion. As a downstream symptom, callers (`Receive.tsx:17`) import the type from a `.tsx` file, which is a smell.

## Findings

- **File**: `src/ldk/ldk-context.ts:14` — `import type { JitQuote } from './context'`
- **File**: `src/pages/Receive.tsx:17` — `import { ..., type JitQuote } from '../ldk/context'`
- **Identified by**: kieran-typescript-reviewer (#1), architecture-strategist (#7)
- `JitQuote` is a pure data shape — it has no React dependency

## Proposed Solutions

### Option A: Move `JitQuote` to `src/ldk/lsps2/types.ts` (Recommended)

- The type belongs alongside `OpeningFeeParams`, `BuyResponse`, `JitInvoiceResult`
- Update imports in `context.tsx`, `ldk-context.ts`, `Receive.tsx`, tests
- **Pros**: Clean layering; types live in `types.ts`
- **Cons**: Touches several files
- **Effort**: Small
- **Risk**: Low

### Option B: Move `JitQuote` + the error classes to a new `src/ldk/lsps2/jit-quote.ts`

- Group quote-specific types and errors together
- **Pros**: Cohesive module
- **Cons**: One more file
- **Effort**: Small

## Recommended Action

(Filled during triage)

## Technical Details

- **Affected files**: `src/ldk/context.tsx`, `src/ldk/ldk-context.ts`, `src/ldk/lsps2/types.ts`, `src/pages/Receive.tsx`, test files
- **Note**: `JitPeerConnectError`, `JitPaymentSizeOutOfRangeError`, `JitQuoteFreshnessError` could move with `JitQuote` for consistency

## Acceptance Criteria

- [ ] `JitQuote` defined in `src/ldk/lsps2/types.ts` (or a new `src/ldk/lsps2/jit-quote.ts`)
- [ ] `ldk-context.ts` no longer imports from `context.tsx`
- [ ] `pnpm test` and `pnpm lint` pass

## Work Log

(Empty)

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/150
