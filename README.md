# Zinqq

> A self-custodial Bitcoin Lightning wallet that runs entirely in your browser.

> [!WARNING]
> **Experimental software on Bitcoin mainnet.** Zinqq is under active
> development; storage layouts, channel-state formats, and external interfaces
> can change between commits. Use only amounts you can afford to lose, and back
> up your 12-word seed before funding the wallet.

---

## Why Zinqq

Zinqq is a working answer to a single question: what does a Bitcoin Lightning
wallet look like if it trusts nothing outside the device it runs on? No
custodian, no server-side signing, no native install, and no hidden on-chain
fallback.

- **Browser-only.** LDK and BDK both ship as WebAssembly; every signing
  operation happens client-side. Zinqq installs as a PWA on iOS, Android, and
  desktop, but it doesn't require installation to run.
- **Self-custodial by construction.** The BIP 39 seed never leaves the device.
  The cross-device backend (VSS) sees only ChaCha20-Poly1305-encrypted blobs
  with hashed keys; request authentication is a secp256k1 signature, not a
  password.
- **Lightning-first.** Payments always attempt Lightning. On-chain exists as an
  escape hatch — for example, the BIP 321 URI Zinqq generates on receive bundles
  an on-chain address alongside a BOLT 11 invoice — and is never a silent
  fallback.
- **Instant inbound via LSPS2.** A user's first receive doesn't need manual
  channel management: Zinqq buys a just-in-time channel from a configured LSP
  the moment inbound liquidity is needed.
- **Anchor channels with a proactive reserve.** A small on-chain balance stays
  available for CPFP fee-bumping at force-close, and a dedicated recovery flow
  walks the user through topping it up if the reserve is ever exhausted.
- **Encrypted cross-device restore.** Restore from the 12-word seed alone and
  Zinqq rebuilds channel monitors, channel manager, scorer, network graph, and
  known peers from VSS — no manual static-channel-backup juggling.
- **Unified send UX.** One input box classifies BIP 321 URIs, BOLT 11 invoices,
  BOLT 12 offers, BIP 353 human-readable names, LNURL-pay, and raw on-chain
  addresses, and routes each one to the right review screen.

## What it does

### Stable Balance

