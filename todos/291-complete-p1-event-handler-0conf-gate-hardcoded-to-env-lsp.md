---
status: complete
priority: p1
issue_id: 291
tags: [code-review, lightning, lsp, ldk, correctness, blocks-merge, pr-148]
dependencies: []
---

# P1 — `Event_OpenChannelRequest` 0-conf gate hardcoded to env-var LSP, breaks LQwD primary path

## Problem Statement

`src/ldk/traits/event-handler.ts:621` accepts 0-conf channel opens **only** when the counterparty equals `lspNodeId` — a single string parameter wired from `LDK_CONFIG.lspNodeId` (the env-var fallback, Megalith) at `src/ldk/init.ts:720`. PR #148 adds LQwD as the primary LSP, but its pubkey is **discovered at runtime** and never reaches the event handler. When LQwD opens a 0-conf JIT channel — which is exactly what the primary path does on every JIT receive — the handler hits the `else` branch at `event-handler.ts:641-651` and **rejects the channel**.

The user-visible effect: every LQwD-targeted receive silently fails channel acceptance. The receive flow either falls back to Megalith (which works because Megalith's pubkey IS in the gate) or degrades to on-chain. The primary path is broken on day one.

The unit test suite (423/423 passing) didn't catch this because `runJitInvoiceFlow` injects `attemptJitInvoiceWithLsp` as a mock — the real LDK `ChannelManager.accept_inbound_channel_from_trusted_peer_0conf` and the event-handler chain are never exercised end-to-end in CI.

## Findings

- **Gate condition**: `src/ldk/traits/event-handler.ts:621` —
  ```ts
  if (counterpartyHex === lspNodeId && lspNodeId !== '') {
    // accept 0-conf
  } else {
    // reject
  }
  ```
- **`lspNodeId` source**: `src/ldk/init.ts:720` passes `LDK_CONFIG.lspNodeId` (= env-var `VITE_LSP_NODE_ID`, Megalith).
- **No code path updates this list** when `fetchLqwdContact()` resolves. The handler is created once at LDK init, before discovery completes.
- **Receive consequence**: LQwD's `lsps2.buy` returns a JIT channel SCID. When the first payment arrives, LQwD initiates `OpenChannelRequest` with its own pubkey as counterparty. The handler rejects. The HTLC times out. The user sees a failed payment.
- **Tests don't cover it**: `src/ldk/lsp/jit-failover.test.ts` mocks the entire LSPS2 dance via the `attempt` injection seam, so this real-LDK integration is never run.

## Proposed Solutions

### Option A — Mutable Set updated by discovery (recommended)

Replace the `lspNodeId: string` parameter on the event handler with a predicate `isTrustedLsp(pubkey: string) => boolean` backed by a `Set<string>` that:

1. Initially contains `LDK_CONFIG.lspNodeId` (Megalith).
2. Has LQwD's pubkey added when `fetchLqwdContact()` resolves successfully.

Wire-up: pass a `trustedLspIds: Set<string>` (or a getter closure) from `LdkProvider` into `createEventHandler`. After `resolveLspContacts()` settles, call `trustedLspIds.add(primary.nodeId)`.

**Pros:** Both LSPs are trusted simultaneously. No race window where LQwD opens a channel before discovery completes (we'd reject — but that race is unlikely since discovery fires at app boot, well before any receive). Minimal API surface change.

**Cons:** Mutable state owned outside the handler. Need to ensure the Set is shared by reference, not value-copied at handler creation time.

**Effort:** Small (~30 lines).

**Risk:** Low. Only widens the trust set — never narrows it.

### Option B — Re-create event handler on discovery

Tear down and rebuild the event handler whenever the discovered LSP set changes. Pass a fresh `lspNodeIds: string[]` array each time.

**Pros:** Immutable handler API.

**Cons:** Heavy. The event handler manages cleanup state (`cleanupEventHandler`); rebuilding mid-session risks losing in-flight events. Not worth the complexity.

**Effort:** Large.

**Risk:** Medium-high.

### Option C — Look up trusted LSPs at event time

Instead of capturing `lspNodeId` at handler creation, take a `getTrustedLspIds: () => Set<string>` lazy-getter and call it inside the `OpenChannelRequest` branch.

**Pros:** Most flexible — the source of truth is whatever the wallet's current state says.

**Cons:** Slightly more indirection. Easy to forget that the lookup is dynamic.

**Effort:** Small.

**Risk:** Low.

## Recommended Action

(triage — likely Option A or C; both are small. Option A is my lean.)

## Technical Details

- **Affected files:**
  - `src/ldk/traits/event-handler.ts` (signature + gate)
  - `src/ldk/init.ts:716-720` (handler construction)
  - `src/ldk/context.tsx` (somewhere after `resolveLspContacts()` settles, add LQwD's pubkey to the set)
- **Tests to add:** an integration test that exercises `Event_OpenChannelRequest` with LQwD's pubkey and asserts acceptance (no need for real LDK if we just unit-test the gate).

## Acceptance Criteria

- [x] Event handler accepts 0-conf opens from BOTH LQwD's discovered pubkey and Megalith's env-var pubkey.
- [x] If LQwD discovery fails, only Megalith is trusted (current behavior).
- [x] If LQwD discovery succeeds AFTER an `OpenChannelRequest` from LQwD arrives (race), the channel is rejected — but a later receive attempt succeeds once the set is populated. New test "reflects mutable trust-set updates between calls" covers this.
- [x] New unit test for the gate covering: LQwD-only trusted, both trusted, neither trusted (`() => false`), and dynamic update post-discovery (4 new tests in `src/ldk/traits/event-handler.test.ts`).
- [x] `pnpm test` (427/427) + `pnpm build` + `pnpm format:check` pass.

## Resolution (Option A — mutable Set updated by discovery)

- `src/ldk/traits/event-handler.ts`: changed `lspNodeId: string` parameter on both `createEventHandler` and `handleEvent` to `isTrustedLsp: IsTrustedLsp` (predicate). Gate at the previous line 621 now reads `if (isTrustedLsp(counterpartyHex))`.
- `src/ldk/init.ts`: created a mutable `trustedLspIds: Set<string>` initialised with `LDK_CONFIG.lspNodeId` (Megalith), passed to `createEventHandler` via closure `(pubkey) => trustedLspIds.has(pubkey)`. The set is attached to `LdkNode` so `LdkProvider` can mutate it.
- `LdkNode` interface: added `trustedLspIds: Set<string>` field.
- `src/ldk/context.tsx`: after `nodeRef.current = node`, fire-and-forget `fetchLqwdContact()` and on success call `node.trustedLspIds.add(contact.nodeId)`. Failures are silent (Megalith remains the sole trusted LSP, matching today's behaviour).
- New tests in `src/ldk/traits/event-handler.test.ts` (`describe('createEventHandler — Event_OpenChannelRequest trust set')`):
  1. Accepts 0-conf when predicate returns true.
  2. Rejects when predicate returns false.
  3. Reflects mutable set updates between calls (the discovery-race scenario).
  4. Trusts multiple LSPs simultaneously (primary + fallback).

## Work Log

| Date       | Action                                    | Notes                                                                                                                                  |
| ---------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-05 | Discovered during `/ce:review` of PR #148 | architecture-strategist flagged; verified by reading `event-handler.ts:621` and `init.ts:720`.                                         |
| 2026-05-05 | Fixed and merged into PR #148             | Option A. 4 new tests added. All 427 tests + build + lint + prettier pass. File renamed `pending → complete` per Zinqq todo lifecycle. |

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/148
- Brainstorm: `docs/brainstorms/2026-04-30-lsp-failover-lqwd-primary-brainstorm.md`
- Plan: `docs/plans/2026-05-04-001-feat-lsp-failover-lqwd-primary-plan.md`
- Source: `src/ldk/traits/event-handler.ts:617-651`, `src/ldk/init.ts:720`
- Related: `src/ldk/lsp/contacts.ts`, `src/ldk/lsp/lqwd-discovery.ts`
