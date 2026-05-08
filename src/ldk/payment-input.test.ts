import { describe, it, expect, vi } from 'vitest'

// Mock lightningdevkit since we can't load WASM in tests
vi.mock('lightningdevkit', () => {
  class MockHumanReadableName {
    _user: string
    _domain: string
    constructor(user: string, domain: string) {
      this._user = user
      this._domain = domain
    }
    user() {
      return this._user
    }
    domain() {
      return this._domain
    }
  }

  class Result_OK {
    res: MockHumanReadableName
    constructor(res: MockHumanReadableName) {
      this.res = res
    }
  }

  class Result_Err {}

  // Classes used for instanceof checks — define once, reuse in mock and export
  class Option_u64Z_Some {
    some: bigint
    constructor(val: bigint) {
      this.some = val
    }
  }

  class Bolt11InvoiceResult_OK {
    res: unknown
    constructor(res: unknown) {
      this.res = res
    }
  }

  // Minimal mock invoice for BIP 321 + lightning= tests
  const TEST_BOLT11 = 'lnbc50u1ptest'
  class MockBolt11Invoice {
    currency() {
      return 'bitcoin'
    }
    would_expire() {
      return false
    }
    amount_milli_satoshis() {
      return new Option_u64Z_Some(50_000_000n)
    }
    into_signed_raw() {
      return {
        raw_invoice: () => ({
          description: () => ({ to_str: () => 'Test invoice' }),
        }),
      }
    }
  }

  return {
    Bolt11Invoice: {
      constructor_from_str: (raw: string) =>
        raw === TEST_BOLT11
          ? new Bolt11InvoiceResult_OK(new MockBolt11Invoice())
          : new Result_Err(),
    },
    Offer: { constructor_from_str: () => new Result_Err() },
    HumanReadableName: {
      constructor_from_encoded: (encoded: string) => {
        const atIndex = encoded.indexOf('@')
        if (atIndex === -1 || atIndex === 0 || atIndex === encoded.length - 1) {
          return new Result_Err()
        }
        const user = encoded.slice(0, atIndex)
        const domain = encoded.slice(atIndex + 1)
        return new Result_OK(new MockHumanReadableName(user, domain))
      },
    },
    Currency: { LDKCurrency_Bitcoin: 'bitcoin' },
    Network: { LDKNetwork_Bitcoin: 0 },
    Option_u64Z_Some,
    Option_AmountZ_Some: class {},
    Amount_Bitcoin: class {},
    Result_Bolt11InvoiceParseOrSemanticErrorZ_OK: Bolt11InvoiceResult_OK,
    Result_OfferBolt12ParseErrorZ_OK: class {},
    Result_HumanReadableNameNoneZ_OK: Result_OK,
  }
})

// Mock lnurl module to avoid circular dependency issues
vi.mock('../lnurl/resolve-lnurl', () => ({
  type: {} as never, // type-only import, no runtime needed
}))

describe('classifyPaymentInput — on-chain addresses', () => {
  it('accepts mainnet bech32 address', async () => {
    const { classifyPaymentInput } = await import('./payment-input')
    const result = classifyPaymentInput('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')
    expect(result.type).toBe('onchain')
  })

  it('accepts mainnet P2PKH address', async () => {
    const { classifyPaymentInput } = await import('./payment-input')
    const result = classifyPaymentInput('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')
    expect(result.type).toBe('onchain')
  })

  it('accepts mainnet P2SH address', async () => {
    const { classifyPaymentInput } = await import('./payment-input')
    const result = classifyPaymentInput('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')
    expect(result.type).toBe('onchain')
  })

  it('rejects signet address on mainnet', async () => {
    const { classifyPaymentInput } = await import('./payment-input')
    const result = classifyPaymentInput('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')
    expect(result.type).toBe('error')
  })
})

