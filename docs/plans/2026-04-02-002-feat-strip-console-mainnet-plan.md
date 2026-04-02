---
title: 'feat: Strip console output on mainnet production builds'
type: feat
status: completed
date: 2026-04-02
origin: docs/brainstorms/2026-04-02-strip-console-mainnet-brainstorm.md
---

# feat: Strip console output on mainnet production builds

## Overview

Remove all `console.*` calls from mainnet production bundles using esbuild's build-time `drop` option, and expand `captureError` coverage to ~60 critical error/warn sites so failures are still persisted to IndexedDB when console is stripped.

## Problem Statement

The app currently emits 159 `console.*` calls across 29 files unconditionally. On mainnet with real user funds, this leaks internal operational details to the browser console and is unnecessary noise. There is no log-level gating today.

## Proposed Solution

Two coordinated changes, landed in a **single PR** to avoid a window where errors are silently dropped:

1. **Vite config**: Add esbuild `drop: ['console']` gated on `VITE_NETWORK=mainnet` + production mode
2. **captureError expansion**: Wire `captureError(severity, source, message, detail?)` into critical error/warn sites so the IDB ring buffer captures what console no longer shows

## Technical Approach

### Phase 1: Vite Config Change

**File:** `vite.config.ts`

Add conditional console stripping using the `env` object already populated by `loadEnv()` on line 52:

```ts
const isMainnet = env.VITE_NETWORK === 'mainnet'

// Inside the returned config:
esbuild: {
  drop: isMainnet && mode === 'production' ? ['console'] : [],
},
```

> **Implementation note:** Verify the correct Vite 5 config key. The top-level `esbuild` key controls transform options. If `drop` only applies during minification, use `build.minify: 'esbuild'` (already default) with the appropriate minification options. **Run a local mainnet production build and grep `dist/assets/*.js` for `console.` to confirm stripping works before proceeding.**

**Worker bundle:** Add a comment to the `worker` section noting it does not currently need its own `drop` option but would require one if worker files are added.

### Phase 2: Expand captureError Coverage

**Tiers of call sites:**

#### Tier 1 — Critical (fund-safety, must capture)

These are persistence failures, channel operations, and signing errors. Wire to `captureError('critical', source, message, detail)`:

| File                                    | Lines                                            | Signal                                                |
| --------------------------------------- | ------------------------------------------------ | ----------------------------------------------------- |
| `src/ldk/traits/persist.ts`             | 186, 208, 213                                    | Version conflict, write failure                       |
| `src/ldk/traits/event-handler.ts`       | 116, 216, 231, 255, 421, 436, 461, 470, 546, 559 | Event handling failures, funding tx failures          |
| `src/ldk/context.tsx`                   | 119, 133, 151, 626, 737, 745, 755                | Channel ops failures, persist failures                |
| `src/ldk/traits/bdk-signer-provider.ts` | 85, 100, 106                                     | Cannot derive address (CRITICAL)                      |
| `src/ldk/traits/bdk-wallet-source.ts`   | 55, 65, 82                                       | UTXO/signing failures                                 |
| `src/onchain/sync.ts`                   | 68                                               | CRITICAL: failed to persist ChangeSet                 |
| `src/onchain/context.tsx`               | 56                                               | CRITICAL: failed to persist changeset                 |
| `src/onchain/init.ts`                   | 96                                               | CRITICAL: failed to persist ChangeSet after full scan |
| `src/ldk/init.ts`                       | 417                                              | CRITICAL: persist failure                             |

#### Tier 2 — Error (operational, should capture)

Wire to `captureError('error', source, message, detail)`:

| File                         | Lines                | Signal                      |
| ---------------------------- | -------------------- | --------------------------- |
| `src/ldk/lsps2/client.ts`    | 35                   | LSPS2 get_info error        |
| `src/ldk/sync/chain-sync.ts` | 75, 87, 93, 117, 249 | Sync errors, malformed data |
| `src/pages/CloseChannel.tsx` | 106                  | Close error                 |
| `src/pages/OpenChannel.tsx`  | 152                  | Open error                  |
| `src/pages/Receive.tsx`      | 84                   | Address generation failure  |
| `src/pages/Backup.tsx`       | 37                   | Mnemonic retrieval failure  |

#### Tier 3 — Warning (degraded but recoverable, should capture)

Wire to `captureError('warning', source, message, detail)`:

| File                               | Lines                        | Signal                               |
| ---------------------------------- | ---------------------------- | ------------------------------------ |
| `src/ldk/sweep.ts`                 | 33, 44, 94, 128              | Partial sweep failures               |
| `src/ldk/init.ts`                  | 370, 376, 431, 452, 502, 718 | Recovery fallbacks                   |
| `src/ldk/context.tsx`              | 96, 515, 530, 576, 773, 824  | Peer management, LSP connect         |
| `src/onchain/sync.ts`              | 86                           | Sync tick failure                    |
| `src/onchain/init.ts`              | 27, 88                       | Wallet restore fallback              |
| `src/onchain/address-utils.ts`     | 17, 68                       | Persist address reveal failure       |
| `src/ldk/sync/chain-sync.ts`       | 73, 113, 183, 240            | RGS failures, partial check failures |
| `src/ldk/traits/fee-estimator.ts`  | 49                           | Fee fetch failure                    |
| `src/ldk/lsps2/message-handler.ts` | 100, 108, 116                | Message decode failures              |
| `src/ldk/storage/known-peers.ts`   | 52, 55                       | VSS sync failures                    |
| `src/pages/Send.tsx`               | 288                          | Address resolution failure           |
| `src/pages/Restore.tsx`            | 101                          | Monitor missing from VSS             |
| `src/pages/Receive.tsx`            | 145, 164                     | Invoice creation failures            |
| `src/onchain/context.tsx`          | 47                           | Fee estimation fallback              |

