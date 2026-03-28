---
title: 'feat: BIP 353 Receive — DNS Payment Address Registration'
type: feat
status: active
date: 2026-03-28
origin: docs/brainstorms/2026-03-28-bip353-receive-brainstorm.md
---

# feat: BIP 353 Receive — DNS Payment Address Registration

## Overview

Allow zinqq users to claim a human-readable payment address like `alice@zinqq.app` that resolves via BIP 353 to their BOLT 12 offer. A Vercel serverless function calls the Cloudflare DNS API to create DNSSEC-signed TXT records. Users register on the existing BOLT 12 offer settings screen, and the wallet verifies the record on startup.

## Problem Statement / Motivation

Zinqq already resolves BIP 353 addresses on the send side and creates BOLT 12 offers — but users have no way to _publish_ their offer under a human-readable name. Sharing a raw `lno1...` string is impractical. BIP 353 closes this loop: `alice@zinqq.app` is memorable, universally resolvable, and spec-compliant.

## Proposed Solution

Self-serve username registration from the BOLT 12 offer screen. The wallet signs the request with the node key, a Vercel serverless function verifies and writes a Cloudflare DNS TXT record. DNS is the sole source of truth — no database.

(See brainstorm: `docs/brainstorms/2026-03-28-bip353-receive-brainstorm.md` for full decision rationale.)

## Technical Approach

### Architecture

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

### Signing Approach

LDK's `NodeSigner` does not expose a generic `sign(bytes)` method — `sign_gossip_message` only accepts structured `UnsignedGossipMessage` variants. Instead:

1. **Browser**: Use `keysManager.get_node_secret_key()` to get the raw 32-byte node secret, then sign with `@noble/curves/secp256k1`:

   ```typescript
   import { secp256k1 } from '@noble/curves/secp256k1'
   import { sha256 } from '@noble/hashes/sha256'

   const msg = `zinqq:register:v1|${username}|${offer}|${timestamp}`
   const msgHash = sha256(new TextEncoder().encode(msg))
   const sig = secp256k1.sign(msgHash, nodeSecretKey)
   ```

2. **Server**: Verify with the same library (pure JS, no native deps, already a transitive dep via `@scure/bip32`):
   ```typescript
   secp256k1.verify(signature, sha256(message), nodePubkey)
   ```

The `zinqq:register:v1` domain prefix prevents cross-protocol signature reuse.

### DNS Record Format

TXT record at `<username>.user._bitcoin-payment.zinqq.app`:

```
bitcoin:?lno=<bolt12_offer>
```

- Offer-only URI, no on-chain address (see brainstorm: avoids address reuse per BIP 353 guidance)
- Cloudflare automatically splits content >255 bytes into multiple character-strings on the wire
- The existing `resolve-bip353.ts` already handles multi-segment TXT concatenation (line 58)
- TTL: `1` (Cloudflare auto, typically 300s) — reasonable for signet

### Implementation Phases

#### Phase 1: Serverless Registration Endpoint

**Deliverables:** `api/bip353-register.ts` — a single Vercel serverless function handling registration and updates.

**File: `api/bip353-register.ts`**

Exports `POST(request: Request)` following the existing pattern from `api/vss-proxy.ts` and `api/lnurl-proxy.ts`.

Request body:

```json
{
  "username": "alice",
  "offer": "lno1qgsq...",
  "timestamp": 1711612800,
  "signature": "3045...",
  "nodePubkey": "02abc..."
}
```

Server-side logic:

1. **Validate input** — username matches `^[a-z0-9]{3,15}$`, not on reserved word blocklist, offer is non-empty
2. **Validate timestamp** — within 5-minute window of server time
3. **Verify signature** — `secp256k1.verify(sig, sha256("zinqq:register:v1|username|offer|timestamp"), nodePubkey)`
4. **Verify pubkey matches offer** — the BOLT 12 offer encodes the node_id. Extract and compare to `nodePubkey` (see "Server-side offer parsing" below)
5. **Check DNS** — `GET /zones/{zone_id}/dns_records?type=TXT&name.exact=<username>.user._bitcoin-payment.zinqq.app`
6. **If record exists** — extract offer from existing TXT, parse node_id, verify it matches `nodePubkey`. If match: update (PUT). If mismatch: return 409 "Username unavailable"
7. **If record does not exist** — create (POST) the TXT record
8. **Return** — `{ ok: true, address: "alice@zinqq.app" }` on success

Error responses (following existing `{ error: string }` pattern):

- `400` — invalid input (bad username, expired timestamp, invalid signature)
- `409` — username taken by a different node
- `502` — Cloudflare API error

