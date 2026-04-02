---
title: 'feat: Mainnet Deployment — Phased Rollout'
type: feat
status: active
date: 2026-04-02
origin: docs/brainstorms/2026-04-02-mainnet-deployment-brainstorm.md
---

# feat: Mainnet Deployment — Phased Rollout

## Overview

Prepare Zinq for public mainnet release through three ordered phases: Infrastructure, Safety, and Polish. Each phase produces a deployable milestone. The work builds on the [mainnet fund safety audit](../brainstorms/2026-03-30-mainnet-fund-safety-audit-brainstorm.md) and [mainnet infrastructure brainstorm](../brainstorms/2026-03-30-mainnet-infra-brainstorm.md), with many audit items already resolved in prior PRs.

## Problem Statement

Zinq's mainnet config scaffolding exists but the app cannot actually run on mainnet due to: empty WS proxy URL (startup crash), missing BOLT 12 network validation (cross-network fund loss risk), and unimplemented anchor channel CPFP (force-close fund loss risk). A public release requires closing these gaps systematically.

## Proposed Solution

Three phases, each gated on the previous:

1. **Infrastructure** — Deploy WS proxy, wire config, verify services, implement peer reconnection
2. **Safety** — BOLT 12 validation, anchor CPFP, broadcaster resilience
3. **Polish** — Smoke testing, monitoring, cleanup, rollback procedures

## Technical Approach

### Architecture

Separate Vercel deployments per network (see brainstorm: `docs/brainstorms/2026-04-02-mainnet-deployment-brainstorm.md`):

- `zinqq.app` → mainnet (`VITE_NETWORK=mainnet`)
- `testnet.zinqq.app` → signet (`VITE_NETWORK=signet`)

Config selected at build time via `VITE_NETWORK` env var in `src/ldk/config.ts:54`.

### Implementation Phases

---

#### Phase 1: Infrastructure

**Goal:** App connects to mainnet peers, syncs chain data, opens channels via LSP.

##### PR 1.1 — Deploy WS proxy to production

- Deploy Cloudflare Workers proxy from `proxy/` to production
- Use `zinqq.app` domain (e.g., `wss://proxy.zinqq.app`)
- Verify `ALLOWED_ORIGINS` in `proxy/wrangler.toml:18-22` includes `zinqq.app`
- Add rate limiting to prevent abuse on public proxy
- **Files:** `proxy/wrangler.toml`, Cloudflare dashboard config

##### PR 1.2 — Wire mainnet config

- Set `wsProxyUrl` in mainnet config (`src/ldk/config.ts:42`) — currently empty string, causes startup throw at L71-76
- Update mainnet LSP to `034066e29e402d9cf55af1ae1026cc5adf92eed1e0e421785442f53717ad1453b0@64.23.159.177:9735` in `src/ldk/config.ts:35-37`
- Verify esplora URL `https://mempool.space/api` responds correctly
- Verify RGS URL `https://rapidsync.lightningdevkit.org/snapshot` serves mainnet snapshots
- **Files:** `src/ldk/config.ts`

##### PR 1.3 — Implement ConnectionNeeded peer reconnection

- Currently logs warning but does nothing (`src/ldk/traits/event-handler.ts:331-336`)
- Parse `SocketAddress` from the event and call `peer_manager.new_outbound_connection()`
- Critical for mainnet: dropped LSP connections mean failed payments and HTLC timeouts
- **Files:** `src/ldk/traits/event-handler.ts`

##### PR 1.4 — Set up mainnet Vercel project & VSS

- Create mainnet Vercel project with `VITE_NETWORK=mainnet`
- Set up separate mainnet VSS instance (same provider as signet)
- Configure `VSS_PROXY_TARGET` env var on mainnet Vercel project to point at mainnet VSS
- **Important:** Verify VSS routing is network-isolated — both deployments use `/api/vss-proxy` but must target different upstream VSS instances via different `VSS_PROXY_TARGET` values
- Document `VSS_PROXY_TARGET` configuration in project docs
- Reference gotchas from `docs/solutions/infrastructure/vercel-staging-vss-serverless-proxy.md`: `bodyParser: false`, path parsing, negative lookahead rewrite, Node.js runtime
- **Files:** Vercel dashboard, `vercel.json`, `api/vss-proxy.ts`

**Phase 1 exit criteria:**

- [x] App starts on mainnet without errors
- [x] Connects to mainnet peers via WS proxy
- [ ] Chain sync completes (genesis block verification passes at `src/ldk/init.ts:216-223`)
- [ ] Can open a channel via LSP JIT
- [x] Peer reconnection works after disconnect

---

#### Phase 2: Safety

**Goal:** No cross-network payment possible. Fee handling is mainnet-safe. Force-close scenarios are handled.

**Critical gate:** Anchor channels MUST remain disabled (`src/ldk/init.ts:119` — `set_negotiate_anchors_zero_fee_htlc_tx(false)`) until PR 2.2 (CPFP) is merged and tested. Do not enable anchors prematurely.

