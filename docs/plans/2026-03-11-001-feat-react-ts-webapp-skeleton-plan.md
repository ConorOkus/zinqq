---
title: 'feat: React/TypeScript Webapp Skeleton with Vite, Tooling, and WASM Scaffolding'
type: feat
status: completed
date: 2026-03-11
origin: docs/brainstorms/2026-03-11-react-ts-webapp-skeleton-brainstorm.md
---

# ✨ React/TypeScript Webapp Skeleton with Vite, Tooling, and WASM Scaffolding

Set up the foundational project skeleton for the browser-wallet standalone web app: build tooling, code quality pipeline, testing infrastructure, styling, routing, and WASM integration scaffolding.

## Acceptance Criteria

- [x] `pnpm dev` starts Vite dev server with HMR on `localhost:5173`
- [x] `pnpm build` produces a production bundle in `dist/`
- [x] `pnpm preview` serves the production bundle locally
- [x] `pnpm lint` runs ESLint with zero errors on all scaffold code
- [x] `pnpm format` formats all files with Prettier; `pnpm format:check` verifies without writing
- [x] `pnpm typecheck` passes TypeScript strict mode (including `noUncheckedIndexedAccess`)
- [x] `pnpm test` runs Vitest in run mode with a sample passing test; `pnpm test:watch` for dev
- [x] `pnpm test:e2e` runs Playwright with a sample passing E2E test (auto-starts dev server via `webServer` config)
- [x] Tailwind CSS v4 classes render correctly in components
- [x] React Router v7 navigation works between `/` and placeholder routes
- [x] WASM Vite plugins configured and a stub `.wasm` import compiles without error

## Context

This is a greenfield project. The repo currently contains only `.gitignore` and `.gitattributes` (configured for WASM/TypeScript). All decisions were made during brainstorming (see brainstorm: `docs/brainstorms/2026-03-11-react-ts-webapp-skeleton-brainstorm.md`).

### Key Technical Decisions (from brainstorm)

| Decision         | Choice                                             | Rationale                                        |
| ---------------- | -------------------------------------------------- | ------------------------------------------------ |
| Build tool       | Vite 7                                             | Fast HMR, WASM plugin ecosystem (see brainstorm) |
| Package manager  | pnpm                                               | Strict deps, disk-efficient (see brainstorm)     |
| Styling          | Tailwind CSS v4                                    | Build-time CSS, zero runtime (see brainstorm)    |
| State management | React Context + hooks                              | YAGNI — upgrade later if needed (see brainstorm) |
| Linting          | ESLint v9 flat config + Prettier                   | Stay on v9 — `eslint-plugin-react` broken on v10 |
| Testing          | Vitest + RTL + Playwright                          | Native Vite integration + modern E2E             |
| Routing          | React Router v7 (Data mode)                        | SPA with `createBrowserRouter`, loaders support  |
| WASM             | `vite-plugin-wasm` + `vite-plugin-top-level-await` | Required for Rust-compiled WASM modules          |

### Gaps Resolved from SpecFlow Analysis

1. **`tailwind.config.ts` removed** — Tailwind v4 is CSS-first; configuration via `@theme` in CSS. The brainstorm's proposed structure was stale.
2. **`eslint.config.ts` requires `jiti`** — Added as dev dependency for TypeScript ESLint config support.
3. **Use `eslint-plugin-import-x`** (not `eslint-plugin-import`) — The original doesn't support ESLint v9 flat config reliably.
4. **Playwright `webServer` config included** — Auto-starts `pnpm dev` so `pnpm test:e2e` works on fresh clones and CI.
5. **`pnpm test` uses `vitest run`** (not watch mode) — `pnpm test:watch` added separately for dev.
6. **`pnpm preview` and `pnpm format:check` scripts added** — For production bundle verification and CI-friendly formatting check.
7. **Sample Vitest test targets a leaf component** (not `<App />`) — Avoids needing router context in the first test.
8. **WASM loader exports `async initWasm(): Promise<WasmExports>`** — Minimal contract for the placeholder utility.
9. **Browser targets: modern only** — `vite-plugin-top-level-await` kept for safety with WASM plugin internals but may be removable later.

## MVP

### Step 1: Scaffold with Vite

```bash
pnpm create vite browser-wallet --template react-swc-ts
# Move contents to repo root since repo already exists
```

### Step 2: Install dependencies

#### package.json (scripts section)

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui"
  }
}
```

#### Dev dependencies to install

```bash
# Tailwind CSS v4
pnpm add -D tailwindcss @tailwindcss/vite

# ESLint v9 + TypeScript + React + Prettier integration
pnpm add -D eslint @eslint/js typescript-eslint \
  eslint-plugin-react eslint-plugin-react-hooks \
  eslint-plugin-jsx-a11y eslint-plugin-import-x \
  eslint-config-prettier jiti

# Prettier
pnpm add -D prettier

# Vitest + React Testing Library
pnpm add -D vitest jsdom @testing-library/react \
  @testing-library/user-event @testing-library/jest-dom

# Playwright
pnpm add -D @playwright/test

# WASM plugins
pnpm add -D vite-plugin-wasm vite-plugin-top-level-await
```

#### Runtime dependencies

```bash
pnpm add react-router
```

### Step 3: Configuration files

#### vite.config.ts

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

export default defineConfig({
  plugins: [react(), tailwindcss(), wasm(), topLevelAwait()],
  worker: {
    plugins: () => [wasm(), topLevelAwait()],
  },
})
```

