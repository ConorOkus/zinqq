/**
 * Vercel serverless function that proxies Esplora requests to Blockstream
 * Enterprise, keeping OAuth2 credentials server-side.
 *
 * Vercel rewrite maps /api/esplora/SEGMENTS to /api/esplora-proxy?_path=SEGMENTS
 *
 * Requires env vars (NOT VITE_ prefixed — server-only):
 *   BLOCKSTREAM_CLIENT_ID
 *   BLOCKSTREAM_CLIENT_SECRET
 */

const TOKEN_URL =
  'https://login.staging.blockstream.com/realms/blockstream-public/protocol/openid-connect/token'
const UPSTREAM_BASE = 'https://enterprise.staging.blockstream.info/api'
const TOKEN_REFRESH_BUFFER_MS = 30_000
const UPSTREAM_TIMEOUT_MS = 15_000

let cachedToken: string | null = null
let expiresAt = 0
let pendingRefresh: Promise<string> | null = null
let failedAt = 0
const FAILURE_COOLDOWN_MS = 5_000

async function getToken(): Promise<string> {
  const clientId = process.env.BLOCKSTREAM_CLIENT_ID
  const clientSecret = process.env.BLOCKSTREAM_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('BLOCKSTREAM_CLIENT_ID / BLOCKSTREAM_CLIENT_SECRET not configured')
  }

  if (cachedToken && Date.now() < expiresAt) return cachedToken

  if (Date.now() < failedAt + FAILURE_COOLDOWN_MS) {
    throw new Error('Token fetch in cooldown after failure')
  }

  if (pendingRefresh) return pendingRefresh

  pendingRefresh = (async () => {
    const params = new URLSearchParams()
    params.append('client_id', clientId)
    params.append('client_secret', clientSecret)
    params.append('grant_type', 'client_credentials')
    params.append('scope', 'openid')

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    })

    if (!res.ok) {
      throw new Error(`Token request failed: HTTP ${res.status}`)
    }

    const data = (await res.json()) as Record<string, unknown>
    if (typeof data.access_token !== 'string' || typeof data.expires_in !== 'number') {
      throw new Error('Unexpected token response shape')
    }
    cachedToken = data.access_token
    expiresAt = Date.now() + data.expires_in * 1000 - TOKEN_REFRESH_BUFFER_MS
    return cachedToken
  })()
    .catch((err: unknown) => {
      failedAt = Date.now()
      throw err
    })
    .finally(() => {
      pendingRefresh = null
    })

  return pendingRefresh
}

export async function GET(request: Request): Promise<Response> {
  return proxyToEsplora(request)
}

export async function POST(request: Request): Promise<Response> {
  return proxyToEsplora(request)
}

async function proxyToEsplora(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const esploraPath = url.searchParams.get('_path') ?? ''

  if (esploraPath.includes('..') || esploraPath.startsWith('/')) {
    return Response.json({ error: 'invalid path' }, { status: 400 })
  }

  const targetUrl = `${UPSTREAM_BASE}/${esploraPath}`

  let token: string
  try {
    token = await getToken()
  } catch {
    return Response.json({ error: 'auth unavailable' }, { status: 502 })
  }

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    }
    if (request.method === 'POST') {
      headers['Content-Type'] = request.headers.get('content-type') ?? 'text/plain'
    }

    const upstream = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.method === 'POST' ? await request.arrayBuffer() : undefined,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })

    // Invalidate cached token if upstream rejects it
    if (upstream.status === 401) {
      cachedToken = null
      expiresAt = 0
    }

    // Body must pass through as raw bytes: /tx/:txid/raw and /block/:hash/raw
    // are binary, and .text() corrupts them (invalid UTF-8 becomes U+FFFD).
    return new Response(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') ?? 'text/plain',
        'Cache-Control': 'no-store',
      },
    })
  } catch {
    return Response.json({ error: 'upstream unavailable' }, { status: 502 })
  }
}
