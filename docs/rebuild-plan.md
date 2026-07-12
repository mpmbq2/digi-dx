# Digi-Dx Rebuild Plan

**Status:** Draft v1 — 2026-07-12
**Scope:** Post-review refactor plan for the `rebuild` branch. Captures the five
architecture decisions taken during the code-review walkthrough, the sequenced
workstreams, and first-cut interface stubs for the three new abstractions.

This plan does **not** change the daemon's public WebSocket contract or the FT8
domain semantics (AF 200–3000 Hz, even/odd slots, FT8/FT4, snr/dt/af decodes).
Those stay the stable public seam; everything here is internal restructuring.

---

## 1. Decisions

| # | Question | Decision |
|---|----------|----------|
| 1 | Engine-swap form | Call-oriented `EngineDriver` interface; keep ft8cat/ft8modem as a **subprocess adapter** (`Ft8CatModemDriver`) now. In-process (TS or Rust/N-API) is the future default; crash-isolation choice deferred to when the native module exists. |
| 2 | Shared-code layout | New top-level **`core/`** dir included by both tsconfigs. Holds the wire protocol (single source of truth), `qso.ts`, `OperatorController`, and `DaemonClient`. No workspaces/monorepo. |
| 3 | Single-operator model | Controller stays **client-side** now (matches `AGENTS.md`, keeps daemon QSO-unaware). Designed **transport-abstract** so it can be promoted into the daemon later (all UIs become thin remotes of one session) as a relocation, not a rewrite. |
| 4 | Sequencing | `W1 → W4 → W2`; W4 moved up because the `EngineDriver` seam is the prerequisite for turnkey/zero-install onboarding — the metric-critical Engine-backend track in `STRATEGY.md` — not "someday" insurance. W5 (security) low-priority on trusted LAN; W6 opportunistic. |
| 5 | Deliverable | This doc, left uncommitted next to the existing design docs. |

**Deferred (future option B / later):** promoting `OperatorController` into the
daemon for cross-UI shared session state; choosing crash-isolation vs single
process for the eventual native engine.

---

## 2. Target module layout

```
src/daemon/        daemon-only: engine (state machine), engine-driver + Ft8CatModemDriver,
                   websocket, config, tx-state, audio-devices
core/              shared, framework-agnostic
  protocol.ts        wire message + command types + constants  <-- single source of truth
  qso.ts             QsoAutomation, FT8 parser, slot/occupancy math (moved from ui/)
  daemon-client.ts   typed connect/reconnect/send/on
  controller.ts      OperatorController (headless orchestration)
  view-model.ts      pure ControllerState -> view helpers (shared; today's ui/web/view-model.ts)
ui/                thin: render + input only
  tui.ts             blessed rendering of ControllerState
  web/server.ts      ControllerState -> StateMessage + browser cmds -> controller methods
  web/public/app.js  unchanged (already clean)
  cli.ts             raw DaemonClient console
```

tsconfig: daemon build `include: ["src/**/*.ts", "core/**/*.ts"]`; UI typecheck
includes `core/ + ui/`. NodeNext `.js` import extensions and `rootDir: "."` keep
emit working without a bundler.

---

## 3. Interface stubs

### 3.1 `EngineDriver` (W4, daemon-internal — Q1)

The `Engine` state machine depends on this; it no longer knows any ft8cat/ft8modem
grammar. `Ft8CatModemDriver` wraps today's spawn args, stdin protocol, stdout
`TX:`/`FA:` parsing, `-A -u` UDP parsing, dummy-`rigctld` handling, and `ft8modem -h`
device discovery. A future `NativeDriver` implements the same interface in-process.

```ts
// src/daemon/engine-driver.ts
import { EventEmitter } from "node:events";
import type { SessionConfig } from "./config.js";
import type { TxIntent } from "./protocol.js";
import type { AudioDevice } from "./audio-devices.js";

export interface DriverDecode {
  ts: number; snr: number; dt: number; af: number;
  mode: "FT8" | "FT4"; message: string;
}
export interface DriverTx {
  ts: number; af: number; mode: "FT8" | "FT4"; message: string;
}

export interface EngineDriverEvents {
  decode: [DriverDecode];   // was: parseInternalUdpLine (Rx)
  tx: [DriverTx];           // was: parseInternalUdpLine (Tx)
  freq: [number];           // was: stdout "FA:" line, Hz
  ptt: [boolean];           // was: stdout "TX: 0|1" line
  crash: [Error];           // unexpected exit -> Engine emits PROCESS_CRASHED
}

export interface EngineDriver extends EventEmitter<EngineDriverEvents> {
  start(session: SessionConfig): Promise<void>;   // spawn/connect, own lifecycle
  stop(): Promise<void>;                           // graceful teardown (signal group today)
  transmit(intent: TxIntent): Promise<void>;       // driver owns "<af><E|O> <msg>" grammar
  cancelTransmit(): Promise<void>;                 // driver owns "STOP" grammar
  listAudioDevices(): Promise<AudioDevice[]>;      // engine-specific discovery
}
```