describe('classifyPaymentInput — BIP 321 URI validation', () => {
  it('accepts BIP 321 URI with mainnet address', async () => {
    const { classifyPaymentInput } = await import('./payment-input')
    const result = classifyPaymentInput(
      'bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq?amount=0.001'
    )
    expect(result.type).toBe('onchain')
    if (result.type === 'onchain') {
      expect(result.address).toBe('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')
      expect(result.amountSats).toBe(100_000n)
    }
  })

  it('rejects BIP 321 URI with signet address on mainnet', async () => {
    const { classifyPaymentInput } = await import('./payment-input')
    const result = classifyPaymentInput('bitcoin:tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')
    expect(result.type).toBe('error')
    if (result.type === 'error') {
      expect(result.message).toContain('different Bitcoin network')
    }
  })

  it('extracts bolt11 from BIP 321 URI with lightning= parameter', async () => {
    const { classifyPaymentInput } = await import('./payment-input')
    const result = classifyPaymentInput(
      'bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq?lightning=lnbc50u1ptest'
    )
    expect(result.type).toBe('bolt11')
    if (result.type === 'bolt11') {
      expect(result.raw).toBe('lnbc50u1ptest')
      expect(result.amountMsat).toBe(50_000_000n)
    }
  })

  it('prefers lightning= over onchain address in BIP 321 URI', async () => {
    const { classifyPaymentInput } = await import('./payment-input')
    const result = classifyPaymentInput(
      'bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq?amount=0.001&lightning=lnbc50u1ptest'
    )
    // Should return bolt11, not onchain — lightning takes precedence
    expect(result.type).toBe('bolt11')
  })

  it('rejects BIP 321 URI with malformed %-sequence in query', async () => {
    const { classifyPaymentInput } = await import('./payment-input')
    const result = classifyPaymentInput(
      'bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq?amount=0.00%ZZ'
    )
    expect(result.type).toBe('error')
    if (result.type === 'error') {
      expect(result.message).toContain('Malformed')
    }
  })
})

