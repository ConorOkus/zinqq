---
title: 'fix: Mainnet fund safety audit'
type: fix
status: active
date: 2026-03-30
origin: docs/brainstorms/2026-03-30-mainnet-fund-safety-audit-brainstorm.md
deepened: 2026-03-30
---

# fix: Mainnet Fund Safety Audit

## Enhancement Summary

**Deepened on:** 2026-03-30
**Research agents used:** Security Sentinel, Architecture Strategist, TypeScript Reviewer, Data Integrity Guardian, Performance Oracle, Best Practices Researcher, LDK Docs (Context7), Institutional Learnings

### Key Improvements from Deepening

1. **2 new Critical bugs discovered:** Hardcoded `'signet'` in BDK descriptor derivation (`wallet/context.tsx:21`) and CSP `connect-src` missing mainnet domains (`index.html`)
2. **PR4b conflict resolution redesigned:** "Accept server version" is unsafe for channel monitors — must compare `update_id` to prevent revoked state broadcast
3. **PR3 code examples corrected:** Fixed `this.seed` reference (closure, not class), `peekAddressAtIndex` return type, HMAC domain separation, u128 handling
4. **PR2 broadcast pattern improved:** Fire IDB write and broadcast in parallel (not sequential) for time-critical force-close txs
5. **Missing IDB infrastructure identified:** New `ldk_pending_broadcasts` store requires STORES array addition and DB_VERSION bump
6. **Institutional learnings applied:** BDK descriptor version bytes, eager BDK init order, WASM u128 asymmetry warning

### New Considerations Discovered

- Mnemonic stored as plaintext in IDB — document as accepted risk with follow-up
- LDK `MinAllowed*` fee rate defaults should be raised to match LDK docs (2,500 sat/kw)
- SpendableOutputs persistence crash window remains unaddressed
- Multi-endpoint broadcast recommended for force-close reliability

---

## Overview

Comprehensive fix plan for 27+ issues identified in a pre-mainnet security audit of Zinq, a non-custodial Lightning/Bitcoin browser wallet built on LDK WASM + BDK. Issues range from hardcoded signet values that completely break mainnet to persistence race conditions that could cause fund loss on browser crash.

Organized into 6 PRs in strict dependency order. PRs 1-4 are mainnet launch blockers. PR5 is deferred (anchors disabled). PR6 improves recovery resilience.

## Problem Statement / Motivation

Zinq is preparing for mainnet launch. The audit (see brainstorm: `docs/brainstorms/2026-03-30-mainnet-fund-safety-audit-brainstorm.md`) found:

- **7 Critical issues**: Hardcoded signet values, dangerous fee defaults, empty wsProxy config, unimplemented anchor fee bumping
- **10 High issues**: Silent broadcast failures, non-deterministic channel key IDs, persistence races, VSS recovery timeouts
- **10 Medium issues**: Fire-and-forget payment persistence, sweep concurrency, conflict retry loops

**Deepening discovered 2 additional Critical issues:** hardcoded signet in BDK descriptor derivation and missing mainnet CSP domains.

Real money is at stake. Every Critical and High issue must be resolved before mainnet launch.

## Proposed Solution

6 PRs in dependency order, each addressing a coherent set of related issues. Critical items first, defense-in-depth improvements later.

**PR dependency graph:**

```
PR1 (mainnet blockers) ──> PR2 (broadcast/persist safety) ──> PR3 (channel recovery)
                                                                     │
PR1 ──────────────────────> PR4 (monitor persistence) ───────────────┘

PR5 (anchor CPFP) ── deferred, anchors disabled in PR1
PR6 (VSS recovery) ── independent, can parallel with PR3/PR4
```

## Technical Approach

### Phase 1: PR1 — Mainnet Blockers

**Branch:** `fix/mainnet-payment-input-and-config`

Fixes C1, C2, C3, C4, C5, C6, C7 (disable), H10 from the brainstorm, plus 2 new Critical findings from deepening.

#### 1a. Network-aware payment input parsing

**File:** `src/ldk/payment-input.ts`

**C1 — BOLT 11 currency check (line 97):**

```typescript
// Before:
if (invoice.currency() !== Currency.LDKCurrency_Signet)

// After:
import { ACTIVE_NETWORK, type NetworkId } from './config'

const NETWORK_CURRENCY: Record<NetworkId, Currency> = {
  signet: Currency.LDKCurrency_Signet,
  mainnet: Currency.LDKCurrency_Bitcoin,
}

if (invoice.currency() !== NETWORK_CURRENCY[ACTIVE_NETWORK])
```

**C2 — On-chain address regex (line 82):**

The current code uses an inline regex, not a named constant. Extract it and make it network-aware:

```typescript
const ON_CHAIN_RE: Record<NetworkId, RegExp> = {
  signet: /^(tb1|bcrt1|[mn2])[a-zA-Z0-9]{25,}$/,
  mainnet: /^(bc1)[a-z0-9]{25,}$|^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/,
}
```

### Research Insights (C2)

**From TypeScript Review:** The original plan's mainnet regex `/^(bc1|[13])[a-zA-Z0-9]+$/` is too permissive — it accepts invalid Base58 characters (`0`, `O`, `I`, `l`) and has no length constraints. The improved regex above:

- Bech32 (`bc1`): lowercase only, min 25 chars (as per BIP 173)
- Base58 (`1`, `3`): excludes confusable characters per Base58Check alphabet, 25-34 char length
- Removes `tpub` from signet regex (extended public keys are not addresses)

