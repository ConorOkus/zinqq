---
title: 'feat: LSP failover — LQwD primary, Megalith fallback'
type: feat
status: completed
date: 2026-05-04
origin: docs/brainstorms/2026-04-30-lsp-failover-lqwd-primary-brainstorm.md
pr: https://github.com/ConorOkus/zinqq/pull/148
---

# feat: LSP Failover — LQwD Primary, Megalith Fallback

## Overview

Make LQwD Germany the default LSPS2 JIT-channel provider, with the
existing Megalith integration as a transparent fallback. Receive flow
looks identical to the user. LQwD's pubkey/host/port is fetched from
`https://germany.lqwd.tech/api/v1/get_info` on each app boot
(session-cached); Megalith stays env-var-driven. If both fail, the
flow degrades to on-chain-only (existing behavior).

(see brainstorm:
`docs/brainstorms/2026-04-30-lsp-failover-lqwd-primary-brainstorm.md`)

## Problem Statement / Motivation

Single-LSP architecture today (`src/ldk/config.ts:50-56` →
`src/ldk/context.tsx:260-337`) means an outage at Megalith silently
degrades the receive flow to on-chain. We have a known-good second
LSP (LQwD Germany) that supports zero-conf channels and a usable
payment-size range; we should default to it and keep Megalith warm as
a fallback. The codebase already ships the failover pattern
(`broadcastWithRetry` at `src/ldk/traits/broadcaster.ts:36-62`) — we
mirror it at the LSPS2 layer.

Scope is intentionally narrow: **LSPS2 only** (JIT channels). LSPS1
paid channels were considered and deferred — see brainstorm for the
trade-off (new transport, new UI, no current product demand).

## Proposed Solution

Three logical pieces, each small:

1. **LQwD discovery module**
   `src/ldk/lsp/lqwd-discovery.ts` — pure async helper:
   `fetchLqwdContact(): Promise<LspContact>`. Hits the HTTP endpoint
   with `cache: 'no-store'`, parses `uris[0]`, validates the
   `<66hex>@<host>:<port>` shape, returns `{nodeId, host, port,
token: null}` or throws. Memoised at module scope: invocations
   share the in-flight promise; resolved value is reused for the
   lifetime of the page.

2. **LSP-contact resolver**
   `src/ldk/lsp/contacts.ts` — combines discovery + env config:
   `resolveLspContacts(): Promise<{primary: LspContact | null,
fallback: LspContact | null}>`. Primary = the discovered LQwD
   contact (or `null` if discovery failed); fallback = the existing
   `LDK_CONFIG.lsp*` env-var contact (or `null` if disabled). Fired
   eagerly at app init — by the time the user navigates to /receive
   the promise is settled.

3. **Failover wrapper** in `requestJitInvoice`
   Extract the existing LSPS2 dance (peer connect → fee params →
   select → buyChannel → invoice) into
   `attemptJitInvoiceWithLsp(lspContact, amountMsat, description)`.
   `requestJitInvoice` becomes:
   ```
   try primary → on fail (any of 4 triggers) → try fallback
                                            → on fail throw
   ```
   The throw bubbles up to `Receive.tsx:144-150` which already
   degrades to on-chain-only. No new error surface.

## Technical Considerations

### Architecture

- **`LspContact`** type: `{nodeId: string, host: string, port: number,
token: string | null, label: 'lqwd' | 'megalith'}`. The `label` is
  for telemetry only.
- **Discovery wire shape** is the live JSON from
  `https://germany.lqwd.tech/api/v1/get_info` — we **only** consume
  `uris[0]`. All other fields (LSPS1 channel-balance bounds, etc.)
  are ignored; they're paid-channel metadata irrelevant to LSPS2.
  Parse the URI with a strict regex `^[0-9a-f]{66}@([^:]+):(\d+)$`
  so a malformed response fails loud.
- **Trigger 1: HTTP `/get_info`** — handled by `fetchLqwdContact`.
  Network error / non-2xx / parse error / empty `uris` → discovery
  rejects; resolver returns `primary: null`; `requestJitInvoice`
  skips primary attempt entirely and goes straight to fallback.