**Server-side offer parsing:** BOLT 12 offers are bech32m-encoded. The node_id is embedded in the TLV payload. Rather than implementing a full BOLT 12 parser, include the `nodePubkey` in both the API request and the DNS record content. Store as: `bitcoin:?lno=<offer>&node=<pubkey_hex>`. The `&node=` parameter is non-standard but harmless — BIP 21 parsers ignore unknown parameters, and the send-side resolver only extracts `lno=`. This makes ownership verification a simple string comparison against the existing TXT record.

**Reserved word blocklist:**

```typescript
const RESERVED = new Set([
  'admin',
  'administrator',
  'support',
  'help',
  'info',
  'zinqq',
  'wallet',
  'bitcoin',
  'lightning',
  'root',
  'system',
  'api',
  'www',
  'mail',
  'test',
  'null',
  'undefined',
])
```

**Environment variables:**

- `CF_API_TOKEN` — Cloudflare API token with `Zone:DNS:Edit` permission, scoped to zinqq.app zone only
- `CF_ZONE_ID` — Cloudflare zone ID for zinqq.app
- `BIP353_DNS_PREFIX` — optional prefix for staging (e.g., `staging.`) defaults to empty string

**Vercel config update** (`vercel.json`):

- No rewrite needed — flat path `/api/bip353-register` is handled automatically by Vercel's default routing

**Success criteria:**

- [ ] POST creates a TXT record at the correct DNS name with correct content
- [ ] Duplicate username returns 409
- [ ] Invalid signature returns 400
- [ ] Expired timestamp returns 400
- [ ] Same pubkey can update the record
- [ ] Reserved words are rejected

#### Phase 2: Client-Side Signing and Registration

**Deliverables:** Registration module and API client.

**File: `src/ldk/bip353-register.ts`**

Functions:

- `signRegistration(keysManager, username, offer, timestamp)` — builds the message string, hashes with SHA-256, signs with the node secret key via `secp256k1.sign()`, returns `{ signature, nodePubkey }` as hex strings
- `registerBip353(username, offer, keysManager)` — calls `signRegistration`, POSTs to `/api/bip353-register`, returns the result
- `USERNAME_REGEX = /^[a-z0-9]{3,15}$/`
- `validateUsername(username)` — checks regex and reserved words (shared blocklist with server for instant client-side feedback)

**Dependencies to add (explicit, already transitive):**

- `@noble/curves` — secp256k1 signing/verification
- `@noble/hashes` — SHA-256

**File: `src/ldk/bip353-register.test.ts`**

Tests:

- Signing produces a valid signature verifiable with the node pubkey
- Registration API call with valid payload succeeds (mock fetch)
- Invalid username rejected client-side
- Reserved words rejected client-side
- Timestamp is current (within tolerance)

**Success criteria:**

- [ ] `signRegistration` produces valid secp256k1 ECDSA signatures
- [ ] `registerBip353` sends correctly formatted POST request
- [ ] `validateUsername` rejects invalid/reserved usernames
- [ ] All unit tests pass

#### Phase 3: IndexedDB Persistence

**Deliverables:** Username storage wrapper and IDB schema update.

**File: `src/ldk/storage/username.ts`**

Following the pattern from `src/ldk/storage/offer.ts`:

```typescript
const STORE = 'ldk_bip353_username' as const
const KEY = 'default'

export function getPersistedUsername(): Promise<string | null>
export function putPersistedUsername(username: string): Promise<void>
export function deletePersistedUsername(): Promise<void>
```

**File: `src/storage/idb.ts`**

- Add `'ldk_bip353_username'` to the `STORES` array
- Bump `DB_VERSION` from 8 to 9
- Add migration comment for version 9

**Success criteria:**

- [ ] Username persists across page reloads
- [ ] `getPersistedUsername` returns `null` when no username is stored
- [ ] IDB version upgrade from 8 to 9 works cleanly

#### Phase 4: LDK Context Integration

**Deliverables:** Expose `bip353Username` in the LDK context with startup verification.

**File: `src/ldk/ldk-context.ts`**

Add to the `'ready'` variant:

```typescript
bip353Username: string | null
```

**File: `src/ldk/context.tsx`**

Add `loadAndVerifyUsername()` function (called after `loadOrCreateOffer()` completes):

