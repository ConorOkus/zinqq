import { afterEach, describe, expect, it, vi } from 'vitest'
import { GET } from './stable-price'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'

afterEach(() => vi.unstubAllGlobals())
describe('fixed-market USD price endpoint', () => {
  it('loads the compiled price handler in Node without a bundler resolving its imports', () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'zinq-price-handler-'))
    try {
      writeFileSync(join(outputDir, 'package.json'), JSON.stringify({ type: 'module' }))
      for (const file of ['api/stable-price', 'src/stable/price']) {
        const compiled = transpileModule(readFileSync(resolve(`${file}.ts`), 'utf8'), {
          fileName: `${file}.ts`,
          compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
        })
        const destination = join(outputDir, `${file}.js`)
        mkdirSync(dirname(destination), { recursive: true })
        writeFileSync(destination, compiled.outputText)
      }
      const handlerUrl = pathToFileURL(join(outputDir, 'api/stable-price.js')).href
      const output = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `const { GET } = await import(${JSON.stringify(handlerUrl)}); console.log(typeof GET)`,
        ],
        { encoding: 'utf8', timeout: 5000 }
      )
      expect(output.trim()).toBe('function')
    } finally {
      rmSync(outputDir, { recursive: true, force: true })
    }
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