- **Trigger 2: peer connect** — wrap `connectAndTrack`
  (`src/ldk/context.tsx:88`) in a per-LSP `try/catch`. **Drop the
  current one-time auto-retry** (`src/ldk/context.tsx:282-284`) on
  the primary path — failover replaces it. Keep one retry on the
  fallback attempt (this preserves today's resilience for the
  always-present Megalith).
- **Trigger 3: LSPS2 RPC** — `getOpeningFeeParams` and `buyChannel`
  reject after `REQUEST_TIMEOUT_MS` from the existing reaper
  (`src/ldk/lsps2/message-handler.ts:60-61`). Both rejections fall
  through to the catch handler that triggers fallback.
- **Trigger 4: payment-size out of range** —
  `selectCheapestParams(feeMenu, amountMsat)`
  (`src/ldk/lsps2/types.ts:99-100`) returns `null`. Today this
  throws `"No suitable fee parameters available for this amount"`.
  After this change: in the primary attempt, that condition triggers
  fallback (different LSP may have a different range); in the
  fallback attempt, it throws as today.
- **No mid-flow swapping**: once primary's `buyChannel` succeeds we
  are committed to that LSP for the resulting invoice. There is no
  trigger past `buyChannel` that fires fallback.

### Performance / latency budget

- HTTP discovery is fired in parallel with LDK init at app boot. By
  the time the user first hits /receive, it's settled or rejected
  — adds zero user-visible latency in the happy path.
- Worst-case total latency on a double-failure: **HTTP timeout (3s) +
  primary peer connect attempt (~existing budget) + primary LSPS2
  RPC timeout + fallback peer connect + fallback LSPS2 RPC**. We
  should enforce tighter primary budgets than fallback to keep the
  total bounded; concrete timeouts are a tuning detail for /ce:work,
  not this plan.

### Security

- Third-party HTTPS endpoint (`germany.lqwd.tech`) — standard public
  CA, no pinning. Same trust posture as Megalith's existing channel
  trust assumption.
- Privacy: hitting LQwD on every boot reveals "this user opened the
  app" to LQwD. Acceptable for v1; same posture as our existing
  esplora/mempool calls.
- Strict regex on the parsed `uris[0]` prevents a malicious
  `/get_info` from injecting host strings into the LDK peer dial
  path.

### Workbox / Service Worker

- `vite.config.ts:85-102` defines runtime caching with NetworkFirst
  for static assets. The `/get_info` GET is a JSON request to a
  third-party origin; by default it would NOT be precached
  (`globPatterns` is `**/*.{js,css,html,ico,png,svg,woff2}`) but
  could be runtime-cached if a generic pattern matches.
- Defence in depth: explicit `fetch(url, {cache: 'no-store'})` in
  `fetchLqwdContact`. **Verify** at impl time that no Workbox
  runtime rule's `urlPattern` matches `germany.lqwd.tech` — if any
  match, add a NetworkOnly override.

### CSP

- Add `https://germany.lqwd.tech` to `connect-src` in **both**:
  - `vercel.json:31` (production header)
  - `index.html:13` (dev meta tag)
- LSP node-level p2p still flows through `wss://proxy.zinqq.app` —
  already covered. No other CSP changes.

### Telemetry

Use the existing `captureError` pattern
(`src/storage/error-log.ts`). Emit one event per receive attempt:

- On primary success: `info`, scope `'LSP'`, `"primary lsp succeeded
(lqwd)"`.
- On fallback success: `warning`, scope `'LSP'`, `"fell back to
megalith"` + JSON detail `{trigger: 'http_preflight' |
'peer_connect' | 'lsps2_rpc' | 'payment_size_filter',
duration_ms}`.
- On both-fail: `error`, scope `'LSP'`, `"both lsps failed,
degrading to on-chain"` + same detail keys.

## System-Wide Impact

### Interaction graph

