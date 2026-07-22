---
title: 'Vercel serverless functions returning 404 — catch-all pattern not supported in generic framework mode'
category: infrastructure
date: 2026-03-27
tags:
  - vercel
  - serverless
  - deployment
  - cors-proxy
  - lnurl
  - vss
components:
  - api/lnurl-proxy
  - api/vss-proxy
severity: high
resolution_type: fix
---

## Problem

Lightning address resolution (`refund@lnurl.mutinynet.com`) failed in production at zinqq-app.vercel.app with "No Lightning Address or BIP 353 record found". Both `/api/lnurl-proxy/*` and `/api/vss-proxy/*` returned 404.

This doc is the canonical reference for the Vercel serverless proxy layout — it covers the deployment-pattern fix below plus (in "Why the VSS proxy works this way") the underlying reason a VSS proxy function exists at all.

## Root Cause

Two layered issues:

1. **Legacy function format**: The functions used `@vercel/node`'s `export default function handler(req: VercelRequest, res: VercelResponse)` pattern, which isn't detected by Vercel's Vite/generic framework adapter. Converting to Web Standard API (`export async function GET(request: Request)`) was necessary but not sufficient.

2. **Catch-all in subdirectory not supported**: Vercel's generic framework mode (`"framework": null`) does not detect catch-all route files (`[...path].ts` or `[[...path]].ts`) inside `api/` subdirectories. A flat `api/hello.ts` (a temporary diagnostic function, since removed) deployed fine, but `api/lnurl-proxy/[...path].ts` silently failed to deploy.

## Solution

Restructured to flat function files with Vercel rewrites:

**`api/lnurl-proxy.ts`** (flat file, no subdirectory):

```typescript
export async function GET(request: Request) {
  const url = new URL(request.url)
  const rest = url.searchParams.get('_path') ?? ''
  // Parse domain and path from _path, proxy to https://domain/path
}
```

**`vercel.json`** rewrites map path segments to query params. A third instance of the same pattern, `/api/esplora`, was added later for the Blockstream Enterprise proxy — same flat-file-plus-rewrite shape:

```json
{
  "framework": null,
  "rewrites": [
    { "source": "/api/esplora/:path(.*)", "destination": "/api/esplora-proxy?_path=:path" },
    { "source": "/api/lnurl-proxy/:path(.*)", "destination": "/api/lnurl-proxy?_path=:path" },
    { "source": "/api/vss-proxy/:path(.*)", "destination": "/api/vss-proxy?_path=:path" },
    {
      "source": "/((?!api/|sw\\.js|manifest\\.webmanifest|workbox-).*)",
      "destination": "/index.html"
    }
  ]
}
```

The SPA catch-all's negative lookahead has grown beyond just excluding `/api/`: it also excludes `sw.js`, `manifest.webmanifest`, and `workbox-*` chunks so the PWA service worker and its Workbox-generated assets are served as static files instead of being rewritten to `index.html`.

Client code is unchanged — still sends `/api/lnurl-proxy/domain/path`. The rewrite transparently converts to query params before the function receives the request.

Also removed `@vercel/node` dependency entirely.

## Why the VSS proxy works this way

The VSS proxy specifically (`api/vss-proxy.ts`) exists for reasons beyond the flat-file/rewrite pattern above:

- **Browser CORS**: The VSS server (Rust `vss-server`) does not send CORS headers, and it sits on a private/staging IP that must not appear in client-shipped code or be hit directly from the browser.
- **Edge runtime can't reach private IPs**: Vercel's Edge runtime (V8 isolates) cannot open connections to private networks — the proxy must run as a Node.js serverless function, not an Edge function. `api/vss-proxy.ts` has no `runtime: 'edge'` config, so it uses Vercel's default Node.js serverless runtime.
- **Protobuf bodies must be forwarded as raw bytes**: VSS requests/responses are binary protobuf. `api/vss-proxy.ts` reads the request body with `request.arrayBuffer()` and passes it straight through — never parsing it as JSON/text — because body-parsing middleware corrupts binary payloads.

### Env var split: `VSS_ORIGIN` vs `VSS_PROXY_TARGET`

These two are easy to conflate but serve different layers:

- **`VSS_ORIGIN`** — server-only env var, read by `api/vss-proxy.ts` (`process.env.VSS_ORIGIN`) at request time in the deployed Vercel function. Never exposed to the browser (no `VITE_` prefix). This is the actual VSS server origin.
- **`VSS_PROXY_TARGET`** — dev-only, read by `vite.config.ts` (`env.VSS_PROXY_TARGET`) to configure the Vite dev server's `/__vss_proxy` proxy target for local development. Not used in production at all — production requests go through the deployed `api/vss-proxy.ts` function, which reads `VSS_ORIGIN` instead.

## Diagnosis Steps

1. Confirmed BIP 353 DoH returns NXDOMAIN (expected — no DNS record)
2. Confirmed LNURL endpoint works directly: `curl https://lnurl.mutinynet.com/.well-known/lnurlp/refund` returns valid payRequest
3. Confirmed production proxy returns 404: `curl https://zinqq-app.vercel.app/api/lnurl-proxy/...` → 404
4. Created test `api/hello.ts` → deployed successfully, confirming Vercel CAN deploy functions
5. Concluded subdirectory catch-all patterns are the issue
6. Restructured to flat files + rewrites → proxy returns 200 with correct data

## Prevention

- **Use flat api/ files on Vercel**: Avoid catch-all patterns in subdirectories. Use Vercel rewrites to map complex URL patterns to flat functions.
- **Test function deployment**: After any api/ function changes, verify with `curl https://domain/api/endpoint` that the function is reachable before merging.
- **Set `"framework": null`** in vercel.json for non-framework projects to ensure generic function detection.

## Related

- [VSS CORS bypass via Vite proxy](../integration-issues/vss-cors-bypass-vite-proxy.md) — dev proxy setup
- PR: #56
