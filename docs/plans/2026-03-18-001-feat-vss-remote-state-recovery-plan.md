---
title: "feat: Add VSS Remote State Recovery"
type: feat
status: active
date: 2026-03-18
origin: docs/brainstorms/2026-03-18-vss-integration-brainstorm.md
---

# feat: Add VSS Remote State Recovery

## Overview

Integrate VSS (Versioned Storage Service) as a remote persistence layer for zinq's Lightning channel state. A TypeScript VSS client communicates with a hosted VSS server using protobuf over HTTP, with client-side ChaCha20-Poly1305 encryption. Combined with existing IndexedDB storage, this creates a dual-write architecture that enables full channel state recovery from any device using only the wallet mnemonic.

## Problem Statement

Today, if a user clears browser data or loses their device, all Lightning channel state is permanently lost. The BIP39 mnemonic only recovers on-chain funds. Open channels, in-flight payments, and channel balances are irrecoverable. This is the single biggest gap in zinq's self-custody story.

## Proposed Solution

Dual-write all critical LDK state to both IndexedDB (fast local reads) and VSS (durable remote backup). Writes to VSS must succeed before LDK state advances. Recovery fetches state from VSS, populates IndexedDB, and restarts the LDK node via the existing init path.

**Phased rollout** (see brainstorm: `docs/brainstorms/2026-03-18-vss-integration-brainstorm.md`):
- **Phase 1 (this plan):** ChannelMonitors + ChannelManager — fund-critical state
- **Phase 2 (future):** NetworkGraph + Scorer + known peers
- **Phase 3 (future):** Payment history, BDK changeset, remaining metadata

## Technical Approach

### Architecture

```
Browser (zinq)
├── LDK WASM Node
│   ├── Persist trait impl (src/ldk/traits/persist.ts)
│   │   ├── Write to VSS first (remote, durable)
│   │   ├── Write to IndexedDB second (local, fast)
│   │   └── Both must succeed → call channel_monitor_updated
│   └── Reads from IndexedDB only (zero network latency)
│
├── VSS TypeScript Client (NEW: src/ldk/storage/vss-client.ts)
│   ├── HTTP POST to VSS server (protobuf wire format)
│   ├── Client-side encryption (ChaCha20-Poly1305 via @noble/ciphers)
│   ├── Key obfuscation (HMAC-SHA256)
│   ├── Protobuf serialization (@bufbuild/protobuf)
│   ├── Exponential backoff retry (indefinite, capped at 60s)
│   └── Pluggable auth via VssHeaderProvider interface
│
├── VSS Crypto Layer (NEW: src/ldk/storage/vss-crypto.ts)
│   ├── Encryption key derived from mnemonic at m/535'/1'
│   ├── ChaCha20-Poly1305 encrypt/decrypt
│   ├── Random 12-byte nonce prepended to ciphertext
│   └── HMAC-SHA256 key obfuscation
│
└── Recovery Flow (NEW: Settings > Restore from Backup)
    ├── User enters mnemonic
    ├── Derive encryption key + store_id
    ├── Fetch all state from VSS via listKeyVersions + getObject
    ├── Decrypt and write to IndexedDB
    └── Full page reload → existing init path restores from IDB
```

### Write Ordering: VSS-First, Then IDB

**Decision:** Write to VSS before IDB. This maximizes recovery safety.

- If the browser crashes after VSS write but before IDB write: recovery data is intact on the server. On restart, LDK re-persists the in-memory monitor to IDB (it calls `persist_new_channel` again because `channel_monitor_updated` was never called).
- If VSS write fails: `channel_monitor_updated` is never called. LDK halts channel operations, preventing state advancement. Retry loop continues in background.
- If IDB write fails after VSS succeeds: Log at CRITICAL level. LDK will re-persist on restart. The brief inconsistency window is acceptable because VSS has the durable copy.

**Rationale from learnings:** `docs/solutions/integration-issues/ldk-wasm-foundation-layer-patterns.md` documents that returning `InProgress` and resolving via `channel_monitor_updated` is the correct pattern for async persistence. VSS-first ordering ensures the durable store always has the latest state.

