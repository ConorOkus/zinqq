/* eslint-disable @typescript-eslint/unbound-method -- vi.mocked() takes references to static mock methods */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { KeysManager } from 'lightningdevkit'
import type { Wallet } from '@bitcoindevkit/bdk-wallet-web'
import {
  attemptSubsidizedSweep,
  selectSubsidyInputs,
  listConfirmedP2wpkhUtxos,
  MAX_SUBSIDY_INPUTS,
  type SubsidizedSweepParams,
} from './subsidized-sweep'
import {
  serializePsbt,
  serializeTxOut,
  writeVarint,
  type ParsedPsbt,
  type ForeignInput,
} from './psbt-surgery'
import { hexToBytes } from './utils'
import { UtilMethods } from 'lightningdevkit'
import { broadcastWithRetry } from './traits/broadcaster'

const state = vi.hoisted(() => ({
  feeOverride: null as bigint | null,
  fakeTxid: 'ab'.repeat(32),
}))

vi.mock('../storage/error-log', () => ({ captureError: vi.fn() }))

vi.mock('../onchain/address-utils', () => ({
  revealNextAddress: vi.fn(() => {
    const script = new Uint8Array(22)
    script[1] = 0x14
    script.fill(0xcc, 2)
    return script
  }),
}))

vi.mock('./traits/broadcaster', () => ({
  broadcastWithRetry: vi.fn(() => Promise.resolve(state.fakeTxid)),
}))

vi.mock('lightningdevkit', () => {
  class Result_SpendableOutputDescriptorDecodeErrorZ_OK {
    res: unknown
    constructor(res: unknown) {
      this.res = res
    }
  }
  class Result_C2Tuple_CVec_u8Zu64ZNoneZ_OK {
    res: { get_a: () => Uint8Array; get_b: () => bigint }
    constructor(res: { get_a: () => Uint8Array; get_b: () => bigint }) {
      this.res = res
    }
  }
  class Result_CVec_u8ZNoneZ_OK {
    res: Uint8Array
    constructor(res: Uint8Array) {
      this.res = res
    }
  }
  class SpendableOutputDescriptor {
    static constructor_read(bytes: Uint8Array) {
      if (bytes[0] === 0xff) return { err: 'decode-failure' }
      // Fresh object per decode so identity comparisons detect reuse.
      return new Result_SpendableOutputDescriptorDecodeErrorZ_OK({ marker: bytes[0] })
    }
  }
  return {
    Result_SpendableOutputDescriptorDecodeErrorZ_OK,
    Result_C2Tuple_CVec_u8Zu64ZNoneZ_OK,
    Result_CVec_u8ZNoneZ_OK,
    SpendableOutputDescriptor,
    UtilMethods: {
      constructor_SpendableOutputDescriptor_create_spendable_outputs_psbt: vi.fn(),
    },
    Option_u32Z: { constructor_none: () => ({}) },
  }
})

vi.mock('@bitcoindevkit/bdk-wallet-web', async () => {
  const surgery = await import('./psbt-surgery')

  function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }

  class Psbt {
    private readonly parsed: ReturnType<typeof surgery.parsePsbt>

    private constructor(parsed: ReturnType<typeof surgery.parsePsbt>) {
      this.parsed = parsed
    }

    static from_string(base64: string): Psbt {
      // Mimics BDK by round-tripping through the real (golden-vector-pinned)
      // parser, so malformed surgery output still fails loudly in tests.
      return new Psbt(surgery.parsePsbt(base64ToBytes(base64)))
    }

    fee_amount(): { to_sat: () => bigint } | undefined {
      if (state.feeOverride !== null) {
        const value = state.feeOverride
        return { to_sat: () => value }
      }
      const inputSum = surgery
        .readWitnessUtxoValues(this.parsed)
        .reduce((sum: bigint, v: bigint) => sum + v, 0n)
      const outputSum = this.parsed.unsignedTx.outputs.reduce(
        (sum: bigint, o: { valueSats: bigint }) => sum + o.valueSats,
        0n
      )
      return { to_sat: () => inputSum - outputSum }
    }

    extract_tx() {
      return {
        compute_txid: () => ({ toString: () => state.fakeTxid }),
        to_bytes: () => Uint8Array.from([0xaa, 0xbb]),
      }
    }
  }

  class SignOptions {
    trust_witness_utxo = false
  }

  return { Psbt, SignOptions }
})

