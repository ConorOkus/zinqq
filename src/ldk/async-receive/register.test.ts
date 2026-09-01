import { describe, it, expect, vi } from 'vitest'

const NODE_A = 'aa'.repeat(33)
const NODE_B = 'bb'.repeat(33)

// Same marker convention as server-paths.test.ts: a hex entry is one byte whose
// value steers the decode. 0x01 -> introduces at NODE_A, 0x02 -> NODE_B,
// 0xff -> fails to decode.
vi.mock('lightningdevkit', () => {
  class Result_BlindedMessagePathDecodeErrorZ_OK {
    res: unknown
    constructor(res: unknown) {
      this.res = res
    }
  }
  class Result_BlindedMessagePathDecodeErrorZ_Err {}
  class Result_NoneNoneZ_OK {}
  class Result_NoneNoneZ_Err {}

  class IntroductionNode {}
  class IntroductionNode_NodeId extends IntroductionNode {
    node_id: Uint8Array
    constructor(node_id: Uint8Array) {
      super()
      this.node_id = node_id
    }
  }
  class IntroductionNode_DirectedShortChannelId extends IntroductionNode {}

  const hexToBytes = (hex: string) => {
    const out = new Uint8Array(hex.length / 2)
    for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    return out
  }

  class FakePath {
    marker: number
    constructor(marker: number) {
      this.marker = marker
    }
    write() {
      return new Uint8Array([this.marker, 0xaa, 0xbb])
    }
    introduction_node() {
      return new IntroductionNode_NodeId(hexToBytes(this.marker === 0x02 ? NODE_B : NODE_A))
    }
    public_introduction_node_id() {
      return null
    }
  }

  class BlindedMessagePath {
    static constructor_read(ser: Uint8Array) {
      const marker = ser[0] ?? 0
      if (marker === 0xff || ser.length < 3) {
        return new Result_BlindedMessagePathDecodeErrorZ_Err()
      }
      return new Result_BlindedMessagePathDecodeErrorZ_OK(new FakePath(marker))
    }
  }

  return {
    BlindedMessagePath,
    IntroductionNode,
    IntroductionNode_NodeId,
    IntroductionNode_DirectedShortChannelId,
    Result_BlindedMessagePathDecodeErrorZ_OK,
    Result_BlindedMessagePathDecodeErrorZ_Err,
    Result_NoneNoneZ_OK,
    Result_NoneNoneZ_Err,
  }
})

const { createStaticInvoiceServerRegistrar } = await import('./register')
// The mocked module's classes are typed against LDK's real declarations, whose
// constructors are protected; go through a loose alias to instantiate them.
const ldk = (await import('lightningdevkit')) as unknown as Record<
  string,
  new (...args: unknown[]) => unknown
>
const Result_NoneNoneZ_OK = ldk.Result_NoneNoneZ_OK!
const Result_NoneNoneZ_Err = ldk.Result_NoneNoneZ_Err!

function makeManager(options: { usableChannels?: number; accept?: boolean } = {}) {
  const { usableChannels = 1, accept = true } = options
  return {
    list_usable_channels: vi.fn((): unknown[] => new Array<unknown>(usableChannels).fill({})),
    set_paths_to_static_invoice_server: vi.fn(() =>
      accept ? new Result_NoneNoneZ_OK() : new Result_NoneNoneZ_Err()
    ),
  }
}

/** Build `u16 count || 3-byte path records` from marker bytes. */
function blob(markers: number[]): string {
  const bytes = [markers.length >> 8, markers.length & 0xff]
  for (const m of markers) bytes.push(m, 0xaa, 0xbb)
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    channelManager: makeManager() as never,
    networkGraph: {} as never,
    pathsConfig: blob([0x01]),
    hasPersistedOffer: false,
    ...overrides,
  } as never
}

