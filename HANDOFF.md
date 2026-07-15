# Handoff — simulated engine & demo mode

Scratch note. Delete when the branch merges.

## State

- **Branch:** `feat/slot-clock` (ahead of `main`; all of U1–U10 + review fixes committed)
- **Plan:** `docs/plans/2026-07-13-001-feat-simulated-engine-demo-mode-plan.md`
- **Done:** U1–U10. Untracked only: this `HANDOFF.md`.
- **Gates green:** `npm test` (160), `npm run build`, `npm run typecheck`, `npm run smoke`, `npm run smoke:ui`

## Verification commands

```bash
npm test && npm run build && npm run typecheck && npm run smoke && npm run smoke:ui
```

Screenshots: `artifacts/smoke-ui/` (gitignored). Residuals: `docs/residual-review-findings/feat-slot-clock.md`.

## Remaining (human)

1. **Open / push PR** when ready (not done from ce-work).
2. **Hardware regression** at the radio box before any user-facing ship (Product Contract reachability).
3. Soft R17 banners will appear on this PR’s own smoke runs (expected): CI shows a GitHub Actions warning annotation; exit stays 0.

## Try demo

```bash
DIGI_DX_PORT=8911 DIGI_DX_CONFIG_PATH=/tmp/none.json npx tsx src/index.ts
# start_session { demo: true }
```
