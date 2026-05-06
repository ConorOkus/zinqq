/**
 * Vercel serverless function that proxies LQwD's /get_info to bypass CORS.
 * The upstream endpoint serves valid JSON but does not emit
 * Access-Control-Allow-Origin, so browsers block direct fetch from
 * the wallet origin. Same-origin proxying makes the browser happy.
 *
 * Vercel rewrite maps /api/lqwd/get_info to this function.
 * Hardcoded target — no path or domain forwarding — keeps the SSRF
 * surface zero.
 */
const LQWD_GET_INFO_URL = 'https://germany.lqwd.tech/api/v1/get_info'

export async function GET(): Promise<Response> {
  try {
    const upstream = await fetch(LQWD_GET_INFO_URL, {
      signal: AbortSignal.timeout(5_000),
    })
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
        'Cache-Control': 'no-store',
      },
    })
  } catch {
    return Response.json({ error: 'lqwd upstream unavailable' }, { status: 502 })
  }
}
