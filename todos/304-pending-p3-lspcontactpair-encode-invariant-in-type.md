---
status: pending
priority: p3
issue_id: 304
tags: [code-review, architecture, pr-148]
dependencies: []
---

# P3 — `LspContactPair` allows {null, null}; encode invariant in type

## Problem Statement

`LspContactPair` is `{primary: LspContact | null; fallback: LspContact | null}`. The runtime invariant — at least one must be non-null — lives only in `runJitInvoiceFlow`'s early throw at line ~120. A discriminated union would lift the invariant into the type system, making it impossible to construct a pair with both nulls and removing the runtime guard plus several non-null assertions downstream.

## Findings

- `src/ldk/lsp/contacts.ts:22-25`:
  ```ts
  export interface LspContactPair {
    primary: LspContact | null
    fallback: LspContact | null
  }
  ```
- `src/ldk/lsp/contacts.ts:32-44` — `resolveLspContacts` can return `{primary: null, fallback: null}`; nothing in the type prevents it.
- Runtime invariant enforced in `runJitInvoiceFlow` (~ line 120): `if (!contacts.primary && !contacts.fallback) throw new Error('LSP not configured')`.
- Pairs with todo #298 — once invariant is encoded, the `contacts.fallback!` assertions disappear naturally.

## Proposed Solutions

### Option A — Discriminated union

```ts
export type LspContactPair =
  | { primary: LspContact; fallback: LspContact | null }
  | { primary: null; fallback: LspContact }
```

`resolveLspContacts` returns `LspContactPair | null` (null = neither configured); caller handles the null case once at the top, then type-narrows the rest of the flow.

**Pros:** Compile-time guarantee; eliminates runtime check + 3 non-null assertions; clearer contract.
**Cons:** Wider blast radius — touches every consumer of the pair.
**Effort:** Medium.
**Risk:** Low.

### Option B — Keep loose pair, document invariant

Add a JSDoc note on `LspContactPair` saying "at least one must be non-null; consumers MUST guard". Status quo.

**Pros:** No churn.
**Cons:** Invariant remains a runtime concern; type still permits the impossible state.
**Effort:** Trivial.
**Risk:** Low.

## Recommended Action

Option A. Land it together with todo #298 — they collapse into a single refactor that removes runtime check, removes 3 `!` assertions, and makes the type honest.

## Technical Details

- **Affected files:** `src/ldk/lsp/contacts.ts`, `src/ldk/lsp/jit-flow.ts` (or wherever `runJitInvoiceFlow` lives), any test fixtures.

## Acceptance Criteria

- [ ] `LspContactPair` cannot represent `{null, null}` at the type level.
- [ ] `resolveLspContacts` callers handle the "neither configured" case exactly once.
- [ ] Non-null assertions on `contacts.primary` / `contacts.fallback` removed.
- [ ] Tests / build / lint stay green.

## Work Log

| Date       | Action                                    | Notes                   |
| ---------- | ----------------------------------------- | ----------------------- |
| 2026-05-05 | Discovered during `/ce:review` of PR #148 | architecture-strategist |

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/148
- Source: `src/ldk/lsp/contacts.ts:22-25`
