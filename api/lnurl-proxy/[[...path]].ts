/**
 * Vercel serverless function that proxies LNURL requests to bypass CORS.
 * Routes /api/lnurl-proxy/DOMAIN/PATH to https://DOMAIN/PATH.
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const rest = url.pathname.replace(/^\/api\/lnurl-proxy\/?/, '')
  const slashIdx = rest.indexOf('/')
  if (slashIdx === -1) {
    return Response.json(
      { error: 'Bad proxy URL — expected /api/lnurl-proxy/DOMAIN/PATH' },
      { status: 400 }
    )
  }

  const targetHost = rest.slice(0, slashIdx)
  const targetPath = rest.slice(slashIdx)
  const targetUrl = `https://${targetHost}${targetPath}${url.search}`

  try {
    const upstream = await fetch(targetUrl, {
      signal: AbortSignal.timeout(10_000),
    })

    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
        'Cache-Control': 'no-store',
      },
    })
  } catch {
    return Response.json({ error: 'upstream unavailable' }, { status: 502 })
  }
}
