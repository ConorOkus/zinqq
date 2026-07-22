---
title: 'VSS Remote State Recovery — Full Phase 1 Integration'
category: integration-issues
date: 2026-03-18
severity: HIGH
tags:
  [
    vss,
    persistence,
    recovery,
    channel-monitor,
    channel-manager,
    dual-write,
    migration,
    ldk,
    indexeddb,
  ]
modules:
  [
    src/ldk/traits/persist.ts,
    src/ldk/storage/persist-cm.ts,
    src/ldk/init.ts,
    src/ldk/context.tsx,
    src/wallet/context.tsx,
    src/pages/Restore.tsx,
  ]
---

## Problem

Lightning channel state persisted only to browser-local IndexedDB. Clearing browser data or losing the device meant permanent loss of all channel state, in-flight payments, and channel balances. The BIP39 mnemonic recovered only on-chain funds.

## Root Cause

No remote persistence layer existed. The single-write IDB architecture had no redundancy — browser storage is volatile and unrecoverable by design.

## Solution

Full VSS (Versioned Storage Service) integration across 5 phases:

### Phase 1A: Foundation

- `VssClient` with protobuf wire format, ChaCha20-Poly1305 encryption, HMAC key obfuscation
- Key derivation: encryption key at `m/535'/1'`, store_id from SHA-256 of LDK seed

### Phase 1B: ChannelMonitor Dual-Write

- VSS-first write ordering in `persistWithRetry` (remote durable before local fast)
- Indefinite exponential backoff (500ms → 60s cap) replacing 3-attempt linear
- Version conflict resolution with 5-attempt cap, then fallback to backoff
- `onVssUnavailable`/`onVssRecovered` callbacks for UI degradation banner
- `VssStatus` type in React context

### Phase 1C: ChannelManager Consolidation

- `persistChannelManager()` with VSS+IDB dual-write
- `persistChannelManagerIdbOnly()` for visibility handler (browser may kill tab)
- Consolidated 3 separate CM persist paths into one function
- Version conflict resolution (re-fetch server version, retry once)

**Update:** CM persistence is now wrapped in `createChannelManagerPersistScheduler`, a single-flight/dirty-bit scheduler that owns LDK's `get_and_clear_needs_persistence()` check so callers can invoke `schedule()` unconditionally (`src/ldk/storage/persist-cm.ts`, `src/ldk/storage/serial-persister.ts`). VSS conflict resolution also gained a wallet-lock takeover-grace window (`src/ldk/storage/vss-write.ts`): a 409 landing inside the grace window throws `VssConflictDuringTakeoverError` instead of retrying-and-overwriting, so a newly-active tab's write can't clobber the previous tab's late write.

### Phase 1D: Initialization + Migration

- VSS keys derived in `WalletProvider`, passed through context to `LdkProvider`
- `VssClient` instantiated with degradation callbacks wired to React state
- Migration: existing IDB state uploaded to VSS on first startup via `putObjects`
- Version cache seeded to 1 after migration to avoid unnecessary conflict round trips
- Version cache otherwise starts empty — conflict resolution handles sync on first write

### Phase 1E: Recovery Flow

**Update — this phase shipped full automatic recovery, superseding the "Phase 2" deferral noted below.** Whenever LDK init finds IDB empty and VSS has data (`src/ldk/init.ts`, ~299-450), it runs a full automatic recovery: fetches the `_monitor_keys` manifest (`MONITOR_MANIFEST_KEY`), downloads all monitors + the ChannelManager + known-peers, and restores them to IDB before the node starts:

- Monitors are downloaded in parallel chunks (chunk size 10, `VSS_RECOVERY_CHUNK_SIZE`) to bound concurrent requests
- An overall 2-minute timeout (`VSS_RECOVERY_TIMEOUT_MS`) aborts recovery on slow connections rather than hanging indefinitely
- Each monitor blob is deserialized (`constructor_C2Tuple_ThirtyTwoBytesChannelMonitorZ_read`) and validated _before_ being persisted to IDB — corrupt data throws rather than silently writing bad state
- The ChannelManager gets a minimum-size sanity check (32 bytes) before being written
- On any failure, partial IDB writes (monitors + CM) are rolled back so the app starts fresh instead of half-restored
- Known peers are restored from the `_known_peers` VSS key if present

The separate Restore page at `/settings/restore` (mnemonic input, confirmation, progress) drives the same manifest-based recovery path explicitly for user-initiated restores.

### Key Design Decisions

**Version cache starts empty after restart.** `listKeyVersions` returns HMAC-obfuscated keys that can't be mapped back to plaintext keys used by the version cache. Rather than implementing a manifest or reverse mapping, the cache starts at 0 and conflict resolution handles the version mismatch on first write (one extra round trip per key). This is a pragmatic tradeoff — complexity avoided for a one-time-per-restart cost.

**CM persistence throws on failure (no indefinite retry).** Unlike monitors where `channel_monitor_updated` is withheld to halt channel operations, CM persistence is caller-managed. Chain-sync uses `cmNeedsPersist` for next-tick retry. The event timer is fire-and-forget with `.catch()`.

**Monitor recovery via manifest key (superseded the original Phase 2 deferral).** The VssClient obfuscates keys before every API call, so you can't fetch monitors by their obfuscated keys from `listKeyVersions`. Rather than waiting on a manifest feature, a `_monitor_keys` manifest object (`MONITOR_MANIFEST_KEY`) is written alongside every monitor persist and read back on recovery to enumerate which monitor keys to fetch — see `src/ldk/init.ts`. This restores full channel state (CM + all monitors + known peers), not just the CM, so channels do not need to be force-closed on recovery.

## Prevention

- **Always add conflict resolution when introducing version-tracked writes.** CM persistence initially lacked it, causing infinite failure loops when version started at 0 after restart.
- **Seed version refs after bulk uploads.** `putObjects` returns void — manually set versions to 1 after migration to prevent unnecessary conflicts.
- **Test the full restart cycle.** Version cache emptiness after restart is a real operational scenario that unit tests with mocks won't catch.
- **Document obfuscated vs plaintext key distinction.** HMAC obfuscation is one-way — any code that needs to map between obfuscated and plaintext keys must be designed around this constraint.

## Related

- `docs/solutions/logic-errors/vss-restore-background-persist-race.md` — accurate current reference for the recovery flow (manifest-based monitor recovery, shutdown-before-clear ordering); supersedes the recovery-flow description in this doc
- `docs/solutions/design-patterns/vss-dual-write-persistence-with-version-conflict-resolution.md` — Phase 1B deep dive
- `docs/solutions/integration-issues/ldk-wasm-foundation-layer-patterns.md` — `InProgress` return pattern
- `docs/solutions/integration-issues/ldk-trait-defensive-hardening-patterns.md` — Retry patterns
- `docs/plans/2026-03-18-001-feat-vss-remote-state-recovery-plan.md` — Full implementation plan
