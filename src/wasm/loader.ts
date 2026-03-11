/**
 * Placeholder WASM loader utility.
 * Replace with actual wasm-pack output when Rust modules are ready.
 */
export interface WasmExports {
  [key: string]: unknown
}

export async function initWasm(wasmUrl: string): Promise<WasmExports> {
  const response = await fetch(wasmUrl)
  const { instance } = await WebAssembly.instantiateStreaming(response)
  return instance.exports as WasmExports
}
