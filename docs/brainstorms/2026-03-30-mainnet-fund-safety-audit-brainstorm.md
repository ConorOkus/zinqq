# Mainnet Fund Safety Audit

**Date:** 2026-03-30
**Status:** Audit findings compiled, pending fixes

## What We're Building

A comprehensive audit of Zinq's codebase before mainnet launch, focused on:

1. **Mainnet blockers** — hardcoded signet values that break mainnet functionality
2. **Fund loss risks** — code paths where bugs could cause permanent loss of user funds
3. **Degraded safety** — issues that reduce safety margins without direct fund loss

## Approach

Risk-tiered audit: every finding categorized as Critical, High, Medium, or Low based on likelihood and impact of fund loss.

---

## CRITICAL — Direct Fund Loss or Mainnet Broken

### C1. Hardcoded Signet currency check rejects all mainnet BOLT 11 invoices

- **File:** `src/ldk/payment-input.ts:97`
- **Issue:** `invoice.currency() !== Currency.LDKCurrency_Signet` is hardcoded. On mainnet, every BOLT 11 invoice is rejected.
- **Impact:** Lightning payments completely non-functional on mainnet.
- **Fix:** Check against the active network's currency from config.

### C2. On-chain address regex only matches testnet/signet prefixes

- **File:** `src/ldk/payment-input.ts:82`
- **Issue:** Regex `/^(tb1|tpub|bcrt1|[mn2])[a-zA-Z0-9]+$/` doesn't match mainnet addresses (`bc1`, `1`, `3`).
- **Impact:** On-chain sends to mainnet addresses rejected at input parsing. BDK validates downstream, but the input is never classified as "onchain" type.
- **Fix:** Make regex network-aware or remove the regex pre-filter and rely on BDK validation.

### C3. BOLT 12 offers have no network validation

- **File:** `src/ldk/payment-input.ts:123-154`
- **Issue:** Unlike BOLT 11 (which at least checks, albeit wrong network), BOLT 12 offers have zero network validation. A signet offer scanned on mainnet would be accepted.
- **Impact:** Potential cross-network payment attempt.
- **Fix:** Add network validation for BOLT 12 offers.

### C4. BIP 321 URI skips address validation entirely

- **File:** `src/ldk/payment-input.ts:204-216`
- **Issue:** `bitcoin://` URIs extract the address but never validate it against the regex or network. Passes directly to downstream.
- **Impact:** Wrong-network addresses in URIs bypass input validation. BDK catches it later, but error messaging is poor.
- **Fix:** Validate parsed address against active network before returning.

### C5. Default fee rate of 1 sat/vB on mainnet

- **File:** `src/onchain/context.tsx:28`
- **Issue:** `DEFAULT_FEE_RATE_SAT_VB = 1n`. If Esplora fee estimation fails, transactions are built at 1 sat/vB — will never confirm on mainnet.
- **Impact:** User's funds stuck in unconfirmed transaction indefinitely.
- **Fix:** Raise minimum default to at least 2-5 sat/vB on mainnet. Add a minimum fee rate floor. Better: refuse to send if fee estimation fails rather than using a default.

### C6. Empty mainnet `wsProxyUrl` in config

- **File:** `src/ldk/config.ts:42`
- **Issue:** Mainnet config has `wsProxyUrl: ''`. Without a WebSocket proxy, LDK cannot connect to peers.
- **Impact:** No peer connections = no Lightning functionality on mainnet.
- **Fix:** Configure a production WebSocket proxy URL for mainnet, or error at startup if empty.

### C7. BumpTransaction event unimplemented (anchor channels)

- **File:** `src/ldk/traits/event-handler.ts:379-383`
- **Issue:** `Event_BumpTransaction` logs a warning but takes no action. Anchor channels require CPFP fee bumping.
- **Impact:** During high-fee periods, commitment transactions can't be fee-bumped. Counterparty can claim funds while your tx is stuck.
- **Fix:** Implement CPFP using BDK UTXOs, or disable anchor channels until implemented.

---

## HIGH — Fund Loss Under Specific Conditions

### H1. Broadcaster silently drops failed transactions

- **File:** `src/ldk/traits/broadcaster.ts:58-65`
- **Issue:** `broadcast_transactions()` uses `void` + `.catch(console.error)`. If all 5 retries fail, the tx is silently lost. LDK thinks it was broadcast.
- **Impact:** Force-close transactions could fail to reach the mempool. User's channel funds locked or lost.
- **Fix:** Track broadcast failures and surface them. Consider retry queue with persistence.

