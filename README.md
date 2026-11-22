# Digi-Dx v2

A local-first FT8 & transceiver daemon with an embedded web console (`:8788`).

## Native Linux Install (Ubuntu / Raspberry Pi OS)

### 1. System Dependencies

Install build tools, Hamlib (`rigctld`), ALSA dev headers, and optionally `wsjtx` (provides `jt9` for full-sensitivity FT8 decoding; without it, Digi-Dx falls back to the built-in `ft8_lib` decoder):

```bash
sudo apt update
sudo apt install -y \
  build-essential pkg-config libasound2-dev libsqlite3-dev \
  libhamlib-utils wsjtx curl git
```

You also need:
- **Rust** (`rustup`): <https://rustup.rs>
- **Node.js & npm** (v20+): for building the embedded UI (`ui/`)

### 2. Serial & Audio Permissions

Add your user to `dialout` (serial CAT) and `audio` (ALSA soundcards), then **log out and back in** (or reboot) so group membership takes effect:

```bash
sudo usermod -aG dialout,audio "$USER"
```

### 3. Build from Source

```bash
git clone https://github.com/n1mpm/digi-dx.git
cd digi-dx
make ui-deps
make build
```

This compiles the frontend into `ui/dist/` and embeds it into the single release binary at `target/release/digi-dx`.

### 4. Verify & Run

Run the preflight check, then start the daemon:

```bash
./target/release/digi-dx preflight
./target/release/digi-dx serve
```

Open `http://127.0.0.1:8788` (or `http://<host-ip>:8788` on your LAN) in a browser.

### 5. Optional: Install as a `systemd` Service

To install `/usr/local/bin/digi-dx`, udev rules (`/etc/udev/rules.d/99-digi-dx.rules`), and a `systemd` service (`digi-dx.service`):

```bash
sudo ./scripts/install.sh
sudo systemctl status digi-dx
```

---

## Documentation

- [`docs/mvp-spec.md`](docs/mvp-spec.md) — MVP milestones and verification criteria
- [`docs/architecture.md`](docs/architecture.md) — System architecture
- [`docs/deployment-and-deps.md`](docs/deployment-and-deps.md) — Deployment & dependency notes
- [`docs/legacy-domain-notes.md`](docs/legacy-domain-notes.md) — Radio, CAT/Hamlib, audio/DSP, and FT8 domain notes
