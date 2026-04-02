---
title: Mainnet Deployment — Phased Rollout with Anchor CPFP and Safety Guards
category: infrastructure
date: 2026-04-02
tags:
  - mainnet
  - anchor-channels
  - cpfp
  - bolt12-validation
  - broadcaster-fallback
  - wsproxy
  - vercel
---

## Problem

Zinq's mainnet config scaffolding existed but the app could not run on mainnet: empty WS proxy URL caused startup crash, no BOLT 12 network validation risked cross-network fund loss, and unimplemented anchor channel CPFP meant force-close scenarios could lose funds during high-fee periods.

## Root Cause

Mainnet support required coordinated changes across infrastructure (WS proxy, Vercel deployment, VSS), safety (payment validation, CPFP fee bumping, broadcaster resilience), and operational readiness (error monitoring, rollback procedures). These could not be shipped incrementally without a phased plan.

## Solution

Three-phase rollout, each producing a deployable milestone:

### Phase 1 — Infrastructure

- Set `wsProxyUrl: 'wss://proxy.zinqq.app'` in mainnet config (`src/ldk/config.ts`)
- Deploy Cloudflare Workers WS proxy with `custom_domain = true` route for `proxy.zinqq.app`
- Implement `Event_ConnectionNeeded` handler — parse `SocketAddress` (TcpIpV4, TcpIpV6, Hostname) and reconnect via callback pattern matching existing `onPaymentEvent`/`onChannelClosed` conventions
- Separate Vercel projects: `zinqq.app` (mainnet) and `testnet.zinqq.app` (signet) via `VITE_NETWORK` build-time env var

### Phase 2 — Safety

- **BOLT 12 validation**: `offer.chains()` IS exposed in LDK WASM (the old TODO was wrong). Compare chain hashes against `LDK_CONFIG.genesisBlockHash`. Empty chains = implicit mainnet per BOLT 12 spec, rejected on signet.
- **Anchor CPFP**: LDK provides `BumpTransactionEventHandler` which wraps all CPFP complexity. Implement `WalletSourceInterface` backed by BDK wallet:
  - `list_confirmed_utxos()`: Filter `bdkWallet.list_unspent()` to confirmed-only via `wallet.get_tx(txid).chain_position.is_confirmed`
  - `get_change_script()`: Use existing `revealNextAddress()` (handles changeset persistence)
  - `sign_psbt()`: Convert bytes → base64 → `Psbt.from_string()` → `wallet.sign()` → `extract_tx().to_bytes()`
- **Broadcaster fallback**: Extract `postTxToEsplora()` helper, add `tryBroadcast()` with configurable retry count. Primary gets 5 retries, fallback (`blockstream.info`) gets 3.
- **Anchor reserve**: 10k sats reserved when open channels exist. `sendMax` uses fixed-amount send instead of `drain_wallet()`. `sendToAddress` estimates fee before checking reserve.

### Phase 3 — Polish

- **DiscardFunding cleanup**: Store `finalChannelId → tempChannelId` mapping in IDB on `ChannelPending`, look up and delete orphaned `ldk_funding_txs` entries on `DiscardFunding`
- **Error log**: IDB ring buffer (100 entries), `captureError(severity, source, message, detail?)` replaces critical `console.error` calls. Prune debounced to every 10th capture. No external transmission.
- Rollback procedure and smoke test checklist docs

## Key Gotchas

1. **`offer.chains()` is available** in LDK WASM v0.1.8-0 despite the codebase TODO saying otherwise. Always check the actual `.d.mts` type declarations before assuming an API is missing.

2. **BDK `list_unspent()` returns ALL UTXOs including unconfirmed**. For CPFP coin selection, LDK requires confirmed inputs only — an unconfirmed parent could be dropped, invalidating the fee bump. Must cross-reference with `wallet.get_tx()` to check confirmation status.

3. **BDK txid is big-endian (display order), LDK txid is little-endian (internal order)**. Use `Uint8Array.from(bytes).reverse()` (clone first to avoid mutating the source).

4. **BDK `Psbt` has `from_string()` (base64) but no `from_bytes()`**. Manual `uint8ArrayToBase64` conversion needed for the LDK→BDK PSBT bridge.

5. **Prettier version mismatch** between local (3.8.1) and CI (3.5.3) causes different formatting of escaped underscores in markdown. Use `pnpm` lockfile version or avoid ambiguous escape sequences.

## Prevention

- For any new LDK WASM feature, check `node_modules/lightningdevkit/structs/*.d.mts` for the actual API surface before assuming it's missing
- Always filter UTXOs to confirmed-only when providing inputs for security-critical transaction construction
- Run `npx prettier@<lockfile-version> --check .` locally to match CI exactly
