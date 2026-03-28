---
title: Vercel staging deployment with VSS serverless proxy
category: infrastructure
date: 2026-03-26
tags: [vercel, vss, serverless, proxy, cors, protobuf, deployment]
modules: [api/vss-proxy, src/ldk/config, vercel.json]
---

# Vercel Staging Deployment with VSS Serverless Proxy

## Problem

Deploying the browser wallet to Vercel as a staging environment required proxying VSS (Versioned Storage Service) requests because the VSS server does not send CORS headers. The VSS server is at a private IP that must not appear in the repo.

## Root Cause

Three interacting issues made this harder than expected:

1. **CORS** — The VSS server (vss-server in Rust) does not emit CORS headers. Browsers block cross-origin protobuf POST requests.
2. **Private IP** — Static Vercel rewrites hardcode the destination URL in `vercel.json`, which is committed to GitHub. A serverless function reading from env vars was needed.
3. **Vercel body parsing + path routing** — Two Vercel platform behaviors caused bugs:
   - Vercel's default body parser corrupts `application/octet-stream` protobuf payloads. Must use `bodyParser: false` with `buffer()` from `node:stream/consumers`.
   - `req.query.path` is undefined in catch-all `[...path].ts` routes. Must parse path segments from `req.url` instead.
   - The SPA catch-all rewrite `/(.*) → /index.html` intercepts `/api/*` routes. Must use negative lookahead: `/((?!api/).*)`.
   - Edge Runtime cannot reach private IPs (403). Must use Node.js serverless runtime.

## Solution

### 1. Serverless function (`api/vss-proxy/[...path].ts`)

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { buffer } from 'node:stream/consumers'

export const config = { api: { bodyParser: false } }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const vssOrigin = process.env.VSS_ORIGIN // Server-side only, not in repo
  const urlPath = (req.url ?? '').split('?')[0]
  const segments = urlPath.replace(/^\/api\/vss-proxy\/?/, '')
  const targetUrl = `${vssOrigin}/vss/${segments}`

  const body = await buffer(req) // Raw binary, no parsing

  const upstream = await fetch(targetUrl, {
    method: req.method,
    headers: { 'Content-Type': req.headers['content-type'] ?? 'application/octet-stream' },
    body: req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
    signal: AbortSignal.timeout(15_000),
  })

  res.status(upstream.status)
  res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/octet-stream')
  res.setHeader('Cache-Control', 'no-store')
  res.send(Buffer.from(await upstream.arrayBuffer()))
}
```

### 2. SPA catch-all excludes `/api/` (`vercel.json`)

```json
"rewrites": [{ "source": "/((?!api/).*)", "destination": "/index.html" }]
```

### 3. Client config defaults to serverless path (`src/ldk/config.ts`)

```typescript
vssUrl: (import.meta.env.VITE_VSS_URL as string | undefined) ?? '/api/vss-proxy',
```

Local dev overrides via `VITE_VSS_URL=/__vss_proxy/vss` in `.env` to use the Vite dev proxy.

### 4. Vercel environment variables (dashboard, not committed)

- `VSS_ORIGIN` — Private VSS server URL (Production + Preview)
- `VITE_WS_PROXY_URL` — WebSocket proxy URL (Production only)

### 5. ESLint config

`api/` directory excluded from ESLint (separate Node.js runtime, not part of Vite app tsconfig):

```javascript
{
  ignores: ['dist/**', 'node_modules/**', 'proxy/**', 'design/**', 'api/**']
}
```

## Key Gotchas

| Gotcha                                         | Symptom                                | Fix                                                              |
| ---------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------- |
| Vercel body parser corrupts protobuf           | VSS returns 400                        | `bodyParser: false` + `buffer(req)` from `node:stream/consumers` |
| `req.query.path` undefined in catch-all routes | VSS returns 400 "Invalid request path" | Parse from `req.url` instead                                     |
| SPA rewrite catches `/api/*`                   | 405 Method Not Allowed on POST         | Negative lookahead: `/((?!api/).*)`                              |
| Edge Runtime can't reach private IPs           | 403 Forbidden                          | Use Node.js serverless runtime                                   |
| Passthrough rewrite `/api/(.*)` → `/api/$1`    | Still 405                              | Doesn't work — use negative lookahead instead                    |

## Prevention

- Before adding a Vercel serverless function that handles binary data, always set `bodyParser: false` and use `buffer()` from `node:stream/consumers` — never rely on `req.body` for `application/octet-stream`.
- Always parse URL paths from `req.url`, not `req.query.path`, in Vercel catch-all routes.
- Test serverless functions with `curl` before relying on browser testing — isolates proxy issues from client issues.
- If the upstream is a private IP, do not use Vercel Edge Runtime (V8 isolates can't reach private networks).
