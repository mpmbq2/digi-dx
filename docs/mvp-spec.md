# Digi-Dx v2 MVP Specification & Milestone Roadmap

**Status:** Design Specification (v2.0 Ground-Up Rebuild)
**Reference Context:** Incorporates validated FT8/ADIF/band/safety rules from [`docs/legacy-domain-notes.md`](legacy-domain-notes.md).
**Companion Specs:** [`docs/architecture.md`](architecture.md) · [`docs/deployment-and-deps.md`](deployment-and-deps.md)

---

## 1. Strict MVP Scope Boundary

### 1.1 In-Scope for v2.0 MVP
| Domain | Concrete MVP Deliverable |
| :--- | :--- |
| **Core Runtime** | Single-process Rust daemon (`digi-dx`) binding `0.0.0.0:8788`, serving embedded Vite + TypeScript + Preact SPA, backed by bundled SQLite (`WAL` mode). |
| **Native Packaging & Preflight** | `scripts/install.sh` (Linux `apt`/`dnf`/`pacman` + macOS `Homebrew`), manual fallback guide, `99-digi-dx.rules`, `systemd` unit, macOS `launchd` plist, and `digi-dx preflight` startup checks. |
| **Hot-Plug Multi-Radio CAT** | Post-boot USB/serial hot-plug discovery (`udev`/`nusb` + `5 s` reconciler), persistent `/dev/serial/by-id/` + `(vid, pid, serial, iface)` indexing, per-radio `rigctld` subprocess supervision (including dummy `rigctld -m 1`), and Hamlib `+` extended response client. |
| **Audio & Hybrid FT8 DSP** | Cross-platform `cpal` audio I/O with persistent USB/UID device matching, `48 kHz ↔ 12 kHz` resampling, real-time `200–3000 Hz` FFT occupancy/waterfall, `Ft8Decoder` trait (`jt9` primary + embedded MIT `ft8_lib` fallback), in-process GFSK TX synthesis, and `SimulatedModem` (`QQ*` demo/CI). |
| **Hardware PTT Safety** | Autonomous `PttWatchdog` (`500 ms` heartbeat / `2000 ms` lease timeout / `13.5 s` hard TX ceiling), instant PTT drop on disconnect/USB detach, and emergency halt override. |
| **FT8 Operating & QSO Automation** | Single-active-radio operating view with multi-radio selector, UTC `SlotClock`, AF picker (`200–3000 Hz`), TX-slot survey (`300–2700 Hz`), occupied-AF warning (`±50 Hz`), standard FT8 QSO auto-sequencer (`CQ → Grid → Report → R-Report → RR73 → 73`, 5-attempt timeout), QSO logbook, and ADIF 3.1.4 export (strictly excluding demo QSOs). |
| **Unified Command Bus & LAN Control** | Open LAN read-only telemetry + per-radio single-operator control lease + optional static bearer token (`DIGI_DX_AUTH_TOKEN`), routed through `Validate -> Authorize -> Execute -> Ack` with idempotency and audit log. |
| **Future GCP Seams (Stubbed)** | Structured telemetry event envelope + transactional SQLite `telemetry_outbox` + `TelemetrySink` trait (`NoopTelemetrySink` & `GcpPubSubSinkStub`), plus `CommandTransport` trait & `GcpBridgeClientStub` verified by unit/contract tests. |
| **Hardware Reference Validation** | End-to-end live shack sign-off on **Kenwood TS-570S + SignaLink USB** (`Linux`) plus simulated/audio verification on **macOS**. |