Migration notes:
- `TxState` stays at the `Engine` level (slot-switch sequencing is protocol-agnostic)
  but calls `driver.transmit(intent)` / `driver.cancelTransmit()` instead of writing
  raw stdin lines — the `<af><E|O>` / `STOP` grammar moves into the driver.
- CAT readiness + dummy-`rigctld` spawn become internal to `Ft8CatModemDriver.start`.
- `Engine.snapshot()`, the state machine, and the outward `EngineApi`/`event`/`status`
  fan-out are unchanged — the websocket layer sees no difference.

### 3.2 `DaemonClient` (W1, core — Q2)

One typed WebSocket client, replacing the hand-rolled `ws` wiring in `tui.ts`,
`web/server.ts`, and `cli.ts`. Command and event types come from `core/protocol.ts`.

```ts
// core/daemon-client.ts
import { EventEmitter } from "node:events";
import type {
  DaemonStatus, DecodeEvent, TxEvent, TxUpdateEvent, LogEvent,
  ErrorMessage, ConfigMessage, AudioDevicesMessage, DaemonCommand
} from "./protocol.js";

export interface DaemonClientOptions {
  url: string;
  token?: string;
  reconnectMs?: number;   // default 2000; TUI/web both reconnect today
}

export interface DaemonClientEvents {
  open: [];
  close: [];
  status: [DaemonStatus];
  decode: [DecodeEvent];
  tx: [TxEvent];
  tx_update: [TxUpdateEvent];
  log: [LogEvent];
  error: [ErrorMessage];
  config: [ConfigMessage];
  audio_devices: [AudioDevicesMessage];
}

export interface DaemonClient extends EventEmitter<DaemonClientEvents> {
  connect(): void;
  close(): void;
  readonly connected: boolean;
  send(command: DaemonCommand): void;   // auto-attaches an id
}
```

### 3.3 `OperatorController` (W2, core — Q2/Q3)

Headless orchestration extracted from `tui.ts` and `web/server.ts`. Owns the
`QsoAutomation`, the decode buffer, the slot-aligned scheduler, the survey, control
state, dial freq, and worked-call/logging side effects. All dependencies are
injected, so it runs identically inside a UI process today or inside the daemon
later (option B).

```ts
// core/controller.ts
import type { DaemonClient } from "./daemon-client.js";
import type {
  QsoRecord, DecodeRecord, QsoLogEntry, TxSlot
} from "./qso.js";
import type { TxState, QsoAction } from "./protocol.js";

export interface QsoLogStore {
  append(entry: QsoLogEntry): Promise<void>;
  readAll(): Promise<QsoLogEntry[]>;
}

export interface OperatorControllerDeps {
  client: DaemonClient;
  log: QsoLogStore;
  token?: string;
  now?: () => number;                                  // injectable clock (test hook)
  onLog?: (level: string, text: string) => void;       // activity-log sink
}

export interface ControllerState {
  station: {
    call: string; grid: string; dialFreqHz: number | null;
    catConnected: boolean; sessionActive: boolean;
    controlHeld: boolean; controlMine: boolean;
  };
  tx: {
    state: TxState; enabled: boolean;
    message: string | null; af: number | null; slot: TxSlot | null;
  };
  survey: { active: boolean; slot: TxSlot | null; endSec: number };
  af: { value: number; slot: TxSlot };
  qsos: { callingCq: boolean; active: QsoRecord[]; completed: QsoRecord[] };
  decodes: DecodeRecord[];
}

export interface OperatorController {
  readonly state: ControllerState;
  onChange(listener: (state: ControllerState) => void): () => void;  // returns unsubscribe

  // operator actions (mirror today's UI handlers)
  setIdentity(call: string, grid: string): void;
  setDialFreq(mhz: number | null): void;
  setAf(af: number): void;
  setSlot(slot: TxSlot): void;
  callCq(slot?: TxSlot): void;
  stopCq(reason?: string): void;
  replyToCall(call: string): void;
  qsoAction(id: string, action: QsoAction): void;
  survey(): void;
  setTxEnabled(enabled: boolean): void;
  haltTx(): void;
  startSession(): void;
  stopSession(): void;
  releaseControl(): void;

  start(): void;    // subscribe to client events, seed worked-calls/dial-freq
  dispose(): void;  // clear timers, unsubscribe
}
```

Consumers after extraction:
- **TUI** — renders `ControllerState` with blessed; key/mouse handlers call controller
  methods. No scheduler/survey/automation logic remains in `tui.ts`.
- **Web** — `core/view-model.ts` maps `ControllerState -> StateMessage`; browser
  `CommandMessage`s dispatch to controller methods. `web/server.ts` shrinks to the
  http/static server + the browser WS bridge.
- Both share **one** implementation of halt/enable/survey/control-claim — the current
  drift (`manualOverridePending` vs `txEnabled`/`haltTx`/`controlClaimPending`) is
  resolved by picking the web server's superset behavior.

