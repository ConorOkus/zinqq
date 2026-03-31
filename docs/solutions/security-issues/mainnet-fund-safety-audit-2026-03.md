---
title: 'Pre-Mainnet Fund Safety Audit — 27+ Issues Fixed'
category: security-issues
date: 2026-03-31
tags: [mainnet, fund-safety, audit, ldk, bdk, network-config, persistence, key-derivation]
module: ldk, onchain, wallet, storage
symptom: 'Multiple hardcoded signet values, persistence race conditions, and key derivation issues that would cause fund loss or broken functionality on mainnet'
root_cause: 'Codebase developed exclusively on signet without mainnet validation. Sync-to-async bridging gaps in LDK WASM trait callbacks. Non-deterministic key generation.'
---

# Pre-Mainnet Fund Safety Audit

## Problem

Before mainnet launch, a systematic audit of the entire codebase revealed 27+ issues across Critical/High/Medium severity tiers that would cause fund loss, broken functionality, or degraded safety on mainnet.

## Key Findings (by Category)

### 1. Hardcoded Signet Values (9 Critical)

**Symptom:** Mainnet completely non-functional — all Lightning invoices rejected, on-chain addresses unrecognized, BDK wallet deriving wrong coin type.

**Root causes found:**

- `payment-input.ts:97` — BOLT 11 currency check hardcoded to `LDKCurrency_Signet`
- `payment-input.ts:82` — On-chain address regex only matched `tb1`, `bcrt1` prefixes
- `wallet/context.tsx:21` — `deriveBdkDescriptors(mnemonic, 'signet')` hardcoded, meaning mainnet would use coin type 1 (`m/84'/1'/0'`) instead of coin type 0 (`m/84'/0'/0'`). **This was the most dangerous bug** — funds would be invisible in standard wallets on restore.
- `index.html` CSP — `connect-src` only allowed signet domains, silently blocking all mainnet API calls
- `config.ts:42` — `wsProxyUrl: ''` for mainnet with no validation
- Fee defaults of 1 sat/vB — would never confirm on mainnet

**Solution pattern:** Import `ACTIVE_NETWORK` from `./config` and use `Record<NetworkId, T>` lookup tables for network-dependent values. Add fail-fast validation for critical config values.

### 2. Persistence Race Conditions (5 High)

**Symptom:** Browser crash during critical operations could lose fund-critical data.

**Root causes found:**

- `broadcast_transactions()` — fire-and-forget with no crash recovery
- `FundingGenerationReady` — LDK notified before funding tx persisted to IDB
- BDK changeset not awaited after funding tx creation
- Payment persistence had no error handling

**Solution pattern:**

- **Broadcast persistence:** Write to `ldk_pending_broadcasts` IDB store in parallel with broadcast. Chain `idbDelete` after both `idbPut` and broadcast complete to prevent race. Drain on startup with 48-hour TTL.
- **Funding tx:** Wrap in async IIFE, `await idbPut` before calling `funding_transaction_generated`. If IDB fails, abort channel (it will timeout safely).
- **Key lesson:** When adding a new IDB store, must: (1) add to `STORES` array, (2) bump `DB_VERSION`, (3) verify `clearAllStores()` covers it.

### 3. Non-Deterministic Key Derivation (2 High)

**Symptom:** Cross-device recovery from seed would produce different channel key IDs, breaking force-close fund routing.

**Root cause:** `generate_channel_keys_id()` used `crypto.getRandomValues()` instead of deterministic derivation.

**Solution:** HMAC-SHA256 with domain separation:

1. Derive purpose-specific key in `init.ts`: `channelKeyHmacKey = HMAC(seed, "zinq/channel_keys_id/v1")`
2. Zero the seed copy immediately
3. Use derived key as HMAC key with channel params as message: `HMAC(channelKeyHmacKey, inbound || value || user_channel_id)`
4. Only the 32-byte derived key lives in the closure — not the master seed

**Key lesson:** For sync LDK callbacks needing crypto, use `@noble/hashes` (synchronous) — `crypto.subtle` is async and cannot be used. Always use domain separation. Always put the secret as the HMAC key, not in the message.

### 4. Monitor Persistence Hardening (3 High)

**Root causes:**

- Concurrent monitor updates could race on VSS version cache
- Conflict retry counter reset caused infinite loops
- Manifest limit of 100 too low for mainnet

**Solution:**

- Per-channel promise chain with `.catch(() => {})` to swallow previous errors (critical — otherwise one failure permanently halts the chain)
- Remove `conflictRetries = 0` reset after exhaustion
- Raise `MAX_MANIFEST_ENTRIES` to 1,000
- Clean up `channelWriteChains` on `archive_persisted_channel`

### 5. Signer Fallback Removal (1 High)

**Root cause:** `get_destination_script` and `get_shutdown_scriptpubkey` fell back to KeysManager defaults on BDK failure, silently sending close funds to unwatched addresses.

**Solution:** Return `Result.err()` instead of falling back. LDK handles the error gracefully (fails the channel operation). Failing loudly is safer than silently misdirecting funds.

## Prevention Strategies

1. **Network-awareness checklist:** Before mainnet launch, grep for hardcoded `signet`, `Signet`, `tb1`, `tpub`, `mutinynet`, coin type `1`, and review each occurrence.

2. **IDB store lifecycle:** When adding a new IDB store: update `STORES` array, bump `DB_VERSION`, verify `clearAllStores()` covers it, and add to init-recovery test mocks.

3. **Sync-to-async bridge pattern:** For fund-critical operations in LDK sync callbacks, use the async IIFE pattern: `void (async () => { await criticalWrite(); ldkCallback(); })()`. Never fire-and-forget fund-critical IDB writes.

4. **Key material hygiene:** Derive purpose-specific keys before zeroing the master seed. Only the derived key should live in closures. Use `@noble/hashes` for sync HMAC in LDK callbacks.

5. **Review agent findings:** The deepening phase (multi-agent review of the plan before implementation) caught 2 Critical bugs the initial audit missed (BDK descriptor coin type, CSP domains). Always deepen security-critical plans.

## Related Documentation

- Brainstorm: `docs/brainstorms/2026-03-30-mainnet-fund-safety-audit-brainstorm.md`
- Plan: `docs/plans/2026-03-30-002-fix-mainnet-fund-safety-audit-plan.md`
- PRs: #65, #66, #67, #68, #69, #70
- Prior learnings applied: `bdk-descriptor-version-bytes-network-mismatch.md`, `bdk-ldk-signer-provider-fund-routing.md`, `bdk-address-reveal-not-persisted.md`, `ldk-event-handler-patterns.md`