### 1.2 Explicitly Deferred to v1.1+ (Not in MVP)
- **Live GCP Cloud Services:** Live Pub/Sub → BigQuery uploader, cloud web portal, 6-digit cloud pairing service, and live outbound GCP remote-control bridge execution.
- **Multi-User Auth / RBAC:** OAuth/OIDC, per-user accounts, or concurrent multi-operator scheduling.
- **Additional Digital Modes:** FT4, JS8Call, WSPR, JT9, JT65, CW, RTTY, VarAC/VARA.
- **Non-Standard / Contest FT8:** Fox/Hound DXpedition mode, compound/hashed non-standard callsigns (`<...>`), EU VHF / ARRL Field Day contest exchanges, split/fake-it CAT TX frequency shifting.
- **Simultaneous Multi-Radio TX:** MVP discovers/supervises multiple radios and lets the operator switch between them, but operates one active FT8 TX session at a time (multi-radio SO2R concurrent TX is v1.1+).
- **Station Peripherals:** Antenna rotators (`rotctld`), linear amplifier telemetry, external ATU control.
- **Remote Live Audio Streaming:** WebRTC RX/TX voice or audio monitoring in browser.
- **Agentic UI Builder / Sandboxed Custom Periphery:** Deferred until the core daemon and stock operating UI are battle-tested.
- **Windows Native Service & 32-bit ARM (`armv7`).**

---

## 2. HTTP REST & WebSocket API Contract

### 2.1 Transport & Auth Rules
- **Base URL:** `http://<host>:8788` (default bind `0.0.0.0:8788`).
- **Read-Only Endpoints (`GET`):** Open on the local network (no auth required in MVP) so phones, tablets, or status monitors can watch decodes and rig health frictionlessly.
- **Mutating Commands (`POST /api/v1/commands` & WS `command` frames):**
  - If `DIGI_DX_AUTH_TOKEN` is set, callers must send `Authorization: Bearer <token>` (REST) or `{ "token": "<token>" }` on WS `auth` / `control.claim_lease` (constant-time compare).
  - If `DIGI_DX_AUTH_TOKEN` is unset, mutating LAN commands are permitted with a startup `WARN` log, while per-radio single-operator control leases are **always** enforced.

### 2.2 HTTP REST Endpoints

