---
status: pending
priority: p3
issue_id: 298
tags: [code-review, tooling, pr-148]
dependencies: []
---

# P3 — `contacts.fallback!` non-null assertions can narrow naturally

## Problem Statement

`runJitInvoiceFlow` early-returns when both contacts are null, which logically guarantees that the else branch sees a non-null fallback — but TypeScript can't track this across the if/else split. The function uses three `contacts.fallback!` non-null assertions to paper over the gap. A small destructure + narrowing rewrite removes them.

## Findings

- `src/ldk/context.tsx:120-122` — early throw if both null.
- `src/ldk/context.tsx:155, 158, 173` — three `contacts.fallback!` uses where TS can't see the invariant from the early return.
- (Note: line numbers are from `runJitInvoiceFlow` in the LSP module — verify exact path; see `src/ldk/lsp/jit-flow.ts` or wherever it actually lives in current tree.)

## Proposed Solutions

### Option A — Discriminated union return from `resolveLspContacts`

Return `{primary: LspContact; fallback: LspContact | null} | {primary: null; fallback: LspContact}` instead of the loose pair. Then the orchestrator narrows via `if (contacts.primary)` without needing `!`.

**Pros:** Removes runtime check; invariant becomes a type error.
**Cons:** Wider blast radius — touches the type and every consumer.
**Effort:** Medium.
**Risk:** Low.

### Option B — Local destructure with explicit narrowing

Inside the orchestrator: `const { primary, fallback } = contacts; if (!primary && !fallback) throw ...`. Then `else if (primary) { ... } else { /* fallback is guaranteed non-null here */ }` and pass `fallback` (a local) which TS can narrow.

**Pros:** Localised; no API change.
**Cons:** Doesn't solve drift if a future caller forgets the early throw.
**Effort:** Small.
**Risk:** Low.

## Recommended Action

Option A is the structurally correct fix and it pairs with todo #304 (encode invariant in the type). If we land #304, this falls out for free.

## Technical Details

- **Affected files:** `src/ldk/context.tsx` (or `src/ldk/lsp/jit-flow.ts` — wherever `runJitInvoiceFlow` lives), `src/ldk/lsp/contacts.ts`.

## Acceptance Criteria

- [ ] No `!` non-null assertions on `contacts.fallback` or `contacts.primary` in the JIT flow.
- [ ] Either type-level invariant (Option A) or local narrowing (Option B).
- [ ] Tests / build / lint stay green.

## Work Log

| Date       | Action                                    | Notes                                                 |
| ---------- | ----------------------------------------- | ----------------------------------------------------- |
| 2026-05-05 | Discovered during `/ce:review` of PR #148 | kieran-typescript-reviewer + code-simplicity-reviewer |

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/148
- Source: `src/ldk/context.tsx:155, 158, 173`