#### Excluded from captureError (strip silently)

- **`src/storage/idb.ts` lines 64-67** — IDB migration `console.warn` inside `onupgradeneeded`. Calling async `captureError` from a synchronous IDB upgrade callback is unsafe.
- **`src/ldk/traits/filter.ts`** — High-frequency `register_tx`/`register_output` traces
- **`src/ldk/sync/rapid-gossip-sync.ts`** — RGS fetch progress
- **`src/ldk/peers/peer-reconnect.ts`** — Peer reconnect progress
- **All `console.log` and `console.info` calls** — Informational traces, stripped by esbuild with no replacement needed

### Phase 3: LDK Logger Bridge

**File:** `src/ldk/traits/logger.ts`

The LDK logger bridge maps internal LDK log levels to `console.*` methods. All will be stripped on mainnet. Add `captureError` calls for `LDKLevel_Error` and `LDKLevel_Warn` only:

```ts
case Level.LDKLevel_Error:
  captureError('error', `LDK:${record.module_path}`, record.args)
  console.error(...)  // stripped on mainnet, visible on signet/dev
  break
case Level.LDKLevel_Warn:
  captureError('warning', `LDK:${record.module_path}`, record.args)
  console.warn(...)
  break
```

**Rate limiting:** LDK can emit high-frequency error logs during channel stress. Add a simple dedup guard:

```ts
const recentCaptures = new Map<string, number>()
const CAPTURE_COOLDOWN_MS = 5000

function shouldCapture(key: string): boolean {
  const now = Date.now()
  const last = recentCaptures.get(key)
  if (last && now - last < CAPTURE_COOLDOWN_MS) return false
  recentCaptures.set(key, now)
  return true
}
```

Gate `captureError` behind `shouldCapture(`${level}:${module_path}`)` so the 100-entry ring buffer isn't flooded.

`LDKLevel_Gossip`, `LDKLevel_Trace`, `LDKLevel_Debug`, and `LDKLevel_Info` are stripped silently — no captureError needed.

### Phase 4: Housekeeping

1. **Update comment in `src/storage/error-log.ts` line 43**: Remove the false claim that `console.error` is a fallback — on mainnet it's stripped. The IDB write is the only record.

2. **IDB-failure call sites** (broadcaster line 107, onchain/sync.ts line 68, onchain/init.ts line 96): These represent persistence failures where `captureError` itself may also fail. Wire them to `captureError` anyway — it's best-effort. Accept that if IDB is entirely broken, these are lost. The user will notice via other symptoms (stale balance, missing channels).

## System-Wide Impact

- **Interaction graph**: esbuild's `drop` removes `console.*` call expressions at the AST level during minification. All other code (IDB writes, state updates, event handling) is unaffected.
- **Error propagation**: `captureError` writes are fire-and-forget. IDB failures are silently swallowed. This is acceptable — the alternative (blocking on error logging) is worse for UX.
- **State lifecycle risks**: None. This is a build-time transform, not a runtime state change.
- **API surface parity**: No API changes. The `captureError` function signature is unchanged.

## Acceptance Criteria

- [x] `vite.config.ts` strips all `console.*` calls when `VITE_NETWORK=mainnet` and `mode=production`
- [x] Signet production builds and all dev builds retain full console output
- [x] All Tier 1 (critical) call sites wired to `captureError`
- [x] All Tier 2 (error) call sites wired to `captureError`
- [x] All Tier 3 (warning) call sites wired to `captureError`
- [x] LDK logger bridge calls `captureError` for `LDKLevel_Error` and `LDKLevel_Warn` with rate limiting
- [x] `error-log.ts` fallback comment updated
- [x] IDB migration log in `idb.ts` excluded from `captureError` migration
- [x] Local mainnet production build verified: `grep -r "console\." dist/assets/*.js` returns no matches
- [x] Worker config section has comment about future `drop` need

## Verification

```bash
# Build mainnet production
VITE_NETWORK=mainnet pnpm build

# Verify console calls are stripped
grep -r "console\." dist/assets/*.js
# Expected: no matches

# Build signet production
VITE_NETWORK=signet pnpm build

# Verify console calls are retained
grep -c "console\." dist/assets/*.js
# Expected: matches present
```

## Dependencies & Risks

- **Risk**: Incorrect Vite config key placement silently fails to strip. **Mitigation**: Verify with grep on build output before merging.
- **Risk**: captureError migration lands after config change, leaving a window of silent errors. **Mitigation**: Ship as a single PR.
- **Risk**: LDK retry storm floods 100-entry ring buffer. **Mitigation**: Rate-limit dedup guard in logger bridge.

## Sources & References

- **Origin brainstorm:** [docs/brainstorms/2026-04-02-strip-console-mainnet-brainstorm.md](../brainstorms/2026-04-02-strip-console-mainnet-brainstorm.md) — Key decisions: strip all console.\* including errors, build-time via esbuild, mainnet only, expand captureError coverage
- **Institutional learning:** `docs/solutions/integration-issues/ldk-trait-defensive-hardening-patterns.md` — Documents that raw `console.error` in LDK traits was a known prototype shortcut
- **Institutional learning:** `docs/solutions/infrastructure/mainnet-deployment-phased-rollout.md` — Specifies `captureError` API and IDB ring buffer design
- Config file: `vite.config.ts`
- Error utility: `src/storage/error-log.ts`
- LDK logger: `src/ldk/traits/logger.ts`
- Network config: `src/ldk/config.ts`
