import type * as PdkModule from 'payjoin'

export type Pdk = typeof PdkModule.payjoin

/**
 * PDK browser-entry loader.
 *
 * Currently rejects unconditionally. The vendored PDK build
 * (`payjoin-1.0.0-rc.2`) ships `dist/index.web.js` whose wasm-bindgen
 * output was generated with `--target nodejs` (via ubrn). The
 * resulting wasm-bindgen `index.js` uses `require('fs').readFileSync`
 * to load the wasm bytes — Node-only — and the matching `index_bg.js`
 * companion file Vite needs is not produced. Rollup fails the
 * production build with `Could not resolve "./index_bg.js" from
 * "...index_bg.wasm"`.
 *
 * Until the build script invokes wasm-bindgen with `--target web` (or
 * a runtime fetch loader is wrapped around the existing artefact),
 * `loadPdk()` rejects with a `pdk_load` reason. `tryPayjoinSend`
 * catches the rejection and falls back to broadcasting the original
 * PSBT, so on-chain sends continue to succeed — they just aren't
 * Payjoin-coordinated.
 *
 * Tracked in todo: pdk-browser-wasm-loader (TBD #).
 */
export function loadPdk(): Promise<Pdk> {
  return Promise.reject(
    new Error('Payjoin PDK browser loader not yet wired (see pdk.ts header comment)')
  )
}
