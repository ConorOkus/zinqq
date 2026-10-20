import { initializeWasmFromBinary } from 'lightningdevkit'

const READY = Symbol.for('zinq.test.ldk-wasm-ready')
type Initializer = typeof initializeWasmFromBinary & { [READY]?: Promise<void> }

/** External bindings may survive Vitest's file isolation. Never replace their live memory. */
export function initializeTestLdk(): Promise<void> {
  const initialize = initializeWasmFromBinary as Initializer
  if (!initialize[READY]) {
    initialize[READY] = (async () => {
      const module = 'node:fs'
      const fs = (await import(/* @vite-ignore */ module)) as {
        readFileSync(path: string): Uint8Array
      }
      await initialize(
        new Uint8Array(fs.readFileSync('node_modules/lightningdevkit/liblightningjs.wasm'))
      )
    })()
  }
  return initialize[READY]
}
