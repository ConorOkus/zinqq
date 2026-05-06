---
status: pending
priority: p2
issue_id: 294
tags: [code-review, lifecycle, lsp, pr-148]
dependencies: []
---

# P2 — Module-scope `inflight` promise in `lqwd-discovery.ts` leaks across shutdown / restore

## Problem Statement

`src/ldk/lsp/lqwd-discovery.ts:23` declares the memoised in-flight promise at **module scope**:

```ts
let inflight: Promise<LspContact> | null = null
```

Today the wallet has one `LdkProvider` per page, so this works. But the wallet supports an explicit teardown path (`shutdown()` in `LdkProvider` — used by the Restore flow to clear IDB and re-init LDK). When the user restores, LDK is torn down and re-initialised; the memoised LQwD contact survives across the boundary because it lives in module state, not in `LdkContext`.

Two failure modes:

1. **Stale pubkey across re-init**: if LQwD rotates its pubkey while the user is in the Restore flow, the memo never refreshes — the post-restore session uses the pre-restore (stale) pubkey for the rest of the page lifetime.
2. **Test isolation**: production code already pays for this with a `__resetForTests()` export (line 71). That's a smell — the production module shouldn't need a test-only escape hatch if its lifetime were properly scoped.

This isn't reachable by today's UX (the Restore flow does a full page reload after teardown, which clears module state). But the next time someone implements an in-app wipe-and-reinit without a reload, the bug is silently waiting.

## Findings

- **Module scope state**: `src/ldk/lsp/lqwd-discovery.ts:23` (`let inflight: Promise<...> | null = null`).
- **Test escape hatch**: `src/ldk/lsp/lqwd-discovery.ts:71-73` — `__resetForTests()` resets the memo. Public export, only commented-as-test.
- **No teardown path**: nothing in `LdkProvider.shutdown()` resets the memo.

## Proposed Solutions

### Option A — Move state to `LdkNode` or `LdkContext`

Attach the memoised contact (or a `Promise<LspContact>`) to `LdkNode` (alongside `lsps2Client`). `resolveLspContacts` takes the node as input; module-scope `inflight` goes away. Test reset becomes "create a new node" — matching how every other piece of LDK state is tested.

**Pros:** Lifetime correctness. No `__resetForTests` needed. Each LDK init gets a fresh discovery cycle.

**Cons:** Threading the cache through requires touching `init.ts` and `context.tsx`. ~50 lines of plumbing.

**Effort:** Medium.

**Risk:** Low.

### Option B — Reset in `shutdown()`

Add a public `resetLqwdDiscoveryMemo()` exported from `lqwd-discovery.ts` and call it from `LdkProvider.shutdown()`.

**Pros:** Tiny diff.

**Cons:** Doesn't address the test smell. Future re-init paths will need to remember to call it.

**Effort:** Trivial.

**Risk:** Low — just a forgotten-call hazard.

### Option C — Status quo + document explicitly

Leave the page-lifetime memo in place; document at the top of `lqwd-discovery.ts` that it's intentionally page-scoped and that any in-app re-init must trigger a page reload to clear it.

**Pros:** No code change.

**Cons:** Brittle. Future refactor will trip on this.

**Effort:** Trivial.

**Risk:** Medium (latent bug).

## Recommended Action

(triage)

## Technical Details

- **Affected files:**
  - `src/ldk/lsp/lqwd-discovery.ts` (drop module-scope state if Option A)
  - `src/ldk/lsp/contacts.ts` (take cache as arg if Option A)
  - `src/ldk/context.tsx` (call resolver with node-attached cache if Option A; call reset on shutdown if Option B)
  - `src/ldk/init.ts` (attach cache to `LdkNode` if Option A)

## Acceptance Criteria

- [ ] Re-running `LdkProvider.shutdown()` followed by a fresh init produces a fresh discovery fetch (or the memo is explicitly cleared).
- [ ] `__resetForTests` either goes away entirely (Option A) or is documented as still-acceptable.
- [ ] All 13 discovery tests + 8 orchestration tests still pass.

## Work Log

| Date       | Action                                    | Notes                            |
| ---------- | ----------------------------------------- | -------------------------------- |
| 2026-05-05 | Discovered during `/ce:review` of PR #148 | architecture-strategist flagged. |

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/148
- Source: `src/ldk/lsp/lqwd-discovery.ts:23, 71-73`
- Related: `src/ldk/init.ts:LdkNode`, `src/ldk/context.tsx:LdkProvider.shutdown`
