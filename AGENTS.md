# Repository Guidelines

## Project Structure & Module Organization

This is a Node 20 TypeScript project. Runtime daemon code lives in `src/`, with the entry point at `src/index.ts` and domain modules under `src/daemon/` for configuration, protocol, websocket handling, audio devices, engine behavior, and transmit state. Tests live in `test/` and follow the source concerns they exercise, for example `test/config.test.ts` and `test/websocket.test.ts`. CLI and TUI utilities are in `ui/` and run through `tsx`. Design and planning notes are kept in `docs/`. Build output goes to `dist/` and should not be edited directly.

## Build, Test, and Development Commands

- `npm install`: install dependencies from `package-lock.json`.
- `npm run dev`: run the daemon with `tsx` and `DIGI_DX_CONFIG_PATH=./data/config.json`.
- `npm run build`: type-check and compile `src/**/*.ts` with `tsc`.
- `npm start`: run the compiled daemon from `dist/index.js`.
- `npm test`: run the Vitest suite once.
- `npm run ui` / `npm run tui`: start the CLI or terminal UI helpers.

## Coding Style & Naming Conventions

Use strict TypeScript, ESM imports, and NodeNext module resolution. Keep two-space indentation, double quotes, semicolons, and explicit `.js` extensions in relative imports from TypeScript source. Prefer small modules with named exports. Use kebab-case for multiword filenames such as `audio-devices.ts` and `tx-state.ts`; use PascalCase for classes and interfaces where appropriate.

## Testing Guidelines

Vitest is the test framework. Put tests in `test/**/*.test.ts`, mirror the behavior under test, and use descriptive `describe` and `it` names. Cover validation, error details, state transitions, websocket protocol behavior, and filesystem edge cases when changing daemon behavior. Run `npm test` before submitting changes; run `npm run build` when touching types or exports.

## Commit & Pull Request Guidelines

Recent history uses short, imperative or descriptive subjects such as `Implement phase 1 daemon` and `Validated behavior against real hardware`. Keep commits focused and avoid mixing unrelated changes. Pull requests should describe the behavior change, list commands run, link related issues or PRs, and include screenshots or terminal output when UI behavior changes.

## Security & Configuration Tips

Do not commit local runtime config, secrets, or auth tokens. Use `DIGI_DX_CONFIG_PATH` for local config and `DIGI_DX_AUTH_TOKEN` for websocket authentication. The production default config path is `/var/lib/digi-dx/config.json`; keep development examples under ignored local data paths.
