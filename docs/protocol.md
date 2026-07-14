# Daemon ↔ client protocol

Wire contract for the WebSocket between the digi-dx daemon and its clients (TUI, web server/CLI). Types live in [`core/protocol.ts`](../core/protocol.ts); this document is the human-readable contract.

## Contract revision: slot clock (breaking)

**Breaking revision.** `DaemonStatus` now always carries a published **slot clock** and an **engine kind**. Clients that previously scheduled or rendered FT8 slots from `Date.now()` (or from an additive clock-skew offset alone) are incorrect under any `scale` other than `1`, and must not fall back to wall time when no clock has arrived yet.

| Field | Meaning |
|-------|---------|
| `engine` | `"ft8cat"` (live radio path) or `"simulated"` (demo / headless sim). |
| `clock` | Four-field `SlotClockSpec` — the authoritative time base for every slot decision. |

### `clock` (`SlotClockSpec`)

| Field | Meaning |
|-------|---------|
| `epochMs` | Virtual time at the anchor instant. |
| `anchorWallMs` | Wall-clock instant at which virtual time equalled `epochMs`. |
| `slotMs` | Slot duration in milliseconds (FT8 default 15 000). |
| `scale` | Virtual milliseconds per wall millisecond. `1` is real time. |

Virtual now is `epochMs + (wallNow - anchorWallMs) * scale`. Both anchors are required: a virtual reading without a wall anchor is meaningless, and omitting the wall anchor forces clients to re-anchor locally (which breaks time-scaled runs).

**Client rules**

- Derive countdown rendering, TX-window display, and automated transmit scheduling from the published clock.
- Local interpolation between status updates is fine; holding an authoritative clock is not.
- Until the first `status` with `clock` arrives, there is **no** slot clock — do not substitute `Date.now()`.

Shared arithmetic for Node clients lives in [`core/slot-clock.ts`](../core/slot-clock.ts).

## Status and identity

`status` is the primary push message. Besides `clock` and `engine`, it carries session state (`active`, mode, device, CAT, freq, PTT, callsign, grid), current TX intent, and control-holder flags. See `DaemonStatus` in `core/protocol.ts`.

Other server→client types: `decode`, `tx`, `tx_update`, `log`, `error`, `config`, `audio_devices`.

## Commands (high level)

Clients send commands over the same socket (each tagged with an `id` by the transport). Relevant to demo mode:

| Command | Notes |
|---------|--------|
| `start_session` | Optional `session` config. `demo: true` starts on the simulated engine with a synthesized identity and skips the config gate — usable when no radio is wired. Driver selection is per session. |
| `stop_session` | Ends the active session; engine kind returns to the live default when idle. |
| `transmit` / `cancel_transmit` | Daemon stays QSO-unaware: it only arms/cancels a TX intention. |

Session config shape, audio discovery, and error codes are defined in `core/protocol.ts`. For running without a radio, see [install.md](./install.md) (demo mode).