| Method & Path | Auth | Purpose |
| :--- | :--- | :--- |
| `GET /api/v1/health` | Open | Liveness check (`{ status, version, uptime_sec, active_radios, active_ptt }`). |
| `GET /api/v1/preflight` | Open | Latest startup/on-demand preflight report (schema in [`docs/deployment-and-deps.md`](deployment-and-deps.md#preflight-json-schema-digi-dx-preflight---json--get-apiv1preflight)). |
| `GET /api/v1/station` | Open | Configured station callsign, Maidenhead grid, `station_id`, and `auth_required` boolean. |
| `GET /api/v1/devices/usb` | Open | Currently discovered USB/serial hardware inventory (`usb_devices` joined with live attachment status). |
| `GET /api/v1/devices/audio` | Open | Live `cpal` audio devices with persistent UID/USB topology metadata and sample-rate support. |
| `GET /api/v1/radios` | Open | All configured `radio_profiles` + current lifecycle state, VFO frequency, mode, PTT, decoder backend, and active lease holder. |
| `GET /api/v1/radios/:radio_id` | Open | Single radio detailed status, active QSOs, recent decodes, and CAT diagnostics. |
| `POST /api/v1/commands` | Token (if set) + Lease | Synchronous entry point to the unified Command Bus (`CommandEnvelope` → `CommandAck`). |
| `GET /api/v1/qsos` | Open | Paginated QSO history (`?limit=100&offset=0&band=20m&demo=false`). `demo=true` reads `demo_qso_log`; default reads real `qso_log`. |
| `GET /api/v1/qsos/export.adi` | Open | Streams **ADIF 3.1.4** (`text/plain; charset=utf-8`) exclusively from `qso_log`. **Never** reads `demo_qso_log`. |
| `GET /api/v1/outbox/stats` | Open | Local telemetry outbox diagnostics (`pending_count`, `sent_count`, `dead_letter_count`, `sink_name`, `oldest_pending_utc`). |
| `GET /api/v1/ws` | Open (upgrades to observer) | Real-time bidirectional WebSocket stream for telemetry push and Command Bus dispatch. |

### 2.3 Unified Command Envelope & Ack Schema

#### Client → Daemon (`POST /api/v1/commands` or WS `{ "type": "command", "envelope": ... }`)
```json
{
  "command_id": "019a2f50-1a2b-7c3d-8e4f-5a6b7c8d9e0f",
  "idempotency_key": "ui-1795212910-cq",
  "origin": "local_ui",
  "actor": "browser-tab-9f3a",
  "radio_id": "rad_ts570s_01",
  "kind": "tx.arm",
  "issued_at_utc": "2026-11-21T22:15:10.000Z",
  "payload": {
    "af_hz": 1420,
    "slot": "even",
    "message": "CQ N1MPM FN33"
  }
}
```

#### Daemon → Client (`CommandAck`)
```json
{
  "type": "command_ack",
  "command_id": "019a2f50-1a2b-7c3d-8e4f-5a6b7c8d9e0f",
  "status": "ok",
  "error_code": null,
  "error_message": null,
  "result": { "tx_state": "armed", "af_hz": 1420, "slot": "even" },
  "completed_at_utc": "2026-11-21T22:15:10.012Z"
}
```

#### Command Catalog (`CommandKind`)
| `kind` | Lease Required? | Key Payload Fields |
| :--- | :--- | :--- |
| `station.update_config` | No (Token only) | `{ callsign, grid }` (rejects `QQ*` non-assignable prefixes) |
| `radio.create_profile` / `radio.update_profile` / `radio.delete_profile` | No (Token only; inactive session) | `{ name, hamlib_model, serial_selector, baud_rate, audio_selector, is_dummy, auto_connect, rig_options }` |
| `radio.test_cat` | No | `{ radio_id }` → returns `{ freq_hz, mode, passband_hz }` via `+f`/`+m` |
| `radio.test_ptt` | **Yes** | `{ radio_id, duration_ms: 200 }` (`<= 500 ms` hard cap) |
| `radio.set_freq` | **Yes** | `{ freq_hz }` (integer Hz, sends `+F <hz>`) |
| `radio.set_mode` | **Yes** | `{ mode, passband_hz }` (e.g., `"USB"`, `2400` or `"PKTUSB"`, `0`) |
| `control.claim_lease` | Acquires lease | `{ radio_id, actor, force?: false }` (returns `lease_id`, `ttl_ms: 2000`) |
| `control.release_lease` | **Yes** | `{ radio_id }` (drops PTT if active before releasing) |
| `control.heartbeat` | **Yes** | `{ radio_id, lease_id }` (sent every `500 ms`, pets `PttWatchdog`) |
| `session.start` | **Yes** | `{ radio_id, demo?: false }` (`demo: true` starts `SimulatedModem` in memory without modifying DB config) |
| `session.stop` | **Yes** | `{ radio_id }` (drops PTT, releases audio, clears automation state) |
| `tx.arm` | **Yes** | `{ af_hz: 200..=3000, slot: "even"|"odd", message }` (trimmed, uppercased, max 128 chars, no control chars) |
| `tx.cancel` | **Yes** | `{ radio_id }` |
| `tx.halt_emergency` | **No** (Token only if set) | `{ radio_id }` (immediate PTT off + audio abort + disables auto-TX) |
| `qso.call_cq` | **Yes** | `{ slot?: "even"|"odd", directed?: null|"DX" }` |
| `qso.reply` | **Yes** | `{ callsign, their_grid?: null, rx_slot: "even"|"odd", snr_db?: null }` |
| `qso.action` | **Yes** | `{ qso_id, action: "resume"|"pause"|"retry"|"complete"|"abandon"|"prev_step"|"next_step"|"move_up"|"move_down" }` |
| `qso.survey_af` | **Yes** | `{ radio_id }` (holds TX `1 slot + 5 s`, selects widest gap in `300..2700 Hz`) |
| `qso.set_af` / `qso.set_tx_enabled` | **Yes** | `{ af_hz }` / `{ enabled: boolean }` |

### 2.4 WebSocket Push Events (`/api/v1/ws`)
| `type` | Payload Summary |
| :--- | :--- |
| `snapshot` | Sent immediately on WS connect: station config, `SlotClockSpec`, all radios + states, preflight summary, active QSOs, recent decodes, and control leases. |
| `radio_state` | Per-radio lifecycle transition (`DISCOVERED`..`ACTIVE_SESSION`..`DISCONNECTED`), `freq_hz`, `band`, `mode`, `ptt`, `decoder_backend`, `is_demo`, `audio_rms_dbfs`. |
| `decode` | `{ radio_id, ts_sec, slot, snr_db, dt_sec, af_hz, mode: "FT8", message, parsed, decoder_backend }`. |
| `tx_state` | `{ radio_id, state: "idle"|"armed"|"transmitting", af_hz, slot, message, ptt_elapsed_ms }`. |
| `waterfall` | Throttled (`4 Hz`) passband FFT magnitude array (`200–3000 Hz`, ~140 bins) + occupied AF markers. |
| `qso_update` | Full updated active QSO queue + newly completed QSO notifications. |
| `control_lease` | `{ radio_id, held, holder_actor, expires_at_utc }`. |
| `preflight_alert` | Real-time health/watchdog/USB warning or abort notification. |
| `command_ack` | Direct reply to a WS `command` frame. |

### 2.5 Error Code Taxonomy
`VALIDATION_FAILED` · `AUTH_FAILED` · `LEASE_REQUIRED` · `LEASE_HELD` · `RADIO_NOT_FOUND` · `RADIO_NOT_READY` · `SESSION_ALREADY_ACTIVE` · `NO_ACTIVE_SESSION` · `CONFIG_REQUIRED` · `DEMO_CONFIG_FORBIDDEN` · `AUDIO_DEVICE_UNAVAILABLE` · `CAT_UNAVAILABLE` · `CAT_COMMAND_FAILED` · `PORT_UNAVAILABLE` · `DECODER_FAILED` · `PTT_WATCHDOG_ABORT` · `INTERNAL_ERROR`.

---

## 3. Domain Reference Tables (Carried Forward from v1)

### 3.1 Amateur Band Derivation (ADIF `BAND`, Lower-Inclusive / Upper-Exclusive)
| Band | Range (MHz) | Standard FT8 Dial Freq (MHz) |
| :--- | :--- | :--- |
| `160m` | `1.800` – `2.000` | `1.840` |
| `80m` | `3.500` – `4.000` | `3.573` |
| `60m` | `5.060` – `5.450` | `5.357` |
| `40m` | `7.000` – `7.300` | `7.074` |
| `30m` | `10.100` – `10.150` | `10.136` |
| `20m` | `14.000` – `14.350` | `14.074` |
| `17m` | `18.068` – `18.168` | `18.100` |
| `15m` | `21.000` – `21.450` | `21.074` |
| `12m` | `24.890` – `24.990` | `24.915` |
| `10m` | `28.000` – `29.700` | `28.074` |
| `6m` | `50.000` – `54.000` | `50.313` |
| `2m` | `144.000` – `148.000` | `144.174` |
| `1.25m` | `222.000` – `225.000` | — |
| `70cm` | `420.000` – `450.000` | `432.174` |

### 3.2 ADIF 3.1.4 Export Contract
- Header: `ADIF_VER` (`3.1.4`), `PROGRAMID` (`digi-dx`), `PROGRAMVERSION` (`2.0.0`), `CREATED_TIMESTAMP` (`YYYYMMDD HHMMSS`), `<EOH>`.
- Per-QSO fields: `CALL`, `GRIDSQUARE`, `MODE` (`FT8`), `QSO_DATE`, `TIME_ON`, `QSO_DATE_OFF`, `TIME_OFF`, `RST_SENT`, `RST_RCVD`, `FREQ` (MHz, 6 decimal places), `BAND`, `STATION_CALLSIGN`, `OPERATOR`, `MY_GRIDSQUARE`, `<EOR>`.
- Length rule: `<FIELD:BYTE_LEN>VALUE ` using UTF-8 **byte length** (`str::len()` in Rust).

---

## 4. SQLite Database Schema (`digi-dx.db`)

Opened with:
```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

```sql
-- 1. Embedded schema migration ledger
CREATE TABLE schema_migrations (
    version         INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    applied_at_utc  TEXT NOT NULL
);

-- 2. Singleton local station identity (id always = 1)
CREATE TABLE station_config (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    station_id      TEXT NOT NULL UNIQUE,      -- Stable UUIDv4 for GCP telemetry identity
    callsign        TEXT,                      -- Uppercase [A-Z0-9/]{3,16}; QQ* rejected in app layer
    grid            TEXT,                      -- 4- or 6-char Maidenhead [A-R]{2}[0-9]{2}([A-X]{2})?
    updated_at_utc  TEXT NOT NULL
);

-- 3. Discovered USB/serial hardware inventory (updated by hot-plug & 5s reconciler)
CREATE TABLE usb_devices (
    device_key          TEXT PRIMARY KEY,      -- Persistent key: by-id path or vid:pid:serial:iface
    os_path             TEXT NOT NULL,         -- Current /dev/serial/by-id/... or /dev/cu....
    real_tty_path       TEXT,                  -- Resolved /dev/ttyUSB0 (informational only)
    usb_vid             TEXT,                  -- 4-hex lowercase (e.g., "0403")
    usb_pid             TEXT,                  -- 4-hex lowercase (e.g., "6001")
    usb_serial          TEXT,
    usb_interface       TEXT,
    usb_topology_path   TEXT,                  -- Physical USB hub/port path fallback
    manufacturer        TEXT,
    product             TEXT,
    is_connected        INTEGER NOT NULL DEFAULT 0 CHECK (is_connected IN (0, 1)),
    first_seen_utc      TEXT NOT NULL,
    last_seen_utc       TEXT NOT NULL
);

-- 4. User-configured transceiver profiles (multi-radio capable)
CREATE TABLE radio_profiles (
    radio_id            TEXT PRIMARY KEY,      -- e.g., "rad_<uuid_short>"
    name                TEXT NOT NULL,         -- e.g., "Kenwood TS-570S (Shack)"
    hamlib_model        INTEGER NOT NULL,      -- Hamlib model ID (1 = dummy, 2004 = Kenwood TS-570S, etc.)
    is_dummy            INTEGER NOT NULL DEFAULT 0 CHECK (is_dummy IN (0, 1)),
    serial_device_key   TEXT REFERENCES usb_devices(device_key) ON DELETE SET NULL,
    serial_baud_rate    INTEGER NOT NULL DEFAULT 9600,
    civ_address         TEXT,                  -- Optional hex CI-V for Icom rigs
    ptt_method          TEXT NOT NULL DEFAULT 'cat' CHECK (ptt_method IN ('cat', 'cat_data', 'rts', 'dtr', 'vox')),
    rig_options_json    TEXT NOT NULL DEFAULT '{}', -- Extra Hamlib -C key/value overrides & quirk flags
    audio_device_uid    TEXT,                  -- CoreAudio UID or Linux ALSA card/USB path
    audio_device_name   TEXT,                  -- Human-readable name (fallback + mismatch warning)
    audio_rx_channel    TEXT NOT NULL DEFAULT 'mono' CHECK (audio_rx_channel IN ('mono', 'left', 'right')),
    audio_tx_gain_db    REAL NOT NULL DEFAULT -6.0,
    rigctld_port        INTEGER NOT NULL UNIQUE CHECK (rigctld_port BETWEEN 4532 AND 4599),
    auto_connect        INTEGER NOT NULL DEFAULT 1 CHECK (auto_connect IN (0, 1)),
    last_dial_freq_hz   INTEGER,
    created_at_utc      TEXT NOT NULL,
    updated_at_utc      TEXT NOT NULL
);

-- 5. Real operator QSO logbook (ONLY source for ADIF exports)
CREATE TABLE qso_log (
    qso_id              TEXT PRIMARY KEY,      -- UUIDv7
    radio_id            TEXT REFERENCES radio_profiles(radio_id) ON DELETE SET NULL,
    started_at_utc      TEXT NOT NULL,
    completed_at_utc    TEXT NOT NULL,
    my_call             TEXT NOT NULL,
    my_grid             TEXT NOT NULL,
    their_call          TEXT NOT NULL,
    their_grid          TEXT,
    mode                TEXT NOT NULL DEFAULT 'FT8',
    dial_freq_hz        INTEGER,
    band                TEXT,
    af_hz               INTEGER,
    rst_sent            TEXT,
    rst_rcvd            TEXT,
    completion_reason   TEXT NOT NULL,
    transcript_json     TEXT NOT NULL          -- Ordered RX/TX message array
);
CREATE INDEX idx_qso_log_completed_at ON qso_log(completed_at_utc DESC);
CREATE INDEX idx_qso_log_their_call_band ON qso_log(their_call, band);

-- 6. Isolated demo/simulated QSO logbook (NEVER read by ADIF exporter)
CREATE TABLE demo_qso_log (
    qso_id              TEXT PRIMARY KEY,
    started_at_utc      TEXT NOT NULL,
    completed_at_utc    TEXT NOT NULL,
    my_call             TEXT NOT NULL,         -- Always QQ*
    my_grid             TEXT NOT NULL,
    their_call          TEXT NOT NULL,         -- Always QQ*
    their_grid          TEXT,
    mode                TEXT NOT NULL DEFAULT 'FT8',
    dial_freq_hz        INTEGER,
    band                TEXT,
    rst_sent            TEXT,
    rst_rcvd            TEXT,
    completion_reason   TEXT NOT NULL,
    transcript_json     TEXT NOT NULL
);

-- 7. Persistent transactional outbox for future GCP Pub/Sub -> BigQuery ingestion
CREATE TABLE telemetry_outbox (
    event_id            TEXT PRIMARY KEY,      -- UUIDv7 (time-ordered)
    schema_version      INTEGER NOT NULL DEFAULT 1,
    station_id          TEXT NOT NULL,
    radio_id            TEXT,
    event_type          TEXT NOT NULL,
    is_demo             INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
    occurred_at_utc     TEXT NOT NULL,
    payload_json        TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'dead_letter')),
    attempts            INTEGER NOT NULL DEFAULT 0,
    next_attempt_at_utc TEXT NOT NULL,
    leased_until_utc    TEXT,
    last_error          TEXT,
    created_at_utc      TEXT NOT NULL
);
CREATE INDEX idx_outbox_pending ON telemetry_outbox(status, next_attempt_at_utc);
CREATE INDEX idx_outbox_created ON telemetry_outbox(created_at_utc);