1. Read persisted username from IndexedDB via `getPersistedUsername()`
2. If null, set `bip353Username: null` and return
3. Check if a registration timestamp was persisted less than 5 minutes ago — if so, skip verification (DNS propagation grace period)
4. Resolve via `resolveBip353(username, 'zinqq.app')` using the existing DoH resolver
5. If resolution succeeds — set `bip353Username: username`
6. If resolution fails due to network error — set `bip353Username: username` with a `bip353VerifyFailed: true` flag (optimistic, don't scare the user)
7. If resolution returns NXDOMAIN (record definitively gone) — set `bip353Username: username` with `bip353VerifyFailed: true`

Also persist the registration timestamp alongside the username (add to the same IDB store or a separate key).

**Success criteria:**

- [ ] `bip353Username` is available from `useLdk()` when status is `'ready'`
- [ ] Startup verification runs after offer is loaded
- [ ] Propagation grace period prevents false warnings
- [ ] Network errors don't produce false "record gone" warnings

#### Phase 5: UI — Registration and Display

**Deliverables:** Username registration UI on the BOLT 12 offer screen.

**File: `src/pages/Bolt12Offer.tsx`**

Two states:

**State A: No username claimed**

- Below the offer QR code, show a text input with placeholder "Choose a username"
- Input auto-lowercases on change
- Inline validation: show error if username is invalid or reserved
- "Claim" button (disabled while submitting)
- On submit: call `registerBip353()`, persist username, update context
- Success: transition to State B
- Error "Username unavailable": show inline error
- Error network: show "Registration failed, try again" with retry

**State B: Username claimed**

- Display `₿ username@zinqq.app` prominently below the offer QR
- Copy button copies `₿username@zinqq.app` (with symbol prefix, per BIP 353 spec)
- If `bip353VerifyFailed` is true, show a subtle warning: "Could not verify your address — it may take a few minutes for DNS to propagate, or the record may have been removed."
- Note at bottom: "Payments to this address only work while this tab is open."

**File: `src/pages/Bolt12Offer.test.tsx`**

Tests:

- Renders username input when no username is claimed
- Shows claimed address when username exists in context
- Input validation rejects invalid usernames
- Successful registration displays the address
- Error states render correctly
- Verification failure shows warning

**Success criteria:**

- [ ] Registration flow works end-to-end
- [ ] Display follows BIP 353 spec (symbol prefix on copy)
- [ ] Error states are handled gracefully
- [ ] Loading/disabled states prevent double submission
- [ ] Online-only limitation is communicated to the user

#### Phase 6: Local Development Support

**Deliverables:** Mock DNS backend for local development.

**File: `api/bip353-register.ts`** (modification)

When `process.env.DNS_BACKEND === 'mock'`:

- Skip Cloudflare API calls
- Use an in-memory `Map<string, string>` for record storage (resets on function cold start, which is fine for dev)
- Log the would-be DNS record to console

**File: `vite.config.ts`** (modification)

Add proxy rule for the registration endpoint in local dev:

```typescript
'/api/bip353-register': {
  target: 'http://localhost:3000', // or Vite's own server
}
```

Note: Vite handles `/api/*` routes via Vercel's dev adapter or a local middleware. Verify the existing pattern — the LNURL proxy uses a custom Vite plugin (`lnurlCorsProxy`), while the VSS proxy uses Vite's built-in `server.proxy`. Choose whichever fits best.

**Success criteria:**

- [ ] Registration works locally without hitting real Cloudflare DNS
- [ ] Startup verification can be tested locally

## System-Wide Impact

### Interaction Graph

Registration request → Vercel serverless function → Cloudflare DNS API (TXT record creation). On startup: LDK context init → `loadOrCreateOffer()` → `loadAndVerifyUsername()` → DoH query to Cloudflare. No callbacks, middleware, or observers involved beyond React state updates.

### Error Propagation

- Cloudflare API errors (rate limit, auth failure, network) surface as 502 from the serverless function → displayed as "Registration failed" in UI
- DoH verification failures on startup → optimistic display with warning badge, no hard failure
- Signature verification failure on server → 400, displayed as "Registration failed" (should not happen in normal use)

### State Lifecycle Risks

**Partial failure scenario:** Registration POST succeeds at Cloudflare but the response never reaches the browser (network drop). The DNS record exists but the username is not persisted locally. On next visit, the user sees the "Claim username" input. If they enter the same username, the server detects they own it (same pubkey) and returns success. If they enter a different username, the old one is orphaned.

**Mitigation:** The upsert behavior of the serverless function (same pubkey = update) handles the "retry same username" case cleanly. Orphaned records are an accepted limitation for signet (see brainstorm: no expiry mechanism).

### API Surface Parity

No other interfaces expose BIP 353 registration. The serverless function is the sole entry point. The send-side resolver (`resolve-bip353.ts`) is read-only and unaffected.

### Integration Test Scenarios

1. **End-to-end registration:** Claim username → verify DNS record exists via DoH → send payment to `username@zinqq.app` from another wallet
2. **Offer update after reclaim:** Clear IndexedDB → restore from seed → re-register same username → verify DNS record updated with new offer
3. **Concurrent registration race:** Two requests for the same username at the same time → exactly one succeeds, the other gets 409
4. **Startup verification with DNS delay:** Register → immediately reload → verify no false warning during propagation grace period
5. **Cross-wallet send:** Register on zinqq → resolve from a different BIP 353-compatible wallet → verify the offer is parseable and payable

## Acceptance Criteria

### Functional Requirements

- [ ] User can claim a username (3-15 chars, a-z0-9) on the BOLT 12 offer screen
- [ ] DNS TXT record is created at `<username>.user._bitcoin-payment.zinqq.app` with content `bitcoin:?lno=<offer>&node=<pubkey>`
- [ ] Claimed address `₿ username@zinqq.app` is displayed on the offer screen
- [ ] Username persists across page reloads (IndexedDB)
- [ ] Startup verification confirms the DNS record still exists
- [ ] Same node key can update the DNS record (offer change)
- [ ] Different node key cannot overwrite an existing username (409)
- [ ] Reserved words are rejected
- [ ] Invalid usernames are rejected client-side before submission
- [ ] Registration works in local dev with mock DNS backend
- [ ] Online-only limitation is communicated to the user

### Non-Functional Requirements

- [ ] Cloudflare API token has minimal scope (Zone:DNS:Edit, single zone)
- [ ] Signatures use domain-separated messages (`zinqq:register:v1|...`)
- [ ] Timestamp validation prevents replay (5-minute window)
- [ ] No native crypto dependencies (pure JS `@noble/curves`)

### Quality Gates

- [ ] Unit tests for signing, validation, storage, and UI components
- [ ] Serverless function tested with curl against staging before merge
- [ ] CI passes

## Dependencies & Risks

### Dependencies

- **Cloudflare API token** — must be created manually in the Cloudflare dashboard and added to Vercel env vars before the feature works in staging/production
- **DNSSEC enabled on zinqq.app** — must be configured once at the Cloudflare zone level
- **`@noble/curves` and `@noble/hashes`** — add as explicit dependencies (already transitive via `@scure/bip32`, zero weight increase)

### Risks

| Risk                                                             | Likelihood | Impact                | Mitigation                                                                     |
| ---------------------------------------------------------------- | ---------- | --------------------- | ------------------------------------------------------------------------------ |
| `keysManager.get_node_secret_key()` not exposed in WASM bindings | Low        | High (blocks signing) | Fallback: derive from LDK seed via `HDKey.fromMasterSeed(seed).derive("m/0'")` |
| Cloudflare API token compromised                                 | Low        | High (DNS hijacking)  | Minimal scope, IP allowlist, Vercel env var encryption                         |
| "One username per pubkey" unenforceable without DB               | Medium     | Low (signet only)     | Client-side enforcement; accept as known limitation                            |
| BOLT 12 offer >4096 bytes exceeds DNS wire limit                 | Very low   | Medium                | Typical offers are 300-500 chars; monitor and add length check                 |

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-03-28-bip353-receive-brainstorm.md](docs/brainstorms/2026-03-28-bip353-receive-brainstorm.md) — Key decisions carried forward: Cloudflare DNS-only state, node-key signing auth, offer-only URI, online-only acceptable, self-serve on BOLT 12 offer screen

