# UI-Owned FT8 QSO Automation Implementation Plan

This plan is a detailed handoff for implementing standard FT8 QSO automation in the TUI only. The daemon and `ft8modem` remain unaware of QSOs; the daemon is only a transport for the existing `transmit` and `cancel_transmit` commands.

## Current Repository Context

- Runtime daemon code is in `src/`.
- The TUI is currently a single blessed application in `ui/tui.ts`.
- Existing protocol types are in `src/daemon/protocol.ts`.
- Tests are Vitest tests in `test/**/*.test.ts`.
- `tsconfig.json` currently includes only `src/**/*.ts` for the build, while Vitest can still import `ui/*.ts` directly through `tsx`/Vite.
- The current TUI:
  - Tracks `decodes`, `myCall`, `myGrid`, and `currentSlot`.
  - Lets the operator select decodes, edit AF/message/slot, transmit, and cancel.
  - Sends WebSocket commands via `send({ type: ... })`.
  - Handles `decode`, `tx`, `tx_update`, and `status` daemon events.
  - Claims control only when the user explicitly runs `claim`.

## Non-Goals

- Do not add QSO state, QSO commands, or QSO logging to the daemon.
- Do not modify `ft8modem` or `ft8cat`.
- Do not auto-claim daemon control.
- Do not change manual AF ownership. Selecting a decode may draft a reply, but automation must not overwrite AF.
- Do not implement non-standard FT8 message variants in v1.
- Do not implement true mid-cycle starts after the transmit start window has passed.

## Files To Add

### `ui/qso.ts`

Create a pure, testable QSO automation module. It should export all types and functions needed by both `ui/tui.ts` and tests.

Recommended exported types:

```ts
export type TxSlot = "even" | "odd";

export interface DecodeRecord {
  ts: number;
  snr: number;
  dt: number;
  af: number;
  message: string;
}

export interface TxIntent {
  af: number;
  slot: TxSlot;
  message: string;
}

export interface TxConfirmation {
  ts: number;
  af: number;
  message: string;
}

export type QsoStep = "cq" | "call-grid" | "report" | "r-report" | "rr73" | "73" | "done";
export type QsoStatus = "active" | "paused" | "timed_out" | "stopped" | "complete";
export type QsoKind = "calling-cq" | "standard";
```

Recommended QSO record shape:

```ts
export interface QsoRecord {
  id: string;
  kind: QsoKind;
  status: QsoStatus;
  createdAt: string;
  updatedAt: string;
  myCall: string;
  myGrid: string;
  theirCall: string | null;
  theirGrid: string | null;
  step: QsoStep;
  nextSlot: TxSlot;
  attempts: Partial<Record<QsoStep, number>>;
  lastDecodeSnr: number | null;
  sentReport: string | null;
  receivedReport: string | null;
  rxMessages: QsoMessageRecord[];
  txMessages: QsoMessageRecord[];
  note: string | null;
}
```

Important exported helpers:

- `parseFt8Message(message: string): ParsedFt8Message | null`
- `messageForQso(qso: QsoRecord): string | null`
- `slotFromTimestamp(ts: number): TxSlot`
- `oppositeSlot(slot: TxSlot): TxSlot`
- `secondsUntilNextSlot(slot: TxSlot, nowMs?: number): number`
- `formatReport(snr: number): string`
- `findOccupiedAf(decodes, af, txSlot, rangeHz = 50, matchingSlotCount = 2)`
- `normalizeMessage(message: string): string`

Important class:

```ts
export class QsoAutomation {
  readonly qsos: QsoRecord[];

  createCq(myCall: string, myGrid: string, initialSlot: TxSlot, position?: "top" | "bottom"): QsoRecord;
  createReplyToCq(decode: DecodeRecord, myCall: string, myGrid: string, position?: "top" | "bottom"): QsoRecord | null;
  handleDecode(decode: DecodeRecord, myCall: string, myGrid: string): QsoAutomationEvent[];
  nextTransmission(af: number): AutomationTx | null;
  confirmTransmission(pending: AutomationTx | null, tx: TxConfirmation): ConfirmTransmissionResult;
  pauseAll(note: string): void;
  resume(id: string): QsoRecord | null;
  complete(id: string, reason?: string): QsoAutomationEvent[];
  abandon(id: string): QsoRecord | null;
  resetAttempts(id: string): QsoRecord | null;
  previousStep(id: string): QsoRecord | null;
  nextStep(id: string): QsoRecord | null;
  move(id: string, delta: -1 | 1): QsoRecord | null;
  toLogEntry(qso: QsoRecord, reason: string): QsoLogEntry | null;
}
```

