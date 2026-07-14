# Digi-Dx install guide

Turnkey flow for brother/dad on supported Linux (x86_64 or aarch64):

```bash
git clone <repo-url> digi-dx
cd digi-dx
npm install
npm run install-engine
npm run digi -- --ui web
```

Open the web UI in a browser (default `http://<host>:8080`) or use `--ui tui` for the terminal UI.

## Prerequisites

- Node.js 20+
- Debian/Ubuntu-derived Linux with `apt` (for build dependencies)
- `sudo` for apt package install during `install-engine`
- Audio interface and CAT wiring configured through the UI after first launch

## Commands

| Command | Purpose |
|---------|---------|
| `npm install` | Node dependencies |
| `npm run install-engine` | Build/fetch ft8modem, ft8cat, wsjtx-utils decode tools, rigctld; write `vendor/engine/manifest.json` |
| `npm run digi -- --ui web` | Start daemon + web UI |
| `npm run digi -- --ui tui` | Start daemon + TUI |

Developer overrides (optional):

- `DIGI_DX_FT8CAT_PATH`, `DIGI_DX_FT8MODEM_PATH`, `DIGI_DX_RIGCTLD_PATH` — override manifest paths
- `DIGI_DX_CONFIG_PATH` — config file location (default `./data/config.json` in dev)
- `DIGI_DX_AUTH_TOKEN` — websocket control token

## First-run setup

On first connect, the UI prompts for callsign, grid, audio device, and CAT settings when config is incomplete. Session start stays disabled until config is saved.

If you do not have a radio wired yet, use **Try it without a radio** on that setup screen. That starts a simulated FT8 band (demo mode): nothing is transmitted, no audio device or CAT is required, and completed contacts are written to `data/demo-qso-log.jsonl` rather than your real QSO log. Demo mode runs in real time and is labeled clearly in the UI so it cannot be mistaken for a live band.

Developer / verification overrides (optional):

- `DIGI_DX_ENGINE=sim` — force every session onto the simulated engine (headless verification path)
- `DIGI_DX_SIM_SCALE` / `DIGI_DX_SIM_SEED` — only applied when `DIGI_DX_ENGINE=sim`; leave unset for a normal install so interactive demo mode stays real-time

## Troubleshooting

- **No audio devices** — add your user to the `audio` group and re-login; verify `vendor/engine/<arch>/bin/ft8modem -h` lists devices.
- **CAT failed** — confirm `rigctld` is running on the configured port, or use `dummy` CAT mode for testing without a radio.
- **Wrong-arch binary** — re-run `npm run install-engine`; install picks `x86` vs `aarch64` wsjtx-utils subfolder automatically.
- **Install succeeds but no decodes** — radio/audio/CAT wiring is a station-config issue, not an incomplete engine install.

## Radio wiring boundary

Install proves the engine stack is present and the daemon can start a session. Decodes and QSOs require correctly wired audio and CAT — install tooling cannot verify your shack hardware.