### H2. Random channel keys ID breaks cross-device recovery

- **File:** `src/ldk/traits/bdk-signer-provider.ts:36-44`
- **Issue:** `generate_channel_keys_id()` uses `crypto.getRandomValues()` instead of deterministic derivation. On recovery from seed, channel keys IDs won't match.
- **Impact:** Cross-device recovery cannot reconstruct channel signing keys.
- **Fix:** Use deterministic derivation from seed + channel parameters.

### H3. SpendableOutputs persistence race condition

- **File:** `src/ldk/traits/event-handler.ts:265-297`
- **Issue:** IDB write is async (`void idbPut(...)`) but event handler returns synchronously. Browser crash before IDB commit = outputs lost permanently.
- **Impact:** Spendable outputs from force-closes lost if crash occurs in the ~10ms window.
- **Fix:** Consider synchronous-like persistence or at minimum ensure sweep startup recovery covers this case.

### H4. Signer provider fallback sends close funds to wrong address

- **File:** `src/ldk/traits/bdk-signer-provider.ts:55-89`
- **Issue:** If BDK wallet derivation fails, `get_destination_script()` and `get_shutdown_scriptpubkey()` fall back to KeysManager defaults. Close funds go to a different address.
- **Impact:** Channel close funds sent to an address the user may not control in their BDK wallet.
- **Fix:** Fail loudly instead of falling back. Never silently redirect funds.

### H5. Funding tx persistence failure causes channel funding loss

- **File:** `src/ldk/traits/event-handler.ts:341-347`
- **Issue:** Funding tx IDB write failure is caught but only logged. When `FundingTxBroadcastSafe` fires, no tx is found to broadcast.
- **Impact:** Channel funding transaction never broadcast. Funds locked in unbroadcast tx.
- **Fix:** Block channel progress if funding tx persistence fails.

### H6. Concurrent monitor persistence race condition

- **File:** `src/ldk/traits/persist.ts:224-262`
- **Issue:** Multiple `persistWithRetry` calls fire in parallel without coordination. Rapid updates to the same monitor can cause version cache desync.
- **Impact:** Channel monitor data corruption, potentially unresolvable channel state.
- **Fix:** Queue monitor updates per channel key.

### H7. Version conflict resolution can trap channel state

- **File:** `src/ldk/traits/persist.ts:166-200`
- **Issue:** On true version conflict (different data on server), code logs CRITICAL but retries anyway. IDB and VSS can end up inconsistent.
- **Impact:** Channel stuck in unresolvable state between devices.
- **Fix:** On true conflict, halt and surface error to user rather than silently retrying.

### H8. VSS recovery timeout can block initialization permanently

- **File:** `src/ldk/init.ts:252-316`
- **Issue:** Each monitor download has a 15s timeout. Many monitors = very long recovery. Browser may kill the tab.
- **Impact:** Wallet becomes inaccessible if VSS recovery takes too long.
- **Fix:** Add progress indicators, chunked downloads, and overall timeout with graceful degradation.

### H9. Monitor manifest 100-entry limit

- **File:** `src/ldk/traits/persist.ts:20`
- **Issue:** `MAX_MANIFEST_ENTRIES = 100`. Power users with >100 lifetime channels hit this limit and can't recover.
- **Impact:** Wallet inaccessible after exceeding manifest limit.
- **Fix:** Increase limit significantly or make dynamic. Archive closed channel entries.

### H10. Fee sanity check doesn't catch LOW fees

- **File:** `src/onchain/context.tsx:177-182`
- **Issue:** `MAX_FEE_SATS = 50_000n` prevents overpayment but there's no minimum fee check. Transactions at 1 sat/vB pass through.
- **Impact:** Stuck transactions on mainnet.
- **Fix:** Add minimum fee rate validation (e.g., reject < 2 sat/vB on mainnet).

---

## MEDIUM — Degraded Safety / Operational Issues

### M1. Keysend payments rejected (no preimage handling)

- **File:** `src/ldk/traits/event-handler.ts:142-163`
- **Issue:** `PaymentClaimable` without preimage (keysend) is logged but `claim_funds()` never called.
- **Impact:** Inbound keysend payments time out. Sender loses nothing but receiver misses payment.