const DEST_SCRIPT = hexToBytes('0014dddddddddddddddddddddddddddddddddddddddd')
const WALLET_SCRIPT = hexToBytes('0014eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')

/** Compose real PSBT bytes the way LDK's create_spendable_outputs_psbt would. */
function buildFakeLdkPsbt(inputValueSats: bigint, outputValueSats: bigint): Uint8Array {
  const witnessUtxoMap = (valueSats: bigint) => {
    const txout = serializeTxOut({ valueSats, scriptPubkey: WALLET_SCRIPT })
    const parts = [
      writeVarint(1n),
      Uint8Array.from([0x01]),
      writeVarint(BigInt(txout.length)),
      txout,
      Uint8Array.from([0x00]),
    ]
    const total = parts.reduce((s, p) => s + p.length, 0)
    const map = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
      map.set(part, offset)
      offset += part.length
    }
    return map
  }

  const psbt: ParsedPsbt = {
    otherGlobalKvs: [],
    unsignedTx: {
      version: 2,
      inputs: [{ prevTxid: new Uint8Array(32).fill(0x77), vout: 0, sequence: 0xffffffff }],
      outputs: [{ valueSats: outputValueSats, scriptPubkey: DEST_SCRIPT }],
      locktime: 0,
    },
    inputMaps: [witnessUtxoMap(inputValueSats)],
    outputMaps: [Uint8Array.from([0x00])],
  }
  return serializePsbt(psbt)
}

function makeWallet(utxoValues: bigint[], { confirmed = true, signResult = true } = {}): Wallet {
  return {
    list_unspent: () =>
      utxoValues.map((valueSats, index) => ({
        outpoint: { txid: { toString: () => index.toString(16).padStart(64, '0') }, vout: 0 },
        txout: {
          script_pubkey: { as_bytes: () => WALLET_SCRIPT },
          value: { to_sat: () => valueSats },
        },
      })),
    get_tx: () => ({ chain_position: { is_confirmed: confirmed } }),
    sign: vi.fn(() => signResult),
  } as unknown as Wallet
}

function makeKeysManager() {
  const signCalls: unknown[][] = []
  const keysManager = {
    sign_spendable_outputs_psbt: vi.fn((descriptors: unknown[], psbt: Uint8Array) => {
      signCalls.push(descriptors)
      const Result_CVec_u8ZNoneZ_OK = signResultClass
      return new Result_CVec_u8ZNoneZ_OK(psbt)
    }),
  }
  return { keysManager: keysManager as unknown as KeysManager, signCalls }
}

// Resolved in beforeEach from the mocked module (hoisting prevents top-level import use).
let signResultClass: new (res: Uint8Array) => unknown
let createPsbtOkClass: new (res: { get_a: () => Uint8Array; get_b: () => bigint }) => unknown

function mockCreatePsbt(psbtBytes: Uint8Array, weightWu: bigint) {
  vi.mocked(
    UtilMethods.constructor_SpendableOutputDescriptor_create_spendable_outputs_psbt
  ).mockReturnValue(
    new createPsbtOkClass({ get_a: () => psbtBytes, get_b: () => weightWu }) as never
  )
}

