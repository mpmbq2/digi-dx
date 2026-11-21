# Legacy Domain Notes (Pre-v2 Rebuild)

Reusable radio, CAT/Hamlib, audio/DSP, Linux device, and FT8 domain knowledge extracted from the v1 Digi-Dx codebase, scripts, deployment configs, tests, and hardware validation history before the v2 ground-up rebuild.

---

## 1. Hamlib / `rigctld` Flags & CAT Protocol

### CAT Modes Supported in Legacy Stack
- **External `rigctld` (`mode: "rigctld"`):** Assumed a host-managed `rigctld` daemon listening on TCP `127.0.0.1:<port>` (default `4532`). Pre-flight verified TCP connectivity with a `1000 ms` timeout before starting the modem.
- **Dummy `rigctld` (`mode: "dummy"`):** Spawned internally when no physical CAT link was active:
  ```bash
  rigctld -m 1 -t <port>
  ```
  - `-m 1`: Hamlib dummy rig model.
  - `-t <port>`: TCP listen port (default `4532`).
  - Pre-checked that `127.0.0.1:<port>` was unoccupied (`250 ms` probe), then polled until TCP connect succeeded (up to `5000 ms`, `100 ms` interval).
  - Spawned detached (`detached: true` on POSIX) so teardown could signal the process group (`-pid`).

### Why Dummy `rigctld` Was Required Instead of `ft8cat -F`
- `ft8cat -F` (fixed frequency / CAT disabled) has an **undocumented side effect**: it silently disables decode logging (`-a` / `-A` UDP output).
- Root cause: `ft8cat`'s decode logging code path is gated behind `if fa_last:`, and `fa_last` is only populated inside the CAT VFO-A polling loop, which never executes under `-F`.
- **Workaround:** Always run `rigctld -m 1 -t <port>` instead of `ft8cat -F` when testing without a real rig.

### Direct `rigctld` TCP Commands Used for Diagnostics
- `f\n` — query VFO frequency in Hz (parse integer on first response line; `2000 ms` timeout).
- `T 1\n` / `T 0\n` — key/unkey PTT (`1500 ms` timeout; used for safe `200 ms` PTT pulse test).
- **Contention caveat:** Do not open a separate diagnostic TCP connection to `rigctld` to query frequency while `ft8cat` already has an active CAT session open; reuse the session's reported frequency to avoid port/serial contention.

### Scope Gap from v1
- Legacy Digi-Dx **did not** encode per-transceiver `rigctld` launch flags (Hamlib rig model IDs, `-r` serial port, `-s` baud rate, stop bits, CI-V address, PTT-type overrides `-P`/`-p`, or `-C` conf params); real `rigctld` was launched externally on the host.

---

## 2. Validated Shack Hardware & Transceiver Quirks

- **Reference shack rig:** Linux host (`c3p0`) connected to a **Kenwood TS-570S** via **SignaLink USB** (`USB Audio CODEC (USB Audio)`, observed RtAudio/ALSA ID `141`, `48000 Hz`) and USB-serial CAT.
- **Supported CPU architectures:** Linux `x86_64` and `aarch64` (`arm64`, e.g., Raspberry Pi 4/5 64-bit OS). 32-bit ARM (`armv7`) was explicitly unsupported.
  - Note: Node's `process.arch` reports `"x64"` / `"arm64"`, whereas `uname -m` and vendor toolchains expect `"x86_64"` / `"aarch64"`.
- **Scope gap from v1:** No multi-transceiver quirk matrix (Icom, Yaesu, Elecraft, split/fake-it, data-mode commands like `PKTUSB`/`USB-D`) existed in the legacy codebase beyond the Kenwood TS-570S + SignaLink USB reference setup.

---

## 3. Serial / USB Device Matching & Linux / Container Permissions

