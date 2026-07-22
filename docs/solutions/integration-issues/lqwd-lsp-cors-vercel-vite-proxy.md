---
title: LQwD LSP discovery blocked by CORS from browser, fixed via same-origin Vercel proxy
category: integration-issues
date: 2026-05-06
severity: HIGH
module: api/lqwd-proxy.ts, vercel.json, vite.config.ts, src/ldk/lsp/lqwd-discovery.ts
tags:
  [
    lsp,
    lqwd,
    lsps2,
    jit-channels,
    cors,
    vercel-serverless,
    vite-proxy,
    csp,
    same-origin,
    lightning-receive,
  ]
related_pr: 148
related:
  - vss-cors-bypass-vite-proxy.md
  - blockstream-enterprise-esplora-proxy.md
  - pwa-workbox-vercel-csp-integration.md
commit: db47af4
---

> ⚠️ **Superseded (2026-07-07, PR #167).** LQwD was removed as an LSP; Megalith is
> now the sole provider. The proxy this documents (`api/lqwd-proxy.ts`, the
> `vercel.json` rewrite, and the `vite.config.ts` dev proxy) and
> `src/ldk/lsp/lqwd-discovery.ts` were all deleted. Kept for historical reference:
> the same-origin proxy pattern still applies to other third-party endpoints
> (Esplora, VSS, LNURL). See [[reference_megalith_lsp]].

# LQwD LSP discovery blocked by CORS from browser, fixed via same-origin Vercel proxy

## Symptom

Browser console showed:

```
Access to fetch at 'https://germany.lqwd.tech/api/v1/get_info' from origin
'http://localhost:5173' has been blocked by CORS policy: No
'Access-Control-Allow-Origin' header is present on the requested resource.
GET https://germany.lqwd.tech/api/v1/get_info net::ERR_FAILED 404 (Not Found)
```

LQwD discovery (`fetchLqwdContact()`) rejected, the wallet silently fell back to Megalith, and JIT receive via the new primary LSP never armed.

## Root Cause

The upstream `https://germany.lqwd.tech/api/v1/get_info` returns a perfectly valid `200 OK` with JSON when hit from `curl` or any server-side runtime — but the response carries no `Access-Control-Allow-Origin` header. Browsers therefore reject the response (and fail the CORS preflight) before any JS code can read it. From the page's point of view the request "fails," and Chrome surfaces the network-tab status as `(failed) 404` even though the server never emitted a 404.

That explains the divergence between environments. `curl` ignores CORS entirely, so manual smoke checks before merging PR #148 looked green. CI passed because every test in `lqwd-discovery.test.ts` mocked `globalThis.fetch` — the production code path that actually performs the cross-origin request was never exercised against a real network. The misleading "404" in DevTools sent the initial investigation toward "is the upstream URL wrong?" before someone noticed the `(blocked:cors)` annotation in the network panel.

## Investigation

1. Reproduced in `pnpm dev` against `localhost:5173` — `fetchLqwdContact()` rejected; Megalith fallback fired.
2. `curl -i https://germany.lqwd.tech/api/v1/get_info` → `200 OK`, valid JSON, **no** `Access-Control-Allow-Origin` header. Confirmed upstream is fine and the issue is browser-only.
3. Re-read DevTools network entry: status `(failed) 404`, but `(blocked:cors)` flag set. The "404" was a CORS side-effect, not an upstream response.
4. Re-checked `lqwd-discovery.test.ts` — every test stubs `fetch`, so CORS is structurally invisible to vitest.
5. Confirmed three sibling proxies (`esplora-proxy`, `lnurl-proxy`, `vss-proxy`) already exist for exactly this class of problem.

## Solution

Same-origin proxy in five layers.

**1. New Vercel function — hardcoded target, no forwarding** (`api/lqwd-proxy.ts`):

```ts
const LQWD_GET_INFO_URL = 'https://germany.lqwd.tech/api/v1/get_info'

export async function GET(): Promise<Response> {
  try {
    const upstream = await fetch(LQWD_GET_INFO_URL, {
      signal: AbortSignal.timeout(5_000),
    })
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
        'Cache-Control': 'no-store',
      },
    })
  } catch {
    return Response.json({ error: 'lqwd upstream unavailable' }, { status: 502 })
  }
}
```

No `_path` parameter, unlike `api/lnurl-proxy.ts` — the target is a constant, so the SSRF surface is zero.

**2. Vercel rewrite** (`vercel.json`):

```json
{ "source": "/api/lqwd/get_info", "destination": "/api/lqwd-proxy" }
```

**3. Vite dev proxy** (`vite.config.ts`):

```ts
'/api/lqwd/get_info': {
  target: 'https://germany.lqwd.tech',
  changeOrigin: true,
  rewrite: () => '/api/v1/get_info',
},
```

**4. Discovery client switches to relative URL** (`src/ldk/lsp/lqwd-discovery.ts`):

```ts
const LQWD_GET_INFO_URL = '/api/lqwd/get_info'
```

**5. CSP tightened** — `https://germany.lqwd.tech` removed from `connect-src` in both `vercel.json` and `index.html`. The browser now only ever talks to `'self'`; cross-origin egress lives on the server.

## Verification

```bash
# Dev server (Vite proxy)
pnpm dev
curl -i http://localhost:5173/api/lqwd/get_info
# -> HTTP/1.1 200 OK
# -> content-type: application/json
# -> {"uris":["032c9c76...@3.68.244.94:26000"], ...}

# Vercel preview (serverless function)
curl -i https://<preview>.vercel.app/api/lqwd/get_info
# -> 200 + JSON, Cache-Control: no-store
```

Browser: hard reload, open DevTools → Network → confirm `get_info` is same-origin, `200`, no `(blocked:cors)`. LSP resolver returns LQwD as primary; JIT invoice issuance succeeds end-to-end.

## Why It Slipped Through

The test suite mocked `globalThis.fetch`, so unit tests asserted parsing behaviour against fake responses and never actually crossed an origin. Pre-merge manual smoke used `curl`, which ignores CORS. Together that produced a perfect blind spot — both gates were strictly server-side, and the only environment that enforces CORS (a real browser on the deployed origin) was the one place we didn't check before merging.

## Prevention

### Default to proxy for new third-party endpoints

Any new third-party HTTPS endpoint called directly from the browser must be assumed CORS-hostile until proven otherwise — route it through our existing edge proxy (same pattern as the Esplora proxy) by default, and only inline a direct fetch after a documented browser-origin probe passes. The cost of an extra proxy hop is trivial compared to a silent receive-flow outage that only reproduces in a deployed browser, and the proxy gives us a single chokepoint for retries, header rewrites, and observability.

### Verify CORS at the smoke-test layer

Add a pre-merge smoke that hits the endpoint with a browser-shaped `Origin` header and asserts `Access-Control-Allow-Origin` is present. Server-side curl without `-H "Origin: ..."` will not surface the bug.

```bash
# Fails (exit 1) if ACAO is missing for our deployed origin
curl -sI -H "Origin: https://zinqq.app" "$ENDPOINT" \
  | grep -i '^access-control-allow-origin:' \
  || { echo "MISSING ACAO for $ENDPOINT"; exit 1; }
```

For Vitest, gate at least one integration test on a non-mocked fetch via `happy-dom` or a Playwright step that loads the real page and watches `page.on('requestfailed')`. `globalThis.fetch` mocks structurally cannot catch CORS, since CORS is enforced by the browser, not the fetch API.

### Diagnostic checklist for "fake 404"

- If DevTools shows 404 but `curl` returns 200, suspect CORS — the browser shows the failed preflight (often surfaced as 404/0/opaque), not the real GET.
- Check the Network tab for an `OPTIONS` request immediately preceding the "404"; a missing or non-2xx OPTIONS response is the smoking gun.
- Look for `Access-Control-Allow-Origin` in the response headers panel — its absence (not its value) is the failure mode.
- Re-run the request from the Console with `fetch(url, {mode: 'no-cors'})`; if it succeeds opaquely, the upstream is alive and CORS is the cause.

### When the upstream owner fixes CORS

The proxy is a thin transparent pass-through. If LQwD ships ACAO upstream, the migration is to flip `LQWD_GET_INFO_URL` in `lqwd-discovery.ts` back to absolute and re-add `https://germany.lqwd.tech` to `connect-src`. Leave the proxy route in place for one release as a fallback, then delete. The receive flow never sees the swap because it always calls `/api/lqwd/get_info`.

## Related Documentation

- [`docs/solutions/integration-issues/vss-cors-bypass-vite-proxy.md`](vss-cors-bypass-vite-proxy.md) — Closest precedent: identical CORS shape (upstream omits `Access-Control-Allow-Origin`, browser blocks preflight) solved by a Vite dev proxy that turns the call same-origin.
- [`docs/solutions/infrastructure/vercel-serverless-functions-not-deployed.md`](../infrastructure/vercel-serverless-functions-not-deployed.md) — Production half of the same VSS pattern. Documents the Vercel serverless proxy approach for a CORS-less upstream and the `vercel.json` SPA-rewrite negative-lookahead gotcha that any new `/api/*` proxy must respect.
- [`docs/solutions/infrastructure/vercel-serverless-functions-not-deployed.md`](../infrastructure/vercel-serverless-functions-not-deployed.md) — Critical deployment trap: catch-all `[...path].ts` files inside `api/` subdirectories silently fail to deploy under Vite/generic framework mode; flat `api/lnurl-proxy.ts`-style files plus rewrites are the working pattern.
- [`docs/solutions/infrastructure/blockstream-enterprise-esplora-proxy.md`](../infrastructure/blockstream-enterprise-esplora-proxy.md) — Sibling production proxy (`/api/esplora`) demonstrating the broader "browser → same-origin Vercel function → third-party endpoint" architecture this fix joins.
- [`docs/solutions/integration-issues/lsps2-jit-receive-channel-config.md`](lsps2-jit-receive-channel-config.md) — Broader LSPS integration context for the JIT flow whose `get_info` endpoint is the CORS-blocked call here.
- [`docs/solutions/integration-issues/pwa-workbox-vercel-csp-integration.md`](pwa-workbox-vercel-csp-integration.md) — Tangential CSP/SW reference: explains the `connect-src` CSP and the SPA-rewrite negative lookahead that excludes `/api/*` and SW assets — relevant because this fix removed the upstream host from CSP and avoided any Workbox runtime-cache entry.