Settings → Stable Balance integrates the [Stable Channels](https://github.com/toneloc/stable-channels)
client protocol. A first Lightning receive through the default provider automatically
allocates the full provider-channel balance to dollars after the opening fee and 1%
allocation fee, with no extra BTC buffer; sub-cent rounding dust stays in the stable
backing. The receive review discloses the conversion;
no separate provider selection or USD-target setup is needed. The target appears
only after the provider signs its acceptance. Settings still supports selecting a
provider, funding a channel, and reviewing manual changes to the USD target.

To add confirmed on-chain bitcoin to the existing provider channel, tap the
dollar amount, then **Add funds to this channel**. Review the amount and maximum
mining fee before confirming. The wallet keeps a 10,000-sat on-chain reserve,
reserves the contributed inputs during negotiation, and restores pending splices
from encrypted backup. Once the new funding output locks, it preserves the
existing dollar position and requests allocation of the added balance to dollars
(1% trade fee and provider acceptance apply). Keep the wallet open and online
while funding completes. Splice-out is not exposed.

The client settles excess backing to the provider when bitcoin rises and waits
for authenticated provider payments when it falls. Home uses the acknowledged
USD target as its main balance, with that same amount converted to sats at the
latest BTC price below it. The bitcoin equivalent excludes separate on-chain
funds and becomes unavailable when prices are stale. Details of backing and
settlement are available by tapping the dollar amount. **Use current value** fills
the largest affordable USD target after the conversion fee; it still requires
review and confirmation. If backup recovery fails, the balances are unavailable
and recovery retries automatically. Keep the wallet open and online:
settlement depends on the provider's availability
and collateral. Closing the channel returns bitcoin at its current value.

The default provider is `stablechannels.com:9735`. Optional
`VITE_STABLE_PROVIDER_NODE_ID`, `VITE_STABLE_PROVIDER_HOST`, and
`VITE_STABLE_PROVIDER_PORT` settings select a different compatible provider;
restored positions retain their original counterparty. One direct provider
channel is supported. The ordinary receive LSP stays separately configured.

Deploy `api/stable-price.ts` with the frontend (Vercel discovers it automatically).
It requests six fixed USD exchange markets; the browser independently requires
three agreeing markets and rejects stale prices. Vite serves the endpoint during
development. Static hosting must supply this API separately. Pending operations
and signed receipts are persisted locally and in encrypted VSS; an uncertain
payment is never automatically retried.

Protocol reference: upstream commit `128b6bcf87f9bcc36b53717f59667043fbf81a11`.
Tests cover accounting, persistence, replay, real LDK signatures and custom-TLV
construction, plus desktop/mobile navigation. Funded live-provider acceptance
and settlement still require verification; local tests send no mainnet payments.
Programmatic callers can use `window.__stableBalance` for status, provider
selection, funding quotes/invoices, trade quotes/confirmation, and pausing settlement.

### Send & Receive

- Unified send accepts BIP 321, BOLT 11, BOLT 12, BIP 353, LNURL-pay, and
  on-chain addresses (`src/ldk/payment-input.ts`).
- Receive produces a single QR that combines an on-chain address and a BOLT 11
  invoice in a BIP 321 URI. BOLT 12 offers have their own view.
- Just-in-time inbound liquidity via LSPS2: when a requested invoice exceeds
  available inbound capacity, Zinqq negotiates a channel purchase with the LSP
  and encodes the SCID and route hint into the invoice (`src/ldk/lsps2/`).
- Camera-based QR scanning for any of the supported payment inputs.

### Channels & liquidity

- Connect, disconnect, and forget peers from the Advanced screen.
- Open channels with chosen peers and pick the funding amount.
- Close channels gracefully; force-close when the remote is unresponsive.
- Force-close recovery flow detects stuck balances and prompts for a small
  on-chain top-up so anchor-output CPFP can unstick the channel.
- Automatic on-chain anchor reserve kept aside for fee bumping
  (`src/onchain/context.tsx`).
- Spendable-output sweeping via `KeysManager.spend_spendable_outputs` whenever
  the node sees claimable outputs (`src/ldk/sweep.ts`).

### Backup & recovery

- 12-word BIP 39 mnemonic with a 60-second auto-hide reveal.
- Encrypted VSS sync of channel monitors, channel manager, network graph,
  scorer, known peers, payment history, and the BOLT 12 offer
  (`src/ldk/storage/vss-client.ts`).
- Restore from seed on a fresh device: Zinqq pulls the encrypted state from VSS,
  decrypts locally with the key derived from the mnemonic, and reconstructs the
  LDK node.

### Progressive web app

- Installable manifest with an iOS "Add to Home Screen" hint on first launch.
- Workbox service worker caches the app shell for offline launch and uses a
  NetworkFirst strategy for the LDK WASM blob.
- An update banner surfaces new service-worker releases without a hard refresh.

## How it works

Zinqq runs in three tiers: a browser-side runtime that does all signing and
state management, a small set of edge proxies that grant the browser access to
TCP peers and authenticated chain data, and the external services those
proxies reach.

```mermaid
flowchart LR
  subgraph Browser["Browser (client)"]
    UI[React UI]
    LDK[LDK Node<br/>WASM]
    BDK[BDK Wallet<br/>WASM]
    IDB[(IndexedDB)]
    UI --> LDK
    UI --> BDK
    LDK <--> BDK
    LDK --> IDB
    BDK --> IDB
  end

  subgraph Proxies["Edge proxies"]
    WSProxy["Cloudflare Worker<br/>WS &rarr; TCP"]
    ESProxy["Esplora Proxy<br/>(Vercel)"]
    VSSProxy["VSS Proxy<br/>(Vercel)"]
    LNURLProxy["LNURL CORS Shim<br/>(Vercel)"]
  end

  subgraph External["External services"]
    Peers["LN Peers<br/>+ LSPS2 LSP"]
    Esplora["Blockstream<br/>Enterprise Esplora"]
    VSS[VSS Origin]
    RGS[Rapid Gossip Sync]
  end

  LDK -->|BOLT 8 over WSS| WSProxy --> Peers
  LDK -->|chain sync| ESProxy
  BDK -->|full scan| ESProxy --> Esplora
  LDK -->|encrypted blobs| VSSProxy --> VSS
  UI -->|LNURL-pay| LNURLProxy
  LDK -->|snapshot| RGS
```

### Browser

- **UI:** React 19 + TypeScript 6.0, React Router v8, Tailwind v4, built by
  Vite 8 with `vite-plugin-wasm` and `vite-plugin-pwa`.
- **LDK node:** `lightningdevkit` 0.2.4-0 (~14 MB WASM) with custom JS trait
  implementations for the logger, fee estimator, broadcaster, persister,
  filter, event handler, signer provider, and wallet source
  (`src/ldk/traits/`). Running components include `ChainMonitor`,
  `ChannelManager`, `NetworkGraph`, `ProbabilisticScorer`, `OnionMessenger`,
  `PeerManager`, and `P2PGossipSync`.
- **BDK wallet:** `@bitcoindevkit/bdk-wallet-web` 0.3.0 (WASM) manages BIP 84
  descriptors for the on-chain escape hatch. LDK pulls UTXOs and signs through
  BDK via the shared wallet source trait.
- **Local state:** IndexedDB (`src/storage/idb.ts`) is the primary persistence
  layer; every persisted blob is mirrored to VSS in encrypted form so that a
  second device can rebuild from it.
- **Key hierarchy:** BIP 39 mnemonic → BIP 32 master → separate hardened
  derivations for the LDK seed (`m/535'/0'`), VSS encryption key
  (`m/535'/1'`), VSS signing key (`m/535'/2'`), and BDK BIP 84 descriptors
  (`m/84'/0'/0'`). See `src/wallet/keys.ts`.

### Edge proxies

- **Cloudflare Worker WS→TCP bridge** (`proxy/`) — the browser cannot open raw
  TCP sockets, so BOLT 8 peer transport goes over
  `wss://proxy.zinqq.app/<host>:<port>` to a Cloudflare Worker that proxies
  bytes to the real Lightning peer. Origin and port lists are allowlisted.
- **Esplora proxy** (`api/esplora-proxy.ts`) — Vercel serverless function that
  adds OAuth2 credentials to requests bound for Blockstream Enterprise
  Esplora. Both LDK's chain sync and BDK's full scan flow through it.
- **VSS proxy** (`api/vss-proxy.ts`) — thin pass-through to the VSS origin.
  Auth is a client-signed token; the proxy adds no trust.
- **LNURL CORS shim** (`api/lnurl-proxy.ts`) — CORS workaround so the browser
  can reach arbitrary LNURL endpoints during an LNURL-pay flow.

### External services

- **Lightning peers and the LSPS2 LSP** — peers Zinqq connects to for payment
  routing, including the configured LSP for just-in-time channel purchase.
- **Blockstream Enterprise Esplora** — chain data (blocks, transactions,
  UTXOs, fee estimates).
- **VSS origin** — encrypted cross-device state store. Zinqq never trusts it
  with plaintext.
- **Rapid Gossip Sync** — the LDK public snapshot at
  `rapidsync.lightningdevkit.org` seeds the network graph.

The Content-Security-Policy in `index.html` enumerates every external host the
app is allowed to reach; it's the tightest inventory of network dependencies
in the codebase.

## Development

Use Node.js 22.22 or newer and pnpm 12.14.0. The app and `proxy/` have separate
lockfiles; run `pnpm install --frozen-lockfile` in each directory.

The app keeps ESLint 9 and TypeScript 6.0 to satisfy the React lint plugins and
typescript-eslint peer requirements. LDK remains pinned to 0.2.4-0 and the app
uses Vitest 4.1: upgrading either causes the real-WASM handshake suite to fail
with an invalid memory offset when run as a whole. `pnpm test` runs the real-WASM
async-receive harness in its own process, since sharing a test invocation with
other native suites also causes invalid memory offsets. All assertions still run.
The test configuration keeps the top-level-await plugin; production uses native
top-level await. The proxy uses TypeScript 7 and Vitest 5.

Run `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, and
`pnpm build` for the app, and `pnpm typecheck` and `pnpm test` in `proxy/`.
Production builds require `VITE_STATIC_INVOICE_SERVER_PATHS` to be unset or empty.

## Upcoming

Features on the near-term roadmap. Not yet shipped — linked plan docs track
status.

- **BIP 353 human Bitcoin address (receive).** Zinqq already resolves BIP 353
  addresses on the send side. The upcoming receive-side feature lets users
  claim a human-readable address like `alice@zinqq.app` that resolves via a
  DNSSEC-signed TXT record to their BOLT 12 offer, so they can share a
  memorable name instead of a raw `lno1…` string. See
  [`docs/plans/2026-03-28-001-feat-bip353-receive-dns-payment-address-plan.md`](docs/plans/2026-03-28-001-feat-bip353-receive-dns-payment-address-plan.md).
- **Offline receive via LSPS5.** Today, receiving a Lightning payment requires
  Zinqq to be online either to claim a just-in-time channel (LSPS2) or to
  answer an HTLC. [LSPS5](https://github.com/BitcoinAndLightningLayerSpecs/lsp)
  defines async receive: the LSP holds the HTLC on the user's behalf while the
  wallet is offline and settles once it comes back. This closes the last gap
  in the lightning-first philosophy — every invoice eventually settles over
  Lightning, even if the wallet was closed when it was created.
