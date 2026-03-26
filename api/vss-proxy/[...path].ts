import type { VercelRequest, VercelResponse } from '@vercel/node'

/** Disable Vercel's default body parser to preserve raw binary (protobuf) payloads. */
export const config = { api: { bodyParser: false } }

/**
 * Vercel serverless function that proxies VSS requests.
 * Reads VSS_ORIGIN from server-side env vars (not exposed to browser).
 * Mapped via vercel.json rewrite: /__vss_proxy/vss/* → /api/vss-proxy/*
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const vssOrigin = process.env.VSS_ORIGIN
  if (!vssOrigin) {
    res.status(500).json({ error: 'VSS_ORIGIN not configured' })
    return
  }

  const path = (req.query.path as string[])?.join('/') ?? ''
  const targetUrl = `${vssOrigin}/vss/${path}`

  // Collect raw body for non-GET/HEAD requests
  const body = await new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: { 'Content-Type': req.headers['content-type'] ?? 'application/octet-stream' },
      body: req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
      signal: AbortSignal.timeout(15_000),
    })

    res.status(upstream.status)
    res.setHeader(
      'Content-Type',
      upstream.headers.get('content-type') ?? 'application/octet-stream'
    )
    res.setHeader('Cache-Control', 'no-store')
    const buffer = Buffer.from(await upstream.arrayBuffer())
    res.send(buffer)
  } catch {
    res.status(502).json({ error: 'upstream unavailable' })
  }
}
