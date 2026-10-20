import { describe, expect, it } from 'vitest'
import { priceConsensus, validatePriceQuote } from './price'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'

describe('stable USD price consensus', () => {
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

  const observations = [
    { source: 'Coinbase', price: 100_000 },
    { source: 'Kraken', price: 100_100 },
    { source: 'Bitstamp', price: 99_900 },
    { source: 'Gemini', price: 150_000 },
  ]
  it('requires three independent markets and removes 5% outliers', () => {
    expect(priceConsensus(observations)).toEqual({
      priceCents: 10_000_000n,
      sources: ['Coinbase', 'Kraken', 'Bitstamp'],
    })
    expect(() => priceConsensus(observations.slice(0, 2))).toThrow(/three/i)
  })
  it('does not count duplicate market names as independent', () => {
    expect(() => priceConsensus([observations[0]!, observations[0]!, observations[0]!])).toThrow()
  })
  it('rejects stale quotes and implausible prices', () => {
    expect(() => validatePriceQuote({ observations, observedAt: 0 }, 61_000)).toThrow(/stale/i)
    expect(() => priceConsensus(observations.map((v) => ({ ...v, price: Infinity })))).toThrow()
  })
  it('quarantines a large move against a still-fresh anchor', () => {
    const first = validatePriceQuote({ observations, observedAt: 1_000 }, 1_000)
    expect(() =>
      validatePriceQuote(
        {
          observations: observations.map((v) => ({ ...v, price: v.price * 1.2 })),
          observedAt: 2_000,
        },
        2_000,
        first
      )
    ).toThrow(/move/i)
  })
})