describe('classifyPaymentInput — BIP 321 pj= / pjos= (Payjoin)', () => {
  const ADDR = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'

  it('attaches payjoin context when pj= is present', async () => {
    const { classifyPaymentInput } = await import('./payment-input')
    const pjUrl = 'https://btcpay.example/payjoin/xyz'
    const result = classifyPaymentInput(
      `bitcoin:${ADDR}?pj=${encodeURIComponent(pjUrl)}`
    )
    expect(result.type).toBe('onchain')
    if (result.type === 'onchain') {
      expect(result.payjoin?.url).toBe(pjUrl)
      expect(result.payjoin?.strict).toBe(false)
    }
  })

  it('parses pj= case-insensitively (PJ=)', async () => {
    const { classifyPaymentInput } = await import('./payment-input')
    const pjUrl = 'https://btcpay.example/payjoin/xyz'
    const result = classifyPaymentInput(
      `bitcoin:${ADDR}?PJ=${encodeURIComponent(pjUrl)}`
    )
    expect(result.type).toBe('onchain')
    if (result.type === 'onchain') {
      expect(result.payjoin?.url).toBe(pjUrl)
    }
  })

  it('drops empty pj= silently (no payjoin attached)', async () => {
    const { classifyPaymentInput } = await import('./payment-input')
    const result = classifyPaymentInput(`bitcoin:${ADDR}?pj=`)
    expect(result.type).toBe('onchain')
    if (result.type === 'onchain') {
      expect(result.payjoin).toBeUndefined()
    }
  })

  it('attaches strict:true when pjos=0 is present', async () => {
    const { classifyPaymentInput } = await import('./payment-input')
    const pjUrl = 'https://btcpay.example/payjoin/xyz'
    const result = classifyPaymentInput(
      `bitcoin:${ADDR}?pj=${encodeURIComponent(pjUrl)}&pjos=0`
    )
    expect(result.type).toBe('onchain')
    if (result.type === 'onchain') {
      expect(result.payjoin?.url).toBe(pjUrl)
      expect(result.payjoin?.strict).toBe(true)
    }
  })

  it('preserves literal `+` in pj= (BIP 77 v2 fragment separator regression)', async () => {
    // BIP 77 v2 receiver-session URLs use `+` as a fragment separator between
    // receiver-key, OHTTP config, and expiry segments. Manual RFC 3986 parsing
    // (vs URLSearchParams) ensures `+` is preserved as a literal byte.
    // Regression test for solution doc bip321-pj-urlsearchparams-plus-corruption.md.
    const { classifyPaymentInput } = await import('./payment-input')
    const pjUrl =
      'HTTPS://PAYJO.IN/LANG586Q3F5PQ#RK1QD9PE26NCQN0GL99F23V3ADZGZ44CFLA8FX998LMKLX6VSL7DEDP2+OH1QYPFLM8XL59R0XV4VGPLS7FRDSSM4TUXL07TXCWC4S0GLVLNK2SE4NQ+EX1M560Z6G'
    const encoded = pjUrl
      .replace(/:/g, '%3A')
      .replace(/\//g, '%2F')
      .replace(/#/g, '%23')
    // `+` is left unencoded — it's not a reserved char in the path/fragment per RFC 3986,
    // and represents the real-world wire format we receive from QR scans.
    const result = classifyPaymentInput(`bitcoin:${ADDR}?pj=${encoded}`)
    expect(result.type).toBe('onchain')
    if (result.type === 'onchain') {
      expect(result.payjoin?.url).toBe(pjUrl)
    }
  })

  it('drops pj= values at or above the 2048-byte length cap', async () => {
    const { classifyPaymentInput } = await import('./payment-input')
    const at2047 = 'https://x/' + 'a'.repeat(2047 - 'https://x/'.length)
    const at2048 = 'https://x/' + 'a'.repeat(2048 - 'https://x/'.length)
    expect(at2047.length).toBe(2047)
    expect(at2048.length).toBe(2048)

    const r1 = classifyPaymentInput(`bitcoin:${ADDR}?pj=${encodeURIComponent(at2047)}`)
    expect(r1.type).toBe('onchain')
    if (r1.type === 'onchain') expect(r1.payjoin?.url).toBe(at2047)

    const r2 = classifyPaymentInput(`bitcoin:${ADDR}?pj=${encodeURIComponent(at2048)}`)
    expect(r2.type).toBe('onchain')
    if (r2.type === 'onchain') expect(r2.payjoin).toBeUndefined()
  })

  it('drops payjoin when lightning= is present (Lightning takes precedence)', async () => {
    // BIP 321 preference: BOLT 12 > BOLT 11 > on-chain. Payjoin attaches only
    // to the on-chain branch, so a URI carrying both lightning= and pj= routes
    // through the Lightning path with no payjoin context.
    const { classifyPaymentInput } = await import('./payment-input')
    const pjUrl = 'https://btcpay.example/payjoin/xyz'
    const result = classifyPaymentInput(
      `bitcoin:${ADDR}?lightning=lnbc50u1ptest&pj=${encodeURIComponent(pjUrl)}`
    )
    expect(result.type).toBe('bolt11')
    // bolt11 variant has no payjoin field — that's the expected behavior.
  })
})

describe('classifyPaymentInput — BIP 353', () => {
  it('parses user@domain as bip353', async () => {
    const { classifyPaymentInput } = await import('./payment-input')
    const result = classifyPaymentInput('alice@example.com')
    expect(result.type).toBe('bip353')
    if (result.type === 'bip353') {
      expect(result.raw).toBe('alice@example.com')
    }
  })

  it('strips ₿ prefix from BIP 353 address', async () => {
    const { classifyPaymentInput } = await import('./payment-input')
    const result = classifyPaymentInput('₿alice@example.com')
    expect(result.type).toBe('bip353')
    if (result.type === 'bip353') {
      expect(result.raw).toBe('alice@example.com')
    }
  })

  it('rejects plain text that is not user@domain', async () => {
    const { classifyPaymentInput } = await import('./payment-input')
    const result = classifyPaymentInput('just-some-text')
    expect(result.type).toBe('error')
  })

  it('classifies on-chain addresses correctly', async () => {
    const { classifyPaymentInput } = await import('./payment-input')
    const result = classifyPaymentInput('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')
    expect(result.type).toBe('onchain')
  })

  it('handles user@domain with dots and hyphens in user part', async () => {
    const { classifyPaymentInput } = await import('./payment-input')
    const result = classifyPaymentInput('my.name-test@example.com')
    expect(result.type).toBe('bip353')
  })

  it('handles subdomains in domain part', async () => {
    const { classifyPaymentInput } = await import('./payment-input')
    const result = classifyPaymentInput('alice@pay.example.co.uk')
    expect(result.type).toBe('bip353')
  })
})
