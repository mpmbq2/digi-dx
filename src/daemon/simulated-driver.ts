import { EventEmitter } from "node:events";
import { FT8_SLOT_MS, SlotClock, maxUsableScale } from "../../core/slot-clock.js";
import type { AudioDevice } from "./audio-devices.js";
import type { SessionConfig } from "./config.js";
import type { EngineDriver, EngineDriverEvents } from "./engine-driver.js";
import type { EngineKind, SlotClockSpec, TxIntent } from "./protocol.js";
import { SimStation, defaultRoster, type SimRoster } from "./sim-station.js";

// A simulated FT8 band behind the engine seam. It opens no audio device, spawns
// no process, and connects to no CAT -- so it runs anywhere, including a
// container with no radio, and it is the only thing a cloud agent can exercise.
//
// It doubles as the product's demo mode: a new user runs it with no radio wired
// and finds out whether the software works before they start fighting audio
// device ids and CAT ports.

// The fraction of a slot an FT8 transmission actually occupies (12.64s of 15s).
const TX_DUTY = 12.64 / 15;

const SIM_DEVICE: AudioDevice = {
  id: 99,
  name: "Simulated Rig",
  inputs: 2,
  outputs: 2,
  defaultSampleRate: 48000
};

export interface SimulatedDriverOptions {
  // Virtual milliseconds per wall millisecond. 1 is real time, which is what a
  // user gets: a sped-up band strobes and looks nothing like a real one. Only
  // the verification commands raise it.
  scale?: number;
  seed?: number;
  slotMs?: number;
  dialFreqHz?: number;
  roster?: SimRoster;
}

export function resolveSimOptions(env: NodeJS.ProcessEnv = process.env): SimulatedDriverOptions {
  const scale = Number(env.DIGI_DX_SIM_SCALE ?? 1);
  const seed = Number(env.DIGI_DX_SIM_SEED ?? 1);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`DIGI_DX_SIM_SCALE must be a positive number, got ${env.DIGI_DX_SIM_SCALE}`);
  }
  if (scale > maxUsableScale()) {
    throw new Error(
      `DIGI_DX_SIM_SCALE ${scale} exceeds the maximum usable scale ${Math.floor(maxUsableScale())}`
    );
  }
  return { scale, seed: Number.isFinite(seed) ? seed : 1 };
}

export class SimulatedDriver extends EventEmitter<EngineDriverEvents> implements EngineDriver {
  readonly kind: EngineKind = "simulated";

  private readonly scale: number;
  private readonly seed: number;
  private readonly slotMs: number;
  private readonly dialFreqHz: number;
  private readonly rosterOverride: SimRoster | null;

  private spec: SlotClockSpec;
  private stations: SimStation[] = [];
  private operatorCall = "";
  private slotTimer: NodeJS.Timeout | null = null;
  private pttTimer: NodeJS.Timeout | null = null;
  private pending: TxIntent | null = null;
  private running = false;

  constructor(options: SimulatedDriverOptions = {}) {
    super();
    this.scale = options.scale ?? 1;
    this.seed = options.seed ?? 1;
    this.slotMs = options.slotMs ?? FT8_SLOT_MS;
    this.dialFreqHz = options.dialFreqHz ?? 14_074_000;
    this.rosterOverride = options.roster ?? null;
    this.spec = this.anchorSpec();
  }

  clock(): SlotClockSpec {
    return this.spec;
  }

  async start(session: SessionConfig): Promise<void> {
    if (this.running) {
      return;
    }

    // Re-anchor: virtual time starts now, not whenever the process happened to
    // boot. Engine re-reads the clock after start for exactly this reason.
    this.spec = this.anchorSpec();
    this.operatorCall = session.callsign.toUpperCase();

    const roster =
      this.rosterOverride ?? defaultRoster(this.operatorCall, session.grid.toUpperCase(), this.seed);
    this.stations = roster.stations.map((spec) => new SimStation(spec));

    this.running = true;
    this.emit("freq", this.dialFreqHz);
    this.scheduleNextSlot();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.clearTimers();
    this.stations = [];
    this.pending = null;
    this.emit("ptt", false);
  }

  async transmit(intent: TxIntent): Promise<void> {
    // Queued, not sent: a real transmission only goes out when its slot opens.
    this.pending = intent;
  }

  async cancelTransmit(): Promise<void> {
    this.pending = null;
    if (this.pttTimer) {
      clearTimeout(this.pttTimer);
      this.pttTimer = null;
    }
    this.emit("ptt", false);
  }

  async listAudioDevices(): Promise<AudioDevice[]> {
    return [SIM_DEVICE];
  }

  // --- internals -----------------------------------------------------------

  private anchorSpec(): SlotClockSpec {
    const wallNow = Date.now();
    // Anchor virtual time on a slot boundary, so the band starts on a clean
    // cycle rather than mid-slot.
    const epochMs = Math.floor(wallNow / this.slotMs) * this.slotMs;
    return { epochMs, anchorWallMs: wallNow, slotMs: this.slotMs, scale: this.scale };
  }

  private slotClock(): SlotClock {
    return new SlotClock(this.spec);
  }

  // Deliberately not core/qso.ts's slotFromTimestamp: the simulator shares no
  // sequencing code with the client it is used to verify.
  private parityOf(slotStartSec: number): "even" | "odd" {
    const slotSeconds = this.slotMs / 1000;
    return Math.floor(slotStartSec / slotSeconds) % 2 === 0 ? "even" : "odd";
  }

  private scheduleNextSlot(): void {
    if (!this.running) {
      return;
    }
    const clock = this.slotClock();
    const slotSeconds = this.slotMs / 1000;
    const nowVirtualMs = clock.now();
    const nowSec = Math.floor(nowVirtualMs / 1000);
    const nextStartSec = (Math.floor(nowSec / slotSeconds) + 1) * slotSeconds;
    const wallMs = Math.max(1, clock.toWallMs(nextStartSec * 1000 - nowVirtualMs));
    this.slotTimer = setTimeout(() => this.runSlot(nextStartSec), wallMs);
  }

  private runSlot(slotStartSec: number): void {
    if (!this.running) {
      return;
    }
    const parity = this.parityOf(slotStartSec);

    // Our transmission, if this is its slot. It goes on the air, and the band
    // hears it -- which is what moves the simulated stations along.
    if (this.pending && this.pending.slot === parity) {
      const intent = this.pending;
      this.pending = null;

      this.emit("ptt", true);
      this.emit("tx", {
        ts: slotStartSec,
        af: intent.af,
        mode: "FT8",
        message: intent.message.toUpperCase()
      });

      for (const station of this.stations) {
        station.hear(intent.message, this.operatorCall);
      }

      const txWallMs = this.slotClock().toWallMs(this.slotMs * TX_DUTY);
      this.pttTimer = setTimeout(() => {
        this.pttTimer = null;
        this.emit("ptt", false);
      }, Math.max(1, txWallMs));
    }

    // Everything the band puts on the air in this slot.
    for (const station of this.stations) {
      if (station.slot !== parity || station.finished) {
        continue;
      }
      const message = station.transmit(this.operatorCall);
      if (!message) {
        continue;
      }
      this.emit("decode", {
        ts: slotStartSec,
        snr: station.snr,
        dt: 0.2,
        af: station.af,
        mode: "FT8",
        message
      });
    }

    this.scheduleNextSlot();
  }

  private clearTimers(): void {
    if (this.slotTimer) {
      clearTimeout(this.slotTimer);
      this.slotTimer = null;
    }
    if (this.pttTimer) {
      clearTimeout(this.pttTimer);
      this.pttTimer = null;
    }
  }
}