### Serial Device Paths
- Prefer persistent **`/dev/serial/by-id/...`** paths over `/dev/ttyUSB0` / `/dev/ttyUSB2` (the legacy Docker Compose file had a commented placeholder `# - /dev/ttyUSB2:/dev/ttyUSB2`, while design docs noted `/dev/serial/by-id/...` is required for stability across USB replugs and container restarts).
- **Scope gap from v1:** No udev rules or USB `idVendor`/`idProduct` auto-matching logic was implemented in code.

### Linux Audio & Serial Permissions
- Both bare-metal users and Docker containers need:
  - Audio device node access: `/dev/snd:/dev/snd` + **`audio`** group membership.
  - Serial CAT device access: **`dialout`** group membership.
  - Container networking for host `rigctld` / local ports used `network_mode: host`.
- **Stale group-membership trap (`aplay -l` + `tmux`):**
  - `aplay -l` can report `"no soundcards found"` even when `lsusb`, `dmesg`, and `/proc/asound/cards` show the SignaLink/USB audio device.
  - Cause: missing `audio` group membership, or a stale session that has not picked up the new group (`newgrp audio` / fresh SSH login required).
  - **`tmux` gotcha:** A running `tmux` server retains the group memberships from when the server started. Creating a new `tmux` session inside an existing server does **not** refresh groups — you must run `tmux kill-server`, re-login over SSH, and start a fresh server.

### Audio Device Matching Behavior
- Legacy config stored `{ id: number, name?: string }`.
- Session startup verified `discovered.id === saved.id` and logged a non-fatal warning when `discovered.name !== saved.name` (because numeric ALSA/RtAudio IDs can shift across reboots or USB replugs, name-based rebinding was not yet implemented).

---

## 4. Audio / DSP Engine Stack (`ft8cat`, `ft8modem`, `rtaudio`, `wsjtx-utils`)

### Pinned Upstream Versions & Build Requirements (Debian/Ubuntu)
- **`rtaudio`:** Git tag `6.0.1` (`https://github.com/thestk/rtaudio.git`). Must be built >= `6.0.1` from source (often newer than distro apt packages) with **ALSA enabled and PulseAudio/JACK disabled**:
  ```bash
  cmake -S rtaudio-src -B rtaudio-build \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX=/usr/local \
    -DCMAKE_INSTALL_LIBDIR=lib \
    -DRTAUDIO_API_ALSA=ON \
    -DRTAUDIO_API_PULSE=OFF \
    -DRTAUDIO_API_JACK=OFF
  ```
  Followed by `cmake --install` and `ldconfig`.
- **`ft8modem` / `ft8cat` (KK5JY):** Version `1.0.11991` (`ft8modem-20260820-1.0.11991.tar.gz` from `https://www.kk5jy.net/ft8modem/Software`).
  - `ft8modem` installs to `/usr/local/bin/ft8modem` (plus `af2udp`); `ft8cat` is a Python 3 script at `/usr/local/lib/ft8modem/ft8cat` invoked via `exec python3 -B /usr/local/lib/ft8modem/ft8cat "$@"` (containers also set `PYTHONPATH=/usr/local/lib/ft8modem`).
- **`wsjtx-utils`:** Version `2.6.1-20260812` (`wsjtx-utils-2.6.1-{x86_64,aarch64}-20260812.tar.xz`), providing `jt9`, `ft8code`, and `ft4code`.
  - **Multi-arch trap:** Tarballs can contain multiple arch subfolders (`armv6`, `armv7`, `aarch64`, `x86`, `i686`). Picking the wrong binary causes a cryptic `sh: 1: jt9: Exec format error`. Always confirm with `uname -m` and `file <binary>`.
