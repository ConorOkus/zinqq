---
status: cancelled
priority: p3
issue_id: '276'
tags: [code-review, docs, comments, bip321]
dependencies: []
---

# Restore `parseBip321` rationale comment for hand-rolled query parsing

## Problem Statement

PR #147 removed the comment in `parseBip321` that explained why we don't use `URLSearchParams` for BIP 21 query parsing. The hand-rolled loop is still there (and still correct), but the rationale is now invisible — a future contributor will look at the loop, propose "simplify with `URLSearchParams`," and silently regress the BIP 77 v2 fragment-separator behavior (literal `+`).

Even with Payjoin gone, the same RFC 3986 vs `application/x-www-form-urlencoded` distinction matters for any future query parameter that could legally contain `+` (e.g. encoded BOLT 12 offers, future BIP extensions).

## Findings

- `src/ldk/payment-input.ts:212-231` (post-PR #147) — hand-rolled loop with no rationale comment.
- Pre-PR #147 had a multi-line block citing BIP 77 v2 fragment separators. That specific framing is now stale, but the underlying RFC 3986 reasoning is not.
- `docs/solutions/integration-issues/bip321-pj-urlsearchparams-plus-corruption.md` is the institutional record and is intentionally kept.
- Flagged by `kieran-typescript-reviewer` as P3.

## Proposed Solution

Add a 2-line comment above the `for (const pair of queryPart.split('&'))` loop:

```ts
// BIP 21 uses RFC 3986 query syntax, not application/x-www-form-urlencoded —
// preserve literal '+' as a character. URLSearchParams would decode '+' to space.
// See docs/solutions/integration-issues/bip321-pj-urlsearchparams-plus-corruption.md.
```

**Effort:** 5 min.

**Risk:** None.

## Recommended Action

To be filled during triage.

## Technical Details

**Affected files:** `src/ldk/payment-input.ts`.

## Acceptance Criteria

- [ ] Hand-rolled loop has a comment pointing at `docs/solutions/integration-issues/bip321-pj-urlsearchparams-plus-corruption.md`.

## Resources

- **PR:** #147
- **Reviewer:** `kieran-typescript-reviewer`

## Work Log

### 2026-04-29 — Surfaced during PR #147 review

**By:** kieran-typescript-reviewer

## Cancelled

Superseded by a Group B follow-up from PR #164's review. Now that Payjoin is gone and the original `pj=` `+`-preservation rationale is moot, the upstream question — "do we even need the hand-rolled loop?" — must be settled first. That decision is tracked in the new todo (decide `URLSearchParams` vs manual RFC 3986 loop in `parseBip321`). If that decision lands on "keep the loop," re-open this todo, clear this Cancelled section, and inline the rationale at the loop site. Note: the solution-doc reference (`docs/solutions/integration-issues/bip321-pj-urlsearchparams-plus-corruption.md`) was deleted in PR #164; any revived comment must inline the rationale instead of pointing at the doc.
