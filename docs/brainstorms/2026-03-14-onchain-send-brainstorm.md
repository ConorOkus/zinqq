# Brainstorm: Onchain Send

**Date:** 2026-03-14
**Status:** Draft

## What We're Building

A send page that lets users send bitcoin onchain from their BDK wallet. The flow is:

1. **Input step:** User enters a destination address (or pastes a BIP21 URI to auto-fill address and amount), enters an amount in sats, and optionally toggles "send max" to drain the wallet.
2. **Review step:** Displays recipient address, amount, estimated fee (fetched from Esplora), and total. User confirms or goes back to edit.
3. **Broadcast:** Transaction is built, signed, and broadcast. User sees success with the txid (linked to a block explorer) or an error message.

## Why This Approach

**Extend OnchainContext** rather than putting BDK logic directly in the page component:

- Consistent with existing patterns — `generateAddress` is already exposed through context for the Receive page
- Keeps the Send page as a thin UI layer focused on form state and navigation
- Centralizes all BDK/Esplora interactions in the `onchain/` module
- Easier to test — context helpers can be mocked in page tests

## Key Decisions

1. **Two-step flow (input → review → broadcast):** Prevents accidental sends by showing fee and total before committing.
2. **BIP21 URI support on paste:** If user pastes `bitcoin:addr?amount=0.001`, auto-fill address and amount fields. No QR scanner for now.
3. **Send max support:** A toggle/button that uses BDK's `drain_wallet()` / `drain_to()` to sweep the entire balance.
4. **Fetched fee estimates:** Use `EsploraClient.get_fee_estimates()` with a sensible default target (e.g. 6 blocks). Display the fee on the review screen. No manual fee rate selection for now.
5. **Context extensions needed:**
   - Expose `broadcastTx(address: string, amountSats: bigint): Promise<string>` (returns txid)
   - Expose `sendMax(address: string): Promise<string>` (returns txid)
   - Expose `estimateFee(address: string, amountSats: bigint): Promise<{ fee: bigint, feeRate: bigint }>` or similar
   - Expose `EsploraClient` or fee estimation through context
   - Persist changeset after signing (call `wallet.take_staged()` + `putChangeset()`)

## Resolved Questions

1. **Address validation:** Use BDK's `Address.from_string(addr, network)` which validates format and network. No extra client-side checks needed.
2. **Post-send UX:** Show a success screen with the txid linked to the mutinynet block explorer. User navigates home from there.
3. **Error handling:** Distinguish between invalid address, insufficient funds, and broadcast failure with specific error messages.