### Consolidate ChannelManager Persist Paths

**Pre-requisite refactor:** Before adding VSS writes, consolidate the three separate ChannelManager persist paths into a single function.

Current locations:
1. `src/ldk/sync/chain-sync.ts:225` — sync loop, has retry via `cmNeedsPersist` flag
2. `src/ldk/context.tsx:542` — event timer, fire-and-forget with `.catch(console.error)`
3. `src/ldk/context.tsx:661` — visibility handler, best-effort

New design:
- Create `persistChannelManager(cm: ChannelManager, vssClient?: VssClient): Promise<void>` in `src/ldk/storage/persist-cm.ts`
- Paths 1 and 2 call this function (VSS + IDB)
- Path 3 (visibility handler) calls IDB-only variant (browser may kill tab before network request completes)
- Consolidation prevents the bug where one path writes to IDB without writing to VSS

### Indefinite Background Retry

**Decision:** Replace the current 3-attempt linear backoff with an indefinite exponential backoff, capped at 60 seconds.

Current behavior (`persist.ts:16-38`): 3 attempts, 500ms × attempt, then abandon permanently. Channel is halted until app restart.

New behavior:
- Exponential backoff: 500ms, 1s, 2s, 4s, 8s, 16s, 32s, 60s (cap)
- Continue retrying indefinitely while the app is running
- After 10 seconds of failure: surface a UI banner ("Backup service unavailable. Lightning payments paused. Retrying...")
- After 2 minutes: escalate to error state in LdkContext
- On success: dismiss banner, call `channel_monitor_updated`, resume normal operations
- On app restart: LDK re-persists from memory, retry loop starts fresh

**Rationale:** A 30-second network blip (user on a train) should not permanently halt a channel. The exponential backoff respects server availability while ensuring eventual recovery.

### Version Conflict Resolution

**Decision:** On `CONFLICT_EXCEPTION` from `putObjects`:
1. Log a warning with the key, expected version, and server response
2. Re-fetch the current object via `getObject` to learn the server's version
3. Compare server data with local data (are they the same serialized bytes?)
4. If same data (duplicate write): update local version counter, done
5. If different data (true conflict): log at CRITICAL level, use the higher-versioned data. In single-device mode, this can only happen due to a bug.
6. Retry the write with the corrected version

This is safe for single-device because there is no competing writer. A conflict always indicates a stale local version counter.

### Implementation Phases

#### Phase 1A: Foundation (VSS Client + Crypto)

New files and dependencies. No changes to existing persistence yet.

**Tasks:**

- [x] Add dependencies: `@noble/ciphers`, `@bufbuild/protobuf`, `@bufbuild/protoc-gen-es`
- [x] Copy `vss.proto` from `lightningdevkit/vss-server` repo into `src/ldk/storage/proto/`
- [x] Generate TypeScript protobuf types from `vss.proto` using `@bufbuild/protoc-gen-es`
- [x] Add `vssUrl` to `SIGNET_CONFIG` in `src/ldk/config.ts` with `VITE_VSS_URL` env override
- [x] Add `deriveVssEncryptionKey(mnemonic)` to `src/wallet/keys.ts` — BIP32 derivation at `m/535'/1'`, returns 32-byte key
- [x] Add `deriveVssStoreId(ldkSeed)` to `src/wallet/keys.ts` — SHA256 of the node public key hex derived from the seed

**`src/ldk/storage/vss-crypto.ts`** (NEW):
```typescript
// Encryption: ChaCha20-Poly1305 via @noble/ciphers
// - Random 12-byte nonce from crypto.getRandomValues()
// - Nonce prepended to ciphertext: [12-byte nonce][ciphertext]
// - Decrypt: split nonce from ciphertext, decrypt with key
export function vssEncrypt(key: Uint8Array, plaintext: Uint8Array): Uint8Array
export function vssDecrypt(key: Uint8Array, cipherBlob: Uint8Array): Uint8Array

// Key obfuscation: HMAC-SHA256(encryptionKey, plaintextKey)
// - Deterministic: same input always produces same output
// - Returns hex string for use as VSS key
export function obfuscateKey(encryptionKey: Uint8Array, plaintextKey: string): string
```

