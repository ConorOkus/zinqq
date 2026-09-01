import { Network } from 'lightningdevkit'

interface LdkConfig {
  network: Network
  esploraUrl: string
  esploraFallbackUrl?: string
  chainPollIntervalMs: number
  wsProxyUrl: string
  peerTimerIntervalMs: number
  rgsUrl: string
  rgsSyncIntervalTicks: number
  vssUrl: string
  lspNodeId: string
  lspHost: string
  lspPort: number
  lspToken?: string
  lspLabel: string

  /**
   * Hex-encoded `Vec<BlindedMessagePath>` addressed to a static invoice server,
   * obtained out-of-band from the server operator. This is the shape ldk-node's
   * uniffi bindings emit for async-recipient paths. Empty disables the
   * async-payments recipient role.
   *
   * Single-recipient only: the server issues these paths against a unique
   * `recipient_id`, so one path set names one wallet. A bundle-baked value
   * cannot serve multiple users.
   */
  staticInvoiceServerPaths: string
  /**
   * Explicit acknowledgement that this build serves exactly one recipient.
   * Required whenever paths are set — see the validation below for why.
   */
  staticInvoiceServerRecipientAck: string

  genesisBlockHash: string
}

// Note: vssUrl uses a relative path (/api/vss-proxy) that requires a proxy:
// - Dev: Vite's server.proxy config (vite.config.ts)
// - Production: Vercel rewrite rules (vercel.json)
// - pnpm preview: NOT supported — Vite's preview server doesn't run proxy config
const DEFAULTS: LdkConfig = {
  network: Network.LDKNetwork_Bitcoin,
  esploraUrl: '/api/esplora',
  esploraFallbackUrl: 'https://mempool.space/api',
  chainPollIntervalMs: 60_000,
  wsProxyUrl: 'wss://proxy.zinqq.app',
  peerTimerIntervalMs: 10_000,
  rgsUrl: 'https://rapidsync.lightningdevkit.org/snapshot',
  rgsSyncIntervalTicks: 30,
  vssUrl: '/api/vss-proxy',
  lspNodeId: '',
  lspHost: '',
  lspPort: 9735,
  lspLabel: 'megalith',
  staticInvoiceServerPaths: '',
  staticInvoiceServerRecipientAck: '',
  genesisBlockHash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
}

export const LDK_CONFIG: LdkConfig = {
  ...DEFAULTS,
  esploraUrl: (
    (import.meta.env.VITE_ESPLORA_URL as string | undefined) ?? DEFAULTS.esploraUrl
  ).trim(),
  wsProxyUrl: (
    (import.meta.env.VITE_WS_PROXY_URL as string | undefined) ?? DEFAULTS.wsProxyUrl
  ).trim(),
  vssUrl: ((import.meta.env.VITE_VSS_URL as string | undefined) ?? DEFAULTS.vssUrl).trim(),
  lspNodeId: (
    (import.meta.env.VITE_LSP_NODE_ID as string | undefined) ?? DEFAULTS.lspNodeId
  ).trim(),
  lspHost: ((import.meta.env.VITE_LSP_HOST as string | undefined) ?? DEFAULTS.lspHost).trim(),
  lspPort: Number(
    ((import.meta.env.VITE_LSP_PORT as string | undefined) ?? String(DEFAULTS.lspPort)).trim()
  ),
  lspToken: ((import.meta.env.VITE_LSP_TOKEN as string | undefined) ?? DEFAULTS.lspToken)?.trim(),
  lspLabel: (import.meta.env.VITE_LSP_LABEL as string | undefined)?.trim() || DEFAULTS.lspLabel,
  staticInvoiceServerPaths: (
    (import.meta.env.VITE_STATIC_INVOICE_SERVER_PATHS as string | undefined) ??
    DEFAULTS.staticInvoiceServerPaths
  ).trim(),
  staticInvoiceServerRecipientAck: (
    (import.meta.env.VITE_STATIC_INVOICE_SERVER_RECIPIENT_ACK as string | undefined) ??
    DEFAULTS.staticInvoiceServerRecipientAck
  ).trim(),
}

