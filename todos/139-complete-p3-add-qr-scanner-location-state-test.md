---
status: complete
priority: p3
issue_id: '139'
tags: [code-review, testing]
---

# Add test for QR scanner location.state integration

## Problem Statement

The QR scanner useEffect that reads `location.state.scannedInput` is a new feature path with non-trivial logic (classify, route, eslint-disable), but has no test coverage.

## Findings

- Flagged by TypeScript reviewer, Security reviewer
- Render with `MemoryRouter initialEntries={[{ pathname: '/send', state: { scannedInput: '...' } }]}`
- Should test: scanned input with amount → review, scanned input without amount → numpad, invalid input → shows error

## Proposed Solutions

Add 2-3 tests using MemoryRouter `initialEntries` with `state: { scannedInput }`.

- Effort: Small
- Risk: None