BDK's `Address.from_string(address, network)` remains the authoritative validator downstream. The regex is a pre-filter for input classification only.

**C3 — BOLT 12 network validation (lines 123-154):**
Add network check in `parseBolt12Offer()`. BOLT 12 offers encode chain hashes — validate against `LDK_CONFIG.genesisBlockHash`. If the LDK WASM bindings expose `offer.chains()`, compare. If not, add a TODO with a comment explaining the limitation.

**C4 — BIP 321 URI address validation (lines 204-216):**
After extracting the address from the URI, validate it against the network-aware regex before returning. Return an error if it doesn't match. Currently the `parseBip321` function returns `{ type: 'onchain', address, amountSats }` without any address validation.

#### 1b. Fee defaults and sanity checks

**File:** `src/onchain/context.tsx`

**C5 — Default fee rate (line 28):**

```typescript
// Before:
const DEFAULT_FEE_RATE_SAT_VB = 1n

// After:
const DEFAULT_FEE_RATE_SAT_VB = ACTIVE_NETWORK === 'mainnet' ? 4n : 1n
```

**H10 — Minimum fee check (after line 182):**

```typescript
const MIN_FEE_RATE_SAT_VB = ACTIVE_NETWORK === 'mainnet' ? 2n : 1n
if (feeRateSatVb < MIN_FEE_RATE_SAT_VB) {
  throw new Error(`Fee rate ${feeRateSatVb} sat/vB is below minimum for ${ACTIVE_NETWORK}`)
}
```

**Also update sweep fee default:**

**File:** `src/ldk/sweep.ts` (line 14)

```typescript
const DEFAULT_FEE_RATE_SAT_VB = ACTIVE_NETWORK === 'mainnet' ? 4 : 1
```

### Research Insights (Fee Safety)

**From LDK Docs:** LDK recommends `MinAllowedAnchorChannelRemoteFee` at 2,500 sat/kw (10 sat/vB) and `MinAllowedNonAnchorChannelRemoteFee` similarly. The current defaults in `fee-estimator.ts` are 1,000 sat/kw (4 sat/vB) — too low for mainnet. Update:

**File:** `src/ldk/traits/fee-estimator.ts` (lines 7-8)

```typescript
// Raise to LDK-recommended values for mainnet safety
[ConfirmationTarget.LDKConfirmationTarget_MinAllowedAnchorChannelRemoteFee]: 2_500,
[ConfirmationTarget.LDKConfirmationTarget_MinAllowedNonAnchorChannelRemoteFee]: 2_500,
```

**From Best Practices Research:** Consider adding a stale-data warning if fee estimates haven't been refreshed in >15 minutes. LDK may force-close channels if feerates get stale without updates (see rust-lightning PR #3037).

#### 1c. Fail-fast on empty wsProxy URL

**File:** `src/ldk/config.ts`

Add validation after line 69:

```typescript
if (!LDK_CONFIG.wsProxyUrl) {
  throw new Error(
    `[LDK Config] wsProxyUrl is empty for ${ACTIVE_NETWORK}. ` +
      'Set VITE_WS_PROXY_URL to the WebSocket proxy endpoint.'
  )
}
```

The actual mainnet wsProxy URL depends on where the Cloudflare Worker proxy (`proxy/`) is deployed. The `proxy/wrangler.toml` production config already allows `zinqq.com` origins. The URL must be set via `VITE_WS_PROXY_URL` env var in the Vercel deployment.

#### 1d. Disable anchor channels

**File:** `src/ldk/init.ts` (in `createUserConfig()`, after line 111)

```typescript
// Disable anchor channels until Event_BumpTransaction CPFP is implemented.
// Without CPFP, force-close commitment txs cannot be fee-bumped during
// high-fee periods, risking fund loss. See brainstorm C7.
const handshakeConfig = config.get_channel_handshake_config()
handshakeConfig.set_negotiate_anchors_zero_fee_htlc_tx(false)
```

**Important:** Verify this method exists in `lightningdevkit` v0.1.8-0 WASM bindings. If not available, add `accept_inbound_channels` gating in the `OpenChannelRequest` handler to reject anchor channels, or document the risk.

### Research Insights (Anchor Channels)

**From LDK Docs (Context7):** Anchor outputs are opt-in via `ChannelHandshakeConfig`. The `set_negotiate_anchors_zero_fee_htlc_tx(false)` method disables negotiation. Without CPFP, force-close commitment transactions cannot be fee-bumped — this is confirmed as a fund-loss risk.

**From Best Practices:** For LSPs using 0-conf JIT channels with anchors, there is a trust model where the mobile node lets the LSP handle force closes. However, since Zinq is non-custodial, we should not rely on this. Disabling anchors is the correct call until CPFP is implemented.

**Pre-existing anchor channel transition:** If any channels were already opened with anchor outputs (unlikely on fresh mainnet), force-closing them will emit `BumpTransaction` events that are silently dropped. Add a log at CRITICAL level:

```typescript
console.error(
  '[LDK Event] CRITICAL: BumpTransaction received but CPFP not implemented. ' +
    'Anchor channel force-close transaction may be stuck.'
)
```

#### 1e. NEW: Fix hardcoded signet in BDK descriptor derivation

**File:** `src/wallet/context.tsx` (line 21)

### Research Insights (CRITICAL — Discovered by Security Review)

**From Security Sentinel:** This is arguably the most dangerous bug in the codebase. The `deriveBdkDescriptors` call is hardcoded to `'signet'`:

```typescript
// Before:
const bdkDescriptors = deriveBdkDescriptors(mnemonic, 'signet')

// After:
const bdkDescriptors = deriveBdkDescriptors(mnemonic, ACTIVE_NETWORK)
```