```
app boot
  ├─ LDK init
  └─ resolveLspContacts() ──┐
                            └─ fetchLqwdContact() ──> HTTPS GET /get_info
                                                      └─ parse uris[0]
                                                      └─ memoise

user navigates /receive
  └─ requestJitInvoice(amountMsat, description)
      ├─ contacts = await resolveLspContacts()
      ├─ try attemptJitInvoiceWithLsp(contacts.primary, ...)
      │   ├─ connectAndTrack(peerManager, lqwd.nodeId, ...)
      │   ├─ lsps2Client.getOpeningFeeParams(...)
      │   ├─ selectCheapestParams(...)
      │   ├─ lsps2Client.buyChannel(...)
      │   ├─ channelManager.create_inbound_payment(...)
      │   └─ lsps2Client.createJitInvoice(...)
      └─ on any trigger: try attemptJitInvoiceWithLsp(contacts.fallback, ...)
          └─ on fail: throw → Receive.tsx falls back to on-chain
```

The other `connectAndTrack` callsites in `src/ldk/context.tsx`
(lines 419, 584, 894, 923) are **out of scope** — they handle BOLT12
peer maintenance and channel-open flows, not LSPS2 receive. Verify
during impl that line 419's "keep LSP connected" maintenance call
still references the env-var Megalith pubkey only (which is fine —
maintenance of the fallback peer is harmless).

### Error & failure propagation

- HTTP error (DNS, TCP, TLS, 5xx, malformed JSON, empty `uris`,
  regex mismatch) → `fetchLqwdContact` rejects → `resolveLspContacts`
  returns `primary: null` → primary attempt skipped → fallback
  tried.
- Peer connect throws → caught by failover wrapper → fallback tried.
- LSPS2 RPC rejects (reaper timeout or LSP-side error code from
  `src/ldk/lsps2/types.ts:56-62`) → caught → fallback tried.
- `selectCheapestParams` returns `null` → wrapper detects → fallback
  tried (not `throw` like today).
- `create_inbound_payment` failure (`src/ldk/context.tsx:316-318`) →
  this happens AFTER successful `buyChannel`. We are committed; no
  fallback. Throws as today; UI degrades to on-chain.
- Both LSPs fail → `requestJitInvoice` throws →
  `Receive.tsx:144-150` clears invoice state; UI shows on-chain
  address only. **Existing behavior preserved.**

### State lifecycle risks

- **Stranded LSPS2 reservation**: if LQwD's `buyChannel` succeeds but
  a later step fails (e.g. `create_inbound_payment` blows up),
  LQwD's server-side jit-channel reservation is leaked until it
  expires. Same risk exists today against Megalith — this change
  doesn't introduce new exposure. Server-side TTL on
  `valid_until` (already validated with 120s buffer at
  `src/ldk/context.tsx:298-300`) handles cleanup.
- **No state crossover between attempts**: the failover wrapper
  treats each attempt as independent. No reservation, no inbound
  payment, no peer connection state is shared between primary and
  fallback. Safe to retry the full LSPS2 dance on the fallback.

### API surface parity

Single entry point: `requestJitInvoice` in `src/ldk/context.tsx`. No
other surface in the wallet generates JIT invoices. UI surface
(`Receive.tsx`) is unchanged.

### Integration test scenarios

5 new scenarios for `src/pages/Receive.test.tsx` and/or new
`src/ldk/lsp/contacts.test.ts`:

1. **LQwD `/get_info` 5xx** → mock fetch returns 500 → `Receive`
   flow uses Megalith → invoice succeeds.
2. **LQwD `/get_info` returns malformed JSON / empty `uris`** →
   discovery rejects → fallback used.
3. **LQwD peer connect times out** → mock `connectAndTrack` rejects
   for LQwD pubkey → fallback path runs full LSPS2 dance against
   Megalith → invoice succeeds.
4. **Payment outside LQwD's range, inside Megalith's range** →
   primary `selectCheapestParams` returns null → fallback used →
   invoice succeeds with Megalith's params.