**`src/ldk/storage/vss-client.ts`** (NEW):
```typescript
// Follows EsploraClient pattern (src/ldk/sync/esplora-client.ts)
// - Class-based, per-request AbortSignal.timeout(15_000)
// - Protobuf request/response encoding
// - Pluggable auth via VssHeaderProvider interface

interface VssHeaderProvider {
  getHeaders(): Promise<Record<string, string>>
}

class FixedHeaderProvider implements VssHeaderProvider { ... }

class VssClient {
  constructor(baseUrl: string, storeId: string, encryptionKey: Uint8Array, auth: VssHeaderProvider)

  async getObject(key: string): Promise<{ value: Uint8Array; version: number } | null>
  async putObject(key: string, value: Uint8Array, version: number): Promise<number>  // returns new version
  async putObjects(items: Array<{ key: string; value: Uint8Array; version: number }>): Promise<void>
  async deleteObject(key: string, version: number): Promise<void>
  async listKeys(): Promise<Array<{ key: string; version: number }>>
}
```

The client handles encryption/decryption and key obfuscation internally — callers pass plaintext keys and values.

**Success criteria:**
- [ ] `VssClient` can `putObject` and `getObject` against a running VSS server
- [ ] Round-trip encryption works: encrypt → upload → download → decrypt = original
- [ ] Key obfuscation is deterministic: same input always produces same obfuscated key
- [ ] Protobuf encoding matches what the server expects (verified with a test PUT/GET)

#### Phase 1B: Persist Trait Integration (ChannelMonitors)

Wire VSS into the ChannelMonitor persistence hot path.

**Tasks:**

- [x] Refactor `persistWithRetry()` in `src/ldk/traits/persist.ts` to accept an optional `VssClient`
- [x] Change write ordering: VSS write first, then IDB write
- [x] Replace 3-attempt linear backoff with indefinite exponential backoff (capped at 60s)
- [x] Add in-memory version cache: `Map<string, number>` keyed by `txid:vout`, tracking the last-known VSS version per monitor
- [x] On `persist_new_channel`: write to VSS with version 0, then IDB. On success, cache version 1.
- [x] On `update_persisted_channel`: write to VSS with cached version, then IDB. On success, increment cached version.
- [x] On VSS `CONFLICT_EXCEPTION`: execute version conflict resolution (see above)
- [x] On `archive_persisted_channel`: delete from VSS (with cached version), then delete from IDB
- [x] Add `onVssUnavailable` callback to surface outage state to the UI
- [x] Wire `onVssUnavailable` into `LdkContext` to show a degradation banner

**Key changes to `src/ldk/traits/persist.ts`:**
```typescript
// Before (current):
async function persistWithRetry(store, key, data) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { await idbPut(store, key, data); return; }
    catch { await delay(500 * attempt); }
  }
  throw new Error('persist failed');
}

// After (new):
async function persistWithRetry(store, key, data, vssClient?, vssVersion?) {
  let backoff = 500;
  while (true) {
    try {
      // VSS first (durable remote)
      if (vssClient) {
        const newVersion = await vssClient.putObject(key, data, vssVersion ?? 0);
        versionCache.set(key, newVersion);
      }
      // IDB second (fast local)
      await idbPut(store, key, data);
      return;
    } catch (e) {
      if (isVssConflict(e)) { /* resolve conflict, retry */ }
      await delay(backoff);
      backoff = Math.min(backoff * 2, 60_000);
      if (backoff >= 10_000) onVssUnavailable?.();
    }
  }
}
```

**Success criteria:**
- [ ] ChannelMonitor writes go to both VSS and IDB
- [ ] `channel_monitor_updated` is only called after both writes succeed
- [ ] VSS failure blocks channel operations (no state advancement)
- [ ] Recovery from brief network outage (<60s) is automatic
- [ ] UI shows degradation banner during VSS outage