- **Required Debian/Ubuntu packages:**
  - Build: `build-essential cmake pkg-config git curl ca-certificates xz-utils file python3 libasound2-dev libsndfile1-dev`
  - Runtime: `python3 libhamlib-utils libasound2 libsndfile1 libfftw3-single3 libgfortran5 libgomp1` plus Qt5 core (`libqt5core5a` on Bookworm, or `libqt5core5t64` on 64-bit `time_t` Ubuntu/Debian releases).
  - **Missing-header trap:** Building `ft8modem` fails with `fatal error: sndfile.h: No such file or directory` unless `libsndfile1-dev` is installed.

### Audio Device Discovery (`ft8modem -h`)
- **Non-zero exit quirk:** `ft8modem -h` exits with **status code `1`** even when listing devices cleanly; always parse `stdout` + `stderr` on exit code `1`.
- **Observed hardware output:**
  ```text
  Usage: ft8modem [options] <mode> [<device>]
      <mode> is one of { FT4, FT8, JT9, JT65, WSPR }
      <device> is the sound card ID, and may be one of these devices:

         + ID = 129: "Default ALSA Device", best rate = 48000
         + ID = 130: "PulseAudio Sound Server", best rate = 48000
         + ID = 131: "HDA Intel PCH (ALC892 Analog)", best rate = 48000
         + ID = 133: "HDA Intel PCH (ALC892 Alt Analog)", best rate = 48000
         + ID = 141: "USB Audio CODEC (USB Audio)", best rate = 48000
  ```
- Parser regex for real output: `/^\+\s*ID\s*=\s*(\d+)\s*:\s*"(.+?)"\s*,\s*best rate\s*=\s*(\d+)/i`
- `ft8modem -h` does **not** report input/output channel counts (unlike raw PortAudio dumps).
- Devices missing from `ft8modem -h` usually either report zero inputs to ALSA or are already locked by another process.

### `ft8cat` Invocation, Flags & Wire Interface
- **Launch command:**
  ```bash
  ft8cat -A 127.0.0.1:<ephemeralUdpPort> -u -p <catPort> <ft8modemPath> <mode> <deviceId>
  ```
  - `-A 127.0.0.1:<port>`: internal UDP output stream (bind `127.0.0.1:0` first to obtain an OS-assigned port). This is **not** WSJT-X binary UDP.
  - `-u`: format timestamps as 10-digit integer Unix seconds instead of `yymmdd_hhmmss`.
  - `-p <catPort>`: TCP port of `rigctld`.
- **Flag traps:**
  - `-m` is **not** a callsign flag — it sets max audio frequency for split mode (`-s`). `ft8cat` has no callsign flag; callsigns exist only inside transmitted FT8 message text.
  - `-F` disables decode logging (see §1).
  - `ft8con` is read-only and cannot transmit into `ft8modem`.
- **Stdin commands (owned by daemon):**
  - Transmit: `<af><E|O> <MESSAGE>\n` (e.g., `1400E CQ N1MPM FN33`, `1600O K1ABC N1MPM R-15`). `E` = even slot, `O` = odd slot. `ft8modem` handles slot boundary alignment.
  - Cancel: `STOP\n`.
- **Stdout status lines:**
  - `TX: 1` / `TX: 0` (`/^TX:\s*([01])\b/`) — engine PTT active/inactive transitions.
  - `FA: <hz>` (`/^FA:\s*(\d+)/`) — VFO-A dial frequency in Hz.
- **UDP decode/TX lines (`-A -u`):** Whitespace-padded ALL.TXT-style layout:
  ```text
  <unix_ts_10digits> <freq_mhz> <Rx|Tx> <FT8|FT4> <snr> <dt> <af> <message...>
  ```
  Live-captured examples (with `-u` Unix timestamp):
  ```text
  1783048560 144.174 Rx FT8     10 -0.6 2024 WM8Q DL0EO -17
  1783005075 144.174 Tx FT8      0  0.0 1000 CQ N1MPM FN42
  1783048560 144.174 Rx FT8    -22  0.3 1993 CQ PY7XC HI21                       ? a1
  ```
  - Rx lines may carry trailing decoder-pass metadata after `?` (e.g., `? a1`); strip tokens starting at `?` before parsing FT8 message grammar.