Implementation details:

- Normalize callsigns, grids, and messages to uppercase.
- `parseFt8Message` should support:
  - `CQ CALL GRID`
  - directed grid messages: `MYCALL THEIRCALL GRID`
  - directed reports: `MYCALL THEIRCALL -12` and `MYCALL THEIRCALL +03`
  - roger reports: `MYCALL THEIRCALL R-12` and `MYCALL THEIRCALL R+03`
  - `MYCALL THEIRCALL RRR`
  - `MYCALL THEIRCALL RR73`
  - `MYCALL THEIRCALL 73`
- Ignore decoder metadata after a `?` token, for example `CQ PY7XC HI21 ? A1`.
- Keep QSO advancement locked to the expected station:
  - Existing standard QSOs only advance if `to === myCall` and `from === qso.theirCall`.
  - Ignore messages from another station, even if addressed to `myCall`.
  - Ignore messages from the expected station if they are not addressed to `myCall`.
- Use the latest relevant decode SNR for the report value that the UI sends:
  - `formatReport(-7)` must return `-07`.
  - `formatReport(3)` must return `+03`.
  - Clamp or round conservatively; a simple `Math.round` with sensible bounds is fine.
- `slotFromTimestamp` should map FT8 15-second periods consistently:
  - `Math.floor(ts / 15) % 2 === 0 ? "even" : "odd"`.
  - The next TX slot is always `oppositeSlot(slotFromTimestamp(decode.ts))`.
- `messageForQso` should produce:
  - `cq`: `CQ MYCALL MYGRID`
  - `call-grid`: `THEIRCALL MYCALL MYGRID`
  - `report`: `THEIRCALL MYCALL -NN/+NN`
  - `r-report`: `THEIRCALL MYCALL R-NN/R+NN`
  - `rr73`: `THEIRCALL MYCALL RR73`
  - `73`: `THEIRCALL MYCALL 73`
  - `done`: `null`

Sequencing rules:

- Calling CQ:
  - Create a CQ automation row at the top.
  - Send `CQ MYCALL MYGRID`.
  - If a station replies to the CQ, create a standard QSO row at the bottom and stop the CQ row.
- Replying to a CQ:
  - Create a standard QSO row at the top.
  - First send `THEIRCALL MYCALL MYGRID`.
- If they send `MYCALL THEIRCALL MYREPORT`:
  - Advance to `r-report`.
  - Send `THEIRCALL MYCALL R-THEIRSIGNAL` using their latest decoded SNR, not the report they gave you.
- If they send `MYCALL THEIRCALL R-MYREPORT`:
  - Advance to `rr73`.
  - Send `THEIRCALL MYCALL RR73`.
- If they send `RRR` or `RR73`:
  - Advance to `73`.
  - Send `THEIRCALL MYCALL 73`.
  - Complete the QSO only after a matching daemon `tx` event confirms that final `73` was actually transmitted.
- If they send plain `73`:
  - Complete immediately without sending another `73`.

Attempt and timeout rules:

- Do not count attempts when a message is merely scheduled or sent to the daemon.
- Count an attempt only when a daemon `tx` event confirms the message.
- Count attempts per QSO step.
- After 5 confirmed transmissions of the same step:
  - Leave the QSO object in the Active QSOs list.
  - Set status to `timed_out`.
  - Do not abandon, complete, or delete it.
  - The operator can later retry/reset attempts.

### `ui/qso-log.ts`

Create a small JSONL append helper:

```ts
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { QsoLogEntry } from "./qso.js";

export async function appendQsoLog(
  entry: QsoLogEntry,
  path = join(process.cwd(), "data", "qso-log.jsonl")
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
}
```

Log only completed standard QSOs with a real `theirCall`. Do not log abandoned QSOs or a stopped CQ row.

### `test/ui-qso.test.ts`

Add focused Vitest coverage for the pure module and logger.

Test groups:

