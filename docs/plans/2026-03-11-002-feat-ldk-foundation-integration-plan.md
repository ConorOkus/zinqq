---
title: 'feat: LDK Foundation Integration'
type: feat
status: completed
date: 2026-03-11
---

# feat: LDK Foundation Integration

## Overview

Integrate the Lightning Dev Kit (LDK) TypeScript bindings into the browser wallet, establishing the foundational layer needed for all future Lightning Network functionality. This covers WASM initialization, core trait implementations, key management, IndexedDB persistence, and a React Context provider — all targeting Bitcoin Signet.

## Problem Statement / Motivation

The browser-wallet project has a working React/TypeScript skeleton with WASM scaffolding but no Lightning Network functionality. LDK provides a flexible, non-custodial Lightning implementation that can run entirely in the browser via WASM. Before any channel management or payment features can be built, the foundational LDK infrastructure must be in place: WASM loaded, core interfaces implemented, keys generated, and state persistence working.

This foundation must be solid because all subsequent Lightning features (channels, payments, routing) depend on it. Getting persistence, key management, and trait implementations right at this stage prevents costly rework later.

## Proposed Solution

Install `lightningdevkit` (v0.1.8-0) and implement the foundation layer:

1. **WASM Initialization** — Use `initializeWasmWebFetch()` to load the LDK WASM binary in-browser, integrated with the existing Vite WASM plugin setup
2. **Core Trait Implementations** — TypeScript implementations of LDK's required interfaces (Logger, FeeEstimator, BroadcasterInterface, Persist)
3. **Key Management** — KeysManager initialized with cryptographically secure entropy from `crypto.getRandomValues()`
4. **IndexedDB Persistence** — Durable storage for ChannelMonitor data, ChannelManager state, and NetworkGraph using IndexedDB
5. **React Integration** — Context provider exposing LDK initialization state and core services to the component tree
6. **Signet Configuration** — Target Bitcoin Signet with appropriate chain parameters and API endpoints

## Technical Considerations

### WASM Loading

- The `lightningdevkit` package includes `liblightningjs.wasm` which must be loaded before any LDK APIs are used
- Two initialization paths available: `initializeWasmWebFetch(uri)` (browser, fetches from URL) or `initializeWasmFromBinary(bin: Uint8Array)` (universal)
- `initializeWasmWebFetch` is preferred for browser as Vite can serve the WASM file as a static asset
- Requires `FinalizationRegistry`, `WeakRef` (Chrome 84+, Firefox 79+, Safari 14.1+) and WASM BigInt support (Chrome 85+)
- The existing `src/wasm/loader.ts` placeholder will be replaced by LDK's own initialization

### Core Trait Implementations

Each trait is created via `TraitName.new_impl({ ...methods })`:

| Trait                  | Purpose                        | Implementation Strategy                                                                           |
| ---------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `Logger`               | LDK internal logging           | Map to `console.debug/info/warn/error` by log level                                               |
| `FeeEstimator`         | Fee rate estimation            | Fetch from Signet Esplora API (`/api/fee-estimates`), cache with TTL, fallback to static defaults |
| `BroadcasterInterface` | Broadcast signed transactions  | POST to Signet Esplora API (`/api/tx`)                                                            |
| `Persist`              | Persist ChannelMonitor updates | Write to IndexedDB; must be durable before returning                                              |
| `Filter`               | Chain data filtering           | `Option_FilterZ.constructor_none()` initially (no SPV filtering needed for foundation)            |

### Key Management

- `KeysManager` requires a 32-byte seed, timestamp (seconds + nanoseconds), and provides `EntropySource`, `NodeSigner`, and `SignerProvider`
- Seed must be generated from `crypto.getRandomValues()` and persisted in IndexedDB
- **Critical**: Seed loss = fund loss. Must implement seed backup/export mechanism (mnemonic display) before any real funds
- For foundation phase: generate and persist seed, defer mnemonic backup UI to a follow-up

### IndexedDB Persistence Layer

Object stores needed:

| Store                  | Key          | Value                     | Purpose                                 |
| ---------------------- | ------------ | ------------------------- | --------------------------------------- |
| `ldk_seed`             | `"primary"`  | `Uint8Array(32)`          | Node seed (encrypted at rest in future) |
| `ldk_channel_monitors` | `channel_id` | `Uint8Array` (serialized) | Per-channel monitor state               |
| `ldk_channel_manager`  | `"primary"`  | `Uint8Array` (serialized) | ChannelManager serialized state         |
| `ldk_network_graph`    | `"primary"`  | `Uint8Array` (serialized) | Network routing graph                   |
| `ldk_scorer`           | `"primary"`  | `Uint8Array` (serialized) | Routing scorer state                    |