### Process Tree, TX State & Fail-Safe Lessons
- **Process-group teardown:** Because `ft8cat` spawns `ft8modem`, launch `ft8cat` detached (`detached: true` on POSIX) and send `SIGTERM` to `-pid` (escalating to `SIGKILL` after `5000 ms`) so `ft8modem` is never orphaned.
- **Active opposite-slot TX switch:** Updating an active transmission on the *same* slot can be written straight to stdin, but switching to the *opposite* slot while `TX: 1` must first send `STOP`, wait for `TX: 0` (with a `1000 ms` timeout fallback), and only then write the replacement `<af><E|O> <msg>`.
- **Post-TX state trap:** When `TX: 0` fires at slot end without a cancel, state transitions from `active` back to `pending` (not `idle`). Any scheduler re-arming must trigger on the falling edge of `active`, not only on `idle`.
- **PTT fail-safe:**
  - Automatically cancel TX / drop PTT if the controlling client socket disconnects while `ptt === true`.
  - Edge PTT watchdog (`500 ms` sliding timeout) calls `cancelTransmit()` on disconnect/silence. *(Legacy bug to avoid in v2: `EdgeRuntime` sent heartbeats every `4000 ms` while the watchdog timeout was `500 ms` — ensure heartbeat cadence is strictly shorter than the watchdog timeout.)*
- **Activity-gated auto-updates:** Container updater deferred restarts whenever PTT was active, the engine was starting/stopping, uptime was `< 60 s`, or operator/TX activity occurred within the last `1800 s` (30 min). Passive RX decodes did not reset the idle timer.

---

## 5. Frequency, Band, Mode & FT8 Protocol Mappings

### Modes & Audio Frequency (AF) Bounds
- **Modes:** Legacy config/TX accepted `"FT8"` only; UDP parser accepted `"FT8" | "FT4"`; `ft8modem` CLI supports `{ FT4, FT8, JT9, JT65, WSPR }`.
- **Valid TX AF range:** `200`–`3000 Hz` (integer).
- **Clear-frequency survey search range:** `300`–`2700 Hz` (selects midpoint of widest unoccupied gap).
- **Occupied-AF collision check:** Warns if another decode on the same TX-slot parity appeared within `±50 Hz` across the last `2` matching slots.

### Amateur Band Table (ADIF `BAND` Derivation)
Lower-inclusive (`mhz >= lo`), upper-exclusive (`mhz < hi`):

| Band | Frequency Range (MHz) | FT8 Dial Freqs Referenced in Legacy Code/Tests |
| :--- | :--- | :--- |
| `160m` | `1.8` – `2.0` | — |
| `80m` | `3.5` – `4.0` | `3.573` |
| `60m` | `5.06` – `5.45` | — |
| `40m` | `7.0` – `7.3` | `7.074` |
| `30m` | `10.1` – `10.15` | — |
| `20m` | `14.0` – `14.35` | `14.074` |
| `17m` | `18.068` – `18.168` | — |
| `15m` | `21.0` – `21.45` | — |
| `12m` | `24.89` – `24.99` | — |
| `10m` | `28.0` – `29.7` | `28.074` |
| `6m` | `50` – `54` | — |
| `2m` | `144` – `148` | `144.174` (observed in live capture) |
| `1.25m` | `222` – `225` | — |
| `70cm` | `420` – `450` | — |

