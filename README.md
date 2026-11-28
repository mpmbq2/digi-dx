# Digi-Dx v2

A local-first FT8 & transceiver daemon with an embedded web console (`:8788`).

---

## Install on macOS (Apple Silicon)

### Option 1: Homebrew (Recommended)

Requires [Homebrew](https://brew.sh) on an Apple Silicon Mac (M1/M2/M3/M4):

```bash
brew install mpmbq2/tap/digi-dx
brew services start digi-dx
```

Then open **<http://127.0.0.1:8788>** in Safari, Chrome, or Firefox.

- **Built-in FT8 & FT4 decoding:** Digi-Dx bundles its high-sensitivity pure-Rust FT8/FT4 decoder engine out of the box (with embedded `ft8_lib` fallback and optional support for an existing WSJT-X `jt9` installation switchable from the UI).
- **Microphone permission:** macOS treats USB radio soundcards as microphones. If RX audio looks silent on first run, run `digi-dx preflight --probe-audio` and approve access under **System Settings → Privacy & Security → Microphone**.
- **Upgrade later:**
  ```bash
  brew update && brew upgrade digi-dx && brew services restart digi-dx
  ```

### Option 2: One-Line Installer (without Tap)

Run as your normal user (do **not** use `sudo`):

```bash
curl -fsSL https://raw.githubusercontent.com/mpmbq2/digi-dx/main/scripts/install.sh | bash
```

---

## Install on Raspberry Pi (64-bit) / Linux

Supports 64-bit Raspberry Pi OS (Pi 4 / Pi 5), Ubuntu, Debian, Fedora, and Arch (`aarch64` / `x86_64`). No `git`, Rust, or Node.js required:

```bash
curl -fsSL https://raw.githubusercontent.com/mpmbq2/digi-dx/main/scripts/install.sh | bash
```

This installs Digi-Dx (with its default FT8/FT4 decoder), installs Hamlib (`rigctld`), sets up USB serial/audio permissions (`udev`), and starts the `digi-dx` `systemd` service automatically.

> **Tip:** You don't need to use a browser on the Raspberry Pi. Open **`http://<pi-hostname>.local:8788`** (or `http://<pi-ip>:8788`) from your Mac, PC, tablet, or phone on the same network.

- **Optional WSJT-X `jt9` decoder:** if you separately install `wsjtx` (`jt9`), Digi-Dx lets you switch between `ftxr` (default), `jt9`, and embedded `ft8_lib` right from the UI.
- **Check status / logs:**
  ```bash
  sudo systemctl status digi-dx
  journalctl -u digi-dx -f
  ```
- **Uninstall** (preserves your QSO database):
  ```bash
  curl -fsSL https://raw.githubusercontent.com/mpmbq2/digi-dx/main/scripts/install.sh | bash -s -- --uninstall
  ```

---

## Build from Source (Developers)

Only needed if you are hacking on Digi-Dx itself.

### 1. System Dependencies

- **Linux (Debian / Ubuntu / Raspberry Pi OS):**
  ```bash
  sudo apt update
  sudo apt install -y \
    build-essential pkg-config libasound2-dev \
    libhamlib-utils curl git
  ```
- **macOS (Homebrew):**
  ```bash
  brew install hamlib
  ```
- **Toolchains:** [Rust (`rustup`)](https://rustup.rs) (>= 1.82) and Node.js (>= 20) + `npm`.

### 2. Clone & Build

```bash
git clone https://github.com/mpmbq2/digi-dx.git
cd digi-dx
make ui-deps
make build
```

This compiles the frontend into `ui/dist/` and embeds it into the single release binary at `target/release/digi-dx`.

### 3. Verify & Run

```bash
./target/release/digi-dx preflight
./target/release/digi-dx serve
```

Or install your locally built binary as a native service:

```bash
./scripts/install.sh --from-source
```

---

## Documentation

- [`docs/mvp-spec.md`](docs/mvp-spec.md) — MVP milestones and verification criteria
- [`docs/architecture.md`](docs/architecture.md) — System architecture
- [`docs/deployment-and-deps.md`](docs/deployment-and-deps.md) — Deployment & dependency notes
- [`docs/legacy-domain-notes.md`](docs/legacy-domain-notes.md) — Radio, CAT/Hamlib, audio/DSP, and FT8 domain notes

## License

- **Digi-Dx daemon & web UI:** [`MIT`](LICENSE)
- **Bundled default FT8/FT4 DSP sidecar (`ftxr-modem`):** `GPL-3.0-only` (executed as a standalone worker binary over stdio IPC; license, notices, and corresponding source archive are included alongside Digi-Dx release packages).