function baseParams(overrides: Partial<SubsidizedSweepParams> = {}): SubsidizedSweepParams {
  return {
    keysManager: makeKeysManager().keysManager,
    bdkWallet: makeWallet([50_000n]),
    serializedDescriptors: [Uint8Array.from([0x01])],
    destinationScript: DEST_SCRIPT,
    targetFeeRateSatVb: 10n,
    esploraUrl: 'https://esplora.test',
    reserveSats: 0n,
    ...overrides,
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  state.feeOverride = null
  const ldk = await import('lightningdevkit')
  signResultClass = ldk.Result_CVec_u8ZNoneZ_OK as never
  createPsbtOkClass = ldk.Result_C2Tuple_CVec_u8Zu64ZNoneZ_OK as never
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const utxo = (valueSats: bigint): ForeignInput => ({
  txidDisplayHex: '11'.repeat(32),
  vout: 0,
  valueSats,
  scriptPubkey: WALLET_SCRIPT,
})

describe('selectSubsidyInputs', () => {
  // Worked example: 3,000 sats pending, LDK tx 439wu paying 110 sats at the
  // floor, target 10 sat/vB. One input + change → 835wu → 209 vB → 2,090 fee.
  it('selects one UTXO with change (worked example)', () => {
    const result = selectSubsidyInputs([utxo(50_000n)], 439n, 110n, 10n, 0n)
    expect(result).toEqual({
      selected: [utxo(50_000n)],
      changeSats: 48_020n,
      totalFeeSats: 2_090n,
      subsidySats: 1_980n,
    })
  })

  it('falls back to changeless when change would be dust, with bounded overpay', () => {
    const result = selectSubsidyInputs([utxo(2_100n)], 439n, 110n, 10n, 0n)
    // Changeless: 711wu → 178 vB → 1,780 fee → 1,670 needed; the whole
    // 2,100-sat input is contributed. Overpay vs. exact is 430 sats < dust +
    // the fee a change output would have cost.
    expect(result).toEqual({
      selected: [utxo(2_100n)],
      changeSats: null,
      totalFeeSats: 2_210n,
      subsidySats: 2_100n,
    })
  })

  it('adds a second UTXO when the first cannot cover the subsidy', () => {
    const candidates = [utxo(1_500n), utxo(1_200n)]
    const result = selectSubsidyInputs(candidates, 439n, 110n, 10n, 0n)
    // n=2 changeless: 983wu → 246 vB → 2,460 fee → 2,350 needed ≤ 2,700.
    expect(result).toEqual({
      selected: candidates,
      changeSats: null,
      totalFeeSats: 2_810n,
      subsidySats: 2_700n,
    })
  })

  it('reports a shortfall when candidates cannot cover the subsidy', () => {
    const result = selectSubsidyInputs([utxo(500n)], 439n, 110n, 10n, 0n)
    expect(result).toEqual({ shortfall: { neededSubsidySats: 1_980n, availableSats: 500n } })
  })

  it('reports a shortfall with no candidates at all', () => {
    const result = selectSubsidyInputs([], 439n, 110n, 10n, 0n)
    expect(result).toEqual({ shortfall: { neededSubsidySats: 1_980n, availableSats: 0n } })
  })

  it('honors the anchor reserve', () => {
    const result = selectSubsidyInputs([utxo(50_000n)], 439n, 110n, 10n, 48_500n)
    expect(result).toEqual({ shortfall: { neededSubsidySats: 1_980n, availableSats: 1_500n } })
  })

  it('caps the number of subsidy inputs', () => {
    const candidates = Array.from({ length: MAX_SUBSIDY_INPUTS + 5 }, () => utxo(10n))
    const result = selectSubsidyInputs(candidates, 439n, 110n, 10n, 0n)
    expect('shortfall' in result).toBe(true)
  })
})

describe('listConfirmedP2wpkhUtxos', () => {
  it('filters unconfirmed outputs', () => {
    expect(listConfirmedP2wpkhUtxos(makeWallet([5_000n], { confirmed: false }))).toEqual([])
  })

  it('sorts confirmed UTXOs largest-first', () => {
    const utxos = listConfirmedP2wpkhUtxos(makeWallet([1_000n, 9_000n, 4_000n]))
    expect(utxos.map((u) => u.valueSats)).toEqual([9_000n, 4_000n, 1_000n])
  })
})

describe('attemptSubsidizedSweep', () => {
  it('broadcasts a subsidized sweep (worked example end to end)', async () => {
    mockCreatePsbt(buildFakeLdkPsbt(3_000n, 2_890n), 439n)
    const outcome = await attemptSubsidizedSweep(baseParams())
    expect(outcome).toEqual({ status: 'broadcast', txid: state.fakeTxid, subsidySats: 1_980n })
    expect(broadcastWithRetry).toHaveBeenCalledOnce()
  })

  it('decodes descriptors freshly for create and sign (wasm ownership)', async () => {
    mockCreatePsbt(buildFakeLdkPsbt(3_000n, 2_890n), 439n)
    const { keysManager, signCalls } = makeKeysManager()
    await attemptSubsidizedSweep(baseParams({ keysManager }))

    const createDescriptors = vi.mocked(
      UtilMethods.constructor_SpendableOutputDescriptor_create_spendable_outputs_psbt
    ).mock.calls[0]![0] as unknown[]
    expect(signCalls).toHaveLength(1)
    expect(createDescriptors).toHaveLength(1)
    expect(signCalls[0]![0]).not.toBe(createDescriptors[0])
  })

  it('returns shortfall when the confirmed balance cannot cover the subsidy', async () => {
    mockCreatePsbt(buildFakeLdkPsbt(3_000n, 2_890n), 439n)
    const outcome = await attemptSubsidizedSweep(baseParams({ bdkWallet: makeWallet([500n]) }))
    expect(outcome).toEqual({
      status: 'shortfall',
      neededSubsidySats: 1_980n,
      availableSats: 500n,
      shortfallSats: 1_480n,
    })
    expect(broadcastWithRetry).not.toHaveBeenCalled()
  })

  it('returns not-economical when the subsidy exceeds the rescued value', async () => {
    mockCreatePsbt(buildFakeLdkPsbt(2_000n, 1_890n), 439n)
    const outcome = await attemptSubsidizedSweep(baseParams({ targetFeeRateSatVb: 20n }))
    expect(outcome).toEqual({
      status: 'not-economical',
      neededSubsidySats: 4_070n,
      pendingSats: 2_000n,
    })
  })

  it('fails on a sub-dust LDK output', async () => {
    mockCreatePsbt(buildFakeLdkPsbt(510n, 400n), 439n)
    const outcome = await attemptSubsidizedSweep(baseParams())
    expect(outcome).toEqual({ status: 'failed', reason: 'sub-dust-output' })
  })

  it('fails when LDK cannot create the PSBT', async () => {
    vi.mocked(
      UtilMethods.constructor_SpendableOutputDescriptor_create_spendable_outputs_psbt
    ).mockReturnValue({ err: true } as never)
    const outcome = await attemptSubsidizedSweep(baseParams())
    expect(outcome).toEqual({ status: 'failed', reason: 'ldk-create-psbt' })
  })

  it('fails when a descriptor does not decode', async () => {
    const outcome = await attemptSubsidizedSweep(
      baseParams({ serializedDescriptors: [Uint8Array.from([0xff])] })
    )
    expect(outcome).toEqual({ status: 'failed', reason: 'descriptor-decode' })
  })

  it('fails when LDK signing fails', async () => {
    mockCreatePsbt(buildFakeLdkPsbt(3_000n, 2_890n), 439n)
    const keysManager = {
      sign_spendable_outputs_psbt: vi.fn(() => ({ err: true })),
    } as unknown as KeysManager
    const outcome = await attemptSubsidizedSweep(baseParams({ keysManager }))
    expect(outcome).toEqual({ status: 'failed', reason: 'ldk-sign' })
  })

  it('fails when BDK signing does not finalize every input', async () => {
    mockCreatePsbt(buildFakeLdkPsbt(3_000n, 2_890n), 439n)
    const outcome = await attemptSubsidizedSweep(
      baseParams({ bdkWallet: makeWallet([50_000n], { signResult: false }) })
    )
    expect(outcome).toEqual({ status: 'failed', reason: 'bdk-sign-incomplete' })
    expect(broadcastWithRetry).not.toHaveBeenCalled()
  })

  it('fails on a fee mismatch instead of broadcasting', async () => {
    mockCreatePsbt(buildFakeLdkPsbt(3_000n, 2_890n), 439n)
    state.feeOverride = 999_999n
    const outcome = await attemptSubsidizedSweep(baseParams())
    expect(outcome).toEqual({ status: 'failed', reason: 'fee-mismatch' })
    expect(broadcastWithRetry).not.toHaveBeenCalled()
  })

  it('accepts a broadcast sentinel only when esplora knows the tx', async () => {
    mockCreatePsbt(buildFakeLdkPsbt(3_000n, 2_890n), 439n)
    vi.mocked(broadcastWithRetry).mockResolvedValue('already-broadcast')
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true }))
    )
    const outcome = await attemptSubsidizedSweep(baseParams())
    expect(outcome).toEqual({ status: 'broadcast', txid: state.fakeTxid, subsidySats: 1_980n })
  })

  it('treats an unverifiable broadcast sentinel as failure', async () => {
    mockCreatePsbt(buildFakeLdkPsbt(3_000n, 2_890n), 439n)
    vi.mocked(broadcastWithRetry).mockResolvedValue('already-broadcast')
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false }))
    )
    const outcome = await attemptSubsidizedSweep(baseParams())
    expect(outcome).toEqual({ status: 'failed', reason: 'broadcast-ambiguous' })
  })

  it('fails when broadcast exhausts retries', async () => {
    mockCreatePsbt(buildFakeLdkPsbt(3_000n, 2_890n), 439n)
    vi.mocked(broadcastWithRetry).mockRejectedValue(new Error('all attempts failed'))
    const outcome = await attemptSubsidizedSweep(baseParams())
    expect(outcome).toEqual({ status: 'failed', reason: 'broadcast' })
  })
})
