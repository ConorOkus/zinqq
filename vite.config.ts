import { defineConfig, loadEnv, type PluginOption, type Plugin } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'
import { VitePWA } from 'vite-plugin-pwa'

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
            res.setHeader(
              'Content-Type',
              upstream.headers.get('Content-Type') ?? 'application/json'
            )
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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const isProd = mode === 'production'

  // Refuse to bake the static invoice server paths into a production bundle.
  //
  // Vite inlines every VITE_ value it sees, so a production build carrying this
  // blob hands it to everyone who loads the page — and the blob is a bearer
  // capability, not an address. It carries the recipient_id the server keys its
  // static-invoice store on (static_invoices/<sha256(recipient_id)>/...), so a
  // second party registering with the same paths overwrites the stored invoice,
  // and payers resolving this wallet's offer are then served theirs. Disclosure
  // is a payment-redirection risk, not a privacy one.
  //
  // This is the only place the rule can be enforced: a runtime check cannot
  // un-inline a value that is already in the shipped JavaScript. Per-wallet
  // provisioning over a runtime channel is the real fix and is deferred — see
  // docs/plans/2026-08-27-001-feat-async-payments-recipient-role-plan.md.
  if (isProd && (env.VITE_STATIC_INVOICE_SERVER_PATHS ?? '').trim() !== '') {
    throw new Error(
      '[vite] VITE_STATIC_INVOICE_SERVER_PATHS is set for a production build. ' +
        'Vite would inline it into the public bundle, where it is a bearer ' +
        "capability: any reader can overwrite this wallet's static invoice and " +
        'redirect its incoming payments. Async receive is development-only until ' +
        'per-wallet provisioning exists. Unset the variable for production builds.'
    )
  }

  return {
    plugins: [
      react(),
      tailwindcss(),
      wasm(),
      topLevelAwait(),
      lnurlCorsProxy(),
      VitePWA({
        registerType: 'prompt',
        injectRegister: null,
        manifest: {
          name: 'Zinqq',
          short_name: 'Zinqq',
          description: 'Lightning wallet powered by LDK',
          theme_color: '#E4D7BE',
          background_color: '#12100C',
          display: 'standalone',
          scope: '/',
          start_url: '/',
          icons: [
            { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
            { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
            {
              src: 'pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
          globIgnores: ['**/*.wasm'],
          maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
          cleanupOutdatedCaches: true,
          navigateFallback: 'index.html',
          navigateFallbackDenylist: [/^\/api\//],
          runtimeCaching: [
            {
              urlPattern: /\.wasm$/,
              handler: 'NetworkFirst',
              options: {
                cacheName: 'wasm-cache',
                expiration: { maxEntries: 1 },
                cacheableResponse: { statuses: [200] },
              },
            },
          ],
        },
      }),
    ],
    esbuild: {
      drop: isProd ? ['debugger'] : [],
      pure: isProd ? ['console.debug'] : [],
    },
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
      proxy: {
        '/__vss_proxy': {
          target: env.VSS_PROXY_TARGET ?? 'http://localhost:8080',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/__vss_proxy/, ''),
        },
        '/api/esplora': {
          target: env.ESPLORA_PROXY_TARGET ?? 'https://zinqq.app',
          changeOrigin: true,
        },
      },
    },
  }
})