- Parser tests:
  - CQ parsing.
  - Grid parsing.
  - signal reports.
  - `R+NN` / `R-NN`.
  - `RRR`, `RR73`, and terminal `73`.
  - Metadata after `?` is ignored.
- Sequencing tests:
  - Reply-to-CQ creates first `THEIRCALL MYCALL MYGRID` message.
  - Call-CQ creates `CQ MYCALL MYGRID`.
  - CQ reply creates a standard QSO row and stops the CQ row.
  - Report progression sends `R` plus latest decoded SNR.
  - `R-MYREPORT` advances to `RR73`.
  - `RRR` and `RR73` advance to final `73`.
  - Plain `73` completes immediately and schedules no further TX.
  - QSO lock ignores messages from the wrong station or not addressed to `myCall`.
- Scheduler/state tests:
  - Top eligible row wins.
  - Reorder changes priority.
  - Attempts are counted only by `confirmTransmission`.
  - Timeout occurs after 5 confirmed attempts for the same step.
  - Cancel pause sets active QSOs to paused.
  - Retry/reset attempts makes a timed-out or paused QSO active again with attempts reset for the current step.
  - Manual one-shot override can be represented by not calling `nextTransmission` while the override is pending.
  - `findOccupiedAf` uses only decodes from the last 2 matching TX-slot parities and warns within 50 Hz.
- Logging tests:
  - Appends valid JSONL.
  - Creates the `data/` directory if missing.

## Files To Modify

### `ui/tui.ts`

Refactor carefully; keep the existing daemon command behavior working.

Imports to add:

```ts
import { appendQsoLog } from "./qso-log.js";
import {
  findOccupiedAf,
  messageForQso,
  normalizeMessage,
  oppositeSlot,
  parseFt8Message,
  QsoAutomation,
  secondsUntilNextSlot,
  slotFromTimestamp,
  type AutomationTx,
  type DecodeRecord,
  type QsoAutomationEvent,
  type QsoRecord,
  type TxSlot
} from "./qso.js";
```

Avoid importing daemon internals into the TUI. Duplicate small protocol-compatible shapes if needed.

State to add near current globals:

```ts
const automation = new QsoAutomation();
let selectedQsoId: string | null = null;
let pendingAutomationTx: AutomationTx | null = null;
let automationTimer: NodeJS.Timeout | null = null;
let manualOverridePending = false;
let latestTxState: "idle" | "pending" | "active" = "idle";
```

Important behavior:

- Manual `TRANSMIT`:
  - Validate AF/message as today.
  - Set `manualOverridePending = true`.
  - Clear `pendingAutomationTx`.
  - Send daemon `transmit`.
  - Automation resumes after the next matching daemon `tx` event, or after the pending state clears if no `tx` arrives.
- `CANCEL TX`:
  - Send daemon `cancel_transmit`.
  - Clear `pendingAutomationTx`.
  - Clear `manualOverridePending`.
  - Pause all active automation rows: `automation.pauseAll("cancelled")`.
  - Active QSOs remain visible.
- Never call `claim_control` from automation.
  - If the user has not claimed control, automated transmits may fail with `CONTROL_REQUIRED`; log the daemon error and leave the QSO active/paused according to operator action.

#### Layout

The current TUI uses:

- status bar: top 0 height 3
- decode list: top 3 left 0 width 60% height 70%
- compose panel: top 3 left 60% width 40% height 70%
- log: bottom band
- command input: bottom 0 height 3

Add an Active QSOs list without making the UI too cramped. A simple layout:

- status bar: top 0 height 3
- decode list: top 3 left 0 width 55% height 45%
- active QSO list: top `48%` left 0 width 55% height `25%`
- compose panel: top 3 left 55% width 45% height 70%
- log remains bottom band.

Use a blessed `list`:

```ts
const qsoList = blessed.list({
  top: "48%",
  left: 0,
  width: "55%",
  height: "25%",
  border: { type: "line" },
  label: " active qsos ",
  mouse: true,
  keys: true,
  vi: true,
  tags: true,
  scrollable: true,
  alwaysScroll: true,
  style: { selected: { bg: "blue" } }
});
```

Add it to the screen and update `decodeList.width`/`composePanel.left`/`composePanel.width`.

#### Compose Panel Controls

