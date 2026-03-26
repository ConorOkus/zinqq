export interface LnurlPayMetadata {
  domain: string
  user: string
  callback: string
  minSendableMsat: bigint
  maxSendableMsat: bigint
  description: string
}

/**
 * Route an HTTPS URL through a CORS proxy.
 * Dev uses the Vite middleware; production uses the Vercel serverless function.
 */
function proxyUrl(httpsUrl: string): string {
  try {
    const u = new URL(httpsUrl)
    const prefix = import.meta.env.DEV ? '/__lnurl_proxy' : '/api/lnurl-proxy'
    return `${prefix}/${u.hostname}${u.pathname}${u.search}`
  } catch {
    return httpsUrl
  }
}

/**
 * Resolve a Lightning Address (LUD-16) to LNURL-pay metadata.
 * Fetches `https://domain/.well-known/lnurlp/user` and validates the response.
 *
 * Returns the metadata on success, or null if no LNURL endpoint exists (404/DNS failure).
 * Throws on validation errors so the caller can surface the real issue.
 */
export async function resolveLnurlPay(
  user: string,
  domain: string,
  signal?: AbortSignal
): Promise<LnurlPayMetadata | null> {
  const url = proxyUrl(`https://${domain}/.well-known/lnurlp/${user}`)

  let response: Response
  try {
    response = await fetch(url, { signal })
  } catch (err) {
    // AbortError should propagate so the caller can distinguish cancel from failure
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    // Network error or CORS block — not a valid LNURL endpoint
    return null
  }

  if (!response.ok) return null

  interface LnurlPayResponse {
    status?: string
    reason?: string
    tag?: string
    callback?: string
    minSendable?: number
    maxSendable?: number
    metadata?: string
  }

  let data: LnurlPayResponse
  try {
    data = (await response.json()) as LnurlPayResponse
  } catch {
    return null
  }

  if (data.status === 'ERROR') {
    throw new Error(data.reason ?? 'Lightning Address returned an error')
  }

  if (data.tag !== 'payRequest') return null

  if (!data.callback || !data.minSendable || !data.maxSendable) {
    return null
  }

  // Validate callback is HTTPS
  const callback = data.callback
  if (!callback.startsWith('https://')) {
    throw new Error('Lightning Address callback is not HTTPS')
  }

  // Validate callback domain matches the original LNURL domain
  let callbackHost: string
  try {
    callbackHost = new URL(callback).hostname
  } catch {
    throw new Error('Lightning Address has invalid callback URL')
  }
  if (callbackHost !== domain && !callbackHost.endsWith('.' + domain)) {
    throw new Error('Lightning Address callback domain mismatch')
  }

  let description: string
  try {
    const metadata = JSON.parse(data.metadata ?? '[]') as string[][]
    description = metadata.find(([mime]) => mime === 'text/plain')?.[1] ?? `${user}@${domain}`
  } catch {
    description = `${user}@${domain}`
  }

  return {
    domain,
    user,
    callback,
    minSendableMsat: BigInt(data.minSendable),
    maxSendableMsat: BigInt(data.maxSendable),
    description,
  }
}

/**
 * Fetch a BOLT 11 invoice from an LNURL-pay callback.
 * Appends the amount in millisatoshis as a query parameter.
 */
export async function fetchLnurlInvoice(
  callback: string,
  amountMsat: bigint,
  signal?: AbortSignal
): Promise<string> {
  const separator = callback.includes('?') ? '&' : '?'
  const fetchUrl = proxyUrl(`${callback}${separator}amount=${amountMsat}`)

  const response = await fetch(fetchUrl, { signal })
  if (!response.ok) throw new Error('Failed to fetch invoice')

  const data = (await response.json()) as { status?: string; reason?: string; pr?: string }
  if (data.status === 'ERROR') throw new Error(data.reason ?? 'LNURL error')
  if (!data.pr) throw new Error('No invoice in response')

  return data.pr
}