With `'signet'`, mainnet BDK wallets derive addresses at `m/84'/1'/0'` (testnet coin type) instead of `m/84'/0'/0'` (mainnet coin type). Users restoring from seed in any standard wallet (Sparrow, BlueWallet, etc.) would **not find their funds**. This silently works but derives wrong addresses.

**From Institutional Learnings (BDK Descriptor Version Bytes):** `@scure/bip32` defaults to mainnet BIP32 version bytes (`xprv`). For signet/testnet, pass `{ private: 0x04358394, public: 0x043587cf }` to get `tprv` keys. Mismatched version bytes cause BDK "Invalid network" errors. Add a test assertion checking descriptor prefix (`tprv` for signet, `xprv` for mainnet).

#### 1f. NEW: Update CSP for mainnet domains

**File:** `index.html` (line 9)

### Research Insights (CRITICAL — Discovered by Security Review)

**From Security Sentinel:** The CSP `connect-src` directive only allows signet/mutinynet domains. On mainnet, the wallet connects to `mempool.space`, `rapidsync.lightningdevkit.org`, and the mainnet wsProxy — all would be blocked by CSP, causing silent failures.

Make CSP environment-aware. Options:

1. **Build-time injection:** Use Vite to inject the correct domains based on `VITE_NETWORK`
2. **Permissive approach:** Add both signet and mainnet domains (acceptable since CSP still restricts to known good origins)
3. **Server-side header:** Set CSP via Vercel headers config instead of HTML meta tag

Option 2 is simplest for launch:

```html
connect-src 'self' https://mutinynet.com https://*.mutinynet.com wss://p.mutinynet.com
https://mempool.space https://*.mempool.space https://rapidsync.lightningdevkit.org
wss://*.workers.dev https://cloudflare-dns.com;
```

#### 1g. Tests

**File:** `src/ldk/payment-input.test.ts`

- Add test cases for mainnet BOLT 11 invoices (mock `Currency.LDKCurrency_Bitcoin`)
- Add test cases for mainnet on-chain addresses (`bc1q...`, `bc1p...`, `1...`, `3...`)
- Add test cases for BIP 321 URIs with mainnet addresses
- Add negative tests: signet invoice rejected on mainnet, mainnet address rejected on signet

**File:** `src/ldk/config.test.ts`

- Add test that `wsProxyUrl` is non-empty for all networks
- Add test that BDK descriptor derivation uses correct coin type per network
- Add test asserting descriptor prefix (`tprv` for signet, `xprv` for mainnet)

**Acceptance Criteria:**

- [x] `parseBolt11` accepts mainnet invoices when `ACTIVE_NETWORK === 'mainnet'`
- [x] `parseBolt11` rejects signet invoices when `ACTIVE_NETWORK === 'mainnet'`
- [x] On-chain address regex matches `bc1q...`, `bc1p...`, `1...`, `3...` on mainnet
- [x] On-chain address regex rejects invalid Base58 characters on mainnet
- [x] BIP 321 URIs validate address against active network
- [x] Default fee rate is >= 4 sat/vB on mainnet
- [x] Minimum fee rate check rejects < 2 sat/vB on mainnet
- [x] Sweep default fee rate is >= 4 sat/vB on mainnet
- [x] `MinAllowed*` fee defaults raised to 2,500 sat/kw
- [x] App throws at startup if `wsProxyUrl` is empty
- [x] Anchor channel negotiation is disabled in `UserConfig`
- [x] **BDK descriptors use correct coin type for active network**
- [x] **CSP includes mainnet domains**
- [x] All existing tests pass
- [x] CI passes

---

### Phase 2: PR2 — Broadcaster & Persistence Safety

**Branch:** `fix/broadcast-and-persistence-safety`

Fixes H1, H5, H3, M2, M3 from the brainstorm.

#### 2a. Persist transactions before broadcast

**File:** `src/ldk/traits/broadcaster.ts`

Add an IDB store `ldk_pending_broadcasts` and write transactions to it before the first broadcast attempt. On success or "already known" response, delete from IDB. On startup, drain any pending broadcasts (crash recovery).

### Research Insights (Broadcast Pattern)

**From Architecture Review:** The original plan chained IDB write _before_ broadcast (`idbPut().then(() => broadcastWithRetry())`). This gates broadcast latency on IDB write latency (~5ms). For time-critical force-close transactions, fire both in parallel instead:

```typescript
// In broadcast_transactions():
for (const txBytes of txs) {
  const txHex = bytesToHex(txBytes)
  // Fire BOTH in parallel — broadcast is time-critical, IDB is for crash recovery
  void idbPut('ldk_pending_broadcasts', txHex, { txHex, createdAt: Date.now() }).catch((err) =>
    console.error('[LDK Broadcaster] Failed to persist pending tx:', err)
  )
  void broadcastWithRetry(esploraUrl, txHex)
    .then(() => idbDelete('ldk_pending_broadcasts', txHex))
    .catch((err) => console.error('[LDK Broadcaster] CRITICAL: broadcast failed:', err))
}
```

**From Performance Review:** If LDK batches multiple transactions, consider an `idbPutBatch` helper to write all pending broadcasts in a single IDB transaction (reduces N round-trips to 1). Low priority since N is typically 1-2.

**From Data Integrity Review — REQUIRED:** The new `ldk_pending_broadcasts` store must be:

1. Added to the `STORES` array in `src/storage/idb.ts`
2. `DB_VERSION` bumped from 8 to 9
3. Without this, all IDB operations on the new store will throw at runtime