5. **Both LSPs fail** → primary fully fails AND fallback fully fails
   → `requestJitInvoice` throws → `Receive.tsx` clears invoice state
   → only on-chain address shown.

## Acceptance Criteria

### Code

- [x] `src/ldk/lsp/lqwd-discovery.ts` exists. Exports
      `fetchLqwdContact()` returning `Promise<LspContact>`. Uses
      `fetch(url, {cache: 'no-store'})`. Validates URI shape with
      strict regex. Memoised at module scope.
- [x] `src/ldk/lsp/contacts.ts` exists with `LspContact` type and
      `resolveLspContacts()` returning `{primary, fallback}` where
      either field may be null. Fired eagerly at app init.
- [x] `requestJitInvoice` in `src/ldk/context.tsx:260-337`
      refactored to: extract LSPS2 dance into
      `attemptJitInvoiceWithLsp(contact, amountMsat, description)`;
      wrap with primary→fallback failover; map all four brainstorm
      triggers to fallback.
- [x] Drop the in-function one-shot retry at
      `src/ldk/context.tsx:282-284` for the _primary_ attempt.
      Preserve a single retry on the _fallback_ attempt.
- [x] CSP entry `https://germany.lqwd.tech` added to **both**
      `vercel.json:31` and `index.html:13` `connect-src`.
- [x] No Workbox runtime rule matches `germany.lqwd.tech`. If any
      does, add a `NetworkOnly` override or adjust pattern.
- [x] No changes to other `connectAndTrack` callsites
      (`src/ldk/context.tsx` lines 419, 584, 894, 923) — out of
      scope.

### Telemetry

- [x] Receive attempts that hit the fallback emit one of:
      fallback-success (`warning`) or both-fail (`error`) via
      `captureError` with scope `'LSP'`. Primary-success path is
      silent (no `info` severity exists in the existing
      `captureError` API; absence of fallback events implies
      primary success — checked in
      `src/storage/error-log.ts:3`).
- [x] Fallback events include `{trigger, duration_ms}` detail JSON.

### Tests

- [x] All 5 scenarios in "Integration test scenarios" implemented
      and passing.
- [x] Existing `src/pages/Receive.test.tsx` still passes (no
      behavioural regression in the happy path against Megalith,
      provided LQwD discovery is mocked).
- [x] New `src/ldk/lsp/lqwd-discovery.test.ts` covers: success
      parse; HTTP 5xx; malformed JSON; empty `uris`; regex mismatch;
      memoisation (single in-flight fetch on concurrent calls).

### Quality gates

- [x] `pnpm typecheck` clean.
- [x] `pnpm lint` clean.
- [x] `pnpm test` passes including new test files.
- [ ] Manual smoke on a Vercel preview: receive a real-looking JIT
      invoice with LQwD as primary; force LQwD failure (e.g. block
      `germany.lqwd.tech` via DNS or browser devtools network tab),
      reload, retry receive, confirm Megalith path runs and invoice
      generates. **Pending push + Vercel preview link.**

### Memory hygiene

- [ ] After merge, update
      `~/.claude/projects/-Users-conor-Projects-zinq/memory/reference_megalith_lsp.md`
      to note Megalith is now the **fallback**. Add a sibling
      `reference_lqwd_lsp.md` documenting LQwD as primary +
      `/get_info` endpoint. **Post-merge.**

## Success Metrics

- Receive flow continues to produce valid BOLT11 invoices when
  Megalith is reachable but LQwD is down (or vice-versa) — verified
  manually via the smoke step above.
- Sentry shows the `LSP` scope with breakdown of
  primary-success / fallback-success / both-fail counts. Healthy
  steady-state: >90% primary-success, <10% fallback-success, ~0%
  both-fail.
- Zero new user-visible regressions on the happy path (no extra
  latency, no UI surface changes).

## Dependencies & Risks

### Dependencies

- LQwD's `/get_info` endpoint must remain available. Single-host
  dependency; we accept its failure mode (silent fallback).
- LDK's `PeerManager.connect` semantics unchanged.
- `src/storage/error-log.ts:captureError` API unchanged.

