---
topic: React/TypeScript Webapp Skeleton Setup
date: 2026-03-11
status: complete
---

# React/TypeScript Webapp Skeleton Setup

## What We're Building

A standalone web wallet application built with React and TypeScript, scaffolded with Vite. The skeleton establishes the project's foundation: build tooling, code quality pipeline (linting, formatting, type checking), testing infrastructure (unit + E2E), styling, routing, and WASM integration scaffolding for future Rust-compiled wallet logic.

## Why This Approach

**Vite scaffold + manual config layering** — start with `pnpm create vite` (React-TS template), then add each tool individually. This gives full control over the build pipeline, which is critical for a project that will integrate WASM modules. Community templates go stale and impose opinions that may conflict with WASM requirements.

## Key Decisions

1. **Build tool: Vite** — Fast HMR, excellent TypeScript support, native WASM plugin ecosystem.
2. **Package manager: pnpm** — Strict dependency resolution, disk-efficient, fast installs.
3. **Styling: Tailwind CSS v4** — Build-time CSS, zero runtime cost, fast prototyping. Runtime CSS-in-JS (styled-components) was considered but is declining in adoption and incompatible with modern React patterns.
4. **State management: React Context + hooks** — Start with built-in primitives. Upgrade to Zustand or similar if complexity warrants it. YAGNI.
5. **Linting: ESLint v9 flat config + Prettier** — Industry standard with the largest plugin ecosystem. Biome was considered but has a smaller plugin ecosystem. ESLint plugins for React, accessibility, and import sorting are mature.
6. **Testing: Vitest + React Testing Library (unit/component) + Playwright (E2E)** — Vitest has native Vite integration. Playwright is the modern standard for E2E testing.
7. **Routing: React Router v7** — Standard, well-documented, supports nested routes and loaders.
8. **WASM integration: Include scaffolding** — `vite-plugin-wasm` + `vite-plugin-top-level-await` for loading Rust-compiled WASM modules. Placeholder structure for future wallet logic.

## Scope

### In Scope

- Vite + React + TypeScript project scaffold
- ESLint v9 flat config with React, TypeScript, accessibility, and import plugins
- Prettier config with ESLint integration
- Vitest setup with React Testing Library and a sample test
- Playwright setup with a sample E2E test
- Tailwind CSS v4 integration
- React Router v7 with basic route structure (home, placeholder pages)
- WASM loader utility and Vite plugin config
- TypeScript strict mode
- pnpm scripts for dev, build, lint, format, typecheck, test, test:e2e

### Out of Scope

- Actual wallet functionality or crypto logic
- Authentication / authorization
- API layer or backend integration
- CI/CD pipeline (separate concern)
- Deployment configuration
- Component library or design system

## Open Questions

None — all key decisions resolved during brainstorming.

## Project Structure (Proposed)

```
browser-wallet/
├── public/
├── src/
│   ├── assets/
│   ├── components/
│   ├── hooks/
│   ├── pages/
│   ├── routes/
│   ├── wasm/            # WASM loader utilities
│   ├── App.tsx
│   ├── main.tsx
│   └── vite-env.d.ts
├── e2e/                  # Playwright E2E tests
├── eslint.config.ts
├── prettier.config.js
├── tsconfig.json
├── tsconfig.node.json
├── tailwind.config.ts
├── vite.config.ts
├── playwright.config.ts
├── vitest.config.ts      # or inline in vite.config.ts
└── package.json
```
