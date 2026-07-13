# Digi-Dx Phase 1 Daemon Plan

**Status:** Resolved planning notes for Phase 1 implementation.

Phase 1 implements only the daemon. Web, Electron, TUI, GridTracker/WSJT-X
compatibility, Docker packaging, and systemd packaging are deferred.

## 1. Scope

Phase 1 daemon responsibilities:

- Run as a bare-metal Node.js/TypeScript service on the radio host.
- Own the `ft8cat` process, which launches `ft8modem`.
- Optionally own a dummy `rigctld` process for CAT compatibility.
- Expose a WebSocket JSON API for clients.
- Parse internal `ft8cat -A` UDP output into structured daemon events.
- Persist complete last-used session config.
- Support one controller client and any number of observer clients.

Out of scope for Phase 1:

- UI implementation.
- Docker image/buildx packaging.
- systemd unit.
- WSJT-X-compatible UDP protocol.
- GridTracker integration.
- GridTracker or third-party control.
- Full FT8 message grammar validation.
- Multi-operator conflict resolution.

## 2. Runtime And Project Shape

Use TypeScript, Node.js, ESM, `ws`, and Vitest.

Suggested structure:

```text
package.json
src/
  index.ts
  daemon/
    audio-devices.ts
    config.ts
    engine.ts
    protocol.ts
    tx-state.ts
    websocket.ts
test/
```

Binary path resolution:

- `DIGI_DX_FT8CAT_PATH`, else `PATH`.
- `DIGI_DX_FT8MODEM_PATH`, else `PATH`.
- `DIGI_DX_RIGCTLD_PATH`, else `PATH`.

## 3. Config

Config path policy:

- If `DIGI_DX_CONFIG_PATH` is set, use it.
- Production default: `/var/lib/digi-dx/config.json`.
- Dev scripts should set `DIGI_DX_CONFIG_PATH=./data/config.json`.

Config writes are complete atomic writes:

1. Validate a complete config.
2. Write `config.json.tmp`.
3. `fsync` where practical.
4. Rename to `config.json`.

Do not overwrite invalid config automatically. Preserve it until an explicit
`save_config` or `start_session.session` replaces it.

Phase 1 schema:

```json
{
  "session": {
    "mode": "FT8",
    "device": {
      "id": 141,
      "name": "USB Audio CODEC (USB Audio)"
    },
    "callsign": "N1MPM",
    "grid": "FN33",
    "cat": {
      "mode": "rigctld",
      "port": 4532
    }
  }
}
```

Rules:

- `mode` is required and must be `"FT8"` in Phase 1.
- Keep `mode` in the API so `"FT4"` can be added later.
- `device.id` is required and is the value used to launch `ft8modem`.
- `device.name` is optional metadata for UI display and mismatch warnings.
- `callsign` is required, uppercased, and lightly validated with
  `[A-Z0-9/]{3,16}`.
- `grid` is required, uppercased, and must be a 4- or 6-character Maidenhead
  locator.
- `cat.mode` is `"rigctld"` or `"dummy"`.
- CAT is always local to the radio host; no CAT host config in Phase 1.

Name mismatch behavior:

- If saved `device.name` does not match the discovered name for `device.id`,
  warn but do not block session start.

## 4. WebSocket Control Model

Opening a WebSocket connection means "connect as an observer." It does not start
the engine and does not require authentication.

Multiple clients may connect. Exactly one client may hold control.

Read-only commands:

- `get_status`
- `get_config`
- `list_audio_devices`

Mutating commands require control:

- `save_config`
- `start_session`
- `stop_session`
- `transmit`
- `cancel_transmit`
- `release_control`

`claim_control` is the command that obtains control. It is token-gated when
`DIGI_DX_AUTH_TOKEN` is configured, but it does not require existing control.

Control commands:

```json
{ "id": "1", "type": "claim_control", "token": "..." }
{ "id": "2", "type": "release_control" }
```

Authentication:

- If `DIGI_DX_AUTH_TOKEN` is set, `claim_control` must provide it.
- If the token is absent or wrong, return `AUTH_FAILED`.
- If no token is configured, allow `claim_control` and log a warning.
- Auth is checked on `claim_control`, not at WebSocket connection time.

