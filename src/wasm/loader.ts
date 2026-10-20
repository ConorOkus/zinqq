/**
 * Placeholder WASM loader utility.
 * Replace with actual wasm-pack output when Rust modules are ready.
 *
 * When wasm-pack generates bindings, use the generated `init()` function
 * and typed exports instead of this raw WebAssembly API wrapper:
 *   import init, { someExport } from '../pkg/wallet_crypto.js'
 */
export interface WasmExports {
  [key: string]: unknown
}

export async function initWasm(wasmPath: string): Promise<WasmExports> {
  // Only allow same-origin paths — reject absolute URLs and protocol-relative URLs
  if (/^[a-z][a-z0-9+\-.]*:/i.test(wasmPath) || wasmPath.startsWith('//')) {
    throw new Error(`initWasm: only same-origin paths are permitted, got: ${wasmPath}`)
  }

  const url = new URL(wasmPath, window.location.origin)
  if (url.origin !== window.location.origin) {
    throw new Error('initWasm: cross-origin WASM loading is not permitted')
  }

  const response = await fetch(url.toString())
  if (!response.ok) {
    throw new Error(`initWasm: fetch failed with status ${response.status} ${response.statusText}`)
  }

  const { instance } = await WebAssembly.instantiateStreaming(response)
  // instance.exports is intentionally typed as WasmExports (opaque until wasm-pack generates bindings)
  return instance.exports
}
