---
title: 'LDK WASM Foundation Layer — Key Patterns and Pitfalls'
category: integration-issues
date: 2026-03-11
tags: [ldk, wasm, indexeddb, react-context, lightning, typescript, persistence]
modules: [src/ldk]
---

# LDK WASM Foundation Layer — Key Patterns and Pitfalls

## Problem

Integrating `lightningdevkit@0.1.8-0` TypeScript/WASM bindings into a browser wallet required solving several non-obvious issues around sync/async mismatches, type safety with LDK's Result types, React Fast Refresh compatibility, and IndexedDB persistence semantics.

## Root Causes & Solutions

### 1. Persist trait is sync, IndexedDB is async

LDK's `Persist` trait methods (`persist_new_channel`, `update_persisted_channel`) are synchronous but IndexedDB writes are async. Returning `ChannelMonitorUpdateStatus_Completed` for a fire-and-forget async write is a **protocol violation** — LDK assumes the data is durable when it is not.

**Fix:** Return `ChannelMonitorUpdateStatus_InProgress` and implement a `ChainMonitor.channel_monitor_updated()` callback when the write resolves (deferred to channel management layer).

### 2. LDK Result types require instanceof narrowing

LDK Result types like `Result_PublicKeyNoneZ` use subclass-based discrimination. The `is_ok()` method confirms success, but accessing `.res` requires narrowing to the `_OK` subclass. Using `as { res: Uint8Array }` compiles but bypasses type safety.

**Fix:** Import the `_OK` subclass and use `instanceof`:

```typescript
import { Result_PublicKeyNoneZ_OK } from 'lightningdevkit'

if (!(nodeIdResult instanceof Result_PublicKeyNoneZ_OK)) {
  throw new Error('Failed to derive node ID')
}
const nodeId = bytesToHex(nodeIdResult.res) // .res is properly typed
```

### 3. React Fast Refresh breaks with co-located context + components

Exporting both a React component (`LdkProvider`) and a context/hook from the same file triggers the `react-refresh/only-export-components` warning and breaks HMR. Even exporting just the context object alongside a component triggers it.

**Fix:** Split into three files:

- `ldk-context.ts` — `createContext` + types (no components)
- `context.tsx` — `LdkProvider` component only
- `use-ldk.ts` — `useLdk()` hook only

### 4. Discriminated unions eliminate impossible states

A flat interface like `{ status: string; node: LdkNode | null; error: Error | null }` allows impossible combinations (`status: 'ready', node: null`). Consumers need redundant null checks even after narrowing on `status`.

**Fix:** Use a discriminated union:

```typescript
export type LdkContextValue =
  | { status: 'loading'; node: null; nodeId: null; error: null }
  | { status: 'ready'; node: LdkNode; nodeId: string; error: null }
  | { status: 'error'; node: null; nodeId: null; error: Error }
```

### 5. Seed overwrite guard prevents fund loss

`generateAndStoreSeed()` with no guard silently overwrites the existing seed, destroying access to any channels opened with the previous key material.

**Fix:** Check before write:

```typescript
const existing = await getSeed()
if (existing) {
  throw new Error('Seed already exists. Refusing to overwrite.')
}
```

### 6. fake-indexeddb for tests, Array.from for equality

jsdom doesn't include IndexedDB. Install `fake-indexeddb` and import in test setup. Uint8Arrays retrieved from IndexedDB come from a different realm, so `toEqual` fails even with identical contents.

**Fix:** Compare with `Array.from()`:

```typescript
expect(Array.from(result!)).toEqual(Array.from(expected))
```

### 7. LDK 0.2: push-only monitor-persist completion (decline the pull path)

LDK 0.2 offers **two** ways to signal that an async `ChannelMonitor` persist has completed:

- **Push (what we use):** call `ChainMonitor.channel_monitor_updated(channelId, updateId)` when the
  async write resolves. In 0.2 this keys on `ChannelId` (not the funding `OutPoint`).
- **Pull (added in 0.2):** the ChainMonitor calls `Persist.get_and_clear_completed_updates()` to
  collect finished `(ChannelId, updateId)` pairs.

These are alternatives. We deliberately keep the push model and implement the pull method as a no-op
(`return []`). **Do not** start populating the pull vec — signaling the same completion through both
paths risks double-signaling. This is the same "return `InProgress`, signal later via
`channel_monitor_updated`" contract as 0.1, just with the ChannelId-keyed API.

Two related 0.2 gotchas:

- The `monitor` handed to `persist_new_channel`/`update_persisted_channel` is a **borrowed** WASM
  handle (`new ChannelMonitor(null, monitor)`) that Rust frees when the callback returns. Any handle
  derived from it — notably `channel_id()` — dangles afterward. Extract owned values (bytes via
  `channel_id().get_a()`, `write()`, `get_latest_update_id()`) in **one synchronous choke point** and
  rebuild `ChannelId.constructor_from_bytes(...)` at completion. Never touch the monitor in a `.then()`.
- `archive_persisted_channel` receives only a `MonitorName` in 0.2. We map
  `MonitorName.to_str()` → storage key, populated on every persist/update and via
  `registerLoadedMonitor` for restored monitors. The mapping relies on
  `monitor.persistence_key().to_str()` equaling the `MonitorName.to_str()` seen in the persist
  callbacks (guaranteed by LDK for the same channel).

## Prevention

- Always return `InProgress` from sync trait methods wrapping async storage — never claim completion until durable.
- LDK 0.2: signal monitor-persist completion via `channel_monitor_updated` (push) only; keep `get_and_clear_completed_updates` a `return []` no-op.
- Extract all values from a borrowed WASM callback arg synchronously; never dereference it (or a derived handle) in an async continuation.
- Use `instanceof` with LDK Result subclasses, never `as` casts.
- Split React context/types/hooks into separate files from the start.
- Use discriminated unions for any multi-state context value.
- Guard any destructive write to security-critical data (seeds, keys) with an existence check.
