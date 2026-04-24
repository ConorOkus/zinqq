import type * as PdkModule from 'payjoin'

export type Pdk = typeof PdkModule.payjoin

let pdkPromise: Promise<Pdk> | null = null

export function loadPdk(): Promise<Pdk> {
  if (pdkPromise) return pdkPromise
  pdkPromise = (async () => {
    const mod = await import('payjoin')
    await mod.uniffiInitAsync()
    return mod.payjoin
  })()
  return pdkPromise
}
