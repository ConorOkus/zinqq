---
status: pending
priority: p3
issue_id: "049"
tags: [code-review, simplicity, cleanup]
dependencies: []
---

# Dead code removal and minor simplifications

## Problem Statement

Several items identified as unnecessary complexity or dead code.

## Findings

1. **`src/onchain/use-onchain.ts`** — exported hook with zero consumers (dead code)
2. **`SyncStatus` type in `ldk-context.ts`** — 3-variant union where only `'syncing'` is ever assigned; no consumer reads it
3. **`isNewWallet` on `BdkWallet` interface** — exported but destructured away by the only consumer
4. **`wallet: Wallet` on `OnchainContextValue`** — exposes raw WASM object; no external consumer uses it
5. **`Wallet` value import in `event-handler.ts`** — should be `import type { Wallet }` (avoids bundling BDK WASM into LDK module)
6. **Inline `import()` type in `init.ts:64`** — inconsistent with top-level import style used elsewhere
7. **`*-context.ts` files** could be merged into their `context.tsx` counterparts (saves 2 files)

## Proposed Solutions

Address each item individually — all are small, low-risk changes.
- **Effort:** Small | **Risk:** Low

## Acceptance Criteria
- [ ] No unused exports in onchain/ or ldk/ modules
- [ ] `import type` used for type-only imports from BDK-WASM
