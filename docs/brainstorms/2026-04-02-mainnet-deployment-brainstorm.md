# Brainstorm: Mainnet Deployment — Phased Rollout

**Date:** 2026-04-02
**Status:** Complete
**Builds on:** [Mainnet Fund Safety Audit](2026-03-30-mainnet-fund-safety-audit-brainstorm.md), [Mainnet Infrastructure](2026-03-30-mainnet-infra-brainstorm.md)

## What We're Building

A phased path to public mainnet release of Zinq. The safety audit (March 30) identified all blockers and the infra brainstorm defined the deployment model. This document sequences the work into deployable phases and captures remaining decisions.

## Why This Approach

**Phased rollout** — each phase produces a deployable milestone, reduces risk, and allows real-world testing between phases. A big-bang approach is too risky for a wallet handling real funds. Minimum viable mainnet was ruled out because anchor channel CPFP is a must-have.

## Key Decisions

### 1. Three phases: Infrastructure → Safety → Polish

Work is ordered so each phase unblocks the next and is independently testable.

### 2. LSP: Use existing mainnet node

Mainnet LSP: `034066e29e402d9cf55af1ae1026cc5adf92eed1e0e421785442f53717ad1453b0@64.23.159.177:9735`

Update `MAINNET_CONFIG` in `src/ldk/config.ts` with this node ID and host.

### 3. Safety UX: Minimal guards

Network validation to prevent cross-network mistakes (C1-C4 from audit), but no confirmation dialogs, amount limits, or onboarding flows. Trust users to know what they're doing.

### 4. Anchor channel CPFP: Must-have before launch

C7 from the safety audit. Without fee bumping, force-close scenarios on mainnet risk fund loss during high-fee periods.

### 5. Deployment model: Separate Vercel projects (per infra brainstorm)

- `zinqq.app` → mainnet (`VITE_NETWORK=mainnet`)
- `testnet.zinqq.app` → signet (`VITE_NETWORK=signet`)

---

## Phase 1 — Config & Infrastructure

Deploy the WS proxy and wire all mainnet config so the app can connect to mainnet peers and services.

**Work items:**

- Deploy Cloudflare Workers WS proxy to production (from `proxy/` directory)
- Set `wsProxyUrl` in mainnet LDK config
- Update mainnet LSP node ID and host in config
- Verify esplora (mempool.space), RGS (rapidsync.lightningdevkit.org) endpoints are working
- Set up mainnet VSS instance and configure `VSS_PROXY_TARGET` for mainnet Vercel project
- Create mainnet Vercel project with `VITE_NETWORK=mainnet`

**Exit criteria:** App connects to mainnet peers, syncs chain data, and can open a channel via LSP.

## Phase 2 — Safety

Fix all Critical and must-have items from the safety audit.

**Work items (audit references):**

- **C1:** Network-aware BOLT 11 currency check (`payment-input.ts`)
- **C2:** Network-aware on-chain address regex (`payment-input.ts`)
- **C3:** BOLT 12 network validation (`payment-input.ts`)
- **C4:** BIP 321 URI address validation (`payment-input.ts`)
- **C5:** Raise minimum fee rate on mainnet, refuse to send if fee estimation fails
- **C7:** Implement anchor channel CPFP fee bumping (`event-handler.ts`)
- **H1:** Broadcaster failure tracking (don't silently drop failed txs)
- **H10:** Minimum fee rate validation

**Exit criteria:** All Critical items resolved. No cross-network payment possible. Fee handling is mainnet-safe. CPFP works for anchor channels.

## Phase 3 — Polish & Hardening

Address High-priority items and operational readiness.

**Work items:**

- **H2:** Deterministic channel key IDs for cross-device recovery
- **H4:** Remove signer provider fallback (fail loudly)
- **H5:** Block channel progress if funding tx persistence fails
- **H6:** Queue concurrent monitor persistence per channel
- **H7:** Halt on true version conflict instead of silent retry
- **M6:** Implement ConnectionNeeded peer reconnection
- NetworkBadge behavior verification (hidden on mainnet)
- Production smoke testing on mainnet with small amounts
- Document VSS_PROXY_TARGET configuration

**Exit criteria:** High-priority safety items resolved. App tested with real mainnet funds.

## Resolved Questions

1. **VSS mainnet hosting** — Same provider/setup as signet for now, just a separate instance.
2. **WS proxy domain** — Will use `zinqq.app` domain (e.g., `ws.zinqq.app` or `proxy.zinqq.app`).
3. **LSP funding** — Mainnet LSP is sufficiently funded for JIT channels at launch.