### Internal References

- Existing BIP 353 resolver: `src/ldk/resolve-bip353.ts` (all lines)
- BOLT 12 offer screen: `src/pages/Bolt12Offer.tsx` (all lines)
- Offer storage pattern: `src/ldk/storage/offer.ts` (all lines)
- IDB schema: `src/storage/idb.ts:4-18` (STORES array)
- LDK context type: `src/ldk/ldk-context.ts:22-63`
- LDK provider offer loading: `src/ldk/context.tsx:589-641`
- KeysManager init: `src/ldk/init.ts:180-188`
- Node ID derivation: `src/ldk/init.ts:499-506`
- Serverless function pattern: `api/vss-proxy.ts` (all lines)
- Vite dev proxy: `vite.config.ts:59-74`

### External References

- BIP 353 specification: DNS Payment Instructions
- Cloudflare DNS Records API: `https://developers.cloudflare.com/api/resources/dns/subresources/records/`
- `@noble/curves` secp256k1: `https://github.com/paulmillr/noble-curves`

### Learnings Applied

- Vercel flat serverless functions deploy reliably; catch-all subdirectory routes do not (`docs/solutions/infrastructure/vercel-serverless-functions-not-deployed.md`)
- BOLT 12 offer creation requires exponential backoff retry after RGS sync (`docs/solutions/integration-issues/bolt12-offer-creation-missing-paths.md`)
- Multi-segment TXT record parsing is already handled in the resolver (`resolve-bip353.ts:58`)
