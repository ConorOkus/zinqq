---
title: LSPS2 trusted-LSP gate hardcoded to fallback pubkey rejected primary LQwD 0-conf channels
category: integration-issues
date: 2026-05-06
severity: P1
module: src/ldk/traits/event-handler.ts, src/ldk/init.ts, src/ldk/context.tsx
tags: [ldk, lsps2, jit-channels, 0-conf, lqwd, megalith, event-handler, multi-lsp, trust-gate]
related_pr: 148
related_commit: 8f58852
related:
  - ldk-event-handler-patterns.md
  - lsps2-jit-receive-channel-config.md
  - anchor-channels-lsp-compatibility.md
---

# LSPS2 trusted-LSP gate hardcoded to fallback pubkey rejected primary LQwD 0-conf channels

## Symptom

A user requesting a JIT Lightning invoice from the runtime-discovered LQwD primary LSP would see the receive flow time out with no payment arriving. There was no browser-console error and no thrown exception — the LSPS2 dance succeeded all the way up to the moment LQwD opened the inbound 0-conf channel, at which point LDK silently dropped the `Event_OpenChannelRequest`. From the user's perspective the invoice "just didn't pay"; from the logs you'd only see `[LDK Event] OpenChannelRequest: rejected from non-LSP peer` against a pubkey that was, in fact, our LSP. The bug only manifested at HTLC time, was not caught by any unit test, and was flagged by the architecture-strategist agent during code review of PR #148.

## Root Cause

The LDK event handler was authored when Zinqq had exactly one trusted LSP (Megalith, env-var configured). `createEventHandler` took a `lspNodeId: string` and the gate was a literal pubkey equality check:

```ts
// before
if (counterpartyHex === lspNodeId && lspNodeId !== '') {
  channelManager.accept_inbound_channel_from_trusted_peer_0conf(...)
}
```

That assumption — _one_ trusted peer, known at handler construction — was baked in.

PR #148 introduced an LSPS2 failover orchestrator with a runtime-discovered primary (LQwD), whose pubkey is fetched over HTTPS via `/get_info` long after `init.ts` has already wired up the event handler. The handler's `lspNodeId` parameter still pointed at Megalith's static value. When LQwD initiated the JIT channel open, `counterpartyHex === lspNodeId` was false and the `Event_OpenChannelRequest` fell through to the rejection branch.

Tests passed because the failover orchestrator (`runJitInvoiceFlow`) accepts an injectable `attempt` function. The 21 LSP-failover unit tests stubbed `attempt`, never reaching the real `ChannelManager.accept_inbound_channel_from_trusted_peer_0conf` nor the `EventHandler` callback chain.

## Investigation

1. Architecture-strategist agent flagged on PR #148 review: "primary LSP pubkey resolved at runtime, but event handler closure captures `lspNodeId` at init."
2. Read `src/ldk/traits/event-handler.ts` (the `Event_OpenChannelRequest` branch) — confirmed the gate compared `counterpartyHex` against a single `lspNodeId` captured by closure.
3. Read `src/ldk/init.ts` handler-construction site — confirmed only `LDK_CONFIG.lspNodeId` (Megalith) was passed in; nothing in the codepath updated it after LQwD discovery.
4. Walked through an LQwD-initiated `OpenChannelRequest`: `bytesToHex(event.counterparty_node_id)` returns LQwD's pubkey; `lspNodeId` still holds Megalith's; equality fails; channel times out.
5. Confirmed no integration test crosses the LDK event boundary — the failover orchestrator tests inject `attempt` and stop short.

## Solution

**1. New predicate type** (`src/ldk/traits/event-handler.ts`):

```ts
export type IsTrustedLsp = (pubkeyHex: string) => boolean
```

`createEventHandler` and `handleEvent` take `isTrustedLsp: IsTrustedLsp` instead of `lspNodeId: string`. The gate becomes:

```ts
if (isTrustedLsp(counterpartyHex)) {
  // accept_inbound_channel_from_trusted_peer_0conf(...)
}
```

**2. Mutable trust set on `LdkNode`** (`src/ldk/init.ts`):

```ts
trustedLspIds: Set<string>
```

**3. Init-time seeding + closure predicate** (`src/ldk/init.ts`):

```ts
const trustedLspIds = new Set<string>()
if (LDK_CONFIG.lspNodeId !== '') trustedLspIds.add(LDK_CONFIG.lspNodeId)
const { handler, cleanup } = createEventHandler(
  channelManager,
  keysManager,
  bdkWallet,
  (pubkey) => trustedLspIds.has(pubkey)
  /* …callbacks… */
)
```

The predicate reads the Set on every event — additions made later are seen live.

**4. LdkProvider runtime discovery** (`src/ldk/context.tsx`, right after `nodeRef.current = node`):

```ts
void fetchLqwdContact()
  .then((contact) => {
    if (cancelled) return
    node.trustedLspIds.add(contact.nodeId)
  })
  .catch(() => {
    /* silent: only Megalith remains trusted */
  })
```

**5. Four new tests** in `src/ldk/traits/event-handler.test.ts` (`describe('createEventHandler — Event_OpenChannelRequest trust set')`):

- predicate-true accepts: `mockAcceptInbound0conf` called once
- predicate-false rejects: no accept calls
- mutable-set-update across calls: pre-discovery rejects, post-`trusted.add(...)` accepts (LQwD race)
- multiple LSPs trusted simultaneously (primary + fallback) both accept