### Risks

1. **Workbox cache poisoning** of `/get_info`. Mitigation: explicit
   `cache: 'no-store'` + verify no runtime caching rule matches.

2. **Stranded reservations** if `create_inbound_payment` fails after
   `buyChannel` succeeds. Pre-existing risk; LSPS2 server-side TTL
   (`valid_until`, validated at line 298-300) handles cleanup.

3. **Worst-case latency on double-failure**: ~30-60s. User
   experience: long spinner, then on-chain-only address. Same UX
   degradation as today's single-LSP failure, just slower. Mitigate
   by tightening primary timeouts during /ce:work tuning.

4. **LQwD pubkey rotation mid-session**: session-cached pubkey goes
   stale → peer connect fails → fallback fires. Acceptable; next
   page reload re-fetches. Documented in brainstorm.

5. **Privacy leakage** to LQwD on every app boot. Acceptable v1
   posture; not novel (esplora/mempool already do similar). Document
   in privacy notes if/when written.

6. **Maintenance peer connection** at `src/ldk/context.tsx:419`
   currently keeps Megalith warm. After this change Megalith is the
   fallback — keeping it warm is still the right call. **No code
   change there**, but note in PR description.

### Out of scope

- LSPS1 paid channels (deferred — see brainstorm).
- User-visible LSP picker, settings page, status indicator (rejected
  in brainstorm in favour of silent + telemetry).
- Multi-LSP simultaneous mode / multipath / parallel attempts.
- Dynamic discovery of Megalith via HTTP (Megalith has no `/get_info`
  HTTP endpoint that we know of; it stays env-var-driven).
- Updating CSP for any LSPS1-related host (LQwD's payment URL or
  similar) — N/A for LSPS2.

## Implementation Sketch

### `src/ldk/lsp/lqwd-discovery.ts`

```ts
export type LspContact = {
  nodeId: string
  host: string
  port: number
  token: string | null
  label: 'lqwd' | 'megalith'
}

const LQWD_GET_INFO_URL = 'https://germany.lqwd.tech/api/v1/get_info'
const URI_RE = /^([0-9a-f]{66})@([^:]+):(\d+)$/

let inflight: Promise<LspContact> | null = null

export function fetchLqwdContact(): Promise<LspContact> {
  if (inflight) return inflight
  inflight = (async () => {
    const res = await fetch(LQWD_GET_INFO_URL, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3_000),
    })
    if (!res.ok) throw new Error(`LQwD /get_info ${res.status}`)
    const json: { uris?: unknown } = await res.json()
    if (!Array.isArray(json.uris) || json.uris.length === 0) {
      throw new Error('LQwD /get_info missing uris')
    }
    const m = URI_RE.exec(String(json.uris[0]))
    if (!m) throw new Error('LQwD /get_info uri shape unexpected')
    return {
      nodeId: m[1],
      host: m[2],
      port: Number(m[3]),
      token: null,
      label: 'lqwd',
    }
  })()
  // Reset inflight on rejection so a transient failure can be retried
  // on next page load (memoisation is per-session, not per-process).
  inflight.catch(() => {
    inflight = null
  })
  return inflight
}
```

### `src/ldk/lsp/contacts.ts`

```ts
export async function resolveLspContacts(): Promise<{
  primary: LspContact | null
  fallback: LspContact | null
}> {
  const primary = await fetchLqwdContact().catch(() => null)
  const fallback: LspContact | null =
    LDK_CONFIG.lspNodeId && LDK_CONFIG.lspHost
      ? {
          nodeId: LDK_CONFIG.lspNodeId,
          host: LDK_CONFIG.lspHost,
          port: LDK_CONFIG.lspPort,
          token: LDK_CONFIG.lspToken ?? null,
          label: 'megalith',
        }
      : null
  return { primary, fallback }
}
```

### `requestJitInvoice` refactor (sketch)