if (!LDK_CONFIG.wsProxyUrl) {
  throw new Error(
    '[LDK Config] wsProxyUrl is empty. Set VITE_WS_PROXY_URL to the WebSocket proxy endpoint.'
  )
}

// Validate LSP config. Empty lspNodeId disables LSPS2 (valid for testing).
if (LDK_CONFIG.lspNodeId !== '') {
  if (!/^[0-9a-f]{66}$/.test(LDK_CONFIG.lspNodeId)) {
    throw new Error(
      `[LDK Config] Invalid lspNodeId "${LDK_CONFIG.lspNodeId.substring(0, 20)}...". ` +
        'Must be a 66-character lowercase hex public key, or empty to disable LSPS2.'
    )
  }
  if (
    !Number.isFinite(LDK_CONFIG.lspPort) ||
    LDK_CONFIG.lspPort < 1 ||
    LDK_CONFIG.lspPort > 65535
  ) {
    throw new Error(`[LDK Config] Invalid lspPort "${LDK_CONFIG.lspPort}". Must be 1-65535.`)
  }
  if (!LDK_CONFIG.lspHost) {
    throw new Error(
      '[LDK Config] lspHost is empty but lspNodeId is set. Both are required for LSPS2.'
    )
  }
  // Warn rather than throw: the default label is correct for Megalith deployments,
  // but silently applying it to some other node is the exact misattribution
  // VITE_LSP_LABEL exists to prevent.
  if (!(import.meta.env.VITE_LSP_LABEL as string | undefined)?.trim()) {
    console.warn(
      `[LDK Config] VITE_LSP_LABEL is unset — telemetry will tag LSP ` +
        `${LDK_CONFIG.lspNodeId.substring(0, 16)}... as "${DEFAULTS.lspLabel}". ` +
        'Set VITE_LSP_LABEL when pointing at a different LSP.'
    )
  }
}

/** Literal the operator must set to affirm a single-recipient deployment. */
const SINGLE_RECIPIENT_ACK = 'single-recipient-deployment'

// Validate the static invoice server config. Empty paths disable the
// async-payments recipient role. Only the hex *shape* is checked here — the
// actual decode is WASM-backed and lives in async-receive/server-paths.ts,
// because this module is imported by tests that never initialize WASM.
if (LDK_CONFIG.staticInvoiceServerPaths !== '') {
  // Single-recipient correctness gate, not a roadmap note.
  //
  // The server issues these paths against a recipient_id that "must uniquely
  // identify the recipient", and its store keys on it —
  // static_invoices/<sha256(recipient_id)>/<invoice_slot>. Shipping one bundle
  // to two wallets therefore does not degrade gracefully: both register under
  // the same id and overwrite each other's static invoices in a shared
  // keyspace, silently corrupting the thing the server exists to serve.
  //
  // Nothing at runtime can detect that another wallet shares the id, so the
  // only place to catch it is here, at deploy time.
  if (LDK_CONFIG.staticInvoiceServerRecipientAck !== SINGLE_RECIPIENT_ACK) {
    throw new Error(
      '[LDK Config] staticInvoiceServerPaths is set, so ' +
        `VITE_STATIC_INVOICE_SERVER_RECIPIENT_ACK must be "${SINGLE_RECIPIENT_ACK}". ` +
        'These paths encode one recipient_id and the server keys its static-invoice ' +
        'store on it, so serving this bundle to more than one wallet makes them ' +
        "overwrite each other's invoices. Set this only for a single-recipient build."
    )
  }

  if (!/^(?:[0-9a-f]{2})+$/.test(LDK_CONFIG.staticInvoiceServerPaths)) {
    throw new Error(
      '[LDK Config] staticInvoiceServerPaths is not even-length lowercase hex. Expected hex of ' +
        "the server's Vec<BlindedMessagePath> blob."
    )
  }
}
