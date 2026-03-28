# Brainstorm: BIP 353 Receive (DNS Payment Instructions)

**Date:** 2026-03-28

## What We're Building

Allow zinqq users to claim a human-readable payment address like `alice@zinqq.app` that resolves via BIP 353 to their BOLT 12 offer. This lets anyone pay a zinqq user by entering their address — the sender's wallet resolves it via DNS to a `bitcoin:?lno=<offer>` URI.

### Scope

- User picks a username on the BOLT 12 offer screen in Settings
- A Vercel serverless function calls the Cloudflare DNS API to create a DNSSEC-signed TXT record at `<username>.user._bitcoin-payment.zinqq.app`
- The TXT record contains `bitcoin:?lno=<bolt12_offer>`
- The claimed address (`₿ alice@zinqq.app`) is displayed on the BOLT 12 offer screen
- Offer-only URI — no on-chain address (avoids address reuse per BIP 353 guidance)
- Online-only — payments only work when the wallet tab is open (acceptable for signet)

### Out of Scope

- LSP relay for offline receive
- On-chain address in the DNS record
- Receive page integration (address stays in Settings for now)
- Username portability or transfer
- Custom domains

## Why This Approach

1. **Builds on what exists** — The BOLT 12 offer is already generated and persisted. The send-side BIP 353 resolver already works. This closes the loop by making zinqq a BIP 353 _publisher_ too.
2. **Cloudflare DNS is natural** — Already used for DoH on the send side. Their API supports creating TXT records with DNSSEC enabled at the zone level.
3. **Self-serve registration scales** — A serverless function handling registration means no manual DNS management. Username uniqueness is enforced by the DNS API itself (can't create duplicate records).
4. **Offer-only URI is clean** — BIP 353 spec explicitly discourages static on-chain addresses without rotation. Since the wallet can't rotate addresses in DNS dynamically, omitting them is the right call.

## Key Decisions

- **Domain:** `zinqq.app` — addresses are `username@zinqq.app`
- **DNS provider:** Cloudflare API for TXT record management
- **URI format:** `bitcoin:?lno=<offer>` (offer only, no on-chain fallback)
- **Registration UX:** Self-serve in the wallet, on the existing BOLT 12 offer screen
- **Display:** Show `₿ username@zinqq.app` on the BOLT 12 offer settings screen
- **Online-only:** Accept that payments only work when the tab is open. Fine for signet.
- **DNSSEC:** Handled at the Cloudflare zone level — no per-record signing needed from our side
- **Username rules:** Strict — 3-15 chars, lowercase a-z and 0-9 only, plus a reserved word blocklist
- **Authentication:** Node-key signing — wallet signs `username|offer|timestamp` with the LDK node key. Serverless function verifies against the node pubkey. Enables updates and reclaims from the same seed.
- **Offer updates:** Supported — same node key can update the DNS record with a new offer
- **Key rotation / seed reset:** Username is lost. New seed = new identity = new username. No recovery mechanism. Simple and correct.
- **State storage:** DNS-only. No separate database or KV store. Cloudflare DNS is the sole source of truth. Ownership verified by querying the existing TXT record and extracting the node pubkey from the offer.
- **Local persistence:** Wallet persists claimed username to IndexedDB. On startup, verifies the DNS record still exists via DoH. Shows a warning if the record is gone.
- **Rate limiting:** One username per node pubkey (enforced server-side). Basic Vercel IP rate limiting (5 req/min).
- **Abuse prevention:** No CAPTCHAs or email verification needed for signet.

## Environment Architecture

### Local Development

- Serverless function runs via Vite dev server proxy
- Mock Cloudflare API using in-memory map (`DNS_BACKEND=mock` env var)
- No real DNS writes during development

### Staging (Vercel Preview)

- Real Cloudflare API with a staging DNS prefix (e.g., `username.user._bitcoin-payment.staging.zinqq.app`)
- Separate `CF_API_TOKEN_STAGING` and zone config in Vercel preview env vars
- Isolated from production DNS records

### Production

- Real Cloudflare API writing to `username.user._bitcoin-payment.zinqq.app`
- `CF_API_TOKEN` and `CF_ZONE_ID` set as Vercel production env vars
- DNSSEC enabled at the Cloudflare zone level

### Request Flow

```
┌─────────────┐     POST /api/bip353-register      ┌──────────────────┐
│  Wallet UI   │ ──────────────────────────────────> │ Vercel Serverless │
│  (Browser)   │  { username, offer, sig, pubkey }   │   Function        │
└─────────────┘                                      └────────┬─────────┘
                                                              │
                                                   ┌──────────▼─────────┐
                                                   │  Cloudflare DNS API │
                                                   │  (create/update TXT)│
                                                   └────────────────────┘
```

Same serverless function code across all environments — only env vars change.

## Error Handling UX

- **Username taken:** Inline error shown immediately ("Username unavailable")
- **Network error:** Generic "Registration failed, try again" with retry button
- **DNS propagation delay:** Success message with note: "Your address is active! DNS may take a few minutes to propagate."
- **Startup verify failure:** Warning badge if persisted username no longer resolves

## What Already Exists

- **BOLT 12 offer:** Generated, persisted to IndexedDB, displayed at `/settings/advanced/bolt12-offer`
- **Send-side BIP 353 resolver:** `src/ldk/resolve-bip353.ts` — resolves `user@domain` via DoH
- **BIP 21 parser:** `src/ldk/payment-input.ts` — already handles `lno=` parameter in BIP 21 URIs
- **Vercel serverless functions:** `api/` directory with existing proxy functions and Vercel rewrites
- **Cloudflare familiarity:** DoH resolution already uses Cloudflare's DNS-over-HTTPS endpoint

## Resolved Questions

1. **Username validation rules** — Strict: 3-15 chars, lowercase a-z and 0-9 only. Reserved word blocklist for common terms (admin, support, wallet, etc.).
2. **Authentication** — Node-key signing. The wallet signs registration requests with its LDK node private key. The serverless function verifies the signature against the node pubkey (which is embedded in the BOLT 12 offer). This ties the DNS record to the wallet's identity, enables updates if the offer changes, and allows reclaims after IndexedDB loss (same seed = same key).
3. **Offer updates** — Supported via the same signing mechanism. If the node key matches the original registrant, the serverless function updates the TXT record with the new offer.

## Open Questions

None — all questions resolved.