Control behavior:

- No control stealing in Phase 1.
- If another controller exists, return `CONTROL_UNAVAILABLE`.
- If an observer sends a mutating command, return `CONTROL_REQUIRED`.
- Release control explicitly with `release_control`.
- Automatically release control when the controller socket disconnects.

Commands may include optional client-provided `id`. Direct responses and errors
echo `id` when applicable. Broadcast events omit `id` for other clients. For the
requesting client, the relevant broadcast/response may include the echoed `id`.

## 5. API Contract

### Config

```json
{ "id": "1", "type": "get_config" }
```

Response when complete:

```json
{
  "id": "1",
  "type": "config",
  "session": {
    "mode": "FT8",
    "device": {
      "id": 141,
      "name": "USB Audio CODEC (USB Audio)"
    },
    "callsign": "N1MPM",
    "grid": "FN33",
    "cat": {
      "mode": "rigctld",
      "port": 4532
    }
  },
  "complete": true
}
```

Response when missing/incomplete:

```json
{
  "id": "1",
  "type": "config",
  "session": null,
  "complete": false,
  "missing": ["mode", "device.id", "callsign", "grid"]
}
```

`save_config` requires control, requires a complete config, and is allowed only
when no session is active:

```json
{
  "id": "2",
  "type": "save_config",
  "session": {
    "mode": "FT8",
    "device": {
      "id": 141,
      "name": "USB Audio CODEC (USB Audio)"
    },
    "callsign": "N1MPM",
    "grid": "FN33",
    "cat": {
      "mode": "dummy",
      "port": 4532
    }
  }
}
```

### Session Lifecycle

`start_session` without a `session` object starts from saved complete config:

```json
{ "id": "3", "type": "start_session" }
```

If no complete saved config exists, return `CONFIG_REQUIRED`.

`start_session` with a `session` object validates and atomically saves the
complete config before launching:

```json
{
  "id": "4",
  "type": "start_session",
  "session": {
    "mode": "FT8",
    "device": {
      "id": 141,
      "name": "USB Audio CODEC (USB Audio)"
    },
    "callsign": "N1MPM",
    "grid": "FN33",
    "cat": {
      "mode": "rigctld",
      "port": 4532
    }
  }
}
```

Rules:

- Active + `start_session` without `session`: no-op success; return/broadcast
  current status.
- Active + `start_session.session`: fail because it writes config first and
  config writes are forbidden while active.
- Inactive + `start_session.session`: validate, save, then start.
- Inactive + no-arg `start_session`: start from saved complete config.

`stop_session`:

```json
{ "id": "5", "type": "stop_session" }
```

Rules:

- Requires control.
- Clears runtime session/TX state.
- Leaves saved config intact.
- Sends graceful termination first, then hard cleanup if needed.

### Audio Device Discovery

```json
{ "id": "6", "type": "list_audio_devices" }
```

Response:

```json
{
  "id": "6",
  "type": "audio_devices",
  "devices": [
    {
      "id": 141,
      "name": "USB Audio CODEC (USB Audio)",
      "inputs": 2,
      "outputs": 2,
      "defaultSampleRate": 48000
    }
  ]
}
```

Phase 1 discovery may parse `ft8modem -h` output, since that is the device view
`ft8modem` itself uses. Parser tests should lock representative help output.

If discovery fails, return `AUDIO_DISCOVERY_FAILED`; do not silently return an
empty list.

### Status

Use grouped status:

```json
{
  "type": "status",
  "session": {
    "active": true,
    "mode": "FT8",
    "device": {
      "id": 141,
      "name": "USB Audio CODEC (USB Audio)"
    },
    "catConnected": true,
    "freq": 14074000,
    "ptt": false,
    "callsign": "N1MPM",
    "grid": "FN33"
  },
  "tx": {
    "state": "idle",
    "af": null,
    "slot": null,
    "message": null
  },
  "control": {
    "held": true,
    "byThisClient": false
  }
}
```

Send `status`:

- On WebSocket connect.
- On `get_status`.
- After session start/stop/crash.
- After TX state changes.
- After relevant CAT/frequency/PTT changes.

