// Message contract between the web server (ui/web/server.ts) and the browser
// front-end (ui/web/public/app.js). The server owns all automation state and
// pushes a StateMessage view-model; the browser sends CommandMessages. Keep
// these types in sync with the runtime shapes app.js reads/writes.

import type { QsoStep, TxSlot } from "../../core/qso.js";
import type { TxPublicState } from "../../core/protocol.js";

// Aliased from the daemon contract so the browser view shares core's TX state.
export type TxState = TxPublicState;

// How a decoded/heard station is coloured in the band panel and rosters.
//  - "reply"  : the message mentions our callsign (someone answering us)
//  - "qso"    : the sender matches an active standard QSO (carries its colour)
//  - "worked" : the sender is already in the QSO log
//  - "normal" : everything else
export type DecodeKind = "reply" | "qso" | "worked" | "normal";

export interface StationView {
  call: string;
  grid: string;
  dialFreqHz: number | null;
  catConnected: boolean;
  sessionActive: boolean;
  controlHeld: boolean;
  controlMine: boolean;
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

export interface NowView {
  txState: TxState;
  txEnabled: boolean;
  af: number | null;
  slot: TxSlot | null;
  message: string | null;
  surveyActive: boolean;
  surveySlot: TxSlot | null;
  surveyEndSec: number;
}

export interface DecodeView {
  ts: number;
  snr: number;
  af: number;
  message: string;
  from: string | null;
  grid: string | null;
  kind: DecodeKind;
  color?: string;
}

export interface RosterEntryView {
  call: string;
  grid: string | null;
  snr: number;
  ageSec: number;
  af: number;
  kind: DecodeKind;
  color?: string;
}

export interface ActiveQsoView {
  id: string;
  call: string | null;
  grid: string | null;
  priority: number;
  kind: "hunted" | "caller";
  stepKey: QsoStep;
  status: string;
  attempts: number;
  slot: TxSlot;
  heardAgoSec: number | null;
  lastRx: string | null;
  nextTx: string | null;
  txing: boolean;
  note: string | null;
  color: string;
}

export interface CompletedQsoView {
  id: string;
  call: string | null;
  grid: string | null;
  sentReport: string | null;
  receivedReport: string | null;
  slot: TxSlot | null;
  time: string;
}

export interface LogLineView {
  level: "info" | "warn" | "error" | "tx" | "qso";
  text: string;
}

export interface StateMessage {
  type: "state";
  serverNow: number;
  cycle: { parity: TxSlot };
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
  | { type: "command"; cmd: "saveSetup"; callsign: string; grid: string; deviceId: number; catMode: "rigctld" | "dummy"; catPort: number }
  | { type: "command"; cmd: "releaseControl" };