**From Best Practices:** Consider multi-endpoint broadcast for mainnet (submit to 2-3 independent Esplora servers). Single endpoint is a single point of failure for force-close transactions. This can be a follow-up improvement.

Add startup drain in `src/ldk/init.ts`:

```typescript
// After LDK init, before starting background tasks:
const pendingTxs = await idbGetAll('ldk_pending_broadcasts')
for (const { txHex } of pendingTxs) {
  void broadcastWithRetry(esploraUrl, txHex)
    .then(() => idbDelete('ldk_pending_broadcasts', txHex))
    .catch((err) => console.error('[LDK Init] Pending broadcast retry failed:', err))
}
```

**From Security Review:** Also add startup drain for `ldk_funding_txs` — if the tab is killed after `funding_transaction_generated` but before `FundingTxBroadcastSafe`, the funding tx is persisted but never broadcast. Document whether LDK's channel timeout mechanism is sufficient to recover, or add explicit drain.

**Architectural constraint:** `broadcast_transactions` is a synchronous LDK callback. The IDB write is fire-and-forget inside it (matching the established pattern from the learnings doc on sync/async bridging). The crash window between the callback returning and IDB completing is ~5ms — accepted as residual risk.

#### 2b. Block channel progress on funding tx persistence failure

**File:** `src/ldk/traits/event-handler.ts` (lines 341-347)

### Research Insights (Async Handler Pattern)

**From Architecture Review & Performance Review:** The plan's original note that `FundingGenerationReady` is "already wrapped in a `.then()` chain" is **incorrect** — the handler is synchronous. The `handle_event` callback returns `ok()` immediately. To await IDB, wrap the funding block in an async IIFE:

```typescript
// Inside handleEvent, for FundingGenerationReady:
void (async () => {
  try {
    const scriptPubkey = ScriptBuf.from_bytes(event.output_script)
    // ... build and sign PSBT ...

    const txHex = bytesToHex(rawTxBytes)
    try {
      await idbPut('ldk_funding_txs', tempChannelIdHex, txHex)
    } catch (err) {
      console.error('[LDK Event] CRITICAL: Failed to persist funding tx — aborting channel:', err)
      return // Channel will timeout; no fund loss since tx was never broadcast
    }
    channelManager.funding_transaction_generated(...)

    // Persist changeset (awaited per learnings doc)
    const changeset = bdkWallet.take_staged()
    if (changeset && !changeset.is_empty()) {
      await putChangeset(changeset.to_json()).catch((err) =>
        console.error('[BDK] CRITICAL: failed to persist changeset after funding tx:', err)
      )
    }
  } catch (err) {
    console.error('[LDK Event] FundingGenerationReady failed:', err)
  }
})()
```

This pattern is correct because LDK does not wait for the event handler to complete — `handle_event` already returned `ok()`.

#### 2c. Harden wallet changeset persistence after funding

**File:** `src/ldk/traits/event-handler.ts` (lines 358-364)

Per the learnings doc ("BDK Address Reveals Not Persisted"): always persist changesets immediately. Included in the async IIFE above (section 2b).

**From Institutional Learnings:** The BDK address reveal persistence bug was a previous fund-safety incident. The pattern is: any call to `next_unused_address()` or address derivation must be followed by immediate changeset persistence. The `revealNextAddress` helper in the SpendableOutputs handler also needs this — currently its changeset is fire-and-forget.

#### 2d. Add error handling to payment persistence

**File:** `src/ldk/traits/event-handler.ts` (lines 173, 195)

Add `.catch()` handlers to `persistPayment()` and `updatePaymentStatus()`:

```typescript
void persistPayment({...}).catch((err) =>
  console.error('[LDK Event] Failed to persist inbound payment:', err)
)

void updatePaymentStatus(paymentIdHex, 'succeeded', feePaidMsat).catch((err) =>
  console.error('[LDK Event] Failed to update outbound payment status:', err)
)
```

Payment persistence failures are M2 (medium) — funds are safe, only history is lost.

#### 2e. Tests

**File:** `src/ldk/traits/broadcaster.test.ts`

- Test that pending broadcasts are written to IDB
- Test startup drain of pending broadcasts
- Test that successful broadcast deletes from IDB
- Test that IDB write failure does not prevent broadcast attempt

**File:** `src/ldk/traits/event-handler.test.ts`

- Test that funding tx IDB failure prevents `funding_transaction_generated` call
- Test changeset persistence after funding

**Acceptance Criteria:**

- [ ] `ldk_pending_broadcasts` added to STORES array, DB_VERSION bumped to 9
- [ ] Broadcast and IDB write fire in parallel (not sequential)
- [ ] Failed broadcasts are persisted to IDB and retried on startup
- [ ] Funding tx IDB failure aborts channel (no call to `funding_transaction_generated`)
- [ ] Wallet changeset persisted (awaited) after funding tx creation
- [ ] Payment persistence has error logging
- [ ] All existing tests pass
- [ ] CI passes

---

### Phase 3: PR3 — Channel Recovery Safety

**Branch:** `fix/deterministic-channel-keys-and-signer-safety`

Fixes H2, H4 from the brainstorm.

#### 3a. Deterministic channel keys ID

**File:** `src/ldk/traits/bdk-signer-provider.ts` (lines 36-44)

Replace `crypto.getRandomValues()` with deterministic derivation.

### Research Insights (Key Derivation)

**From TypeScript Review — CRITICAL corrections:**

