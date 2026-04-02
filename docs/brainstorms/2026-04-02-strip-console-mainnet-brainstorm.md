# Brainstorm: Strip Console Output on Mainnet

**Date:** 2026-04-02
**Status:** Ready for planning

## What We're Building

Remove all `console.*` calls (log, warn, error, info, debug) from mainnet production builds using Vite's build-time stripping. Signet builds and dev mode remain unaffected.

## Why

- Mainnet users shouldn't see verbose internal logs in their browser console
- Reduces information leakage in production
- Zero runtime cost — calls are removed at compile time, not gated at runtime

## Approach: Build-Time Stripping via Vite/Terser

Configure Vite's Terser minifier (or esbuild equivalent) to drop all `console.*` calls when building for mainnet production.

**How it works:**

- Vite already sets `import.meta.env.PROD` in production builds
- The `VITE_NETWORK` env var is already loaded in `vite.config.ts` via `loadEnv(mode, ...)`
- When `VITE_NETWORK=mainnet` and mode is `production`, configure the minifier's `drop_console` (Terser) or `drop` (esbuild) option to strip all console methods
- No source code changes needed — all 159 `console.*` calls across 29 files are removed automatically

**Scope:**

- Strips: `console.log`, `console.warn`, `console.error`, `console.info`, `console.debug`
- Only on: `VITE_NETWORK=mainnet` + production mode
- Preserves: All console output in dev mode and signet production builds

## Key Decisions

1. **Strip everything including errors** — Completely silent mainnet console
2. **Build-time, not runtime** — No logger wrapper needed, no code changes to 29 files, zero runtime overhead
3. **Mainnet only** — Signet production builds keep console output for debugging
4. **Expand captureError coverage** — Wire up `captureError` at critical error/warn sites so failures are still persisted to IndexedDB even when console is stripped. This ensures mainnet debugging is still possible via the error log.

## Open Questions

None — requirements are clear.
