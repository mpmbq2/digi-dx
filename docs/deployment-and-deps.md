# Digi-Dx v2 Deployment, Packaging & System Dependencies

**Status:** Design Specification (v2.0 Ground-Up Rebuild)
**Reference Context:** Incorporates Linux OS/audio/group/architecture traps from [`docs/legacy-domain-notes.md`](legacy-domain-notes.md).
**Companion Specs:** [`docs/architecture.md`](architecture.md) · [`docs/mvp-spec.md`](mvp-spec.md)

---

## 1. Deployment Philosophy

- **Primary Target:** Native OS background service—**`systemd`** on Linux (`x86_64` and `aarch64` / Raspberry Pi 4 & 5 64-bit) and **`launchd`** on macOS (`arm64` Apple Silicon and `x86_64` Intel).
- **Why Native First:** Direct, zero-friction access to Linux `udev` netlink hot-plug events, `/dev/serial/by-id/*` symlinks, ALSA soundcards, and macOS CoreAudio/IOKit USB devices without container passthrough drift.
- **Bootstrap + Escape Hatch:** Automated, idempotent `scripts/install.sh` handles the happy path; every step has a documented manual equivalent below.
- **Containerization:** Supported as an optional/secondary Linux-only deployment path (Section 7).
- **32-bit ARM (`armv7`) & Windows:** Explicitly out of scope for v2.0 MVP.

---

## 2. Cross-Platform Dependency Matrix

### 2.1 Runtime Dependencies

| Dependency | Role in Digi-Dx v2 | Severity | Debian / Ubuntu / RPi OS (`apt`) | Fedora / RHEL (`dnf`) | Arch Linux (`pacman`) | macOS (`Homebrew`) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`hamlib` (`rigctl`, `rigctld`)** | Per-radio CAT & PTT control (`+` extended TCP protocol + dummy `-m 1`) | **Required** | `libhamlib-utils` (pulls `libhamlib4` / `libhamlib4t64`) | `hamlib` | `hamlib` | `brew install hamlib` |
| **`usbutils` (`lsusb`)** | USB VID:PID diagnostics & preflight verification | **Recommended** (Linux) / Built-in (macOS) | `usbutils` | `usbutils` | `usbutils` | Built-in (`ioreg`, `system_profiler`) |
| **`udev` (`udevadm`)** | Linux hot-plug device events & `/dev/serial/by-id/*` symlinks | **Required** (Linux) | `udev` (systemd built-in) | `systemd-udev` | `systemd` | N/A (macOS uses IOKit) |
| **Audio Runtime (`ALSA` / `CoreAudio`)** | `cpal` PCM audio capture & playback | **Required** | `libasound2` (or `libasound2t64`), `alsa-utils` | `alsa-lib`, `alsa-utils` | `alsa-lib`, `alsa-utils` | Built-in (`CoreAudio`) |
| **WSJT-X `jt9` binary** | Primary high-sensitivity FT8 decoder (`~-24 dB`, multi-pass subtraction) | **Recommended** *(graceful fallback to embedded MIT `ft8_lib`)* | `wsjtx` *(or stripped `wsjtx-utils` tarball — see §2.2)* | `wsjtx` | `wsjtx` (AUR/extra) | `brew install --cask wsjtx` (`/Applications/wsjtx.app/Contents/MacOS/jt9`) |
| **Time Sync (`NTP`)** | Sub-second UTC alignment for 15s FT8 slots | **Recommended** | `systemd-timesyncd` or `chrony` | `chrony` | `systemd-timesyncd` | Built-in (`timed`) |

> **Retired v1 Dependencies (No Longer Needed):** `rtaudio 6.0.1` C++ source build, `ft8modem`, `ft8cat`, `libsndfile1-dev`, `python3`, and `Node.js` at runtime are all eliminated in v2.

