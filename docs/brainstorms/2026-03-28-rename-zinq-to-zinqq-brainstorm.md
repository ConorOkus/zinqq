# Brainstorm: Rename zinq → zinqq

**Date:** 2026-03-28
**Status:** Ready for planning

## What We're Building

A full rebrand from **zinq** to **zinqq** across the entire project — source code, UI, configuration, documentation, deployment, and GitHub repository.

## Why This Approach

- **Domain availability:** `zinqq.app` (or similar) is available, `zinq.app` is not
- **Full rename chosen over partial:** Consistency matters — no split-brain where some layers say "zinq" and others say "zinqq"
- **No data migration needed:** Project is pre-launch on signet only, so no real user data to preserve

## Key Decisions

1. **Scope: Everything** — Code identifiers, UI strings, config, docs, and deployment URLs all get renamed
2. **No IndexedDB migration** — Just rename `zinq-ldk` → `zinqq-ldk` since this is signet-only with no real users
3. **GitHub repo rename included** — ConorOkus/zinq → ConorOkus/zinqq
4. **Display name:** `Zinqq` (title case) for UI, `zinqq` (lowercase) for identifiers
5. **Derived names follow the pattern:**
   - IndexedDB: `zinqq-ldk`
   - Web Lock: `zinqq-lock`
   - Invoice description: `Zinqq Wallet`
   - Offer description: `zinqq wallet`

## Scope of Changes

### Source Code (~7 files)

- `src/storage/idb.ts` — DB_NAME `zinq-ldk` → `zinqq-ldk`
- `src/ldk/init.ts` — Web Lock `zinq-lock` → `zinqq-lock`
- `src/ldk/context.tsx` — Invoice/offer descriptions
- `src/wallet/mnemonic.test.ts` — Test DB cleanup
- `src/onchain/storage/changeset.test.ts` — Test DB cleanup

### Config & Deployment (~2 files)

- `package.json` — Package name
- `proxy/wrangler.toml` — Allowed origins URL

### UI (~2 files)

- `index.html` — Page title
- `design/index.html` — Design prototype title

### Design Assets (~2 files)

- `design/styles.css` — Comment
- `design/app.js` — Comment

### Documentation (~20+ files)

- All plans, brainstorms, and solutions referencing "zinq"
- Update domain references: `zinq.vercel.app` → `zinqq.vercel.app`, `zinq.app` → `zinqq.app`

### Infrastructure

- GitHub repo rename: ConorOkus/zinq → ConorOkus/zinqq
- Vercel project rename / domain update
- Cloudflare worker allowed origins

## Open Questions

None — all key decisions resolved during brainstorming.