Do not maintain or replay decode/log history in Phase 1.

## 6. Engine Process Lifecycle

The daemon spawns `ft8cat` directly and passes `ft8modem` as the subcommand.

Launch shape:

```text
ft8cat -A 127.0.0.1:<udpPort> -u -p <catPort> ft8modem FT8 <deviceId>
```

The daemon should create a process group for the engine tree and signal the
group on stop so `ft8modem` is not orphaned.

State model:

```text
inactive -> starting -> active -> stopping -> inactive
```

Exit classification:

- If the daemon initiated `stop_session`, child exit is normal.
- Any other `ft8cat` exit is `PROCESS_CRASHED`.

Crash policy:

- Do not auto-respawn in Phase 1.
- On unexpected exit, set session inactive, clear runtime state, emit
  `PROCESS_CRASHED`, broadcast `status`, and wait for explicit `start_session`.

Stop policy:

- Send `SIGTERM` to the process group.
- If still running after 5 seconds, send `SIGKILL` to the process group.

## 7. CAT

Supported Phase 1 CAT modes:

```json
{ "mode": "rigctld", "port": 4532 }
{ "mode": "dummy", "port": 4532 }
```

No `ft8cat -F` in Phase 1.

Real CAT:

- Assume local external `rigctld` is already running.
- Before session start, verify TCP connection to `127.0.0.1:<port>`.
- If unavailable, fail with `CAT_FAILED`.

Dummy CAT:

- Daemon starts `rigctld -m 1 -t <port>` for the session.
- Verify the configured port is free before starting. If occupied, fail with
  `CAT_PORT_UNAVAILABLE`.
- Wait until the local port accepts connections before starting `ft8cat`.
- Stop dummy `rigctld` when the session ends.

`status.freq` is best-effort from `ft8cat`/CAT output and may be `null`.
`status.ptt` follows engine TX active state in Phase 1.

## 8. Internal UDP From `ft8cat -A`

Use `ft8cat -A` only as an internal daemon input stream. It is not WSJT-X UDP
and is not exposed for GridTracker.

Port policy:

- Bind a UDP socket on `127.0.0.1:0`.
- Read the OS-assigned port.
- Pass that port to `ft8cat -A 127.0.0.1:<port>`.
- If bind fails, return `UDP_BIND_FAILED`.

Use `-u` so timestamp fields are integer Unix timestamps.

Parser policy:

- Parse known RX and TX ALL.TXT-style lines into structured `decode` and `tx`
  events.
- Drop malformed lines with an internal warning.
- Do not surface malformed UDP lines as client command errors.
- Implementation is blocked until real `ft8cat -A -u` RX and TX sample lines
  are captured and added as parser fixtures.

## 9. Transmit Model

The daemon API requires explicit transmit slot:

```json
{
  "id": "7",
  "type": "transmit",
  "af": 2262,
  "slot": "even",
  "message": "JA2KVB N1MPM R-15"
}
```

Validation:

- Requires control.
- Requires active session.
- `af` is required integer, `200 <= af <= 3000`.
- `slot` is required and exactly `"even"` or `"odd"`.
- `message` is required, trimmed, non-empty, uppercased, no embedded newlines
  or control characters, max length 128.
- Do not implement full FT8 message grammar validation in Phase 1.

Forwarding:

- `"even"` becomes `E`, `"odd"` becomes `O`.
- Daemon writes `<af><E|O> <MESSAGE>\n` to `ft8cat` stdin.
- `ft8modem` owns slot timing. The daemon does not implement its own slot clock
  or transmit queue.

Internal TX records:

- `desiredTx`: latest operator intent.
- `activeTx`: what the engine is currently transmitting.
- Public `status.tx` is derived from those records.

Public TX states:

- `idle`: no desired or active TX.
- `pending`: desired TX exists but is not currently active.
- `active`: engine is transmitting the desired TX.

`tx_update` event:

```json
{
  "type": "tx_update",
  "ts": 1782994712,
  "af": 2262,
  "slot": "even",
  "message": "JA2KVB N1MPM R-15",
  "state": "active"
}
```

