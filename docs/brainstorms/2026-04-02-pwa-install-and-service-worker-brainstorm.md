# Brainstorm: PWA Install Button & Service Worker

**Date:** 2026-04-02
**Status:** Ready for planning

## What We're Building

Two related features to make Zinq a proper Progressive Web App:

### 1. Install Button (Home Icon)

- A **house icon** in the **top-left** of the home screen
- Only visible when the app is **not** running as an installed PWA (detected via `display-mode: standalone` media query)
- Tapping it triggers the browser's native `beforeinstallprompt` flow
- Disappears once the app is installed or if the prompt isn't available

### 2. Service Worker with Update Detection

- **Precache app shell** (HTML, JS, CSS, fonts) for faster loads — exclude the 12MB WASM file (too large, changes rarely)
- **Runtime caching** for API responses with network-first strategy
- **Update detection** — when a new SW version is available, notify the app via `postMessage` so it can prompt "New version available, tap to refresh"
- LDK WASM stays in the main thread — the SW does not run the Lightning node

## Why This Approach

- **`vite-plugin-pwa`** (Workbox-based) handles the tricky SW lifecycle correctly out of the box — no reason to hand-roll a service worker for straightforward caching needs
- **No background sync or push notifications** for now — these add complexity (server infrastructure for push, deferred task patterns for sync) and can be layered on later
- **LDK stays in main thread** — the WASM module needs IndexedDB, network access, and tight React state integration; running it in a SW would be a massive architectural change with little benefit
- The existing CSP already allows `worker-src 'self' blob:`, so no header changes needed

## Key Decisions

1. **Install button placement:** Top-left of home screen, house icon, only when not installed as PWA
2. **PWA tooling:** `vite-plugin-pwa` with Workbox (not manual SW)
3. **Caching strategy:** Precache app shell (excluding WASM), network-first for API calls
4. **Update UX:** Show "update available" prompt when new SW version detected
5. **WASM exclusion:** The 12MB `liblightningjs.wasm` is not precached — it loads from network/browser cache
6. **App icons:** Generate from existing design (purple accent `#7c3aed`, app branding)
7. **No background sync or push** — deferred to future work

## Open Questions

None — all key decisions resolved.

## Future Considerations (Not In Scope)

- Web Push notifications for incoming payments (requires server infrastructure)
- Background Sync API for deferred actions
- Running LDK in a SW or shared worker