### M2. Payment persistence is fire-and-forget

- **File:** `src/ldk/traits/event-handler.ts:165-203`
- **Issue:** `persistPayment()` and `updatePaymentStatus()` are async with no error handling. DB failure = lost payment history.
- **Impact:** Payment records disappear on DB errors. No fund loss but broken UX.

### M3. Wallet changeset persistence race after funding

- **File:** `src/ldk/traits/event-handler.ts:358-364`
- **Issue:** `take_staged()` consumes wallet state, async persist can fail. Crash = wallet doesn't know it spent the UTXO.
- **Impact:** Balance inconsistency, potential double-spend attempt on restart.

### M4. Sweep concurrency guard is not atomic

- **File:** `src/ldk/sweep.ts:50,69-70`
- **Issue:** `sweepInProgress` boolean checked and set non-atomically. Multi-tab lock exists at init but sweep itself isn't locked.
- **Impact:** Concurrent sweeps could broadcast conflicting transactions.

### M5. Conflict retry counter resets, causing infinite loops

- **File:** `src/ldk/traits/persist.ts:208`
- **Issue:** `conflictRetries = 0` reset after exhausting 5 retries allows infinite conflict-retry cycles.
- **Impact:** Operational: infinite retry loop if VSS always conflicts. LDK halts channel ops safely.

### M6. ConnectionNeeded event unimplemented

- **File:** `src/ldk/traits/event-handler.ts:299-307`
- **Issue:** Peer reconnection request is logged but ignored.
- **Impact:** Channels to disconnected peers remain stalled until manual reconnect.

### M7. OpenChannelRequest rejection by timeout instead of explicit reject

- **File:** `src/ldk/traits/event-handler.ts:406-434`
- **Issue:** Non-LSP channel requests are silently ignored rather than explicitly rejected.
- **Impact:** Spam potential, slow timeout for requesting peer.

### M8. No max supply validation in amount parser

- **File:** `src/ldk/payment-input.ts:220-228`
- **Issue:** `btcStringToSats()` accepts amounts exceeding 21M BTC without error.
- **Impact:** Invalid amounts passed downstream. BDK/LDK likely catch, but defense-in-depth missing.

### M9. Broadcaster doesn't validate Esplora response

- **File:** `src/ldk/traits/broadcaster.ts:23`
- **Issue:** `res.text()` assumed to be valid txid. No hex format validation.
- **Impact:** Compromised Esplora could return fake txid.

### M10. No validation that mainnet MUST have valid LSP config

- **File:** `src/ldk/init.ts:183-192`
- **Issue:** LSP validation is skipped if `lspNodeId` is empty/undefined. No mainnet-specific requirement.
- **Impact:** App starts on mainnet without LSP, JIT channels don't work, no clear error.

---

## Key Decisions

1. **Approach:** Risk-tiered audit with prioritized fix PRs for Critical/High items
2. **Output:** This document + fix PRs targeting Critical items first, then High
3. **Scope:** Full codebase — mainnet readiness AND general fund safety

## Fix Priority Order

1. **PR 1 — Mainnet blockers:** C1, C2, C3, C4, C5, C6, H10 (payment-input.ts network fixes + fee defaults + wsProxy config)
2. **PR 2 — Broadcaster & persistence safety:** H1, H5, H3, M2, M3 (ensure txs reach mempool, persist critical data)
3. **PR 3 — Channel recovery:** H2, H4 (deterministic key IDs, remove signer fallback)
4. **PR 4 — Monitor persistence:** H6, H7, H9, M5 (queue writes, fix conflict resolution, raise limits)
5. **PR 5 — Anchor channels:** C7 (implement BumpTransaction or disable anchors)
6. **PR 6 — VSS recovery:** H8 (timeout handling, progress, chunked downloads)

## Resolved Questions

1. **Anchor channels:** Yes, enabled by default — `createUserConfig()` (init.ts:105-118) doesn't disable them. C7 is a **mainnet blocker**.
2. **WebSocket proxy:** Cloudflare Worker exists in `proxy/` but not deployed for mainnet. Config has empty string. Needs deployment + URL in config.
3. **Cross-device recovery:** Yes, supported feature. H2 (deterministic channel key IDs) is **high priority**.
4. **Keysend support:** Not needed. M1 is by-design — can close as won't-fix.
