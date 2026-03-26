import type { VercelRequest, VercelResponse } from '@vercel/node'

/**
 * Vercel serverless function that proxies VSS requests.
 * Reads VSS_ORIGIN from server-side env vars (not exposed to browser).
 *
 * Vercel's default body parser delivers application/octet-stream as a
 * raw Buffer in req.body, which is exactly what we need for protobuf.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const vssOrigin = process.env.VSS_ORIGIN
  if (!vssOrigin) {
    res.status(500).json({ error: 'VSS_ORIGIN not configured' })
    return
  }

  const path = (req.query.path as string[])?.join('/') ?? ''
  const targetUrl = `${vssOrigin}/vss/${path}`

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'Content-Type': req.headers['content-type'] ?? 'application/octet-stream',
      },
      body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
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
