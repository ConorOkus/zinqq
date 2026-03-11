import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'
import { router } from './routes/router'
import { LdkProvider } from './ldk/context'
import './index.css'

const root = document.getElementById('root')
if (!root) {
  throw new Error('Root element #root not found. Check index.html.')
}

createRoot(root).render(
  <StrictMode>
    <LdkProvider>
      <RouterProvider router={router} />
    </LdkProvider>
  </StrictMode>
)
