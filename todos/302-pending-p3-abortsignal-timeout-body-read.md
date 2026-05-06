---
status: pending
priority: p3
issue_id: 302
tags: [code-review, security, pr-148]
dependencies: []
---

# P3 — `AbortSignal.timeout(3000)` may not enforce body-read timeout

## Problem Statement

`fetchLqwdContact` uses `AbortSignal.timeout(3_000)` for the fetch and reuses the same signal implicitly via `res.json()`. `AbortSignal.timeout` aborts the fetch lifecycle, but body-read timeout enforcement is implementation-specific — a slowloris-style server dripping body bytes past 3s could keep the read alive in some browsers. Worst case: a stuck JIT receive on one tab.

## Findings

- `src/ldk/lsp/lqwd-discovery.ts:30` — `signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)`.
- `src/ldk/lsp/lqwd-discovery.ts:35` — `const json = (await res.json()) as { uris?: unknown }` reuses the same signal.
- No response-size cap; a malicious or buggy server could send unbounded body bytes.

## Proposed Solutions

### Option A — Wrap body read in a second timeout race

```ts
const json = await Promise.race([
  res.json(),
  new Promise((_, rej) => setTimeout(() => rej(new Error('body read timeout')), 3_000)),
])
```

**Pros:** Explicit total budget; deterministic across browsers.
**Cons:** A bit more code; may double-count time vs the fetch signal.
**Effort:** Small.
**Risk:** Low.

### Option B — Read as text with size cap, then parse

```ts
const text = await res.text()
if (text.length > 4096) throw new Error('LQwD response too large')
const json = JSON.parse(text)
```

**Pros:** Bounded memory; defends against unbounded bodies.
**Cons:** Doesn't solve slowloris timing issue alone — pair with Option A.
**Effort:** Small.
**Risk:** Low.

### Option C — Combine A + B

Cap body size and race the read against a timeout.

**Pros:** Belt-and-braces.
**Cons:** Slightly more code.
**Effort:** Small.
**Risk:** Low.

## Recommended Action

Option C. A real LSP `/get_info` is well under 4 KB; the cap is essentially free.

## Technical Details

- **Affected files:** `src/ldk/lsp/lqwd-discovery.ts`.

## Acceptance Criteria

- [ ] Body read has an explicit timeout independent of `AbortSignal.timeout`.
- [ ] Response size capped (e.g. 4 KB) before `JSON.parse`.
- [ ] Tests / build / lint stay green.

## Work Log

| Date       | Action                                    | Notes             |
| ---------- | ----------------------------------------- | ----------------- |
| 2026-05-05 | Discovered during `/ce:review` of PR #148 | security-sentinel |

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/148
- Source: `src/ldk/lsp/lqwd-discovery.ts:30, 35`
