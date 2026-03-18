---
status: complete
priority: p2
issue_id: "083"
tags: [code-review, architecture, maintainability]
dependencies: []
---

# Invert TabBar visibility logic to positive route list

## Problem Statement

`TabBar.tsx` uses `SUB_FLOW_PREFIXES` to hide the tab bar via prefix matching. This requires manual updates for every new route. Since only `/` and `/activity` show the tab bar, a positive list is shorter and safer.

## Findings

- **File:** `src/components/TabBar.tsx`, `SUB_FLOW_PREFIXES` array
- **Identified by:** architecture-strategist (Section 3.3)

## Acceptance Criteria

- [ ] Replace `SUB_FLOW_PREFIXES` with `TAB_BAR_ROUTES = ['/', '/activity']`
- [ ] Use `TAB_BAR_ROUTES.includes(location.pathname)` to determine visibility
