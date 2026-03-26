import type { VercelRequest, VercelResponse } from '@vercel/node'

/**
 * Vercel serverless function that proxies LNURL requests to bypass CORS.
 * Routes /api/lnurl-proxy/DOMAIN/PATH to https://DOMAIN/PATH.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  // Extract domain and path from URL: /api/lnurl-proxy/domain.com/.well-known/lnurlp/user
  const urlPath = (req.url ?? '').split('?')[0]
  const rest = urlPath.replace(/^\/api\/lnurl-proxy\/?/, '')
  const slashIdx = rest.indexOf('/')
  if (slashIdx === -1) {
    res.status(400).json({ error: 'Bad proxy URL — expected /api/lnurl-proxy/DOMAIN/PATH' })
    return
  }

  const targetHost = rest.slice(0, slashIdx)
  const targetPath = rest.slice(slashIdx)
  const targetUrl = `https://${targetHost}${targetPath}`

  try {
    const upstream = await fetch(targetUrl, {
      signal: AbortSignal.timeout(10_000),
    })

    res.status(upstream.status)
    res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    res.send(await upstream.text())
  } catch {
    res.status(502).json({ error: 'upstream unavailable' })
  }
}