describe('createStaticInvoiceServerRegistrar', () => {
  it('registers once with all decoded paths when configured and a channel is usable', () => {
    const manager = makeManager()
    const register = createStaticInvoiceServerRegistrar()

    const outcome = register(
      deps({ channelManager: manager as never, pathsConfig: blob([0x01, 0x01]) })
    )

    expect(outcome).toEqual({ status: 'registered', pathCount: 2 })
    expect(manager.set_paths_to_static_invoice_server).toHaveBeenCalledTimes(1)
    const firstCall = manager.set_paths_to_static_invoice_server.mock.calls[0] as unknown as [
      unknown[],
    ]
    expect(firstCall[0]).toHaveLength(2)
  })

  it('skips and never calls the manager when no paths are configured', () => {
    const manager = makeManager()
    const register = createStaticInvoiceServerRegistrar()

    const outcome = register(deps({ channelManager: manager as never, pathsConfig: '' }))

    expect(outcome.status).toBe('skipped')
    expect(manager.set_paths_to_static_invoice_server).not.toHaveBeenCalled()
  })

  it('skips when no channel is usable, even with paths configured', () => {
    const manager = makeManager({ usableChannels: 0 })
    const register = createStaticInvoiceServerRegistrar()

    const outcome = register(deps({ channelManager: manager }))

    expect(outcome).toEqual({ status: 'skipped', reason: 'no usable channel yet' })
    expect(manager.set_paths_to_static_invoice_server).not.toHaveBeenCalled()
  })

  it('skips when a prior session already registered', () => {
    const manager = makeManager()
    const register = createStaticInvoiceServerRegistrar()

    const outcome = register(deps({ channelManager: manager as never, hasPersistedOffer: true }))

    expect(outcome.status).toBe('skipped')
    expect(manager.set_paths_to_static_invoice_server).not.toHaveBeenCalled()
  })

  it('reports failure without throwing when the manager rejects the paths', () => {
    const manager = makeManager({ accept: false })
    const register = createStaticInvoiceServerRegistrar()

    const outcome = register(deps({ channelManager: manager }))

    expect(outcome.status).toBe('failed')
    expect(manager.set_paths_to_static_invoice_server).toHaveBeenCalledTimes(1)
  })

  it('does not call the manager a second time after a successful registration', () => {
    const manager = makeManager()
    const register = createStaticInvoiceServerRegistrar()

    expect(register(deps({ channelManager: manager })).status).toBe('registered')
    expect(register(deps({ channelManager: manager })).status).toBe('skipped')
    expect(manager.set_paths_to_static_invoice_server).toHaveBeenCalledTimes(1)
  })

  it('registers nothing when one entry fails to decode', () => {
    const manager = makeManager()
    const register = createStaticInvoiceServerRegistrar()

    const outcome = register(
      deps({ channelManager: manager as never, pathsConfig: blob([0x01, 0xff]) })
    )

    expect(outcome.status).toBe('failed')
    expect(manager.set_paths_to_static_invoice_server).not.toHaveBeenCalled()
  })

  it('registers a blob whose paths introduce at different nodes', () => {
    // The normal shape from a real server: one path per peer it can be
    // reached through, so the introduction nodes differ and none is the
    // server itself.
    const manager = makeManager()
    const register = createStaticInvoiceServerRegistrar()

    const outcome = register(
      deps({ channelManager: manager as never, pathsConfig: blob([0x01, 0x02]) })
    )

    expect(outcome).toEqual({ status: 'registered', pathCount: 2 })
    expect(manager.set_paths_to_static_invoice_server).toHaveBeenCalledTimes(1)
  })

  it('retries on a later call when the first was skipped for lack of a channel', () => {
    const register = createStaticInvoiceServerRegistrar()
    const noChannel = makeManager({ usableChannels: 0 })
    const withChannel = makeManager()

    expect(register(deps({ channelManager: noChannel })).status).toBe('skipped')
    expect(register(deps({ channelManager: withChannel })).status).toBe('registered')
    expect(withChannel.set_paths_to_static_invoice_server).toHaveBeenCalledTimes(1)
  })
})