-- 8. Unified Command Bus audit log & idempotency cache
CREATE TABLE command_audit (
    command_id          TEXT PRIMARY KEY,      -- UUIDv7
    idempotency_key     TEXT UNIQUE,           -- Prevents duplicate execution on retries
    origin              TEXT NOT NULL CHECK (origin IN ('local_ui', 'cli', 'gcp_bridge')),
    actor               TEXT NOT NULL,
    radio_id            TEXT,
    command_kind        TEXT NOT NULL,
    status              TEXT NOT NULL CHECK (status IN ('ok', 'rejected', 'failed')),
    error_code          TEXT,
    response_json       TEXT NOT NULL,
    created_at_utc      TEXT NOT NULL,
    completed_at_utc    TEXT NOT NULL
);
CREATE INDEX idx_command_audit_created ON command_audit(created_at_utc DESC);
```

---

## 5. Phased Milestone Checklist & Verification Criteria

### Milestone M0 — Workspace Scaffold, SQLite Store, Domain Core & Preflight CLI
- **Deliverables:**
  - Rust workspace (`Cargo.toml`, permissive-license dependency check via `cargo-deny` or manual audit) + Vite/TypeScript/Preact scaffold (`ui/`).
  - SQLite `StateStore` with embedded migrations (`WAL` mode, all 8 tables above) and atomic writes.
  - Pure domain modules: `SlotClock` (compile-time `UnixSecs` vs `VirtualMs` types), FT8 message parser (`RR73`-before-grid, `? a1` stripping), amateur band table (160m–70cm), and ADIF 3.1.4 formatter.
  - `digi-dx preflight [--json] [--fail-on-fatal]` implementing all 10 checks from [`docs/deployment-and-deps.md`](deployment-and-deps.md).
- **Verification Criteria:**
  - `cargo test` passes unit suites covering `SlotClock` (scale 1 & 20, floor construction errors), FT8 parser fixtures (including `RR73` vs grid & `? a1`), ADIF byte-length export, and SQLite migration round-trips.
  - `digi-dx preflight --json` runs cleanly on Linux and macOS, accurately reports `hamlib_rigctld`, `os_groups` (including mocked stale-group test), and `ft8_decoder_jt9`.

### Milestone M1 — Hot-Plug USB/Serial Discovery & Per-Radio `rigctld` Lifecycle Manager
- **Deliverables:**
  - `DeviceSupervisor` with OS hot-plug watcher (`udev` on Linux, `nusb`/IOKit on macOS) + `250 ms` debounce + `5 s` reconciliation loop.
  - Persistent indexing into `usb_devices` (`/dev/serial/by-id/*` + VID:PID:serial:iface).
  - Per-radio `rigctld` subprocess pool (loopback port allocation `4532..4599`, process-group teardown, dummy `rigctld -m 1` support) + single-connection `RigctldClient` using Hamlib `+` extended response protocol (`+f`, `+F`, `+m`, `+M`, `+t`, `+T`).
  - Full 9-state device lifecycle machine with exponential recovery backoff.
- **Verification Criteria:**
  - Integration tests spawn real `rigctld -m 1` on two distinct ports simultaneously, prove `+f`/`+F`/`+M`/`+T` round-trips, prove crash recovery (`kill -9` on child `rigctld` → `DEGRADED` → `RECOVERING` → `READY`), and prove zero orphaned `rigctld` processes after daemon stop.
  - Manual hot-plug test on Linux/macOS: start daemon with USB-serial cable unplugged → plug in cable → `GET /api/v1/devices/usb` detects it within `< 2 s` without restarting daemon → unplug → transitions cleanly to `DISCONNECTED`.

### Milestone M2 — Unified Command Bus, Control Leases, Telemetry Outbox & Stubbed GCP Seams
- **Deliverables:**
  - `CommandBus` (`Validate -> Authorize -> Execute -> Ack`) with `command_audit` idempotency cache, constant-time `DIGI_DX_AUTH_TOKEN` check, per-radio control leases, and `tx.halt_emergency` override.
  - `TelemetryOutboxWorker` with transactional enqueue, batch lease/retry/backoff, storage-cap compaction, `NoopTelemetrySink`, and `GcpPubSubSinkStub`.
  - `CommandTransport` trait + HTTP (`POST /api/v1/commands`), WebSocket (`/api/v1/ws`), and `GcpBridgeClientStub`.
- **Verification Criteria:**
  - Contract tests prove: duplicate `idempotency_key` executes once; observer without lease receives `LEASE_REQUIRED`; second operator receives `LEASE_HELD`; `tx.halt_emergency` succeeds without lease; `station.update_config` rejects `QQ0DEMO`.
  - Mock transport test sends commands through `GcpBridgeClientStub` → `CommandBus` and verifies identical validation/auth/audit behavior as LAN WS.
  - Outbox tests verify persistence across daemon restarts, exponential backoff on simulated sink failure, and retention pruning preserving `qso.completed` and `watchdog.abort` rows.

### Milestone M3 — Cross-Platform Audio (`cpal`), Hybrid FT8 Modem & Hardware PTT Watchdog
- **Deliverables:**
  - `AudioManager` (`cpal` device enumeration with persistent UID/USB card matching, `48 kHz ↔ 12 kHz` `rubato` resampler, `rustfft` waterfall bins).
  - Vendored MIT `kgoba/ft8_lib` build via `cc` crate (`Ft8LibEmbeddedDecoder` + `Ft8LibTxModulator`).
  - `Jt9SubprocessDecoder` (`YYMMDD_HHMMSS.wav` temp naming, timeout, cleanup) + automatic primary/fallback selection.
  - `SimulatedModem` (independent far-side FT8 station state machine using `QQ*` callsigns, real-time demo & scaled-time CI).
  - `PttWatchdog` (`500 ms` heartbeat / `2000 ms` timeout / `13.5 s` hard ceiling + disconnect/detach abort).
- **Verification Criteria:**
  - Offline WAV fixture test decodes known FT8 reference WAV files through **both** `Jt9SubprocessDecoder` and `Ft8LibEmbeddedDecoder`, asserting expected decodes and clean `? a1` stripping.
  - Loopback encode→decode test: `Ft8LibTxModulator` generates `CQ N1MPM FN33` PCM at `1420 Hz`, resamples, and both decoders recover the exact message and AF (`±5 Hz`).
  - Watchdog unit & integration tests assert PTT drops (`+T 0`) within `< 2.1 s` on heartbeat silence, `< 200 ms` on WS disconnect, and `<= 13.5 s` on runaway TX.

### Milestone M4 — Daemon QSO Engine, ADIF 3.1.4 Export & Embedded Vite + Preact Web UI
- **Deliverables:**
  - Daemon-side `QsoEngine` (CQ calling, click-to-reply, priority caller queue, auto-sequencer, AF survey, occupied-AF indicator, real vs. demo log isolation).
  - `GET /api/v1/qsos/export.adi` strictly reading `qso_log`.
  - Embedded Vite + TypeScript + Preact SPA (`rust-embed`) served at `/`:
    - Station & Radio Hardware Setup (hot-plug USB/audio picker, Hamlib model selector, CAT/PTT test buttons, preflight health drawer).
    - Live Operating Console (multi-radio switcher, UTC `SlotClock` bar, `200–3000 Hz` interactive waterfall & EVEN/ODD occupancy lanes, live decodes table, active QSO sequencer card, emergency Halt TX button, and unmistakable `DEMO MODE` banner when simulated).
    - Logbook view & 1-click ADIF export.
- **Verification Criteria:**
  - Headless scaled-time (`scale=20`) integration test drives a full simulated FT8 QSO (`CQ → Grid → Report → R-Report → RR73 → 73`) via WebSocket commands through `CommandBus` → `SimulatedModem` → `QsoEngine`, verifies `demo_qso_log` gained 1 entry, and asserts `GET /api/v1/qsos/export.adi` remains empty (zero demo leakage).
  - Browser smoke test (Playwright) loads the embedded SPA from the single compiled `digi-dx` binary, completes a demo QSO, and confirms countdown rendering, AF picker, and demo labeling with zero console errors.

### Milestone M5 — Native Packaging (`install.sh`, `systemd`, `launchd`) & Live Shack Hardware Sign-Off
- **Deliverables:**
  - Complete `scripts/install.sh`, `deploy/udev/99-digi-dx.rules`, `deploy/systemd/digi-dx.service`, `deploy/launchd/com.digidx.daemon.plist`, and optional `Dockerfile` + `docker-compose.yml`.
  - GitHub Actions CI building/testing `linux/x86_64`, `linux/aarch64`, and `darwin/arm64` artifacts (including `cargo test`, UI build, headless scaled-time QSO test, and `install.sh --dry-run` shellcheck).
- **Verification Criteria:**
  - **Fresh Linux VM/Pi install:** Run `scripts/install.sh` → `systemctl status digi-dx` active → `digi-dx preflight` passes → LAN browser connects on `:8788`.
  - **macOS install:** Run `scripts/install.sh` → `launchctl` agent running → CoreAudio device enumerated → simulated & audio loopback QSO passes.
  - **Live Shack Sign-Off (`c3p0`, Kenwood TS-570S + SignaLink USB):**
    1. Hot-plug SignaLink USB + serial CAT cable after service boot → auto-detected and `rigctld` reaches `READY`.
    2. Live band RX decodes on 20m (`14.074 MHz`) via `jt9` with waterfall & SNR telemetry.
    3. Verified CAT `+F`/`+M` tuning and safe `200 ms` PTT test.
    4. At least one real on-air FT8 QSO completed, logged to `qso_log`, exported to valid ADIF 3.1.4, and telemetry events queued in `telemetry_outbox`.
    5. Mid-TX network unplug / WS disconnect triggers `PttWatchdog` and drops physical transceiver PTT cleanly.