```ts
const requestJitInvoice = useCallback(async (amountMsat, description) => {
  const node = nodeRef.current
  if (!node) throw new Error('Node not initialized')

  const { primary, fallback } = await resolveLspContacts()
  if (!primary && !fallback) throw new Error('No LSP available')

  const t0 = performance.now()
  if (primary) {
    try {
      const result = await attemptJitInvoiceWithLsp(node, primary, amountMsat, description)
      captureError('info', 'LSP', `primary lsp succeeded (${primary.label})`)
      return result
    } catch (e) {
      const trigger = classifyFailure(e) // 'http_preflight' | 'peer_connect' | 'lsps2_rpc' | 'payment_size_filter'
      if (!fallback) throw e
      captureError(
        'warning',
        'LSP',
        `falling back from ${primary.label} to ${fallback.label}`,
        JSON.stringify({ trigger, duration_ms: Math.round(performance.now() - t0) })
      )
    }
  }

  // Fallback path (with one retry, mirroring today's resilience for the always-present LSP)
  return attemptJitInvoiceWithLsp(node, fallback!, amountMsat, description, { retryOnce: true })
}, [])
```

### `attemptJitInvoiceWithLsp` (extracted from current 270-336)

Signature: `(node, contact, amountMsat, description, opts?: {retryOnce: boolean}) => Promise<JitInvoiceResult>`. Body is the existing 5-step LSPS2 dance, parameterised on `contact` instead of `LDK_CONFIG`. The "no fee params match" branch becomes `throw new PaymentSizeOutOfRangeError(...)` so the wrapper can classify it as a fallback trigger rather than a user-facing error.

## Sources & References

### Origin

- **Brainstorm:** [`docs/brainstorms/2026-04-30-lsp-failover-lqwd-primary-brainstorm.md`](../brainstorms/2026-04-30-lsp-failover-lqwd-primary-brainstorm.md). Key decisions carried forward: (1) LSPS2-only scope; (2) LQwD via `/get_info` on each boot, session-cached; (3) all four fallback triggers (HTTP / peer connect / LSPS2 RPC / payment-size); (4) silent + telemetry only; (5) on-chain as bottom of cascade; (6) no mid-flow swapping past `buyChannel` success.

### Internal references

- Pattern reference (failover): `src/ldk/traits/broadcaster.ts:36-62`
- LSP config: `src/ldk/config.ts:50-86`, `.env.example:26-31`
- JIT receive flow (to refactor): `src/ldk/context.tsx:260-337`
- Peer connect helper: `src/ldk/context.tsx:88` (and callsites at 273, 283, 419, 584, 894, 923 — only 273+283 in scope)
- LSPS2 transport: `src/ldk/lsps2/message-handler.ts` (reaper at 60-61, 209)
- LSPS2 types / fee math: `src/ldk/lsps2/types.ts:56-62, 99-100`
- Receive UI degradation path: `src/pages/Receive.tsx:144-150`
- CSP locations: `vercel.json:31`, `index.html:13`
- Workbox config: `vite.config.ts:85-102`
- Telemetry: `src/storage/error-log.ts` (`captureError`)

### Institutional learnings

- `docs/solutions/runtime-errors/mobile-pwa-websocket-peer-disconnect.md` — iOS Safari kills WebSockets on backgrounding; relevant to peer-connect retry semantics on the fallback path.
- (Plus the broadcaster fallback pattern itself, which serves as a working precedent.)

### External references

- LQwD discovery endpoint: `https://germany.lqwd.tech/api/v1/get_info`
- LSPS2 spec (BLIPs): bLIP-52 — fee menu / opening fees (already implemented)

### Related work

- The Megalith-only integration is the existing baseline (no PR to swap; this plan is the first time multi-LSP is introduced).
- Brainstorm: [`docs/brainstorms/2026-04-30-lsp-failover-lqwd-primary-brainstorm.md`](../brainstorms/2026-04-30-lsp-failover-lqwd-primary-brainstorm.md)
- Auto-memory entry to update post-merge:
  `~/.claude/projects/-Users-conor-Projects-zinq/memory/reference_megalith_lsp.md`
