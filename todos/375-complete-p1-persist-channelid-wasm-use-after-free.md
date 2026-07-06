---
status: complete
priority: p1
issue_id: 375
tags: [code-review, ldk, wasm, use-after-free, fund-safety, persist]
dependencies: []
---

# WASM use-after-free: borrowed `channelId` dereferenced in async persist completion

## Problem Statement

In `persist.ts` `handlePersist`, the completion signal captures a **borrowed** WASM handle
`const channelId = monitor.channel_id()` synchronously, then dereferences it inside the async
`.then()` continuation via `chainMonitorRef.channel_monitor_updated(channelId, updateId)`.

The `monitor` passed to `persist_new_channel`/`update_persisted_channel` is a borrowed handle
(`new ChannelMonitor(null, monitor)` — null free-fn, raw pointer owned by Rust) valid only for
the synchronous duration of the callback. `channel_id()` returns
`new ChannelId(null, ret)` + `add_ref_from(monitor)` — i.e. a handle whose pointer lives inside
the borrowed monitor's memory. After the persist callback returns, Rust reclaims the monitor,
leaving `channelId` dangling. The IndexedDB/VSS write resolves a macrotask later and the `.then()`
dereferences the freed pointer.

Failure scenario: monitor persisted → `InProgress` returned → monitor freed → async write
resolves → `channel_monitor_updated(channelId, …)` called on a dangling pointer. Best case the
WASM layer throws "call on free'd object" and completion is never signaled → LDK permanently
halts that channel (stuck `InProgress`, no further updates, **funds effectively frozen until
app restart**). Worst case it reads reclaimed heap and signals completion for the wrong
`ChannelId`.

This is exactly the lifetime hazard the file's own comment (`persist.ts:255-257`) warns about;
the migration carried it forward from the old code (which dereferenced the borrowed
`channel_funding_outpoint` param the same way). The existing test can't catch it —
`persist.test.ts` mocks `channel_id()` as a memoized plain JS object that never invalidates.

## Findings

- `src/ldk/traits/persist.ts:259` — `const channelId = monitor.channel_id()` (borrowed).
- `src/ldk/traits/persist.ts:273` — `channel_monitor_updated(channelId, updateId)` inside `.then()`.
- Binding evidence: `node_modules/lightningdevkit/structs/Persist.mjs:82` (`new ChannelMonitor(null, monitor)`), `structs/ChannelMonitor.mjs:127-131` (`new ChannelId(null, ret)` + `add_ref_from`).
- `key`, `data` (`monitor.write()` → owned `Uint8Array`), and `updateId` (`bigint`) are already extracted to owned values before the async boundary — only `channelId` crosses it as a live handle.

## Proposed Solutions

### Option A (recommended) — extract owned bytes synchronously, reconstruct in the continuation

At the sync point: `const channelIdBytes = monitor.channel_id().get_a()` (owned `Uint8Array`,
same decode path as `get_txid`). Inside `.then()`:
`chainMonitorRef.channel_monitor_updated(ChannelId.constructor_from_bytes(channelIdBytes), updateId)`.
Both `ChannelId.get_a()` and `ChannelId.constructor_from_bytes()` exist in 0.2.

- Pros: eliminates the dangling deref; matches the file's own "extract synchronously" invariant; tiny.
- Cons: allocates a fresh `ChannelId` per completion (negligible).
- Effort: Small. Risk: Low.

### Option B — keep the whole ChannelId alive by cloning

`monitor.channel_id().clone()` if the binding exposes a real owned clone. Less obviously correct
than value-extraction; prefer A.

## Recommended Action

_(leave blank for triage)_

## Technical Details

- Affected file: `src/ldk/traits/persist.ts` (`handlePersist`).
- Add a test that invalidates the mock monitor after the persist callback returns to guard against regression.

## Acceptance Criteria

- [ ] No live WASM handle derived from the borrowed `monitor` is dereferenced after the persist callback returns.
- [ ] Completion is signaled with a `ChannelId` reconstructed from owned bytes captured synchronously.
- [ ] `persist.test.ts` updated so `channel_id()`/`get_a()` reflect the real ownership (mock returns fresh bytes; asserts completion still fires with correct id).
- [ ] typecheck + tests + build green; regtest confirms channels re-enable after monitor persist (no stuck `InProgress`).

## Work Log

- 2026-07-06 — Filed from `/ce:review` of PR #166. TypeScript reviewer flagged; verified against generated bindings (`Persist.mjs`, `ChannelMonitor.mjs`) — monitor + channel_id are borrowed handles. Fix primitives (`get_a`, `constructor_from_bytes`) confirmed present.
- 2026-07-06 — FIXED (Option A). `handlePersist` now captures `monitor.channel_id().get_a()` (owned bytes) synchronously and rebuilds `ChannelId.constructor_from_bytes(bytes)` inside the async completion — no borrowed handle crosses the async boundary. `persist.test.ts` updated (mock `channel_id().get_a()` + `ChannelId.constructor_from_bytes` sentinel; completion asserted on rebuilt id). typecheck + 472 tests + build green.

## Resources

- PR #166 — LDK 0.1 → 0.2 upgrade.
- `docs/solutions/integration-issues/ldk-wasm-foundation-layer-patterns.md` (sync-extraction discipline).
- `docs/solutions/integration-issues/ldk-trait-defensive-hardening-patterns.md`.
