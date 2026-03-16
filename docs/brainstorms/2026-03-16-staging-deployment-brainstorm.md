# Brainstorm: Staging Deployment over Signet

**Date:** 2026-03-16
**Status:** Ready for planning

## What We're Building

A staging deployment of the browser wallet so others can test the app over Signet (Mutinynet). The app will be hosted on Vercel with automatic deploys on every push to `main`, plus PR preview deploys. A separate mainnet production deployment will come later once more features are added.

## Why This Approach

- **Vercel Git Integration** was chosen over GitHub Actions + Vercel CLI for simplicity — the app is a static Vite SPA and Vercel auto-detects this with zero config.
- **Vercel** was chosen over Cloudflare Pages/Netlify/GitHub Pages for its strong DX, automatic PR preview deploys, and solid WASM support.
- **Default Vercel URL** is sufficient for staging (no custom domain needed).
- **Existing dev WS proxy** (`ln-ws-proxy-dev.conor-okus.workers.dev`) will be reused — it's already deployed and appropriate for a staging environment.

## Key Decisions

1. **Hosting:** Vercel, using Git integration (auto-deploy on push to main)
2. **Deploy trigger:** Automatic on push to `main`, with PR preview deploys
3. **Domain:** Default Vercel URL (e.g., `browser-wallet.vercel.app`)
4. **WS Proxy:** Reuse existing dev proxy — update ALLOWED_ORIGINS for Vercel domain
5. **CSP:** No changes needed — `'self'` resolves to the serving domain
6. **Network:** Signet/Mutinynet only — network switching is out of scope for now
7. **Production (mainnet):** Deferred until more features are added

## Future Considerations (Out of Scope)

- **Mainnet production deploy:** Will need network config parameterization, separate env vars, production WS proxy with `ALLOWED_ORIGINS`, and stricter CSP
- **CI pipeline:** Could add GitHub Actions for tests/linting without changing the Vercel deploy flow
- **Custom domain:** Can be added later via Vercel dashboard + DNS config