### 2.2 Notes on `jt9` Provisioning & Multi-Arch Trap
- **Debian/Ubuntu/RPi OS:**
  - `sudo apt install wsjtx` installs `/usr/bin/jt9` alongside WSJT-X GUI packages (~150 MB including Qt5).
  - For minimal headless Raspberry Pi / server installs where full GUI packages are unwanted, `install.sh` supports an optional headless `wsjtx-utils` fetch mode (matching the v1 strategy in [`docs/legacy-domain-notes.md`](legacy-domain-notes.md)): requires `libfftw3-single3`, `libgfortran5`, `libgomp1`, and `libqt5core5a` (Debian Bookworm) or `libqt5core5t64` (Ubuntu 24.04+ / Debian Trixie 64-bit `time_t`).
  - **Multi-Arch Safety Check:** Per v1 hardware lessons, `wsjtx-utils` archives bundle subfolders for multiple architectures (`armv6`, `armv7`, `aarch64`, `x86`, `i686`). Any fetched `jt9` binary **must** be verified against `uname -m` using `file <path>` and an execution probe (`jt9 -h`) to prevent `Exec format error`.
- **macOS:**
  - Homebrew distributes `wsjtx` as a cask (`brew install --cask wsjtx`), placing `jt9` inside `/Applications/wsjtx.app/Contents/MacOS/jt9`.
  - Digi-Dx searches in order: `DIGI_DX_JT9_PATH` env var → `PATH` → `/usr/local/lib/digi-dx/jt9` → `/Applications/wsjtx.app/Contents/MacOS/jt9`.
- **Fallback Behavior:** If `jt9` is omitted (`--no-jt9`) or unavailable, Digi-Dx runs cleanly out of the box using the statically embedded MIT `kgoba/ft8_lib` decoder and displays an amber `Fallback Decoder (ft8_lib)` badge in the UI.

### 2.3 Build-from-Source Dependencies (Developers / Non-Release Installs Only)

| Tool / Library | Debian / Ubuntu (`apt`) | Fedora (`dnf`) | Arch (`pacman`) | macOS (`Homebrew`) |
| :--- | :--- | :--- | :--- | :--- |
| Rust Toolchain (`>= 1.82`) | `rustup` | `rustup` | `rustup` | `rustup` |
| C Compiler & `pkg-config` | `build-essential pkg-config` | `gcc pkgconf-pkg-config` | `base-devel pkgconf` | Xcode Command Line Tools |
| Linux Dev Headers | `libasound2-dev libudev-dev` | `alsa-lib-devel systemd-devel` | `alsa-lib systemd-libs` | N/A |
| Frontend Build (UI SPA) | Node.js `>= 20` + `npm` | Node.js `>= 20` + `npm` | Node.js `>= 20` + `npm` | `brew install node@20` |