- Use a single IndexedDB database `browser-wallet-ldk` with versioned schema
- All writes must complete before `Persist` trait methods return (LDK requirement for safety)
- Consider `idb` wrapper library for Promise-based IndexedDB API (simpler than raw API)

### CSP Updates

The current Content-Security-Policy restricts `connect-src` to `'self'`. This must be updated to allow:

- Signet Esplora API (e.g., `https://mutinynet.com/api` or `https://mempool.space/signet/api`)
- WebSocket connections for future peer connectivity

### React Integration

```
src/
  ldk/
    init.ts              — WASM loading + LDK bootstrap sequence
    traits/
      logger.ts          — Logger implementation
      fee-estimator.ts   — FeeEstimator with Esplora backend
      broadcaster.ts     — BroadcasterInterface with Esplora backend
      persist.ts         — Persist with IndexedDB backend
    storage/
      idb.ts             — IndexedDB wrapper (open, get, put, delete)
      seed.ts            — Seed generation and retrieval
    config.ts            — Signet chain parameters, API endpoints
    context.tsx          — React Context + Provider
    types.ts             — Shared LDK TypeScript types
```

- `LdkProvider` wraps the app and manages initialization lifecycle
- `useLdk()` hook exposes: `{ status: 'loading' | 'ready' | 'error', nodeId: string | null, error: Error | null }`
- Initialization is async — UI shows loading state until WASM + LDK are ready

### Signet Configuration

- **Network**: Bitcoin Signet (BIP 325) — predictable block generation, free test coins
- **Esplora API**: `https://mutinynet.com/api` (Mutinynet Signet) as primary, with configurable endpoint
- **Chain Parameters**: `ChainParameters` with `Network.LDKNetwork_Signet` and best known block hash/height

### Browser Compatibility

Minimum browser requirements (from LDK WASM):

- `FinalizationRegistry` + `WeakRef`: Chrome 84, Firefox 79, Safari 14.1
- WASM BigInt: Chrome 85, Firefox 78, Safari 14.1
- IndexedDB: All modern browsers
- `crypto.getRandomValues()`: All modern browsers

## System-Wide Impact

- **CSP change**: `connect-src` must include the Esplora API domain — affects `index.html`
- **Bundle size**: The `liblightningjs.wasm` binary adds significant weight (~4-8MB estimated). Must be loaded asynchronously, not blocking initial render
- **IndexedDB usage**: New persistent storage that survives page reloads. Users clearing browser data will lose wallet state (seed, channels)
- **No external state changes**: Foundation layer doesn't open channels or broadcast transactions — safe to develop and test without affecting any network

## Acceptance Criteria

- [x] `lightningdevkit` package installed and WASM initializes successfully in-browser
- [x] Logger trait outputs LDK logs to browser console at appropriate levels
- [x] FeeEstimator fetches fee rates from Signet Esplora API with fallback defaults
- [x] BroadcasterInterface can POST raw transactions to Signet Esplora API
- [x] Persist trait writes/reads ChannelMonitor data to/from IndexedDB
- [x] KeysManager initializes with secure random seed persisted in IndexedDB
- [x] Seed persists across page reloads (generate once, reuse on subsequent loads)
- [x] `LdkProvider` context provides initialization status to React components
- [x] `useLdk()` hook returns node public key after successful initialization
- [x] CSP updated to allow Esplora API connections
- [x] Unit tests for each trait implementation (mocked LDK APIs where needed)
- [x] Integration test verifying full init sequence: WASM → seed → KeysManager → traits → ready (deferred to e2e — requires real browser for WASM)
- [x] TypeScript strict mode passes with no `any` escape hatches in LDK wrapper code
- [x] WASM loading shows appropriate loading/error states in UI

## Success Metrics

- LDK WASM initializes in < 3 seconds on a modern browser
- All trait implementations pass unit tests
- Node ID is deterministic (same seed → same node ID across page reloads)
- IndexedDB persistence survives page reload without data loss
- No console errors during normal initialization flow

## Dependencies & Risks