#### Phase 1C: ChannelManager Persistence

Consolidate CM persist paths and add VSS writes.

**Tasks:**

- [x] Create `src/ldk/storage/persist-cm.ts` with `persistChannelManager(cm, vssClient?)` function
- [x] Refactor `src/ldk/sync/chain-sync.ts:225` to call `persistChannelManager()`
- [x] Refactor `src/ldk/context.tsx:542` (event timer) to call `persistChannelManager()`
- [x] Keep `src/ldk/context.tsx:661` (visibility handler) as IDB-only — browser may kill tab before network request completes
- [x] ChannelManager uses a single VSS key: `"channel_manager"` (obfuscated by VssClient)
- [x] Track CM version in memory, same pattern as monitors

**Success criteria:**
- [ ] All three CM persist paths go through the consolidated function
- [ ] CM writes to VSS + IDB (except visibility handler: IDB-only)
- [ ] No regression in existing CM persistence behavior

#### Phase 1D: Initialization + Migration

Wire VSS into startup and handle existing users.

**Tasks:**

- [x] Derive `vssEncryptionKey` and `vssStoreId` in `WalletProvider` alongside existing `ldkSeed` and `bdkDescriptors`
- [x] Pass `vssEncryptionKey` and `vssStoreId` through context to `LdkProvider`
- [x] Instantiate `VssClient` in `LdkProvider` before calling `initializeLdk()`
- [x] Pass `VssClient` to `createPersister()` and to the CM persist function
- [x] **Migration for existing users:** On first startup with VSS enabled, if IDB has channel state but VSS does not:
  - Upload all existing ChannelMonitors + ChannelManager to VSS as version 0 → 1
  - Track migration completion with `vss_migrated` flag in a new IDB store
  - If upload fails partway, retry from scratch on next startup (idempotent via version checks)
- [x] Initialize the in-memory version cache by fetching `listKeyVersions` from VSS at startup

**Key integration point in `src/ldk/init.ts`:**
```typescript
// After seed verification, before ChannelMonitor restoration:
// 1. Create VssClient with derived encryptionKey + storeId
// 2. Fetch version list from VSS (populates version cache)
// 3. If IDB has data but VSS does not: run migration upload
// 4. Continue with existing init flow (reads from IDB)
```

**Success criteria:**
- [ ] New wallets: VSS writes begin immediately after first channel open
- [ ] Existing wallets: IDB state is uploaded to VSS on first startup
- [ ] Version cache is populated at startup from VSS
- [ ] Migration is idempotent and resilient to partial failure

#### Phase 1E: Recovery Flow

Add "Restore from backup" in Settings.

**Tasks:**

- [ ] Add "Restore from backup" UI in Settings page (`src/pages/settings/`)
- [ ] Recovery flow:
  1. User enters 12-word mnemonic
  2. Derive `ldkSeed`, `vssEncryptionKey`, `vssStoreId` from mnemonic
  3. Connect to VSS server and call `listKeyVersions` to verify data exists
  4. If no data found: show error "No backup found for this wallet"
  5. Fetch all objects via `getObject` for each key
  6. Decrypt all values
  7. Clear ALL existing IDB stores (all 12 stores)
  8. Write `wallet_mnemonic`, `ldk_seed` (re-derived from mnemonic)
  9. Write `ldk_channel_manager` (must be written BEFORE monitors — `doInitializeLdk` requires this order)
  10. Write all `ldk_channel_monitors`
  11. Full page reload — releases Web Lock, clears WASM state, resets `initPromise`
  12. Normal init path picks up restored IDB data
- [ ] Confirm dialog before destructive operation: "This will replace your current wallet. Are you sure?"
- [ ] Progress indicator during fetch/decrypt/write

**Recovery ordering constraint** (from `src/ldk/init.ts:268-274`):
The init function throws if monitors exist without a ChannelManager. The recovery flow MUST write the ChannelManager before any ChannelMonitors.

