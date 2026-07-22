---
title: VSS server CORS bypass via Vite dev proxy
category: integration-issues
date: 2026-03-19
tags: [vss, cors, vite, proxy, development]
---

## Problem

Connecting to a new VSS server endpoint (`http://98.207.69.189:52146/vss`) from the browser triggers two sequential errors:

1. **CSP block** — `connect-src` doesn't include the new origin.
2. **CORS block** — Even after adding the origin to CSP, the VSS server doesn't return `Access-Control-Allow-Origin` headers, so the browser blocks the preflight `OPTIONS` response.

## Root Cause

The VSS server (rust `vss-server`) does not set CORS headers. This is a server-side configuration issue, but we can't control the server's CORS policy.

## Solution

Proxy VSS requests through Vite's dev server so they become same-origin, bypassing both CSP and CORS:

**`vite.config.ts`** — Add a proxy rule, target driven by env var (the real target lives in the untracked `.env`, defaulting to a local dev server):

```ts
proxy: {
  '/__vss_proxy': {
    target: env.VSS_PROXY_TARGET ?? 'http://localhost:8080',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/__vss_proxy/, ''),
  },
},
```

**`src/ldk/config.ts`** — `vssUrl` defaults unconditionally to `/api/vss-proxy` (a Vercel serverless function that proxies to the real VSS server in production); dev overrides via `VITE_VSS_URL=/__vss_proxy/vss` in `.env` (see `.env.example`) to route through the Vite dev proxy instead:

```ts
vssUrl: ((import.meta.env.VITE_VSS_URL as string | undefined) ?? DEFAULTS.vssUrl).trim(),
// DEFAULTS.vssUrl = '/api/vss-proxy'
```

No CSP changes needed — proxied requests are same-origin (`'self'`).

## Prevention

- When connecting to a new external API from the browser, check CORS support first with `curl -I -X OPTIONS <url>`.
- Prefer Vite proxy for development over CSP allowlisting raw IPs — it's cleaner and avoids leaking test infrastructure into the HTML.
- **Resolved for production**: rather than requiring the VSS server itself to grow CORS headers, production proxies through `api/vss-proxy.ts` (a Node serverless function) plus the `vercel.json` rewrite — see [Vercel serverless functions not deployed](../infrastructure/vercel-serverless-functions-not-deployed.md) for the full serverless proxy layout.