##### PR 2.1 — BOLT 12 network validation

- **Problem:** `src/ldk/payment-input.ts:143-146` — LDK WASM v0.1.8-0 does not expose `offer.chains()`, so no chain hash validation exists. A signet offer pasted on mainnet would be accepted.
- **Option A (preferred):** Parse offer TLV manually to extract chain hashes and validate against active network's genesis hash from config
- **Option B:** Upgrade LDK WASM if a newer version exposes `offer.chains()`
- **Option C (interim):** Disable BOLT 12 send on mainnet until validation exists — add a guard in the send flow that rejects offers when `VITE_NETWORK === 'mainnet'`
- If Option A or B cannot be completed quickly, ship Option C first as a safety gate, then follow up
- **Files:** `src/ldk/payment-input.ts`

##### PR 2.2 — Implement anchor channel CPFP (BumpTransaction)

- Currently at `src/ldk/traits/event-handler.ts:423-431`: logs `CRITICAL` but takes no action
- Implement CPFP fee bumping using BDK wallet UTXOs:
  1. On `BumpTransaction` event, get the commitment tx that needs bumping
  2. Create a child transaction spending from the anchor output
  3. Set fee rate high enough to get parent+child confirmed
  4. Broadcast via existing broadcaster
- Reference sweep logic in `src/ldk/sweep.ts` for fee rate bounds (min 2 sat/vB, max 500 sat/vB)
- After implementation: enable anchor channels by setting `set_negotiate_anchors_zero_fee_htlc_tx(true)` in `src/ldk/init.ts:119`
- Ensure BDK wallet always reserves a UTXO for anchor spending (don't let user drain on-chain balance to zero)
- **Files:** `src/ldk/traits/event-handler.ts`, `src/ldk/init.ts`, possibly `src/onchain/context.tsx`

##### PR 2.3 — Broadcaster fallback esplora

- `esploraFallbackUrl` exists in mainnet config (`src/ldk/config.ts:40`: `https://blockstream.info/api`) but is never consumed by the broadcaster
- Wire fallback into `src/ldk/traits/broadcaster.ts`: if primary broadcast fails all 5 retries, attempt fallback URL
- Also wire fallback into `src/ldk/sweep.ts` for sweep tx broadcasts
- **Files:** `src/ldk/traits/broadcaster.ts`, `src/ldk/sweep.ts`, possibly `src/ldk/config.ts`

**Phase 2 exit criteria:**

- [x] BOLT 12 offers validated against active network (or send disabled on mainnet)
- [x] BumpTransaction handler creates and broadcasts CPFP transactions
- [x] Anchor channels enabled in UserConfig
- [x] BDK wallet reserves anchor-spend UTXO
- [x] Broadcaster falls back to blockstream.info on mempool.space failure
- [x] Sweep uses fallback esplora on primary failure

---

#### Phase 3: Polish & Hardening

**Goal:** Production-ready with monitoring, tested with real funds, rollback plan in place.

##### PR 3.1 — DiscardFunding IDB cleanup

- `src/ldk/traits/event-handler.ts:434-439` skips cleanup of `ldk_funding_txs` IDB entries
- Implement cleanup: delete orphaned funding tx entries on DiscardFunding event
- **Files:** `src/ldk/traits/event-handler.ts`

##### PR 3.2 — Error monitoring

- Add error tracking (Sentry or similar) for critical code paths that currently only `console.error`:
  - Broadcaster failures (`src/ldk/traits/broadcaster.ts`)
  - Persistence failures (`src/ldk/traits/persist.ts`)
  - BumpTransaction events
  - SpendableOutputs handling
- **Files:** New integration, multiple event handler files

##### PR 3.3 — Rollback procedure documentation

- Document what to do if mainnet deploy hits a critical bug:
  - How to display a maintenance banner
  - How to disable new channel opens while keeping existing channels operational
  - Channel drain procedures
  - Communication plan for users with open channels
- **Files:** `docs/` directory

##### PR 3.4 — Mainnet smoke test checklist

Execute manually with real (small amount) mainnet funds:

- [ ] Open JIT channel via LSP (receive Lightning payment)
- [ ] Send Lightning payment (BOLT 11)
- [ ] Send Lightning payment (BOLT 12) — if enabled
- [ ] Receive on-chain payment
- [ ] Send on-chain payment
- [ ] Cooperative channel close
- [ ] Force-close channel (test BumpTransaction/CPFP)
- [ ] Restore wallet from seed on a different browser
- [ ] Verify BIP 353 resolution works on mainnet
- [ ] Test esplora failover (block primary, verify fallback)
- [ ] Test peer reconnection after disconnect

**Phase 3 exit criteria:**

- [x] No orphaned IDB entries on failed channel opens
- [x] Error monitoring captures critical failures
- [x] Rollback procedure documented and reviewed
- [ ] All smoke test scenarios pass with real funds

---

## System-Wide Impact

### Interaction Graph

Network selection (`VITE_NETWORK`) flows through:

1. `config.ts` → exports `CONFIG` and `ONCHAIN_CONFIG` used by all LDK and BDK modules
2. `init.ts` → validates genesis block hash, configures LSP, creates ChannelManager
3. `payment-input.ts` → validates addresses, invoices, offers against active network
4. `event-handler.ts` → handles all LDK events (payments, channels, force-closes)
5. `api/vss-proxy.ts` → routes to network-specific VSS upstream via `VSS_PROXY_TARGET`
6. `proxy/` (Cloudflare Worker) → shared across networks, origin-locked

### Error Propagation

- WS proxy failure → LDK peer connection fails → no Lightning functionality
- Esplora failure → no fee estimation (falls back to default), no broadcast (needs fallback)
- VSS failure → persistence degrades after 10s (`persist.ts:217-219`), channel ops halt
- BumpTransaction failure → anchor channel force-close stuck, potential fund loss

### State Lifecycle Risks

- **VSS cross-contamination:** If `VSS_PROXY_TARGET` is misconfigured, mainnet channel state could be written to signet VSS (or vice versa). Genesis block verification at startup (`init.ts:216-223`) provides a safety net but doesn't cover VSS routing.
- **Anchor UTXO reservation:** If user drains all on-chain funds, no UTXO available for CPFP. Must enforce minimum reserve.

## Acceptance Criteria

### Functional Requirements

- [ ] App runs on mainnet: connects to peers, syncs chain, opens channels
- [ ] No cross-network payments possible (BOLT 11, BOLT 12, on-chain all validated)
- [ ] Anchor channel force-closes can be fee-bumped via CPFP
- [ ] Broadcaster and sweep use fallback esplora on primary failure
- [ ] Peer reconnection works automatically
- [ ] Mainnet and signet deployments are fully isolated (config, VSS, Vercel project)

### Non-Functional Requirements

- [ ] Error monitoring on critical code paths
- [ ] Rollback procedure documented
- [ ] All smoke test scenarios pass with real mainnet funds
- [ ] WS proxy has rate limiting for abuse prevention

## Dependencies & Risks

| Risk                                           | Likelihood | Impact   | Mitigation                                                                                         |
| ---------------------------------------------- | ---------- | -------- | -------------------------------------------------------------------------------------------------- |
| BOLT 12 validation blocked by LDK WASM API gap | High       | High     | Ship with BOLT 12 send disabled on mainnet (Option C), follow up when LDK exposes `offer.chains()` |
| LSP liquidity insufficient                     | Low        | High     | LSP is confirmed funded (see brainstorm)                                                           |
| Mempool.space outage during force-close        | Medium     | High     | Broadcaster fallback to blockstream.info (PR 2.3)                                                  |
| VSS cross-contamination                        | Low        | Critical | Separate instances + genesis block verification + explicit `VSS_PROXY_TARGET` per Vercel project   |
| Browser storage quota exhaustion               | Low        | Medium   | Monitor IDB usage, clean up closed channel monitors                                                |

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-04-02-mainnet-deployment-brainstorm.md](../brainstorms/2026-04-02-mainnet-deployment-brainstorm.md) — Key decisions: phased rollout, minimal safety UX, CPFP must-have, zinqq.app for WS proxy, separate Vercel deployments
- **Safety audit:** [docs/brainstorms/2026-03-30-mainnet-fund-safety-audit-brainstorm.md](../brainstorms/2026-03-30-mainnet-fund-safety-audit-brainstorm.md)
- **Infra brainstorm:** [docs/brainstorms/2026-03-30-mainnet-infra-brainstorm.md](../brainstorms/2026-03-30-mainnet-infra-brainstorm.md)

### Internal References

- Network config: `src/ldk/config.ts:22-52`
- Payment validation: `src/ldk/payment-input.ts`
- Event handler: `src/ldk/traits/event-handler.ts`
- Broadcaster: `src/ldk/traits/broadcaster.ts`
- Persist/monitor: `src/ldk/traits/persist.ts`
- Sweep logic: `src/ldk/sweep.ts`
- Init flow: `src/ldk/init.ts`
- WS proxy: `proxy/wrangler.toml`, `proxy/src/index.ts`
- Fee handling: `src/onchain/context.tsx`
- VSS proxy: `api/vss-proxy.ts`

### Institutional Learnings

- VSS proxy gotchas: `docs/solutions/infrastructure/vercel-staging-vss-serverless-proxy.md`
- WS proxy patterns: `docs/solutions/infrastructure/websocket-tcp-proxy-cloudflare-workers.md`
- VSS restore race: `docs/solutions/logic-errors/vss-restore-background-persist-race.md`
- LDK event patterns: `docs/solutions/integration-issues/ldk-event-handler-patterns.md`
- Fund safety audit fixes: `docs/solutions/security-issues/mainnet-fund-safety-audit-2026-03.md`