**Web Lock interaction** (from `src/ldk/init.ts:90-109`):
The Web Lock is held by a never-resolving promise. Recovery cannot re-init in-place. A full page reload is the simplest and safest teardown mechanism — it releases the lock, clears all WASM state, and resets the `initPromise` singleton.

**Success criteria:**
- [ ] User can restore a wallet from mnemonic + VSS backup
- [ ] Restored wallet has all channels and correct balances
- [ ] Recovery works from a completely fresh browser (no existing IDB data)
- [ ] Recovery from a browser with existing wallet data works (wipes and replaces)

### File Map

| File | Action | Purpose |
|------|--------|---------|
| `src/ldk/storage/vss-client.ts` | NEW | VSS HTTP client with protobuf, encryption, auth |
| `src/ldk/storage/vss-crypto.ts` | NEW | ChaCha20-Poly1305 encryption, HMAC key obfuscation |
| `src/ldk/storage/proto/vss.proto` | NEW | VSS protobuf schema (copied from vss-server) |
| `src/ldk/storage/proto/vss_pb.ts` | NEW | Generated protobuf TypeScript types |
| `src/ldk/storage/persist-cm.ts` | NEW | Consolidated ChannelManager persist function |
| `src/ldk/traits/persist.ts` | MODIFY | Add VSS writes, indefinite retry, version cache |
| `src/ldk/init.ts` | MODIFY | Create VssClient, populate version cache, migration |
| `src/ldk/config.ts` | MODIFY | Add `vssUrl` config |
| `src/wallet/keys.ts` | MODIFY | Add `deriveVssEncryptionKey`, `deriveVssStoreId` |
| `src/wallet/context.tsx` | MODIFY | Derive and pass VSS keys |
| `src/ldk/context.tsx` | MODIFY | Instantiate VssClient, wire to persist, degradation UI |
| `src/ldk/ldk-context.ts` | MODIFY | Add VSS status to context type |
| `src/ldk/sync/chain-sync.ts` | MODIFY | Use consolidated `persistChannelManager()` |
| `src/pages/settings/restore.tsx` | NEW | Restore from backup UI |
| `package.json` | MODIFY | Add dependencies |
| `vite.config.ts` | MODIFY | If protobuf build step needed |

## System-Wide Impact

### Interaction Graph

1. `Persist.persist_new_channel()` → `persistWithRetry()` → `VssClient.putObject()` → VSS server → on success → `idbPut()` → on success → `ChainMonitor.channel_monitor_updated()`
2. `chain-sync tick` → `cm.get_and_clear_needs_persistence()` → `persistChannelManager()` → `VssClient.putObject()` → `idbPut()`
3. `event timer` → `cm.get_and_clear_needs_persistence()` → `persistChannelManager()` → same as above
4. `visibilitychange` → `persistChannelManager()` → IDB-only (no VSS)
5. Recovery: `Settings UI` → derive keys → `VssClient.listKeys()` → `VssClient.getObject()` × N → decrypt → `idbPut()` × N → `window.location.reload()` → normal init

### Error Propagation

| Error | Source | Handler | User Impact |
|-------|--------|---------|-------------|
| VSS network timeout | `VssClient.putObject()` | Exponential backoff retry in `persistWithRetry()` | Banner after 10s, channel ops paused |
| VSS `CONFLICT_EXCEPTION` | `VssClient.putObject()` | Re-fetch version, retry | None (transparent) |
| VSS `AUTH_EXCEPTION` | `VssClient.putObject()` | Log CRITICAL, surface error | Wallet degraded, needs auth fix |
| IDB write failure (after VSS success) | `idbPut()` | Log CRITICAL, LDK will re-persist on restart | Brief inconsistency, self-healing |
| Protobuf decode error | Response parsing | Throw, caught by retry loop | Retry, likely persistent (server bug) |
| Encryption failure | `vssEncrypt()` | Should never happen (deterministic), throw | Fatal error |
| Recovery fetch failure | `VssClient.getObject()` | Show error in restore UI, user can retry | Recovery blocked until VSS available |

