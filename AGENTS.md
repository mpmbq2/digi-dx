# Repository Guidelines

## Project Structure & Module Organization

This is a Node 20 TypeScript project.

- **`src/`** — daemon runtime. Entry point `src/index.ts`; domain modules under `src/daemon/` (config, websocket, audio devices, live and simulated engine drivers, transmit state).
- **`core/`** — shared, QSO-aware and transport-shared code used by clients and imported by the daemon where the wire contract lives:
  - `core/protocol.ts` — daemon ↔ client wire types (single source of truth)
  - `core/slot-clock.ts` — published slot clock arithmetic
  - `core/qso.ts` — FT8 message parser, QSO state machine, scheduling/occupancy helpers
  - `core/daemon-client.ts` — shared WebSocket client helpers
- **`ui/`** — clients. `ui/tui.ts` (blessed TUI), `ui/web/server.ts` + `ui/web/public/` (web UI), `ui/cli.ts`, `ui/qso-log.ts` (QSO log / ADIF path selection). Run via `tsx`.
- **`test/`** — Vitest suites mirroring the modules they exercise.
- **`scripts/`** — install, launch (`digi`), and verification (`smoke`, `smoke:ui`).
- **`docs/`** — design and planning notes; wire contract summary in `docs/protocol.md`.
- **`dist/`** — build output; do not edit.

FT8 QSO automation lives in **`core/qso.ts`**, not the daemon. Both `ui/tui.ts` and `ui/web/server.ts` drive that engine. The daemon stays QSO-unaware — it only transports `transmit` and `cancel_transmit`. Keep new automation logic in `core/qso.ts` (or other pure modules under `core/` / thin `ui/*-state.ts` helpers), not in blessed `ui/tui.ts`, so it stays unit-testable.

The daemon can run a **simulated engine** (demo mode / `DIGI_DX_ENGINE=sim`) with no radio, audio device, or engine binaries. Live sessions use the ft8cat/ft8modem driver. See `docs/install.md` and `docs/protocol.md`.

## Build, Test, and Development Commands

- `npm install` / `npm ci`: install dependencies from `package-lock.json`.
- `npm run dev`: run the daemon with `tsx` and `DIGI_DX_CONFIG_PATH=./data/config.json`.
- `npm run build`: type-check and compile `src/**/*.ts` with `tsc`.
- `npm run typecheck`: type-check UI/clients via `tsconfig.ui.json`.
- `npm start`: run the compiled daemon from `dist/`.
- `npm test`: run the Vitest suite once.
- `npm run smoke`: headless simulated QSO to completion (no radio).
- `npm run smoke:ui`: headless Playwright web screenshots against the simulator (requires `npx playwright install chromium` once).
- `npm run ui` / `npm run tui` / `npm run web`: CLI, TUI, or web server helpers.
- `npm run digi` / `npm run install-engine`: turnkey launch and live-engine install (radio path).

A fresh clone in the [devcontainer](.devcontainer/devcontainer.json) (or CI) reaches green with:

`npm ci && npm test && npm run smoke && npm run smoke:ui`

(Playwright Chromium is installed by the container post-create / CI step.)

## Hardware-verification reachability

The demo/sim path proves the app in a container; it does **not** prove the live radio path.

What no agent-visible path exercises is the **live process boundary**: spawning a real engine binary, binding a real socket, and process-group teardown. Changes that touch **driver construction**, **`SessionConfig`**, **transmit encoding**, or **daemon↔driver wiring** need hardware verification even when the work item is not labeled “engine backend” — stating this as reachability, not as a backlog category.

Stdout PTT parsing, transmit-line encoding, and UDP line parsing are already unit-covered against a mocked spawn; that coverage does not substitute for a live QSO on the rig.

## Coding Style & Naming Conventions

Use strict TypeScript, ESM imports, and NodeNext module resolution. Keep two-space indentation, double quotes, semicolons, and explicit `.js` extensions in relative imports from TypeScript source. Prefer small modules with named exports. Use kebab-case for multiword filenames such as `audio-devices.ts` and `tx-state.ts`; use PascalCase for classes and interfaces where appropriate.

## Testing Guidelines

Vitest is the test framework. Put tests in `test/**/*.test.ts`, mirror the behavior under test, and use descriptive `describe` and `it` names. Cover validation, error details, state transitions, websocket protocol behavior, and filesystem edge cases when changing daemon behavior. For QSO automation, put logic in `core/qso.ts` and cover it in `test/ui-qso.test.ts` (and related suites); the blessed layer in `ui/tui.ts` is only verified by type-checking and a non-crashing startup, so keep it thin. Run `npm test` before submitting changes; `npm run build` when touching `src/`; `npm run typecheck` when touching `ui/` or `core/` client surfaces; `npm run smoke` / `npm run smoke:ui` when changing simulator, timing, or web client behavior.

## Commit & Pull Request Guidelines

Recent history uses short, imperative or descriptive subjects such as `Implement phase 1 daemon` and `Validated behavior against real hardware`. Keep commits focused and avoid mixing unrelated changes. Pull requests should describe the behavior change, list commands run, link related issues or PRs, and include screenshots or terminal output when UI behavior changes (smoke:ui artifacts under `artifacts/smoke-ui/` are intended for phone-legible review).

## Security & Configuration Tips

Do not commit local runtime config, secrets, or auth tokens. Use `DIGI_DX_CONFIG_PATH` for local config and `DIGI_DX_AUTH_TOKEN` for websocket authentication. The production default config path is `/var/lib/digi-dx/config.json`; keep development examples under ignored local data paths.
