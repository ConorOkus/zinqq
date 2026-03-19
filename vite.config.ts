import { defineConfig, type PluginOption, type Plugin } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

/**
 * Vite plugin that proxies LNURL requests to bypass CORS issues.
 * Routes /__lnurl_proxy/DOMAIN/PATH to https://DOMAIN/PATH server-side.
 * Needed because some LNURL servers send malformed CORS headers
 * (e.g., duplicate Access-Control-Allow-Origin: *, *).
 */
function lnurlCorsProxy(): Plugin {
  return {
    name: 'lnurl-cors-proxy',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const prefix = '/__lnurl_proxy/'
        if (!req.url?.startsWith(prefix)) return next()

        const rest = req.url.slice(prefix.length)
        const slashIdx = rest.indexOf('/')
        if (slashIdx === -1) {
          res.statusCode = 400
          res.end('Bad proxy URL')
          return
        }

        const targetHost = rest.slice(0, slashIdx)
        const targetPath = rest.slice(slashIdx)
        const targetUrl = `https://${targetHost}${targetPath}`

        fetch(targetUrl)
          .then(async (upstream) => {
            res.statusCode = upstream.status
            res.setHeader('Content-Type', upstream.headers.get('Content-Type') ?? 'application/json')
            res.end(await upstream.text())
          })
          .catch((err: unknown) => {
            res.statusCode = 502
            res.end(err instanceof Error ? err.message : 'Proxy error')
          })
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), wasm(), topLevelAwait(), lnurlCorsProxy()],
  worker: {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    plugins: (): PluginOption[] => [wasm(), topLevelAwait()],
  },
  server: {
    headers: {
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
    },
  },
})