| Risk                                      | Impact                                     | Mitigation                                                        |
| ----------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------- |
| `lightningdevkit` v0.1.8-0 is pre-release | API instability, possible breaking changes | Pin exact version, wrap LDK APIs behind internal interfaces       |
| WASM binary size may be large             | Slow initial load                          | Async loading with progress indicator, consider lazy loading      |
| IndexedDB can be cleared by user          | Seed/channel loss                          | Display warnings, implement seed backup in follow-up              |
| Signet Esplora API availability           | Init failure if API is down                | Implement retry logic, fallback endpoints, graceful error states  |
| CSP changes widen attack surface          | XSS could exfiltrate to allowed domains    | Restrict connect-src to specific API domains only, not wildcards  |
| `lightningdevkit` types may be incomplete | TypeScript strictness issues               | Create local type declarations where needed, minimize `any` usage |

## MVP

### `src/ldk/init.ts`

```typescript
import ldk from 'lightningdevkit'
import { getSeed, generateAndStoreSeed } from './storage/seed'
import { createLogger } from './traits/logger'
import { createFeeEstimator } from './traits/fee-estimator'
import { createBroadcaster } from './traits/broadcaster'
import { createPersister } from './traits/persist'
import { SIGNET_CONFIG } from './config'

export interface LdkNode {
  nodeId: string
  keysManager: ldk.KeysManager
  logger: ldk.Logger
  feeEstimator: ldk.FeeEstimator
  broadcaster: ldk.BroadcasterInterface
  persister: ldk.Persist
}

export async function initializeLdk(): Promise<LdkNode> {
  // 1. Load WASM
  await ldk.initializeWasmWebFetch('/liblightningjs.wasm')

  // 2. Get or create seed
  let seed = await getSeed()
  if (!seed) {
    seed = await generateAndStoreSeed()
  }

  // 3. Initialize KeysManager
  const timestamp = BigInt(Math.floor(Date.now() / 1000))
  const keysManager = ldk.KeysManager.constructor_new(seed, timestamp, 0)

  // 4. Create trait implementations
  const logger = createLogger()
  const feeEstimator = createFeeEstimator(SIGNET_CONFIG.esploraUrl)
  const broadcaster = createBroadcaster(SIGNET_CONFIG.esploraUrl)
  const persister = createPersister()

  // 5. Derive node ID
  const nodeId = Buffer.from(
    keysManager.as_NodeSigner().get_node_id(ldk.Recipient.LDKRecipient_Node).res!
  ).toString('hex')

  return { nodeId, keysManager, logger, feeEstimator, broadcaster, persister }
}
```

### `src/ldk/storage/idb.ts`

```typescript
const DB_NAME = 'browser-wallet-ldk'
const DB_VERSION = 1

const STORES = [
  'ldk_seed',
  'ldk_channel_monitors',
  'ldk_channel_manager',
  'ldk_network_graph',
  'ldk_scorer',
] as const

export async function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store)
        }
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function idbGet(store: string, key: string): Promise<unknown> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).get(key)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function idbPut(store: string, key: string, value: unknown): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
```

### `src/ldk/context.tsx`

```typescript
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { initializeLdk, type LdkNode } from './init'

type LdkStatus = 'loading' | 'ready' | 'error'

interface LdkContextValue {
  status: LdkStatus
  node: LdkNode | null
  nodeId: string | null
  error: Error | null
}

const LdkContext = createContext<LdkContextValue>({
  status: 'loading',
  node: null,
  nodeId: null,
  error: null,
})

export function LdkProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LdkContextValue>({
    status: 'loading',
    node: null,
    nodeId: null,
    error: null,
  })

  useEffect(() => {
    initializeLdk()
      .then((node) => setState({ status: 'ready', node, nodeId: node.nodeId, error: null }))
      .catch((error: unknown) =>
        setState({
          status: 'error',
          node: null,
          nodeId: null,
          error: error instanceof Error ? error : new Error(String(error)),
        })
      )
  }, [])

  return <LdkContext value={state}>{children}</LdkContext>
}

export function useLdk(): LdkContextValue {
  return useContext(LdkContext)
}
```

## Sources

- **DeepWiki LDK TypeScript Bindings**: Setup, WASM init, trait implementations, browser considerations
- **npm**: `lightningdevkit@0.1.8-0`
- **Existing WASM scaffolding**: `src/wasm/loader.ts`, `vite.config.ts` (wasm + topLevelAwait plugins)
- **CSP**: `index.html:8-10` — requires `connect-src` update
- **Project skeleton**: `docs/plans/2026-03-11-001-feat-react-ts-webapp-skeleton-plan.md`