## Verification

All 427 unit tests pass. The four new trust-set tests cover the exact failure scenario PR #148 introduced: a counterparty whose pubkey is added to the Set _after_ the event handler is constructed is now accepted.

## Why It Slipped Through

The failover orchestrator's `attempt` injection point made the LSPS2 happy-path tests fast and deterministic, but it sat _above_ the LDK event chain — `accept_inbound_channel_from_trusted_peer_0conf` was never invoked under test. With no integration test bridging "JIT invoice issued" to "ChannelManager receives OpenChannelRequest," the single-trusted-peer assumption embedded in handler closure went undetected until the architecture-strategist agent read the PR diff against the multi-LSP design.

## Prevention

### Replace single-tenant string params with predicates from day one

When a config field is named in the singular (`lspNodeId`, `trustedPeer`, `primaryRelay`), it silently encodes a cardinality assumption that any future "second one" must hunt down and unwind across every callsite. Model the capability, not the instance: expose `isTrustedLsp(pubkey: string): boolean` backed by a mutable `Set<string>` that both static env config and runtime discovery write into. Callers ask the predicate; they never compare strings. This makes "add another LSP" a single `set.add()` instead of a refactor, and turns equality bugs into impossible states.

### Integration-test the event-handler gate, not just the orchestrator

The bug survived because tests stubbed `attempt()` above the event boundary, so the `ChannelManager → eventHandler → gate` path never ran. Add tests in `event-handler.test.ts` that construct the real `eventHandler` with a fake `Event` (e.g. `OpenChannelRequest { counterparty_node_id }`), a real `isTrustedLsp` predicate seeded with a known set, and a spy `ChannelManager` shim exposing only `accept_inbound_channel` / `accept_inbound_channel_from_trusted_peer_0conf`. Assert which method got called for trusted vs untrusted pubkeys. No real ChannelManager, no network — just the gate's truth table. Any predicate regression fails here without CI needing LDK at all.

### Audit checklist when adding a new trusted peer / LSP

Before merging any PR that introduces a new LSP, discovery source, or "trusted" classification, grep for and review:

- `LDK_CONFIG.lspNodeId`, `lspNodeId ===`, `counterparty_node_id ===` — any string equality on a peer pubkey
- All `eventHandler` callsites and `Event::OpenChannelRequest` / `Event::ChannelPending` branches
- Peer warmup / persistent-connection lists (often hardcoded to the env LSP)
- Channel-acceptance gates, `accept_inbound_channel_from_trusted_peer_0conf` callers
- Routing hints, JIT-channel scid allowlists, fee-policy overrides keyed by node id
- Test fixtures that hardcode a single LSP pubkey

If any callsite still treats "the LSP" as singular, the predicate refactor is incomplete.

### Mock placement: prefer integration over isolation

Injectable seams are valuable, but every seam is also a place where production wiring can silently disagree with the test double. Rule of thumb: for any seam, keep at least one test that does not use it and exercises the real collaborators across the boundary. Orchestrator-level mocks are fine for branch coverage; pair them with a thinner integration test that runs the actual event handler against a fake event source. The multi-agent static review caught this one — codify that reflex into the test suite.

## Related Documentation

- [`docs/solutions/integration-issues/ldk-event-handler-patterns.md`](ldk-event-handler-patterns.md) — Documents LDK `EventHandler` sync/async bridging and explicitly calls out gotcha #5: `OpenChannelRequest` requires explicit accept/reject (the exact handler whose trust check this fix patches).
- [`docs/solutions/integration-issues/lsps2-jit-receive-channel-config.md`](lsps2-jit-receive-channel-config.md) — LSPS2 0-conf JIT channel config notes that global `accept_underpaying_htlcs` is "safe because the `OpenChannelRequest` handler only accepts channels from the configured LSP" — the exact single-LSP assumption broken by adding LQwD.
- [`docs/solutions/integration-issues/anchor-channels-lsp-compatibility.md`](anchor-channels-lsp-compatibility.md) — Prior mainnet LSP-compatibility fix in `init.ts` whose reasoning assumed a single configured LSP (Megalith); useful context for how the trust-set assumption crept into init.
- [`docs/solutions/integration-issues/ldk-trait-defensive-hardening-patterns.md`](ldk-trait-defensive-hardening-patterns.md) — Establishes the LDK trait-adapter hardening pattern (broadcaster, persist, fee-estimator) where retry/validation lives behind a single trait surface — the pattern an `(pubkey) => boolean` predicate slots into.
- [`docs/solutions/test-failures/persist-manifest-side-effect-mock-assertions.md`](../test-failures/persist-manifest-side-effect-mock-assertions.md) — Canonical case study of orchestrator-level mocks hiding a real side effect from unit tests, the same "mock isolates too much" failure mode that lets a hardcoded-pubkey gate slip past tests.
- [`docs/solutions/infrastructure/blockstream-enterprise-esplora-proxy.md`](../infrastructure/blockstream-enterprise-esplora-proxy.md) — Documents the primary/fallback provider pattern (proxied Blockstream Enterprise primary, `mempool.space` fallback) — closest precedent for runtime-extending a trusted-provider set rather than hardcoding one.
