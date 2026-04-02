/**
 * Vercel serverless function that proxies VSS requests.
 * Vercel rewrite maps /api/vss-proxy/SEGMENTS to /api/vss-proxy?_path=SEGMENTS
 */
export async function GET(request: Request) {
  return proxyToVss(request)
}

export async function POST(request: Request) {
  return proxyToVss(request)
}

export async function PUT(request: Request) {
  return proxyToVss(request)
}

async function proxyToVss(request: Request): Promise<Response> {
  const vssOrigin = process.env.VSS_ORIGIN
  if (!vssOrigin) {
    return Response.json({ error: 'VSS_ORIGIN not configured' }, { status: 500 })
  }

  const url = new URL(request.url)
  const vssPath = url.searchParams.get('_path') ?? ''
  const targetUrl = `${vssOrigin}/vss/${vssPath}`

  try {
    const headers: Record<string, string> = {
      'Content-Type': request.headers.get('content-type') ?? 'application/octet-stream',
    }
    const auth = request.headers.get('authorization')
    if (auth) headers['Authorization'] = auth

    const upstream = await fetch(targetUrl, {
      method: request.method,
      headers,
      body:
        request.method !== 'GET' && request.method !== 'HEAD'
          ? await request.arrayBuffer()
          : undefined,
      signal: AbortSignal.timeout(15_000),
    })

    return new Response(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      },
    })
  } catch {
    return Response.json({ error: 'upstream unavailable' }, { status: 502 })
  }
}
