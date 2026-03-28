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

## Root Cause

Two layered issues:

1. **Legacy function format**: The functions used `@vercel/node`'s `export default function handler(req: VercelRequest, res: VercelResponse)` pattern, which isn't detected by Vercel's Vite/generic framework adapter. Converting to Web Standard API (`export async function GET(request: Request)`) was necessary but not sufficient.

2. **Catch-all in subdirectory not supported**: Vercel's generic framework mode (`"framework": null`) does not detect catch-all route files (`[...path].ts` or `[[...path]].ts`) inside `api/` subdirectories. A flat `api/hello.ts` deployed fine, but `api/lnurl-proxy/[...path].ts` silently failed to deploy.

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

**`vercel.json`** rewrites map path segments to query params:

```json
{
  "framework": null,
  "rewrites": [
    { "source": "/api/lnurl-proxy/:path(.*)", "destination": "/api/lnurl-proxy?_path=:path" },
    { "source": "/api/vss-proxy/:path(.*)", "destination": "/api/vss-proxy?_path=:path" },
    { "source": "/((?!api/).*)", "destination": "/index.html" }
  ]
}
```

Client code is unchanged — still sends `/api/lnurl-proxy/domain/path`. The rewrite transparently converts to query params before the function receives the request.

Also removed `@vercel/node` dependency entirely.

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

- [Vercel staging VSS proxy](vercel-staging-vss-serverless-proxy.md) — original VSS proxy setup
- [VSS CORS bypass via Vite proxy](../integration-issues/vss-cors-bypass-vite-proxy.md) — dev proxy setup
- PR: #56