### FT8 Slot Timing & Clock Invariants
- **Slot duration:** `15,000 ms` (`15 s`); active FT8 transmission duty is `12.64 s` (`12.64 / 15`).
- **Slot parity:** `Math.floor(unixSeconds / 15) % 2 === 0 ? "even" : "odd"`. Always reply on the **opposite** parity of the received decode.
- **Automation pre-arm lead:** Arm transmit `2` virtual seconds before the slot boundary (with a `50 ms` minimum wall-delay floor).
- **TX-slot survey:** Because the radio is deaf during its own TX parity, surveying a clear TX frequency holds TX for one full slot past the next TX-slot boundary plus `5 s` decode latency (`slotSeconds + 5 s`).
- **Seconds vs. milliseconds trap:** Wire decode/TX timestamps are integer Unix **seconds**, while JS clocks are **milliseconds**. Feeding ms into `slotFromTimestamp` flips parity every `15,000` seconds; passing ms into seconds-valued wire fields silently multiplies timestamps by `1000`.

### FT8 Message Grammar & QSO Sequencing Quirks
- **`RR73` vs. Maidenhead grid collision:** `"RR73"` matches the 4-char Maidenhead regex `/^[A-R]{2}[0-9]{2}$/`. Always test terminal literals (`RRR`, `RR73`, `73`) **before** `isGrid()`.
- **Validation patterns:**
  - Config callsign: `/^[A-Z0-9/]{3,16}$/` (uppercased).
  - Message callsign token: `/^[A-Z0-9/]{3,15}$/` containing at least one `[A-Z]`, one `\d`, and `!isGrid(token)`.
  - Maidenhead grid: `/^[A-R]{2}[0-9]{2}([A-X]{2})?$/` (4- or 6-char, uppercased).
  - Signal reports: two-digit zero-padded with explicit sign (`[+-]NN`, clamped `-50` to `+49`); roger-report `R[+-]NN`. Always send *their* latest decoded SNR, never echo the report they gave you.
  - Transmit message sanity bounds: trimmed, uppercased, non-empty, max `128` chars, no CR/LF or Unicode control characters (`/[\r\n\p{Cc}]/u`).
- **Standard QSO exchange & retry rules:**
  - Flow: `CQ MYCALL MYGRID` → `THEIR MY MYGRID` → `THEIR MY ±NN` → `THEIR MY R±NN` → `THEIR MY RR73` (or `RRR`) → `THEIR MY 73`.
  - Count transmit attempts only on confirmed engine `tx` events (time out a standard QSO after `5` confirmed attempts on the same step; `CQ` repeats indefinitely until answered or stopped).
  - Complete on confirmed outgoing `73` or incoming `73` (ignore bare unsolicited `73` from unknown stations).

### ADIF Export (v3.1.4) & Log Safety
- **ADIF encoding:** `<NAME:BYTE_LEN>VALUE ` where `BYTE_LEN` is UTF-8 **byte** length (`Buffer.byteLength`), not character count.
- **Fields exported:** `ADIF_VER` (`3.1.4`), `PROGRAMID` (`digi-dx`), `CREATED_TIMESTAMP` (`YYYYMMDD HHMMSS`), `<EOH>`, and per-QSO `CALL`, `GRIDSQUARE`, `MODE` (`FT8`), `QSO_DATE`, `TIME_ON`, `QSO_DATE_OFF`, `TIME_OFF`, `RST_SENT`, `RST_RCVD`, `FREQ` (`MHz` to 6 decimal places), `BAND`, `STATION_CALLSIGN`, `OPERATOR`, `MY_GRIDSQUARE`, `<EOR>`.
- **Demo / Simulator safety invariants:**
  - Use ITU non-assignable `QQ*` callsigns (e.g., `QQ0DEMO`) for simulated stations so fabricated QSOs never collide with real licensees.
  - Reject `QQ*` callsigns and simulated device IDs from station config persistence so demo config can never satisfy config gates and key a real radio.
  - Isolate demo QSOs in a separate log file never read by the ADIF exporter (avoiding accidental LoTW/QRZ uploads).
  - Clear all in-flight automation, timers, and driver state on session stop, crash, or demo→live transitions.
- **Atomic local persistence:** Write config/state to `<path>.tmp` (`0o600`), `fsync` file, atomic `rename`, and best-effort directory `fsync`.