Emit `tx_update` every time the daemon accepts or changes desired TX intent.
Keep `tx` for engine-confirmed transmit start from `ft8cat -A`/`E:` data:

```json
{
  "type": "tx",
  "ts": 1782994715,
  "af": 2262,
  "mode": "FT8",
  "message": "JA2KVB N1MPM R-15"
}
```

TX update rules:

- Pending same-slot update: replace desired intent and forward immediately.
- Pending opposite-slot update: replace desired intent and forward immediately.
- Active same-slot update: forward immediately to update active TX.
- Active opposite-slot update: send `STOP`, wait for `TX: 0` or 1-second
  timeout, then forward the new slot/message.

`cancel_transmit`:

```json
{ "id": "8", "type": "cancel_transmit" }
```

Rules:

- Requires control.
- Clears desired TX and active TX state.
- Sends `STOP` whether TX is pending or active.
- Emits `tx_update` with `state: "idle"`.

Engine TX lifecycle:

- Parse `E:`/UDP TX spot as the user-facing `tx` event.
- Parse `TX: 1` from engine stdout as active transmit state.
- Parse `TX: 0` from engine stdout as transmit ended.
- If `TX: 0` is missing after `STOP`, proceed after 1 second and log a warning.
- Implementation must verify that `ft8cat` exposes the needed `TX:` lines.

## 10. Errors

Standard error shape:

```json
{
  "id": "abc123",
  "type": "error",
  "code": "VALIDATION_FAILED",
  "message": "transmit.slot must be 'even' or 'odd'",
  "details": {
    "field": "slot"
  }
}
```

`details` is optional. Never expose raw stack traces to clients.

Phase 1 error codes:

```text
INVALID_COMMAND
VALIDATION_FAILED
CONTROL_REQUIRED
CONTROL_UNAVAILABLE
AUTH_FAILED
CONFIG_REQUIRED
CONFIG_INVALID
CONFIG_WRITE_FAILED
SESSION_ALREADY_ACTIVE
NO_ACTIVE_SESSION
SOUND_DEVICE_UNAVAILABLE
AUDIO_DISCOVERY_FAILED
CAT_FAILED
CAT_PORT_UNAVAILABLE
UDP_BIND_FAILED
ENGINE_START_FAILED
PROCESS_CRASHED
TX_FAILED
```

## 11. Logging

Keep logging simple in Phase 1:

- Daemon logs to stdout/stderr.
- Selected operator-relevant `log` events may be sent over WebSocket.
- Client-facing levels: `info`, `warn`, `error`.
- No daemon-managed log files.
- No raw engine diagnostic protocol in Phase 1 unless needed temporarily during
  implementation debugging.

## 12. Testing And Validation

Automated tests:

- Config validation and atomic write behavior.
- Config invalid/corrupt recovery behavior.
- WebSocket control/auth rules.
- Optional `id` correlation.
- TX state machine:
  - pending same-slot update,
  - pending opposite-slot update,
  - active same-slot update,
  - active opposite-slot STOP/wait/forward,
  - cancel pending/active,
  - missing `TX: 0` timeout.
- `ft8cat -A -u` parser tests from real sample RX/TX lines.
- Audio device parser tests from real `ft8modem -h` output.
- Fake-engine integration tests.

Fake-engine integration tests should not require radio/audio hardware. The fake
engine should:

- Read stdin.
- Emit stdout lines such as `TX: 1`, `TX: 0`, and `FA: ...`.
- Send UDP sample lines to the daemon's assigned UDP port.
- Exit on demand to test crash handling.

Manual c3p0 validation checklist:

- `list_audio_devices` returns the SignaLink/USB audio device.
- Start dummy CAT session.
- Start real CAT session when external `rigctld` is running.
- Receive decodes.
- Transmit on requested even slot.
- Transmit on requested odd slot.
- Update active same-slot TX.
- Active opposite-slot update sends `STOP`, waits for `TX: 0` or timeout, then
  arms the new slot.
- `cancel_transmit` stops pending/active TX.
- `stop_session` cleans up `ft8cat`, `ft8modem`, and dummy `rigctld`.
- Unexpected `ft8cat` exit emits `PROCESS_CRASHED` and does not auto-respawn.