1. The plan's original code used `this.seed` — but `createBdkSignerProvider` is a factory function returning an object literal, not a class. The seed must be accessed from the closure (e.g., passed as a parameter to the factory).
2. `peekAddressAtIndex` returns `Uint8Array` (raw script bytes), not an `Address` object. Calling `.script_pubkey().to_bytes()` on it would throw.
3. `channelKeysIdToIndex` is a private function in `address-utils.ts` — not exported. Use `peekAddressAtIndex` directly, which calls it internally.

**From Security Review:** The HMAC key and message both contained the seed — poor cryptographic hygiene. Use a domain-separation string as the HMAC key instead.

**From Architecture Review:** `channel_value_satoshis` should be included in the derivation input (it's a parameter of the function). Also, `user_channel_id` is 128-bit in LDK — using only 8 bytes discards half the entropy. Include all 16 bytes.

**Corrected implementation:**

```typescript
generate_channel_keys_id(
  inbound: boolean,
  channel_value_satoshis: bigint,
  user_channel_id: bigint
): Uint8Array {
  // Deterministic derivation for cross-device recovery.
  // Domain-separated HMAC with all parameters included.
  const key = new TextEncoder().encode('zinq/channel_keys_id/v1')
  const data = new Uint8Array(32 + 1 + 8 + 16) // seed + inbound + value + user_channel_id
  data.set(ldkSeed) // from closure, not this.seed
  data[32] = inbound ? 1 : 0
  const view = new DataView(data.buffer)
  view.setBigUint64(33, channel_value_satoshis, false)
  // Include full 16 bytes of user_channel_id (128-bit)
  // Lower 8 bytes via BigInt, upper 8 bytes are typically 0 (our code uses 64-bit values)
  view.setBigUint64(41, user_channel_id & 0xFFFFFFFFFFFFFFFFn, false)
  view.setBigUint64(49, user_channel_id >> 64n, false)

  return new Uint8Array(hmacSha256(key, data))
}
```

**Note on `hmacSha256` import:** The codebase has HMAC in `src/ldk/storage/vss-crypto.ts`. Either export it or use `@noble/hashes/hmac` directly.

**WASM u128 warning (from learnings):** Never re-encode a decoded `user_channel_id` through `encodeUint128`. The LDK WASM bindings have an encode/decode asymmetry bug (encodeUint128 rejects >= 2^124). Our deterministic derivation avoids this by operating on the raw BigInt value.

**Important caveat:** This change only affects NEW channels. Existing channels have random `channel_keys_id` values stored in their `ChannelMonitor` state. Recovery via VSS restores the original random IDs.

#### 3b. Remove signer fallback to KeysManager

**File:** `src/ldk/traits/bdk-signer-provider.ts` (lines 55-89)

### Research Insights (Signer Safety)

**From TypeScript Review:** The plan's code incorrectly called `.script_pubkey().to_bytes()` on the return of `peekAddressAtIndex`. The actual function returns `Uint8Array` already. Corrected:

```typescript
get_destination_script(): Result_CVec_u8ZNoneZ {
  try {
    // peekAddressAtIndex returns Uint8Array (raw script bytes)
    const script = peekAddressAtIndex(bdkWallet, channelKeysId)
    return Result_CVec_u8ZNoneZ.constructor_ok(script)
  } catch (err) {
    console.error('[BDK SignerProvider] CRITICAL: Cannot derive destination address:', err)
    return Result_CVec_u8ZNoneZ.constructor_err()
  }
}
```

**From Security Review:** Returning `Result.err()` causes LDK to fail the channel close operation — safer than the current fallback which sends funds to a KeysManager-derived address the BDK wallet doesn't watch.

**From Architecture Review:** If BDK wallet initialization fails during deserialization, removing the fallback could prevent the node from starting. The error result lets LDK handle failure gracefully — but test this behavior to ensure LDK does not enter an infinite retry loop.

#### 3c. NEW: Verify BDK init order

### Research Insights (Init Order — from Institutional Learnings)

**From Learnings (bdk-ldk-force-close-destination-script-interop):** The BDK wallet must be initialized **before** LDK deserialization so that `peekAddressAtIndex` can derive destination scripts during `ChannelMonitor` restoration. Verify the current init order in `src/ldk/init.ts` ensures:

1. BDK wallet is created and ready
2. Then LDK `KeysManager` and `ChannelManagerDecodeArgs` are set up
3. Then `ChannelManager` deserialization (which triggers `get_destination_script` calls)

If the order is already correct (likely, given the existing `peekAddressAtIndex` usage), add a comment documenting this dependency.

#### 3d. Tests

- Test deterministic key ID generation produces same output for same inputs
- Test different inputs (including different `channel_value_satoshis`) produce different key IDs
- Test full 128-bit `user_channel_id` values are handled correctly
- Test that `get_destination_script` returns error (not fallback) when BDK wallet fails

**Acceptance Criteria:**

- [ ] `generate_channel_keys_id` is deterministic (same seed + params = same ID)
- [ ] All parameters included in derivation (inbound, value, user_channel_id)
- [ ] HMAC uses domain-separation key, not the seed
- [ ] `get_destination_script` returns error result on BDK failure (no fallback)
- [ ] `get_shutdown_scriptpubkey` returns error result on BDK failure (no fallback)
- [ ] BDK wallet init order verified (before LDK deserialization)
- [ ] Existing channel monitors with random key IDs still work
- [ ] All existing tests pass
- [ ] CI passes

---

### Phase 4: PR4 — Monitor Persistence Hardening

**Branch:** `fix/monitor-persistence-safety`

Fixes H6, H7, H9, M5 from the brainstorm.

#### 4a. Per-channel write queue

**File:** `src/ldk/traits/persist.ts`

### Research Insights (Write Queue Design)

**From Architecture Review — CRITICAL bug in original design:** The promise chain must swallow previous errors, or a single transient VSS failure permanently halts all subsequent writes for that channel:

```typescript
const channelWriteChains = new Map<string, Promise<void>>()

function handlePersist(outpoint: OutPoint, monitor: ChannelMonitor): void {
  const key = outpointKey(outpoint)
  const data = monitor.write()
  const updateId = monitor.get_latest_update_id()

  const prev = channelWriteChains.get(key) ?? Promise.resolve()
  const next = prev
    .catch(() => {}) // Swallow previous error so chain continues
    .then(() => persistWithRetry(key, data, ...))
  channelWriteChains.set(key, next)

  next.then(() => {
    chainMonitorRef?.channel_monitor_updated(outpoint, updateId)
  }).catch((err) => {
    console.error(`[LDK Persist] CRITICAL: monitor ${key} persist failed:`, err)
  })
}
```

**From Architecture Review:** Clean up entries on archive:

```typescript
// In archive_persisted_channel:
channelWriteChains.delete(key)
```

**From Performance Review:** The queue depth is effectively bounded at 1-2 per channel because LDK's `InProgress` return halts further updates. Memory is not a concern. The promise chain does not accumulate — V8 GCs resolved promises once their successor resolves.

#### 4b. Fix version conflict resolution

**File:** `src/ldk/traits/persist.ts` (lines 166-200)

### Research Insights (Conflict Resolution — REDESIGNED)

**From Security Review & Data Integrity Review — CRITICAL:** The original plan's "accept server version" approach is **unsafe for channel monitors**. Blindly accepting server data can cause the local node to operate with a revoked commitment state. If the server has _older_ data from a crashed device, broadcasting from that state triggers a justice transaction — total channel fund loss.

**Correct approach:** Compare monitor `update_id` values. The monitor with the higher `update_id` is more advanced and must win:

```typescript
if (!arraysEqual(serverObj.value, data)) {
  // True conflict: another device wrote different data.
  // Compare update_ids to determine which state is more advanced.
  // The higher update_id wins — it represents more channel state transitions.
  const localUpdateId = monitor.get_latest_update_id()

  // Attempt to deserialize server's monitor to get its update_id
  try {
    const serverMonitorResult = ChannelMonitor.read(
      serverObj.value, entropySource, signerProvider
    )
    if (serverMonitorResult instanceof Result_...OK) {
      const serverUpdateId = serverMonitorResult.res.get_latest_update_id()

      if (serverUpdateId > localUpdateId) {
        // Server is more advanced — accept it
        console.warn(`[LDK Persist] Conflict for ${key}: accepting server (update_id ${serverUpdateId} > ${localUpdateId})`)
        await idbPut(store, key, serverObj.value)
        versionCache.set(key, serverObj.version)
        return
      }
      // Local is same or more advanced — overwrite server
      console.warn(`[LDK Persist] Conflict for ${key}: keeping local (update_id ${localUpdateId} >= ${serverUpdateId})`)
      versionCache.set(key, serverObj.version)
      continue // Retry write with updated version
    }
  } catch {
    // Can't deserialize server monitor — keep local as safer default
    console.error(`[LDK Persist] Cannot deserialize server monitor for ${key}, keeping local`)
    versionCache.set(key, serverObj.version)
    continue
  }
}
```

**From Architecture Review:** During active operation (not recovery), a true conflict should be treated with extreme caution. If both devices are actively using the same wallet simultaneously, this is an inherently unsafe scenario that should be detected and surfaced to the user.

#### 4c. Remove conflict retry counter reset

**File:** `src/ldk/traits/persist.ts` (line 208)

Remove `conflictRetries = 0`. After `MAX_CONFLICT_RETRIES` exhausted, fall through to backoff without resetting. This prevents infinite conflict-retry loops.

**From Architecture Review:** After removing the reset, subsequent conflicts go straight to backoff (since `conflictRetries` stays at `MAX_CONFLICT_RETRIES`). This is the intended behavior — document it explicitly in a comment so future maintainers don't think it's a bug.

#### 4d. Raise manifest entry limit

**File:** `src/ldk/traits/persist.ts` (line 20)

```typescript
const MAX_MANIFEST_ENTRIES = 1_000
```

The manifest only tracks active (non-archived) monitors. With the LSP-only model, users will rarely exceed 10 active channels. 1,000 provides ample headroom.

#### 4e. Tests

- Test that concurrent writes to the same channel are serialized
- Test that error in one write does not break the chain for subsequent writes
- Test that true conflict with higher server `update_id` accepts server data
- Test that true conflict with lower server `update_id` keeps local data
- Test that conflict retries do not reset after exhaustion
- Test manifest with > 100 entries (regression for old limit)

**Acceptance Criteria:**

- [ ] Concurrent monitor writes to same channel are serialized (not interleaved)
- [ ] Error in one write does not break the promise chain
- [ ] True version conflict compares `update_id` — higher wins
- [ ] Conflict retry counter does not reset (no infinite loops)
- [ ] Manifest limit raised to 1,000
- [ ] Write chain entries cleaned up on channel archive
- [ ] All existing tests pass
- [ ] CI passes

---

### Phase 5: PR5 — Anchor Channel CPFP (Deferred)

**Branch:** `feat/anchor-channel-cpfp`

**Status:** Deferred. Anchor channels are disabled in PR1. This PR should be implemented before re-enabling anchors.

### Research Insights (CPFP Implementation)

**From LDK Docs & Best Practices:** When implementing, the wallet needs:

1. **`CoinSelectionSource` implementation:** Provide confirmed BDK UTXOs to fund CPFP child transactions.
2. **Fee reserve management:** Always maintain at least 50,000 sats of confirmed on-chain balance for CPFP. Warn users when reserve drops below threshold.
3. **RBF compliance:** Subsequent `BumpTransaction` events for the same channel must replace previous anchor transactions per BIP125.
4. **`BumpTransaction` variants:** Handle both `ChannelClose` (anchor CPFP) and `HTLCResolution` (HTLC fee bumping). Always broadcast commitment tx first, then the anchor child.
5. **Replayed after failures:** `BumpTransaction` events are regenerated after restart, so transient errors are recoverable.

**Scope when implemented:**

- Implement `Event_BumpTransaction` handler using BDK wallet UTXOs for CPFP
- Add UTXO reservation strategy (ensure wallet always has fee-bumping capacity)
- Add fee estimation for CPFP child transactions
- Re-enable anchor negotiation in `createUserConfig()`

**Dependency:** Requires LSP (Megalith) to support non-anchor channels while anchors are disabled. Coordinate before PR1.

---

### Phase 6: PR6 — VSS Recovery Improvements

**Branch:** `fix/vss-recovery-resilience`

Fixes H8 from the brainstorm.

#### 6a. Parallel chunked downloads

**File:** `src/ldk/init.ts` (recovery loop, lines 257-303)

### Research Insights (Recovery Performance)

**From Performance Review:** Chunk size 5 is conservative. With HTTP/2, browsers allow 100+ concurrent streams to the same origin. Bump to 10 for faster recovery:

```typescript
const CHUNK_SIZE = 10
const TOTAL_TIMEOUT_MS = 120_000 // 2 minutes total

for (let i = 0; i < monitorKeys.length; i += CHUNK_SIZE) {
  const chunk = monitorKeys.slice(i, i + CHUNK_SIZE)
  const results = await Promise.allSettled(chunk.map((key) => vssClient.getObject(key)))

  for (let j = 0; j < results.length; j++) {
    const result = results[j]
    if (result.status === 'rejected') {
      throw new Error(`Failed to download monitor ${chunk[j]}: ${result.reason}`)
    }
    // Validate and write to IDB...
  }

  onProgress?.(Math.min(i + CHUNK_SIZE, monitorKeys.length), monitorKeys.length)
}
```

**From Performance Review:** Consider using `Promise.all` instead of `Promise.allSettled` for fail-fast behavior — if any download fails, abort the chunk immediately rather than waiting for all to complete. Also consider batching IDB writes within each chunk using an `idbPutBatch` helper (reduces N IDB round-trips to 1 per chunk).

**From Institutional Learnings (VSS Recovery):** Version cache starts empty after restart. Conflict resolution handles sync on first write. The recovery flow should be documented as a one-time operation that populates both IDB and the version cache.

#### 6b. Total recovery timeout

Add an `AbortController` with a 2-minute total timeout. If recovery exceeds this, abort with a clear error message suggesting the user retry on a better connection.

#### 6c. Progress reporting

Add a callback parameter to the recovery function:

```typescript
onProgress?: (downloaded: number, total: number) => void
```

Surface this in the Restore page UI as a progress bar.

**Acceptance Criteria:**

- [ ] VSS recovery downloads monitors in parallel chunks of 10
- [ ] Total recovery timeout of 2 minutes with clear error message
- [ ] Recovery progress is reported to the UI
- [ ] Failed individual downloads cause full rollback (existing behavior preserved)
- [ ] All existing tests pass
- [ ] CI passes

---

## System-Wide Impact

### Interaction Graph

- PR1 changes affect `payment-input.ts` (parsing), `config.ts` (validation), `init.ts` (UserConfig), `context.tsx` (fees), `sweep.ts` (fees), `fee-estimator.ts` (defaults), **`wallet/context.tsx` (descriptors)**, **`index.html` (CSP)**
- PR2 changes affect `broadcaster.ts` (new IDB store), `event-handler.ts` (async IIFE pattern), `init.ts` (startup drain), **`storage/idb.ts` (new store + version)**
- PR3 changes affect `bdk-signer-provider.ts` (key derivation, error handling)
- PR4 changes affect `persist.ts` (write queuing, conflict resolution with `update_id` comparison)
- PR6 changes affect `init.ts` (recovery flow)

**From Architecture Review:** PR3 requires BDK initialization before LDK deserialization — init order is load-bearing.

### Error Propagation

- PR1: Config validation errors throw at startup (fast fail)
- PR2: Broadcast fires in parallel with IDB persistence (not gated). IDB failure does not prevent broadcast
- PR3: Signer errors return `Result.err()` to LDK, which fails the channel operation gracefully
- PR4: Monitor persistence errors halt channel operations via `InProgress` status. Promise chain swallows errors to prevent cascading failures

### State Lifecycle Risks

- PR2 introduces a new IDB store (`ldk_pending_broadcasts`) — must be in STORES array and cleared on wallet reset/restore
- PR4 changes conflict resolution to compare `update_id` — requires deserializing server monitor, adding latency to conflict resolution path
- **From Security Review:** Mnemonic stored as plaintext in IDB is the highest-value XSS target. Document as accepted risk with follow-up ticket for encryption at rest

### Integration Test Scenarios

1. Full mainnet payment flow: create wallet, receive via LSPS2, send via BOLT 11, verify correct network checks and correct BDK derivation path
2. Browser crash during funding: verify funding tx is in `ldk_pending_broadcasts`, broadcast on restart
3. Cross-device recovery: verify deterministic key IDs produce correct destination addresses
4. VSS recovery with 20+ monitors: verify chunked download completes within timeout
5. **New:** Monitor conflict resolution with different `update_id` values — verify higher wins

## Dependencies & Risks

| Risk                                                          | Mitigation                                                                                   |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `set_negotiate_anchors_zero_fee_htlc_tx` not in WASM bindings | Check bindings first; if missing, reject anchor channels in `OpenChannelRequest` handler     |
| Megalith LSP only supports anchor channels                    | Coordinate with LSP team before PR1; if anchors required, PR5 must be implemented first      |
| Mainnet wsProxy URL not deployed                              | Deploy Cloudflare Worker proxy before PR1; URL set via `VITE_WS_PROXY_URL`                   |
| Deterministic key IDs change signer behavior                  | Only affects new channels; existing channels use stored random IDs from ChannelMonitor       |
| Per-channel write queue memory growth during VSS outage       | Queue entries bounded by LDK's InProgress halting; max 1-2 per channel                       |
| **Hardcoded signet in BDK descriptors**                       | **CRITICAL fix in PR1 — wrong coin type on mainnet means standard wallets can't find funds** |
| **CSP blocks mainnet domains**                                | **Fix in PR1 — silent failure of all network requests on mainnet**                           |
| **Monitor conflict accepting stale state**                    | **Redesigned in PR4 — compare update_id instead of blind accept**                            |

## Accepted Residual Risks (Post All PRs)

| Risk                                | Severity | Notes                                                             |
| ----------------------------------- | -------- | ----------------------------------------------------------------- |
| Mnemonic in plaintext IDB           | HIGH     | XSS could steal funds. Follow-up: encrypt at rest with WebCrypto  |
| SpendableOutputs ~5ms crash window  | LOW      | LDK replays events if not confirmed handled; startup sweep covers |
| nodeSecretKey in memory for session | MEDIUM   | Follow-up: derive on-demand, zero after use                       |
| Single Esplora endpoint             | MEDIUM   | Follow-up: multi-endpoint broadcast for force-close reliability   |
| No Esplora response validation      | MEDIUM   | Follow-up: validate txid format, add integrity checks             |

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-03-30-mainnet-fund-safety-audit-brainstorm.md](docs/brainstorms/2026-03-30-mainnet-fund-safety-audit-brainstorm.md) — Key decisions: risk-tiered approach, anchors disabled, cross-device recovery is supported feature, keysend not needed.

