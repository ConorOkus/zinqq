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
  const segments = url.pathname.replace(/^\/api\/vss-proxy\/?/, '')
  const targetUrl = `${vssOrigin}/vss/${segments}`

  try {
    const upstream = await fetch(targetUrl, {
      method: request.method,
      headers: {
        'Content-Type': request.headers.get('content-type') ?? 'application/octet-stream',
      },
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