Keep the existing AF, slot, message, TRANSMIT, and CANCEL controls.

Repurpose or add buttons:

- `Call CQ`
  - Creates a CQ automation row at the top.
  - Uses `myCall || "MYCALL"` and `myGrid || "GRID"`.
  - Initial slot can be `currentSlot`.
  - Calls `scheduleAutomation()`.
- `Reply QSO`
  - Operates on the selected decode if it is a CQ.
  - Creates reply QSO at the top.
  - Does not modify AF.
  - Calls `scheduleAutomation()`.
- `Resume`
  - Resumes selected QSO.
- `Complete`
  - Marks selected QSO complete and writes JSONL if it has `theirCall`.
- `Abandon`
  - Deletes selected QSO without logging.
- `Retry`
  - Resets attempts for the selected QSO’s current step and resumes it.
- `Prev`
  - Moves selected standard QSO to previous step.
- `Next`
  - Moves selected standard QSO to next step.
- `Up` / `Down`
  - Reorders QSO priority.

Use a compact grid of blessed buttons in `composePanel` below the existing TX controls. The panel height is limited, so keep content short.

Keyboard shortcuts:

- `r`: reply to selected CQ decode.
- `c`: call CQ.
- `u` or `S-up`: move selected QSO up if focus is in qso list.
- `d` or `S-down`: move selected QSO down if focus is in qso list.
- `space`: resume/pause toggle is optional, but do not conflict with text input.

#### QSO List Rendering

Implement:

```ts
function renderQsoList(): void;
function selectedQso(): QsoRecord | null;
function selectQso(id: string | null): void;
```

Rows should show:

- Priority number.
- Status.
- Their call or `CQ`.
- Step.
- Attempts for the current step.
- Next slot.
- Current message preview from `messageForQso(qso)`.
- Optional note, for example `timed out on report`.

Example row:

```text
1 active JA2KVB step=r-report att=2 slot=even JA2KVB N1MPM R-07
```

Use blessed tags for status:

- Active: normal.
- Paused/stopped: dim or yellow.
- Timed out: red/yellow.
- Complete: green, but completed rows can also be removed after logging if preferred. The safer v1 behavior is to leave them visible until abandoned or app restart.

#### Occupied Frequency Indicator

Add a small text line in the compose panel near the AF input:

```ts
const afWarning = blessed.text({
  parent: composePanel,
  top: 0,
  left: 12,
  width: "70%",
  content: ""
});
```

Implement:

```ts
function updateAfWarning(): void {
  const af = Number(afInput.getValue());
  if (!Number.isInteger(af)) {
    afWarning.setContent("");
    return;
  }
  const match = findOccupiedAf(decodes, af, currentSlot, 50, 2);
  afWarning.setContent(match ? `occupied +/-50 Hz: ${match.decode.af} ${match.decode.message}` : "");
}
```

Call it:

- after decode events,
- after AF input changes/submits,
- after slot toggles,
- before scheduling automated TX.

Do not change `afInput` from automation or decode selection except for the existing manual decode-click behavior if you choose to preserve it. The plan requirement says automated TX uses current global AF at send time.

#### Scheduler

Implement these functions in `ui/tui.ts`:

```ts
function scheduleAutomation(): void;
function clearAutomationTimer(): void;
function armAutomation(tx: AutomationTx): void;
function sendAutomatedTx(tx: AutomationTx): void;
function currentAfOrNull(): number | null;
```

Expected scheduler behavior:

- If `manualOverridePending` is true, do nothing.
- If daemon TX state is `active`, do nothing.
- Read current AF with `currentAfOrNull`.
  - Must be integer 200-3000.
  - If invalid, log once or log on scheduling attempt and do not transmit.
- Ask `automation.nextTransmission(af)`.
  - If null, clear timer and render.
- Pre-arm before next eligible slot:
  - Compute `secondsUntilNextSlot(tx.intent.slot)`.
  - Send around 2 seconds before slot start.
  - If already inside the pre-arm window, send immediately.
  - Example:
    ```ts
    const seconds = secondsUntilNextSlot(tx.intent.slot);
    const delayMs = Math.max(0, (seconds - 2) * 1000);
    ```