### State Lifecycle Risks

1. **Crash between VSS and IDB write:** VSS has the update, IDB does not. On restart, LDK loads stale state from IDB. Since `channel_monitor_updated` was never called, LDK re-persists the monitor (from its in-memory copy loaded from IDB). The re-persist writes to VSS again — version conflict detected, resolved by re-fetching server version. **Self-healing.**

2. **Migration partial failure:** Some monitors uploaded to VSS, then crash. On next startup, migration runs again. Monitors already on VSS get version conflicts, resolved by comparing data. Fresh monitors get uploaded normally. **Idempotent.**

3. **Recovery writes monitors before manager:** `doInitializeLdk` throws "Found monitors but no ChannelManager." **Prevention:** Recovery MUST write CM before monitors. Enforced by code ordering.

### API Surface Parity

- `idbPut` → now paired with `VssClient.putObject` in persist paths
- `idbDelete` → now paired with `VssClient.deleteObject` for archived channels
- `idbGet` / `idbGetAll` → no VSS equivalent needed (reads are local-only)
- New API surface: `VssClient` class, `vssEncrypt`/`vssDecrypt`, `obfuscateKey`

### Integration Test Scenarios

1. **Happy path round-trip:** Open channel → persist monitor to VSS + IDB → close app → clear IDB → restore from VSS → verify channel state matches
2. **VSS outage during payment:** Start payment → VSS goes down → verify payment blocks → VSS comes back → verify payment completes
3. **Existing user migration:** Create wallet with channels (no VSS) → enable VSS → verify all state uploaded → verify subsequent writes go to both
4. **Version conflict recovery:** Manually set wrong version in cache → write monitor → verify conflict resolved and write succeeds
5. **Recovery ordering:** Restore from VSS → verify CM is written before monitors → verify `doInitializeLdk` succeeds

## Acceptance Criteria

### Functional Requirements

- [ ] ChannelMonitor writes persist to both VSS and IDB before `channel_monitor_updated` is called
- [ ] ChannelManager writes persist to both VSS and IDB (except visibility handler: IDB-only)
- [ ] All data is encrypted with ChaCha20-Poly1305 before leaving the browser
- [ ] All VSS keys are obfuscated with HMAC-SHA256
- [ ] VSS failure blocks Lightning state advancement (no advancing ahead of server)
- [ ] Automatic retry with exponential backoff (up to 60s) on VSS failure
- [ ] UI degradation banner shown after 10s of VSS unavailability
- [ ] Existing users' state is migrated to VSS on first startup
- [ ] Users can restore wallet from mnemonic via Settings > Restore from Backup
- [ ] Restored wallet has all channels with correct state
- [ ] Recovery works on a fresh browser with no existing data
- [ ] Version conflicts are resolved transparently

### Non-Functional Requirements

- [ ] VSS writes add <500ms latency to the persist hot path (95th percentile)
- [ ] No regression in LDK read performance (reads remain IDB-only)
- [ ] Encryption key derivation is deterministic from mnemonic
- [ ] `store_id` derivation is deterministic from mnemonic
- [ ] Mnemonic is NEVER sent to VSS server (only encrypted data)

### Quality Gates

- [ ] Unit tests for `VssClient`, `vssEncrypt`/`vssDecrypt`, `obfuscateKey`, `deriveVssEncryptionKey`, `deriveVssStoreId`
- [ ] Unit tests for version conflict resolution logic
- [ ] Unit tests for consolidated `persistChannelManager` function
- [ ] Integration test: round-trip write → read against a VSS server (can mock in tests)
- [ ] E2E test: recovery flow (restore from backup)

## Dependencies & Risks

### Dependencies

- **Hosted VSS provider** — need a running VSS server for signet/mutinynet testing
- **`@noble/ciphers`** — ChaCha20-Poly1305 implementation (well-maintained, audited)
- **`@bufbuild/protobuf`** + **`@bufbuild/protoc-gen-es`** — protobuf TypeScript codegen
- **`vss.proto`** from `lightningdevkit/vss-server` — API schema definition

### Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| VSS provider downtime during testing | Medium | Blocks development | Self-host fallback for dev |
| Protobuf schema mismatch | Low | Writes fail silently | Pin proto version, test against server |
| Encryption key derivation incompatible with vss-client | Low | Cannot migrate to native client later | Match vss-client's derivation if possible |
| Large monitor blobs exceed VSS limits | Low (Phase 1) | Persist failures | Monitor blob size in tests, add chunking in Phase 2 |
| Nonce collision (random 12-byte) | Negligible | Encryption break | 2^96 nonce space, not a practical concern |

## Crypto Contract

Lock down these choices before implementation — they cannot change after wallets are deployed:

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Encryption algorithm | ChaCha20-Poly1305 | Matches vss-client, fast in JS, AEAD |
| Encryption key derivation | `m/535'/1'` from mnemonic | Deterministic, separate from LDK seed (`m/535'/0'`) |
| Nonce strategy | Random 12 bytes, prepended to ciphertext | Stateless, no persistent counter needed |
| Key obfuscation | HMAC-SHA256(encryptionKey, plaintextKey) → hex | Deterministic, non-reversible, fixed-length |
| `store_id` derivation | `hex(SHA256(nodePublicKey))` | Deterministic from mnemonic, unique per wallet |
| Protobuf wire format | `@bufbuild/protobuf` generated from `vss.proto` | Type-safe, tree-shakeable |

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-03-18-vss-integration-brainstorm.md](docs/brainstorms/2026-03-18-vss-integration-brainstorm.md) — Key decisions carried forward: TS client over WASM, dual-write architecture, block on VSS failure, phased rollout, ChaCha20-Poly1305 encryption, pluggable auth.

### Internal References

- IDB storage layer: `src/ldk/storage/idb.ts`
- Persist trait (monitors): `src/ldk/traits/persist.ts:46-102`
- LDK init/restore: `src/ldk/init.ts:125-298`
- Chain sync (CM persist): `src/ldk/sync/chain-sync.ts:222-229`
- Context (CM persist): `src/ldk/context.tsx:540-549, 656-668`
- EsploraClient (HTTP pattern): `src/ldk/sync/esplora-client.ts`
- Broadcaster (retry pattern): `src/ldk/traits/broadcaster.ts:4-5, 44`
- Key derivation: `src/wallet/keys.ts:13`
- LDK config: `src/ldk/config.ts`
- WalletProvider: `src/wallet/context.tsx`
- WalletGate: `src/wallet/wallet-gate.tsx`

### Institutional Learnings

- **Async persist safety:** `docs/solutions/integration-issues/ldk-wasm-foundation-layer-patterns.md` — Return `InProgress`, never `Completed`, for async writes
- **Atomic dual-writes:** `docs/solutions/design-patterns/bdk-ldk-transaction-history-indexeddb-persistence.md` — Every `idbPut` must be paired with its context update (here: VSS write)
- **Seed overwrite guard:** `docs/solutions/integration-issues/ldk-wasm-foundation-layer-patterns.md` — Never silently replace authoritative data
- **Consistency across requests:** `docs/solutions/integration-issues/bdk-030-upgrade-nlocktime-and-chain-sync-consistency.md` — Fetch dependent data atomically
- **Address reveal persistence:** `docs/solutions/logic-errors/bdk-address-reveal-not-persisted.md` — State changes in one subsystem must be persisted in all layers

### External References

- VSS blog post: https://lightningdevkit.org/blog/announcing-versioned-storage-service-vss/
- VSS server (proto + implementation): https://github.com/lightningdevkit/vss-server
- VSS client (Rust reference): https://github.com/lightningdevkit/vss-client
- `@noble/ciphers` (ChaCha20-Poly1305): https://github.com/paulmillr/noble-ciphers
- `@bufbuild/protobuf`: https://github.com/bufbuild/protobuf-es
