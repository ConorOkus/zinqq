import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function tokenResponse() {
  return Response.json({ access_token: 'test-token', expires_in: 300 })
}

// Bytes that are invalid UTF-8 (0x80, 0xff, 0xfe) — a lossy .text() round-trip
// replaces them with U+FFFD and inflates the body, which is exactly the
// corruption from issue #185.
const BINARY_BODY = new Uint8Array([0x01, 0x00, 0x80, 0xff, 0xfe, 0xc0, 0x00, 0x7f])

async function importProxy() {
  vi.resetModules()
  return import('./esplora-proxy')
}

beforeEach(() => {
  mockFetch.mockReset()
  vi.stubEnv('BLOCKSTREAM_CLIENT_ID', 'id')
  vi.stubEnv('BLOCKSTREAM_CLIENT_SECRET', 'secret')
})

describe('esplora-proxy binary passthrough', () => {
  it('returns /tx/:txid/raw bytes unmodified', async () => {
    const { GET } = await importProxy()
    mockFetch.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
      new Response(BINARY_BODY, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      })
    )

    const res = await GET(new Request('https://zinqq.app/api/esplora-proxy?_path=tx/abc123/raw'))

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BINARY_BODY)
  })

  it('forwards POST bodies as raw bytes', async () => {
    const { POST } = await importProxy()
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response('txid', { status: 200 }))

    const res = await POST(
      new Request('https://zinqq.app/api/esplora-proxy?_path=tx', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: BINARY_BODY,
      })
    )

    expect(res.status).toBe(200)
    const upstreamInit = mockFetch.mock.calls[1]?.[1] as RequestInit
    expect(new Uint8Array(upstreamInit.body as ArrayBuffer)).toEqual(BINARY_BODY)
  })

  it('still returns text endpoints intact', async () => {
    const { GET } = await importProxy()
    const hex = 'deadbeef'.repeat(10)
    mockFetch.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
      new Response(hex, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    )

    const res = await GET(new Request('https://zinqq.app/api/esplora-proxy?_path=tx/abc123/hex'))

    expect(res.status).toBe(200)
    expect(await res.text()).toBe(hex)
  })
})