- Store `pendingAutomationTx = tx` only when the command is sent to the daemon.
- When a relevant decode advances the QSO:
  - Clear the existing timer.
  - If there is a pending automated TX for that same QSO, replace it by sending a new `transmit` intent for the advanced step.
  - If daemon state is already `active`, do not try to replace mid-transmission; wait for the next decode/slot.
- Top eligible row wins:
  - `automation.nextTransmission(af)` should search `automation.qsos` order.
  - A QSO is eligible only if `status === "active"` and `messageForQso(qso)` is non-null.
- Reordering rows changes priority immediately and calls `scheduleAutomation()`.

Pseudo-code:

```ts
function scheduleAutomation(): void {
  clearAutomationTimer();
  renderQsoList();
  updateAfWarning();

  if (manualOverridePending || latestTxState === "active") {
    return;
  }

  const af = currentAfOrNull();
  if (af === null) {
    return;
  }

  const tx = automation.nextTransmission(af);
  if (!tx) {
    return;
  }

  const seconds = secondsUntilNextSlot(tx.intent.slot);
  const delayMs = Math.max(0, (seconds - 2) * 1000);
  automationTimer = setTimeout(() => sendAutomatedTx(tx), delayMs);
}

function sendAutomatedTx(tx: AutomationTx): void {
  const af = currentAfOrNull();
  if (af === null) {
    appendLog("automation paused: invalid AF");
    return;
  }

  const refreshed: AutomationTx = {
    ...tx,
    intent: { ...tx.intent, af }
  };

  pendingAutomationTx = refreshed;
  send({ type: "transmit", ...refreshed.intent });
  renderQsoList();
}
```

Important subtlety:

- `nextTransmission` may call `messageForQso`, and `messageForQso` may update `sentReport`. If that is undesirable, make `messageForQso` pure and set `sentReport` elsewhere. Prefer purity if you have time.

#### WebSocket Event Handling

In `handleMessage`:

`status`:

- Update `myCall` and `myGrid` as today.
- Track `latestTxState` from `msg.tx.state`.
- If TX becomes idle and no manual override is pending, call `scheduleAutomation()`.

`decode`:

- Push record into `decodes` and render the decode list as today.
- Call:
  ```ts
  const events = automation.handleDecode(record, myCall, myGrid);
  handleQsoEvents(events);
  ```
- If events advanced the QSO, call `scheduleAutomation()`.
- Do not overwrite AF.

`tx`:

- Log `[tx] af=... message`.
- If `manualOverridePending` is true:
  - Clear `manualOverridePending`.
  - Do not count the transmission as an automation attempt.
  - Clear `pendingAutomationTx` if it somehow matches.
  - Call `scheduleAutomation()`.
- Else:
  - Call `automation.confirmTransmission(pendingAutomationTx, { ts, af, message })`.
  - Clear `pendingAutomationTx` if matched.
  - Handle returned events, including logging completed QSOs.
  - Call `scheduleAutomation()`.

`tx_update`:

- Track `latestTxState`.
- Keep existing logging.
- If state returns to `idle`, call `scheduleAutomation()` unless manual override is pending.

`error`:

- Keep existing logging.
- If error is for a pending automated TX, clear `pendingAutomationTx` and call `scheduleAutomation()` after a small delay or leave the row active. Do not mark an attempt.

#### QSO Event Handling

Implement:

```ts
function handleQsoEvents(events: QsoAutomationEvent[]): void {
  for (const event of events) {
    switch (event.type) {
      case "qso_created":
        appendLog(`[qso] created ${event.qso.theirCall ?? "CQ"}`);
        break;
      case "qso_updated":
        appendLog(`[qso] ${event.qso.theirCall} ${event.previousStep} -> ${event.qso.step}`);
        break;
      case "qso_completed":
        appendLog(`[qso] complete ${event.qso.theirCall ?? "CQ"} (${event.reason})`);
        void logCompletedQso(event.qso, event.reason);
        break;
      case "qso_timed_out":
        appendLog(`[qso] timed out ${event.qso.theirCall ?? "CQ"} step=${event.qso.step}`);
        break;
      case "cq_stopped":
        appendLog("[qso] CQ stopped after reply");
        break;
    }
  }
  renderQsoList();
}
```

`logCompletedQso`:

```ts
async function logCompletedQso(qso: QsoRecord, reason: string): Promise<void> {
  const entry = automation.toLogEntry(qso, reason);
  if (!entry) {
    return;
  }
  try {
    await appendQsoLog(entry);
  } catch (error) {
    appendLog(`[qso-log error] ${error instanceof Error ? error.message : String(error)}`);
  }
}
```

## Edge Cases

- Missing `myCall` or `myGrid`:
  - Let controls use placeholders only for draft display.
  - For automation, prefer refusing to start with a clear log message:
    - `automation requires configured callsign and grid`
- Duplicate QSOs:
  - If a standard QSO with the same `theirCall` is already active/paused/timed out/stopped, do not create another automatically.
  - Selecting a CQ and pressing `Reply QSO` may either reuse the existing row or log `QSO already exists`.
- Incoming report before first outgoing grid:
  - For someone replying to our CQ with a report/grid, allow creation of a standard QSO and send the correct next message.
- Pending replacement:
  - If a pending automated `CQ` exists and someone replies before it transmits, stop the CQ row and replace the pending message with the QSO response if TX is not active.
- Completed QSOs:
  - Write JSONL once per completion event.
  - Avoid duplicate log writes by either marking a private logged set in `ui/tui.ts`:
    ```ts
    const loggedQsoIds = new Set<string>();
    ```
  - Or remove completed rows after logging.

## Implementation Order

1. Add `ui/qso.ts`.
2. Add `ui/qso-log.ts`.
3. Add `test/ui-qso.test.ts` and get parser/state/logging tests passing.
4. Modify `ui/tui.ts` layout to add Active QSOs list.
5. Wire `Call CQ` and `Reply QSO`.
6. Wire QSO list selection and row rendering.
7. Wire scheduler timers.
8. Wire WebSocket `decode`, `tx`, `tx_update`, `status`, and `error` interactions.
9. Add operator controls: Resume, Complete, Abandon, Retry, Previous, Next, Up, Down.
10. Add occupied AF warning.
11. Run tests and type checks.

## Verification Commands

Run:

```sh
npm test
npm run build
```

Important note: because `tsconfig.json` currently includes only `src/**/*.ts`, `npm run build` may not type-check `ui/*.ts`. Either:

- leave build scope unchanged and rely on Vitest coverage for `ui/qso.ts`, or
- intentionally update `tsconfig.json` to include `ui/**/*.ts` if the project wants UI TypeScript included in build validation.

If including `ui/**/*.ts`, expect to fix blessed type issues in `ui/tui.ts`; do that only if the extra type-checking scope is desired.

## Existing Partial Work To Check

Before implementing from this plan in a fresh context, run:

```sh
git status --short
rg --files
```

If these files already exist, inspect them before editing:

- `ui/qso.ts`
- `ui/qso-log.ts`
- `test/ui-qso.test.ts`
- `docs/ui-owned-ft8-qso-automation-implementation-plan.md`

There may be untracked partial work from an earlier interrupted attempt. Do not overwrite it blindly; read it, keep useful pieces, and correct any compatibility issues.

One known compatibility issue from the partial attempt:

- Avoid `Array.prototype.findLast` and `Array.prototype.findLastIndex` unless the TypeScript lib target is updated.
- Use small local helpers instead:

```ts
function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index]!)) {
      return index;
    }
  }
  return -1;
}

function findLast<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  const index = findLastIndex(items, predicate);
  return index === -1 ? undefined : items[index];
}
```

## Acceptance Criteria

- The daemon protocol is unchanged.
- Automation never claims control.
- Manual transmit remains available and acts as a one-shot override.
- Cancel pauses automation and keeps QSO rows.
- Active QSOs list supports creation, selection, reorder, resume, complete, abandon, retry, previous step, and next step.
- Top eligible row wins the next automated TX.
- Automated TX uses the current AF field at send time.
- Occupied AF warning uses the last 2 matching TX-slot parity decode groups and warns within 50 Hz.
- Attempts are counted only from daemon `tx` events.
- Timeout happens after 5 confirmed transmissions of the same step.
- Completed QSOs append JSONL to `data/qso-log.jsonl`, creating `data/` if needed.
- Parser, sequence, scheduler, and logging tests pass.
- `npm test` passes.
- `npm run build` passes, or any build-scope limitation is explicitly documented.