#### eslint.config.ts

```typescript
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactPlugin from 'eslint-plugin-react'
import reactHooksPlugin from 'eslint-plugin-react-hooks'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import importX from 'eslint-plugin-import-x'
import prettierConfig from 'eslint-config-prettier'

export default [
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
      'jsx-a11y': jsxA11y,
      'import-x': importX,
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactPlugin.configs['jsx-runtime'].rules,
      ...reactHooksPlugin.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
    },
  },
  prettierConfig,
  { ignores: ['dist/**', 'node_modules/**', 'e2e/**'] },
]
```

#### .prettierrc

```json
{
  "semi": false,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "es5",
  "printWidth": 100
}
```

#### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitOverride": true,
    "skipLibCheck": true,
    "useDefineForClassFields": true
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

#### tsconfig.node.json

```json
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true,
    "strict": true
  },
  "include": ["vite.config.ts", "eslint.config.ts", "playwright.config.ts"]
}
```

#### vitest.config.ts

```typescript
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react-swc'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    css: true,
  },
})
```

#### playwright.config.ts

```typescript
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
  },
})
```

### Step 4: Source structure

#### src/index.css

```css
@import 'tailwindcss';

@theme {
  --font-sans: 'Inter', system-ui, sans-serif;
}
```

#### src/main.tsx

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'
import { router } from './routes/router'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
)
```

#### src/routes/router.tsx

```tsx
import { createBrowserRouter } from 'react-router'
import { Layout } from '../components/Layout'
import { Home } from '../pages/Home'
import { Settings } from '../pages/Settings'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Home /> },
      { path: 'settings', element: <Settings /> },
    ],
  },
])
```

#### src/components/Layout.tsx

```tsx
import { Outlet, Link } from 'react-router'

export function Layout() {
  return (
    <div>
      <nav>
        <Link to="/">Home</Link>
        <Link to="/settings">Settings</Link>
      </nav>
      <main>
        <Outlet />
      </main>
    </div>
  )
}
```

#### src/pages/Home.tsx

```tsx
export function Home() {
  return <h1>Browser Wallet</h1>
}
```

#### src/pages/Settings.tsx

```tsx
export function Settings() {
  return <h1>Settings</h1>
}
```

#### src/wasm/loader.ts

```typescript
/**
 * Placeholder WASM loader utility.
 * Replace with actual wasm-pack output when Rust modules are ready.
 */
export interface WasmExports {
  [key: string]: unknown
}

export async function initWasm(wasmUrl: string): Promise<WasmExports> {
  const response = await fetch(wasmUrl)
  const { instance } = await WebAssembly.instantiateStreaming(response)
  return instance.exports as WasmExports
}
```

### Step 5: Test files

#### src/test/setup.ts

```typescript
import '@testing-library/jest-dom'
```

#### src/components/Layout.test.tsx (sample Vitest test)

```tsx
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect } from 'vitest'
import { Home } from '../pages/Home'

describe('Home', () => {
  it('renders the heading', () => {
    render(<Home />)
    expect(screen.getByRole('heading', { name: /browser wallet/i })).toBeInTheDocument()
  })
})
```

#### e2e/home.spec.ts (sample Playwright test)

```typescript
import { test, expect } from '@playwright/test'

test('home page loads and displays heading', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /browser wallet/i })).toBeVisible()
})

test('navigation to settings works', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: /settings/i }).click()
  await expect(page.getByRole('heading', { name: /settings/i })).toBeVisible()
})
```

### Step 6: Post-scaffold tasks

```bash
# Install Playwright browsers (one-time)
pnpm exec playwright install chromium

# Verify all scripts pass
pnpm lint
pnpm format
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
pnpm preview
```

## Updated Project Structure

```
browser-wallet/
├── public/
├── src/
│   ├── assets/
│   ├── components/
│   │   ├── Layout.tsx
│   │   └── Layout.test.tsx
│   ├── hooks/
│   ├── pages/
│   │   ├── Home.tsx
│   │   └── Settings.tsx
│   ├── routes/
│   │   └── router.tsx
│   ├── test/
│   │   └── setup.ts
│   ├── wasm/
│   │   └── loader.ts
│   ├── App.tsx
│   ├── main.tsx
│   ├── index.css
│   └── vite-env.d.ts
├── e2e/
│   └── home.spec.ts
├── eslint.config.ts
├── .prettierrc
├── tsconfig.json
├── tsconfig.node.json
├── vite.config.ts
├── vitest.config.ts
├── playwright.config.ts
├── package.json
├── pnpm-lock.yaml
├── .gitignore
└── .gitattributes
```

## Sources

- **Origin brainstorm:** [docs/brainstorms/2026-03-11-react-ts-webapp-skeleton-brainstorm.md](docs/brainstorms/2026-03-11-react-ts-webapp-skeleton-brainstorm.md) — Key decisions: Vite + manual config layering, Tailwind v4, ESLint v9 + Prettier, React Router v7 Data mode, WASM scaffolding
- Vite 7 docs: https://vitejs.dev/guide/
- ESLint flat config: https://eslint.org/docs/latest/use/configure/configuration-files
- typescript-eslint v8: https://typescript-eslint.io/getting-started/
- Tailwind CSS v4 Vite setup: https://tailwindcss.com/docs/installation/using-vite
- Vitest guide: https://vitest.dev/guide/
- Playwright docs: https://playwright.dev/docs/intro
- React Router v7 modes: https://reactrouter.com/start/modes
