---
title: "feat: Deploy staging environment to Vercel over Signet"
type: feat
status: completed
date: 2026-03-16
origin: docs/brainstorms/2026-03-16-staging-deployment-brainstorm.md
---

# feat: Deploy staging environment to Vercel over Signet

## Overview

Deploy the browser wallet as a staging environment on Vercel so others can test over Signet (Mutinynet). Auto-deploys on push to `main` with PR preview deploys.

## What Changed

- **`vercel.json`** — Build config, SPA catch-all rewrite, security headers (matching dev server + HSTS)
- **`proxy/wrangler.toml`** — Added Vercel URL placeholder to `env.dev` ALLOWED_ORIGINS
- **`.env.example`** — Documents `VITE_WS_PROXY_URL` for contributors

## Manual Setup After Merge

1. Connect repo to Vercel at vercel.com/new
2. Note the project URL
3. Set `VITE_WS_PROXY_URL=wss://ln-ws-proxy-dev.conor-okus.workers.dev` (Production only)
4. Replace `VERCEL_URL_HERE` in `proxy/wrangler.toml` with actual URL, redeploy proxy

## Key Design Decisions

- **No CSP changes** — `'self'` resolves to the serving domain; external domains already listed
- **Preview deploys use public proxy** — `VITE_WS_PROXY_URL` set for Production only; previews fall back to `wss://p.mutinynet.com`
- **HSTS added** — appropriate for production HTTPS, not in dev server config
