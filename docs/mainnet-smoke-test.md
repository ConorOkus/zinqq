# Mainnet Smoke Test Checklist

Execute with real mainnet funds (small amounts). All tests should pass before public release.

## Prerequisites

- [ ] WS proxy deployed to `proxy.zinqq.app` and responding
- [ ] Mainnet Vercel project deployed with `VITE_NETWORK=mainnet`
- [ ] VSS instance running and `VSS_ORIGIN` configured
- [ ] LSP node online and funded at `64.23.159.177:9735`
- [ ] App loads at `zinqq.app` without console errors

## Lightning

- [ ] **Receive via JIT channel**: Send a small Lightning payment to the app's BOLT 11 invoice. JIT channel opens via LSP, payment received.
- [ ] **Send BOLT 11**: Pay an external BOLT 11 invoice. Payment succeeds, fee recorded.
- [ ] **Send BOLT 12**: Pay an external BOLT 12 offer (if available). Verify chain validation rejects signet offers.
- [ ] **Peer reconnection**: Disconnect from LSP (close tab, wait 30s, reopen). Verify automatic reconnection and channel becomes usable.

## On-chain

- [ ] **Receive on-chain**: Send sats to the app's on-chain address. Balance updates after confirmation.
- [ ] **Send on-chain**: Send sats to an external address. Transaction broadcasts and confirms.
- [ ] **Send max with channels**: Verify "send max" leaves 10,000 sat anchor reserve when channels exist.
- [ ] **Send max without channels**: Verify "send max" drains entire balance when no channels exist.

## Channel lifecycle

- [ ] **Cooperative close**: Close a channel cooperatively. Funds appear in on-chain balance.
- [ ] **Force close**: Force-close a channel. Commitment tx broadcasts. Verify CPFP fires if fee is low.

## Recovery

- [ ] **Seed restore**: Create a new wallet in a different browser using the same seed phrase. Verify channels and on-chain balance are recovered from VSS.

## Network safety

- [ ] **Cross-network rejection**: Paste a signet BOLT 11 invoice — should show "different Bitcoin network" error.
- [ ] **Cross-network BOLT 12**: Paste a signet BOLT 12 offer — should show "different Bitcoin network" error.
- [ ] **Cross-network address**: Paste a signet address (tb1...) — should show "Unrecognized payment format".

## Resilience

- [ ] **Esplora failover**: Block `mempool.space` in browser devtools network tab. Verify broadcast still works via `blockstream.info` fallback.
- [ ] **BIP 353 resolution**: Send to a `user@domain` address. DNS resolution works on mainnet.

## Result

Date tested: \_\_\_\_\_\_\_\_\_\_\_
Tested by: \_\_\_\_\_\_\_\_\_\_\_
All passing: [ ] Yes / [ ] No
Notes: \_\_\_\_\_\_\_\_\_\_\_
