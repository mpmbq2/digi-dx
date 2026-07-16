// Message contract between the web server (ui/web/server.ts) and the browser
// front-end (ui/web/public/app.js). The server owns all automation state and
// pushes a StateMessage view-model; the browser sends CommandMessages. Keep
// these types in sync with the runtime shapes app.js reads/writes.

import type { TxSlot } from "../../core/qso.js";
import type { TxPublicState } from "../../core/protocol.js";
// The decode/QSO/cycle view shapes moved to core/view-model.ts (rebuild plan W2)
// so the view-model depends only on core. Re-exported here so the browser bridge
// and app.js keep importing them from the web protocol module.
import type {
  ActiveQsoView,
  CompletedQsoView,
  CycleView,
  DecodeView,
  NowView,
  RosterEntryView
} from "../../core/view-model.js";
export type {
  ActiveQsoView,
  CompletedQsoView,
  CycleView,
  DecodeKind,
  DecodeView,
  NowView,
  RosterEntryView
} from "../../core/view-model.js";

// Aliased from the daemon contract so the browser view shares core's TX state.
export type TxState = TxPublicState;

export interface StationView {
  call: string;
  grid: string;
  dialFreqHz: number | null;
  catConnected: boolean;
  sessionActive: boolean;
  controlHeld: boolean;
  controlMine: boolean;
  // True when the simulated engine is running. Every client labels this
  // unmistakably: a ham who believes they worked a station they did not would
  // log it, and a fabricated contact uploaded to LoTW is not recoverable.
  demo: boolean;
}

export interface SetupDeviceView {
  id: number;
  name: string;
  defaultSampleRate: number | null;
}

export interface SetupView {
  complete: boolean;
  missing: string[];
  devices: SetupDeviceView[];
}

export interface LogLineView {
  level: "info" | "warn" | "error" | "tx" | "qso";
  text: string;
}

export interface StateMessage {
  type: "state";
  // Wall time on the server, so the browser can correct for its own clock being
  // off. This is not virtual time -- the skew correction lives in the wall
  // domain, which is what makes it valid at any scale.
  serverNow: number;
  cycle: CycleView;
  station: StationView;
  setup: SetupView;
  now: NowView;
  af: { value: number; slot: TxSlot };
  qsos: {
    callingCq: boolean;
    active: ActiveQsoView[];
    completed: CompletedQsoView[];
  };
  decodes: DecodeView[];
  rosters: { even: RosterEntryView[]; odd: RosterEntryView[] };
  occupancy: { even: number[]; odd: number[] };
  log: LogLineView[];
}

export type QsoAction =
  | "complete"
  | "abandon"
  | "resume"
  | "retry"
  | "prevStep"
  | "nextStep"
  | "moveUp"
  | "moveDown";

export type CommandMessage =
  | { type: "command"; cmd: "setIdentity"; call: string; grid: string }
  | { type: "command"; cmd: "setDialFreq"; mhz: number | null }
  | { type: "command"; cmd: "callCq"; slot?: TxSlot; myCall?: string; myGrid?: string }
  | { type: "command"; cmd: "replyToCall"; call: string; myCall?: string; myGrid?: string }
  | { type: "command"; cmd: "qso"; id: string; action: QsoAction }
  | { type: "command"; cmd: "setAf"; af: number }
  | { type: "command"; cmd: "setSlot"; slot: TxSlot }
  | { type: "command"; cmd: "survey" }
  | { type: "command"; cmd: "txEnable"; enabled: boolean }
  | { type: "command"; cmd: "haltTx" }
  | { type: "command"; cmd: "session"; action: "start" | "stop" }
  // Start on the simulated engine, with no station config. Reachable from the
  // first-run setup surface, so a radio-less user finds it by discovery rather
  // than by typing a flag they would never know about.
  | { type: "command"; cmd: "startDemo" }
  | { type: "command"; cmd: "saveSetup"; callsign: string; grid: string; deviceId: number; catMode: "rigctld" | "dummy"; catPort: number }
  | { type: "command"; cmd: "releaseControl" };
