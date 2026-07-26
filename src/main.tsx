import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'
import { router } from './routes/router'
import { WalletProvider } from './wallet/context'
import { WalletGate } from './wallet/wallet-gate'
import { applyTheme, getStoredTheme } from './utils/theme'
import './index.css'

// CSP forbids inline scripts, so the theme attribute is set here — before
// first render, while #root is still empty.
applyTheme(getStoredTheme())

const root = document.getElementById('root')
if (!root) {
  throw new Error('Root element #root not found. Check index.html.')
}

createRoot(root).render(
  <StrictMode>
    <WalletProvider>
      <WalletGate>
        <RouterProvider router={router} />
      </WalletGate>
    </WalletProvider>
  </StrictMode>
)
