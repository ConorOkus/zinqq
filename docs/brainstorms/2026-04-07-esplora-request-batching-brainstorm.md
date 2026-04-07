# Brainstorm: Esplora Request Batching & Caching

**Date:** 2026-04-07
**Status:** Ready for planning

## What We're Building

A client-side fetch middleware layer for the LDK EsploraClient that reduces request volume through caching, request deduplication, and concurrency limiting. Combined with reducing BDK's parallel request limit to match.

### Problem

The app is getting rate limited (HTTP 429, connection refused, degraded responses, CORS blocks) on mainnet esplora servers (blockstream.info, mempool.space). A prior effort (doubled LDK interval to 60s, tripled BDK to 180s, consolidated fee cache) wasn't enough.

### Root Causes

1. **No response caching** — block headers for the same block are re-fetched multiple times within a single sync tick (once per watched txid/output that confirms in that block)
2. **Unbounded parallelism** — LDK sync fires all watched txid and output checks via `Promise.allSettled` with no concurrency limit, creating request bursts
3. **No request deduplication** — identical in-flight requests (e.g. same block header) aren't coalesced
4. **BDK parallel requests too high** — set to 5 concurrent, hitting the same server as LDK

## Why This Approach

Client-side batching + caching was chosen over a Cloudflare Worker proxy or hybrid approach because:

- **Zero infrastructure** to deploy and maintain
- **Directly addresses the burst problem** — the biggest issue is request volume per sync tick, not total volume over time
- **Block headers and confirmed tx data are immutable** — safe to cache indefinitely
- A proxy can be added later if client-side optimization isn't sufficient

## Key Decisions

1. **Client-side only** — no proxy infrastructure needed
2. **Max 2 concurrent requests** for LDK EsploraClient
3. **Reduce BDK syncParallelRequests from 5 to 2** to match
4. **Keep LDK and BDK sync loops independent** — coordinating them adds coupling for marginal gain; the real burst problem is within each sync tick, not overlap between loops
5. **Cache immutable data** — block headers, confirmed tx hex, merkle proofs (keyed by block hash or txid)
6. **Deduplicate in-flight requests** — coalesce identical concurrent fetches into a single network call

## Scope

### In Scope

- LRU/Map cache in EsploraClient for block headers, tx hex, merkle proofs
- Concurrency limiter (semaphore pattern) capping parallel fetches to 2
- In-flight request deduplication (return same Promise for identical concurrent requests)
- Reduce BDK `syncParallelRequests` config from 5 to 2

### Out of Scope

- Caching proxy / Cloudflare Worker (future consideration if client-side isn't enough)
- Modifying BDK's internal fetch behavior (WASM black box)
- Changing sync intervals (already optimized in prior effort)
- HTTP-level caching (ETag, If-None-Match) — esplora APIs don't consistently support this

## Open Questions

None — all key decisions resolved.

## References

- Prior optimization: `docs/plans/2026-04-06-001-fix-reduce-esplora-request-volume-plan.md`
- LDK EsploraClient: `src/ldk/sync/esplora-client.ts`
- LDK chain sync: `src/ldk/sync/chain-sync.ts`
- BDK config: `src/onchain/config.ts`
