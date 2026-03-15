---
title: BDK-WASM Onchain Wallet Integration with LDK — Key Patterns
category: integration-issues
date: 2026-03-12
tags: [bdk, wasm, ldk, react, indexeddb, bip39, key-derivation, event-handler]
modules: [onchain, wallet, ldk]
---

# BDK-WASM Onchain Wallet Integration with LDK

## Problem

Integrating `@bitcoindevkit/bdk-wallet-web` (BDK compiled to WASM) alongside an existing LDK-WASM Lightning node in a React browser wallet. Both subsystems need to derive keys from a shared BIP39 mnemonic, share IndexedDB storage, and coordinate through LDK's synchronous event handler.

## Key Patterns and Gotchas

### 1. React Context Dependencies Cause Infinite Re-renders

**Problem:** Including the entire LDK context object (`useLdk()`) in a `useEffect` dependency array causes the BDK init effect to re-run on every LDK state change — tearing down the sync loop and reinitializing BDK repeatedly.

**Root cause:** React context values create new object references on every provider state update. Any `useEffect` depending on the full context object re-fires.

**Fix:** Extract the specific function you need into a `useRef`, updated via a separate effect:

```typescript
const ldk = useLdk()
const setBdkWalletRef = useRef<((w: Wallet | null) => void) | null>(null)
useEffect(() => {
  setBdkWalletRef.current = ldk.status === 'ready' ? ldk.setBdkWallet : null
  // Also register wallet if BDK initialized before LDK became ready
  if (walletRef.current && setBdkWalletRef.current) {
    setBdkWalletRef.current(walletRef.current)
  }
}, [ldk])

// Main init effect — stable deps, no ldk object
useEffect(() => {
  // ...use setBdkWalletRef.current?.() instead of ldk.setBdkWallet()
}, [bdkDescriptors, generateAddress])  // no `ldk` here
```

### 2. Seed Consistency Check Prevents Silent Corruption

**Problem:** If the IDB seed was tampered with or the v2→v3 migration failed, LDK silently uses the wrong seed — Lightning funds become unrecoverable from the mnemonic.

**Fix:** Compare stored seed against mnemonic derivation on every startup:

```typescript
let seed = await getSeed()
if (!seed) {
  await storeDerivedSeed(ldkSeed)
  seed = ldkSeed
} else if (seed.length !== ldkSeed.length || !seed.every((b, i) => b === ldkSeed[i])) {
  throw new Error('Stored seed does not match mnemonic derivation — possible corruption')
}
```

### 3. Mnemonic Input Normalization

**Problem:** Users pasting mnemonics may include extra whitespace, mixed case, or double spaces. Without normalization, valid mnemonics fail validation or — worse — get stored with different whitespace than expected, causing derivation inconsistency.

**Fix:** Always normalize before validation and storage:

```typescript
const mnemonic = raw.trim().toLowerCase().replace(/\s+/g, ' ')
```

### 4. BDK-WASM Transaction Type Has No `to_bytes()` Export

**Problem:** BDK-WASM's `Transaction` class doesn't expose raw byte serialization. LDK's `funding_transaction_generated()` requires raw tx bytes (`Uint8Array`). The two WASM modules don't share types.

**Status:** Unresolved. The funding handler builds and signs the PSBT but cannot pass the finalized tx to LDK. Options being explored:
1. BDK-WASM exposing `Transaction.to_bytes()` (upstream feature request)
2. Parsing the PSBT base64 to extract the finalized tx in JS
3. Shared serialization format

### 5. BDK ChangeSet Persistence — `take_staged()` Is Destructive

**Problem:** `wallet.take_staged()` returns and clears the staged changes. If the subsequent IDB write fails, those changes are lost permanently.

**Mitigation:** Same approach as LDK's `get_and_clear_needs_persistence()` — accept the risk, log at CRITICAL level, and rely on full rescan to recover. The risk window is small (IDB writes are typically <10ms).

```typescript
const staged = wallet.take_staged()
if (staged && !staged.is_empty()) {
  try {
    await putChangeset(staged.to_json())
  } catch (err) {
    console.error('[BDK] CRITICAL: failed to persist ChangeSet:', err)
  }
}
```

### 6. BIP84 Descriptor Construction from @scure/bip32

**Pattern:** `@scure/bip32`'s `HDKey.fromMasterSeed()` defaults to mainnet version bytes (`xprv`/`xpub`). **BDK validates that descriptor key version bytes match the target network** — signet/testnet require `tprv`/`tpub`. Pass testnet version bytes explicitly for non-mainnet networks. See [BDK Descriptor Version Bytes Fix](bdk-descriptor-version-bytes-network-mismatch.md) for full details.

```typescript
const TESTNET_VERSIONS = { private: 0x04358394, public: 0x043587cf }
const versions = network === 'bitcoin' ? undefined : TESTNET_VERSIONS
const master = HDKey.fromMasterSeed(seed, versions)
const fingerprint = master.fingerprint.toString(16).padStart(8, '0')
const account = master.derive(`m/84'/${coinType}'/0'`)
const xprv = account.privateExtendedKey  // tprv for signet, xprv for mainnet
const descriptor = `wpkh([${fingerprint}/84'/${coinType}'/0']${xprv}/0/*)`
```

### 7. Provider Nesting Order Matters

The React component tree encodes initialization dependencies:

```
WalletProvider       → owns mnemonic lifecycle
  WalletGate         → gates on mnemonic ready, renders create/import UI
    LdkProvider      → receives derived seed as prop
      OnchainProvider → receives descriptors as prop, registers with LDK
        Router
```

If BDK fails, Lightning still works. If LDK fails, onchain still works. Only mnemonic failure blocks everything — which is correct.

## Prevention

- **Never depend on full context objects in useEffect** — extract the specific value/function you need into a ref
- **Always validate stored key material against its derivation source** on startup
- **Normalize all user text input** before cryptographic operations
- **Test key derivation against known BIP84 test vectors** (the "abandon" mnemonic has published results)
- **Use the three-file React context pattern** (`*-context.ts`, `context.tsx`, `use-*.ts`) per existing `docs/solutions/integration-issues/ldk-wasm-foundation-layer-patterns.md`

## Related

- `docs/solutions/integration-issues/ldk-wasm-foundation-layer-patterns.md` — LDK WASM patterns (Persist sync/async bridge, React context split, seed overwrite guards)
- `docs/solutions/integration-issues/ldk-event-handler-patterns.md` — Event handler patterns (sync/async bridging, fund safety)
- PR #7: feat: Add onchain wallet with BDK-WASM and unified BIP39 mnemonic