---

## 4. Workstreams

W-numbers are stable IDs carried from the review; execution order is top-to-bottom
(`W1 → W4 → W2 → W5/W6`).

### W1 — `core/` foundation *(do first; foundation for the rest)*
1. Create `core/`; move `ui/qso.ts` -> `core/qso.ts`; update imports. **(Done.)**
   `ui/web/view-model.ts` is **deferred to W2**: it is currently web-only and bound to
   the browser contract in `ui/web/protocol.ts`, so moving it now would point
   `core/ -> ui/web/` (wrong direction). It relocates once it is UI-agnostic in W2.
2. Establish `core/protocol.ts` as the single source of truth: lift the client-facing
   message types + command union out of `src/daemon/protocol.ts` (the daemon re-exports
   them). Delete `ui/web/protocol.ts`'s duplicated shapes and the inline `msg.x as T`
   casts in `tui.ts`/`cli.ts`.
3. Add `core/daemon-client.ts`; rewire `tui.ts`, `web/server.ts`, `cli.ts` onto it.
4. tsconfig: add `core/**` to the daemon `include`; point the UI typecheck at `core/ + ui/`.
- Closes: **#6** (protocol drift), **#7** (duplicated `senderOf`/`gridFrom`/`latestSlotAfs`).

### W4 — `EngineDriver` seam *(near-term — enables turnkey onboarding)*
1. Define `src/daemon/engine-driver.ts` per §3.1.
2. Extract today's ft8cat/ft8modem/rigctld code into `Ft8CatModemDriver`.
3. `Engine` depends on `EngineDriver`; `index.ts` injects `new Ft8CatModemDriver(...)`.
4. Keep existing parser tests; add a fake-driver test proving `Engine` needs no
   engine-specific knowledge.
- Closes the structural half of the engine-swap goal (Report 0).
- **Why it moved up:** the seam is the prerequisite for the Engine-backend track's
  zero-install onboarding — bundling a default engine so there is no manual
  `ft8modem`/`ft8cat` install (the brother-and-dad success metric in `STRATEGY.md`).
  The bundling/packaging feature itself sits on top of this seam and is scoped in the
  strategy, not here. Pure daemon-side, so it can also run in parallel with W1.

### W2 — extract `OperatorController` *(the maintainability payoff)*
1. Build `core/controller.ts` per §3.3, porting the web server's orchestration (the
   more-evolved copy) and folding in anything TUI-only.
2. Reduce `web/server.ts` to transport + `ControllerState -> StateMessage`.
3. Reduce `tui.ts` to blessed rendering of `ControllerState` + input dispatch.
4. Add unit tests for the controller (scheduler timing with an injected clock, survey,
   control-claim, QSO event/logging) — the logic that is untestable today.
5. Move `ui/web/view-model.ts` -> `core/view-model.ts` once it renders from
   `ControllerState` and is UI-agnostic (the TUI can render from it too) — the W1 deferral.
- Closes: **#3** (untestable TUI logic), **#4** (duplicated orchestration), **#2/#8**
  (web server size/coverage), **#10** (`messageForQso` side-effect — move report
  derivation out of the render path into the controller).

### W5 — security hardening *(low priority on trusted LAN)*
- Default daemon + web binds to `127.0.0.1`; add a browser-socket secret; require the
  daemon token at connect, not just at `claim_control`; constant-time token compare.
- Addresses: **#1** (unauthenticated browser transmit), **#5** (daemon read/bind).

### W6 — small correctness fixes *(opportunistic)*
- **#9** child-exit race during `start()`; **#11** optimistic `ptt=false`, `prepareCat`
  TOCTOU, brittle device regex; **#12** shared `qso-log.jsonl`/`tui-state.json` writers.

---

## 5. Findings reference

| # | Sev | Area | Finding | Closed by |
|---|-----|------|---------|-----------|
| 1 | P1 | Web | Unauthenticated browser WS -> server transmits on its token | W5 |
| 2 | P1 | Web | 985-line module singleton; untestable/instance-locked | W2 |
| 3 | P1 | TUI | Whole module is a script; ~250 lines untestable | W2 |
| 4 | P1 | Cross | QSO orchestration duplicated across TUI/web, drifting | W2 |
| 5 | P2 | Daemon | Unauthenticated reads + default 0.0.0.0 bind; non-constant-time token | W5 |
| 6 | P2 | Cross | Wire protocol re-declared per client | W1 |
| 7 | P2 | TUI/Web | `senderOf`/`gridFrom`/`latestSlotAfs` copy-pasted | W1 |
| 8 | P2 | Web | 985-line server has 2 tests | W2 |
| 9 | P2 | Daemon | Child-exit race during `start()` | W6 |
| 10 | P3 | Cross | `messageForQso` mutates domain state from render paths | W2 |
| 11 | P3 | Daemon | Optimistic `ptt=false`; `prepareCat` TOCTOU; brittle device regex | W6 |
| 12 | P3 | Web | TUI+web share state files without coordination | W6 |