*(SQLite is compiled via `rusqlite`'s `bundled` feature and `kgoba/ft8_lib` via `cc`, so neither requires host `-dev` libraries.)*

---

## 3. Automated Bootstrap Script Specification (`scripts/install.sh`)

### 3.1 CLI Contract & Flags
```bash
curl -fsSL https://raw.githubusercontent.com/mpmbq2/digi-dx/main/scripts/install.sh | bash
# or from a local checkout:
bash scripts/install.sh [options]
```

| Flag | Default | Behavior |
| :--- | :--- | :--- |
| `--yes` / `-y` | interactive | Non-interactive mode; accepts package-manager prompts. |
| `--version <tag>` | `latest` | Pin a specific Digi-Dx GitHub Release tag (e.g., `v2.0.0`). |
| `--from-source` | off | Build locally via `npm ci && npm run build` (UI) + `cargo build --release` instead of downloading a release binary. |
| `--no-jt9` | off | Skip installing `wsjtx`/`jt9` (use built-in `ft8_lib` fallback only). |
| `--no-service` | off | Install binary, deps, and `udev` rules without registering/starting `systemd`/`launchd`. |
| `--user <name>` | invoking user (or `digi-dx` on Linux service mode) | Service execution user on Linux. |
| `--dry-run` | off | Print all planned actions without modifying the system. |
| `--uninstall` | off | Stop/disable service, remove binary and `udev` rules, **preserving** `/var/lib/digi-dx` (or `~/Library/Application Support/digi-dx`) QSO databases by default. |

### 3.2 Idempotent Execution Steps
1. **Platform & Arch Detection:**
   - Detect `uname -s` (`Linux` | `Darwin`) and normalize `uname -m` (`x86_64`/`amd64` → `x86_64`, `aarch64`/`arm64` → `aarch64`). Abort with a clear message on unsupported architectures (e.g., `armv7l` or prebuilt Intel macOS).
   - On Linux, parse `/etc/os-release` and detect package manager (`apt-get`, `dnf`, `pacman`).
2. **System Dependency Installation:**
   - Install `hamlib`, `usbutils` (Linux), `alsa-utils` (Linux), and optionally `wsjtx` / `jt9` using the matrix in §2.1.
   - Verify `rigctl --version` and `rigctld --version`.
3. **Binary Provisioning:**
   - Download `digi-dx-<os>-<arch>.tar.gz` + `SHA256SUMS`, verify checksum via `sha256sum` / `shasum -a 256`, and install atomically to `/opt/homebrew/bin/digi-dx` (Apple Silicon macOS when writable) or `/usr/local/bin/digi-dx` (`chmod 0755`).
   - *(With `--from-source`: build UI bundle, run `cargo build --release`, copy `target/release/digi-dx`.)*
4. **Linux `udev` Rules & Group Membership (Linux only):**
   - Install `/etc/udev/rules.d/99-digi-dx.rules` (§4).
   - Run `sudo udevadm control --reload-rules && sudo udevadm trigger --subsystem-match=tty --subsystem-match=sound`.
   - Ensure the service/operator user belongs to `dialout`, `plugdev`, and `audio` (`usermod -aG dialout,plugdev,audio <user>` — creating `plugdev` if absent on Fedora/Arch).
   - **Stale Group Warning (from [`docs/legacy-domain-notes.md`](legacy-domain-notes.md)):** If groups were newly added to the interactive operator user, print an explicit banner warning that a fresh SSH login (and `tmux kill-server` if running inside `tmux`) is required before interactive shells reflect the new `audio`/`dialout` permissions. *(Note: the `systemd` service itself inherits `SupplementaryGroups=dialout plugdev audio` immediately upon start.)*
5. **Data Directory & Permissions:**
   - **Linux:** Create `/var/lib/digi-dx` (`0750`, owned by service user/group) and `/etc/digi-dx/digi-dx.env` (`0600`) if not present (never overwriting existing config/DB).
   - **macOS:** Create `~/Library/Application Support/digi-dx` and `~/Library/Logs/digi-dx` (`0700`).
6. **Native Service Installation & Start:**
   - **Linux:** Write `/etc/systemd/system/digi-dx.service`, run `systemctl daemon-reload`, `systemctl enable --now digi-dx.service`.
   - **macOS:** Write `~/Library/LaunchAgents/com.digidx.daemon.plist`, run `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.digidx.daemon.plist`.
7. **Post-Install Verification Gate:**
   - Execute `digi-dx preflight` (as the service user on Linux) and query `http://127.0.0.1:8788/api/v1/health`.
   - Print the LAN access URL (`http://<host-ip>:8788`), active decoder backend (`jt9` vs `ft8_lib`), and any `WARN` advisories.

---

## 4. Linux `udev` Rules Specification

Install to `/etc/udev/rules.d/99-digi-dx.rules`:

```udev
# Digi-Dx v2 — Amateur Radio USB-Serial CAT & USB Audio Device Permissions
# Grants non-root access to serial CAT interfaces (dialout) and audio interfaces (audio),
# and tags devices with uaccess for active local desktop sessions.

# --- Common USB-to-Serial Bridges (CAT / PTT Control) ---
# FTDI (FT232R, FT232H, FT2232D/H — Elecraft, Yaesu SCU-17, SignaLink/RT Systems cables)
SUBSYSTEM=="tty", ATTRS{idVendor}=="0403", MODE="0660", GROUP="dialout", TAG+="uaccess", ENV{DIGI_DX_CAT_CANDIDATE}="1"

# Silicon Labs CP210x (Icom IC-7300/705/9700, Yaesu FT-991A/FTDX10, Kenwood TS-590/890)
SUBSYSTEM=="tty", ATTRS{idVendor}=="10c4", ATTRS{idProduct}=="ea60|ea70|ea71", MODE="0660", GROUP="dialout", TAG+="uaccess", ENV{DIGI_DX_CAT_CANDIDATE}="1"

# Prolific PL2303 (older Kenwood TS-570S/2000 USB-RS232 adapters)
SUBSYSTEM=="tty", ATTRS{idVendor}=="067b", ATTRS{idProduct}=="2303|23a3|23c3", MODE="0660", GROUP="dialout", TAG+="uaccess", ENV{DIGI_DX_CAT_CANDIDATE}="1"

# WCH CH340 / CH341 (budget CAT cables, QRP transceivers, DigiRig Lite)
SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", ATTRS{idProduct}=="7523|5523|55d4", MODE="0660", GROUP="dialout", TAG+="uaccess", ENV{DIGI_DX_CAT_CANDIDATE}="1"

# Microchip / Generic CDC-ACM (QRP Labs QMX/QDX, Flex/SDR bridges)
SUBSYSTEM=="tty", ATTRS{idVendor}=="04d8|0483|2e8a", MODE="0660", GROUP="dialout", TAG+="uaccess", ENV{DIGI_DX_CAT_CANDIDATE}="1"

# --- Common Ham USB Audio Codecs (SignaLink USB, DigiRig, Transceiver Built-in Audio) ---
# Texas Instruments PCM2900/2901/2902/2904/2906 (SignaLink USB, Icom IC-7300/7100, Kenwood)
SUBSYSTEM=="sound", ATTRS{idVendor}=="08bb", MODE="0660", GROUP="audio", TAG+="uaccess", ENV{DIGI_DX_AUDIO_CANDIDATE}="1"

# C-Media CM108/CM119/CM6206 (DigiRig Mobile, AllStar/RIM audio interfaces)
SUBSYSTEM=="sound", ATTRS{idVendor}=="0d8c", MODE="0660", GROUP="audio", TAG+="uaccess", ENV{DIGI_DX_AUDIO_CANDIDATE}="1"
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="0d8c", MODE="0660", GROUP="plugdev", TAG+="uaccess"
```

Reload after installing:
```bash
sudo udevadm control --reload-rules && sudo udevadm trigger
```

---

## 5. Native OS Service Definitions & Manual Fallback

### 5.1 Linux `systemd` Unit (`/etc/systemd/system/digi-dx.service`)

```ini
[Unit]
Description=Digi-Dx v2 Local FT8 & Transceiver Daemon
Documentation=https://github.com/<owner>/digi-dx
After=network-online.target sound.target time-sync.target
Wants=network-online.target time-sync.target

[Service]
Type=simple
User=digi-dx
Group=digi-dx
SupplementaryGroups=dialout plugdev audio
EnvironmentFile=-/etc/digi-dx/digi-dx.env
Environment=DIGI_DX_BIND=0.0.0.0
Environment=DIGI_DX_PORT=8788
Environment=DIGI_DX_DATA_DIR=/var/lib/digi-dx
Environment=RUST_LOG=info,digi_dx=info
ExecStartPre=/usr/local/bin/digi-dx preflight --fail-on-fatal
ExecStart=/usr/local/bin/digi-dx serve
Restart=on-failure
RestartSec=3
TimeoutStopSec=10
KillMode=mixed

# Hardening while preserving /dev serial + audio access and local state writes
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=false
ReadWritePaths=/var/lib/digi-dx /tmp
DevicePolicy=auto

[Install]
WantedBy=multi-user.target
```

> **Note on `PrivateTmp=false` vs. `true`:** Leaving `PrivateTmp=true` is safe if `jt9` runs as a child of `digi-dx` (it shares the mount namespace); `PrivateTmp=false` is shown only if an external operator needs to inspect temp WAV files during troubleshooting and may be tightened to `true` in production.

### 5.2 macOS `launchd` Agent (`~/Library/LaunchAgents/com.digidx.daemon.plist`)

> **Why a LaunchAgent (User Session) is Primary on macOS:** macOS TCC (Transparency, Consent, and Control) grants **Microphone / CoreAudio capture** permissions per interactive GUI user session. Running as a root `LaunchDaemon` causes CoreAudio capture to return silent buffers on modern macOS.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.digidx.daemon</string>

    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/digi-dx</string>
        <string>serve</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
        <key>DIGI_DX_BIND</key>
        <string>0.0.0.0</string>
        <key>DIGI_DX_PORT</key>
        <string>8788</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>RUST_LOG</key>
        <string>info</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>5</integer>

    <key>StandardOutPath</key>
    <string>/Users/REPLACE_USER/Library/Logs/digi-dx/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/REPLACE_USER/Library/Logs/digi-dx/stderr.log</string>
</dict>
</plist>
```

**macOS CoreAudio Microphone Permission Note:** On first run, run `/usr/local/bin/digi-dx preflight --probe-audio` once from Terminal (or approve the macOS Microphone permission prompt under *System Settings → Privacy & Security → Microphone*) so CoreAudio delivers non-zero RX audio samples from the USB transceiver interface.

### 5.3 Manual Fallback Installation Steps

#### Linux (Debian / Ubuntu / Raspberry Pi OS)
```bash
# 1. Install runtime dependencies
sudo apt-get update
sudo apt-get install -y libhamlib-utils usbutils alsa-utils wsjtx

# 2. Create service user and groups
sudo useradd --system --home-dir /var/lib/digi-dx --shell /usr/sbin/nologin digi-dx || true
sudo usermod -aG dialout,plugdev,audio digi-dx
# Also add your interactive login user if running CLI/preflight manually:
sudo usermod -aG dialout,plugdev,audio "$USER"

# 3. Install binary, udev rules, data directory, and systemd unit
sudo install -m 0755 ./digi-dx /usr/local/bin/digi-dx
sudo install -m 0644 ./deploy/udev/99-digi-dx.rules /etc/udev/rules.d/99-digi-dx.rules
sudo udevadm control --reload-rules && sudo udevadm trigger
sudo install -d -o digi-dx -g digi-dx -m 0750 /var/lib/digi-dx
sudo install -m 0644 ./deploy/systemd/digi-dx.service /etc/systemd/system/digi-dx.service

# 4. Run preflight and start service
sudo -u digi-dx /usr/local/bin/digi-dx preflight
sudo systemctl daemon-reload
sudo systemctl enable --now digi-dx.service
journalctl -u digi-dx.service -f
```
*(For Fedora replace step 1 with `sudo dnf install -y hamlib usbutils alsa-utils wsjtx`; for Arch use `sudo pacman -S --needed hamlib usbutils alsa-utils` plus `wsjtx` from AUR/extra.)*

#### macOS (Homebrew)
```bash
# 1. Install Hamlib and optional WSJT-X (provides jt9)
brew install hamlib
brew install --cask wsjtx

# 2. Install binary and state/log directories
sudo install -m 0755 ./digi-dx /usr/local/bin/digi-dx
mkdir -p "$HOME/Library/Application Support/digi-dx" "$HOME/Library/Logs/digi-dx"

# 3. Verify preflight (triggers CoreAudio microphone check if needed)
digi-dx preflight

# 4. Install and load LaunchAgent (replace REPLACE_USER in plist)
sed "s/REPLACE_USER/$USER/g" ./deploy/launchd/com.digidx.daemon.plist \
  > "$HOME/Library/LaunchAgents/com.digidx.daemon.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.digidx.daemon.plist"
launchctl print "gui/$(id -u)/com.digidx.daemon"
```

---

## 6. Daemon Startup Preflight Checks (`digi-dx preflight`)

Preflight runs both as a standalone CLI subcommand (`digi-dx preflight [--json] [--fail-on-fatal]`) and automatically during `digi-dx serve` startup. Results are cached in memory, exposed via `GET /api/v1/preflight`, and emitted as a `station.preflight` telemetry event.

| Check ID | Platform | Severity on Failure | What It Verifies | Actionable Remediation |
| :--- | :--- | :--- | :--- | :--- |
| `hamlib_rigctl` | Linux, macOS | **FATAL** | `rigctl` exists on `PATH` (or `DIGI_DX_RIGCTL_PATH`) and executes `--version`. | Install `libhamlib-utils` (`apt`) / `hamlib` (`dnf`/`pacman`/`brew`). |
| `hamlib_rigctld` | Linux, macOS | **FATAL** | `rigctld` exists on `PATH` (or `DIGI_DX_RIGCTLD_PATH`) and executes `--version`. | Install `libhamlib-utils` / `hamlib`. |
| `hamlib_version` | Linux, macOS | **WARN** | Parses Hamlib version; warns if `< 4.5` (older versions have known TS/IC/FT CAT bugs and limited `+` extended responses). | Upgrade Hamlib package or install backports. |
| `usb_utils` | Linux (macOS: `INFO`) | **WARN** | Linux: `lsusb` present on `PATH`. macOS: `ioreg` present. | Install `usbutils` (`sudo apt install usbutils`). |
| `udev_rules` | Linux only | **WARN** | `/etc/udev/rules.d/99-digi-dx.rules` exists and is readable. | Install `99-digi-dx.rules` and run `udevadm control --reload-rules && udevadm trigger`. |
| `os_groups` | Linux only | **WARN** (non-root) / **INFO** (root) | Compares effective process groups (`getgroups()`) **and** `/etc/group` entries for `dialout`, `plugdev`, and `audio`. Specifically detects the v1 **stale-group trap** where `/etc/group` lists `audio`/`dialout` but the active shell or `tmux` server does not! | Run `sudo usermod -aG dialout,plugdev,audio $USER`, re-login (and run `tmux kill-server` if using `tmux`), or run under `systemd`. |
| `audio_backend` | Linux, macOS | **WARN** | Enumerates `cpal` capture and playback devices; warns if zero duplex-capable devices are visible. | Verify soundcard connection, `audio` group (Linux), or macOS Microphone TCC permission. |
| `ft8_decoder_jt9` | Linux, macOS | **WARN** *(degrades cleanly to `ft8_lib`)* | Locates `jt9` (`DIGI_DX_JT9_PATH` → `PATH` → `/Applications/wsjtx.app/Contents/MacOS/jt9`) and verifies native execution (`jt9 -h`, guarding against wrong-arch `Exec format error`). | Install `wsjtx` / `wsjtx-utils` for full weak-signal sensitivity, or acknowledge built-in `ft8_lib` fallback. |
| `sqlite_storage` | Linux, macOS | **FATAL** | Data directory exists and is writable; SQLite opens in `WAL` mode and passes `PRAGMA quick_check`. | Fix permissions on `/var/lib/digi-dx` or set `DIGI_DX_DATA_DIR`. |
| `system_clock_sync` | Linux, macOS | **WARN** | Checks NTP sync status (`timedatectl` / `chronyc` on Linux; `sntp` on macOS) and flags drift `> 1000 ms` (FT8 decoding degrades severely above `±2.0 s`). | Enable `systemd-timesyncd` or `chrony`. |

### Preflight JSON Schema (`digi-dx preflight --json` & `GET /api/v1/preflight`)
```json
{
  "overall_status": "ok_with_warnings",
  "checked_at_utc": "2026-11-21T22:10:00Z",
  "platform": { "os": "linux", "arch": "aarch64" },
  "active_ft8_decoder": "jt9",
  "checks": [
    {
      "id": "hamlib_rigctld",
      "status": "pass",
      "severity": "fatal",
      "detail": "Hamlib 4.5.5 at /usr/bin/rigctld",
      "remediation": null
    },
    {
      "id": "os_groups",
      "status": "warn",
      "severity": "warn",
      "detail": "User is in /etc/group 'audio', but current process lacks effective GID (stale login or tmux server)",
      "remediation": "Log out and back in (or run 'tmux kill-server' before starting a fresh session)."
    }
  ]
}
```

---

## 7. Optional Containerization (Secondary — Linux Only)

Containerization is explicitly secondary to native `systemd`/`launchd` services, provided for homelab users who prefer Docker on Linux:
- **Multi-stage `Dockerfile`:** Builder compiles Vite/Preact SPA + Rust release binary (`linux/amd64` and `linux/arm64` via `buildx`); slim Debian runtime installs `libhamlib-utils`, `usbutils`, `libasound2`, and optionally `jt9`.
- **Mandatory Host Passthroughs:**
  - `network_mode: host` (LAN mDNS/port `8788` and local `rigctld` simplicity).
  - `--device /dev/snd:/dev/snd` + `group_add: [audio, dialout]`.
  - **Hot-plug caveat:** Static `--device /dev/serial/by-id/...` works for always-connected rigs, but true post-start USB hot-plug inside Docker requires mounting `/dev` + `/run/udev:ro` with appropriate cgroup device rules (`device_cgroup_rules: ['c 188:* rmw', 'c 166:* rmw']`). Native `systemd` avoids this friction completely.
  - Volume mount `/var/lib/digi-dx` so SQLite QSO logs and `telemetry_outbox` persist across container upgrades.
- **macOS Docker Desktop is unsupported** for live radio operation because Docker Desktop's Linux VM cannot directly access host USB-serial CAT cables or macOS CoreAudio soundcards.
