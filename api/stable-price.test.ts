import { afterEach, describe, expect, it, vi } from 'vitest'
import { GET } from './stable-price'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

afterEach(() => vi.unstubAllGlobals())
describe('fixed-market USD price endpoint', () => {
  it('loads the price handler in Node without a bundler resolving its imports', () => {
    const handlerUrl = pathToFileURL(resolve('api/stable-price.ts')).href
    const output = execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        `const { GET } = await import(${JSON.stringify(handlerUrl)}); console.log(typeof GET)`,
      ],
      { encoding: 'utf8', timeout: 5000 }
    )
    expect(output.trim()).toBe('function')
  })

  it('returns independent observations without caching an old price', async () => {
    const fetcher = vi.fn((url: string) => {
      const value = url.includes('bitstamp')
        ? { last: '100000' }
        : url.includes('kraken')
          ? { result: { XXBTZUSD: { c: ['100100'] } } }
          : url.includes('coinbase')
            ? { data: { amount: '99900' } }
            : null
      return Promise.resolve(Response.json(value, { status: value ? 200 : 503 }))
    })
    vi.stubGlobal('fetch', fetcher)
    const response = await GET()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({
      observations: [
        { source: 'Bitstamp', price: 100000 },
        { source: 'Kraken', price: 100100 },
        { source: 'Coinbase', price: 99900 },
      ],
    })
    expect(fetcher).toHaveBeenCalledTimes(6)
  })
  it('fails closed without a three-market quorum', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('market offline')))
    )
    expect((await GET()).status).toBe(503)
  })
})
