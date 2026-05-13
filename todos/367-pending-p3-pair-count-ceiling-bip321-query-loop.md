---
status: pending
priority: p3
issue_id: '367'
tags: [code-review, security, defense-in-depth, bip321, payment-input]
dependencies: ['366']
---

# Add pair-count or length ceiling to `parseBip321` query loop

## Problem Statement

`parseBip321()` (`src/ldk/payment-input.ts:209`) iterates `queryPart.split('&')` with no upper bound on pair count or total length. A pathological QR-encoded URI with thousands of `&`-separated pairs would still parse linearly — not exploitable in this single-threaded, parse-only context (no I/O, no DB writes), but a defensive cap is cheap.

The previously-enforced 2048-byte cap on `pj=` was removed in PR #164 alongside Payjoin. It was specific to one param's URL, not a generic length-of-query gate.

## Findings

- `src/ldk/payment-input.ts:209` — unbounded `split('&')` loop.
- `security-sentinel` flagged as P3 (belt-and-braces, not exploitable) during PR #164 review.
- Linear-time bounded: bech32 regexes are anchored with bounded quantifiers (`{25,87}`, `{25,34}`); no regex backtracking risk.

## Proposed Solution

Add a single guard at the top of the query branch:

```ts
if (queryPart && queryPart.length > 8192) {
  return { type: 'error', message: 'Bitcoin URI query too long' }
}
```

8192 is generous (most QR-encoded URIs are <500 bytes; v40 QR max payload is ~2.9 KiB). Picks the cleanest single failure mode rather than tracking pair count.

**Effort:** Trivial.
**Risk:** None — bound is well above realistic URI sizes.

**Depends on #366:** if #366 settles on `URLSearchParams` (Option A), the cap may be best inserted there or rendered moot by spec-level URL limits.

## Recommended Action

To be filled during triage.

## Technical Details

**Affected files:** `src/ldk/payment-input.ts`, possibly add a test in `src/ldk/payment-input.test.ts`.

## Acceptance Criteria

- [ ] `parseBip321` rejects URIs whose query exceeds the configured ceiling.
- [ ] Test asserts a >8192-byte query returns `type: 'error'`.

## Resources

- **PR:** #164
- **Reviewer:** `security-sentinel`

## Work Log

### 2026-05-13 — Surfaced during PR #164 review

**By:** security-sentinel