### Internal References — Institutional Learnings

- `docs/solutions/integration-issues/bdk-ldk-signer-provider-fund-routing.md` — Custom SignerProvider routing close funds to BDK wallet
- `docs/solutions/logic-errors/bdk-address-reveal-not-persisted.md` — Always persist changeset after address reveal
- `docs/solutions/integration-issues/ldk-event-handler-patterns.md` — Sync/async bridging patterns for fund-critical events
- `docs/solutions/logic-errors/vss-restore-background-persist-race.md` — Shutdown before restore pattern
- `docs/solutions/design-patterns/vss-dual-write-persistence-with-version-conflict-resolution.md` — VSS-first write ordering
- `docs/solutions/integration-issues/ldk-wasm-encode-uint128-asymmetry.md` — WASM u128 encode bug (affects PR3)
- `docs/solutions/integration-issues/bdk-ldk-force-close-destination-script-interop.md` — Eager BDK init order (affects PR3)
- `docs/solutions/integration-issues/bdk-descriptor-version-bytes-network-mismatch.md` — tprv vs xprv (affects PR1)

### External References

- [LDK Fee Estimation Docs](https://lightningdevkit.org/fee_estimation/) — MinAllowed fee rate recommendations
- [LDK Key Management Docs](https://lightningdevkit.org/key_management/) — Seed derivation at m/535h
- [LDK Persist Trait API](https://docs.rs/lightning/latest/lightning/chain/chainmonitor/trait.Persist.html) — InProgress vs Completed
- [rust-lightning PR #3037](https://github.com/lightningdevkit/rust-lightning/pull/3037) — Force-close on stale feerates
- [Anchor Output Design Issue #989](https://github.com/lightningdevkit/rust-lightning/issues/989) — CPFP requirements

### Critical Files

- `src/ldk/payment-input.ts` — Network-aware parsing (PR1)
- `src/ldk/config.ts` — Config validation (PR1)
- `src/ldk/init.ts` — UserConfig, startup drains, recovery (PR1, PR2, PR6)
- `src/ldk/traits/event-handler.ts` — Fund-critical event handling (PR2)
- `src/ldk/traits/broadcaster.ts` — Transaction broadcast persistence (PR2)
- `src/ldk/traits/bdk-signer-provider.ts` — Key derivation, signer safety (PR3)
- `src/ldk/traits/persist.ts` — Monitor persistence, conflict resolution (PR4)
- `src/ldk/traits/fee-estimator.ts` — Fee rate defaults (PR1)
- `src/ldk/sweep.ts` — Fee defaults (PR1)
- `src/onchain/context.tsx` — Fee defaults, sanity checks (PR1)
- `src/wallet/context.tsx` — **BDK descriptor derivation (PR1 — CRITICAL)**
- `src/storage/idb.ts` — **IDB store declarations (PR2)**
- `index.html` — **CSP domains (PR1)**
