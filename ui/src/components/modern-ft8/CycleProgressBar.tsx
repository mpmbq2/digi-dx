import { useEffect, useState } from "preact/hooks";
import type { ActiveQso, SessionSnapshot, SlotClockSpec } from "../../types";
import type { DigitalMode, QsoIdentity } from "./types";
import { formatQsoNextTx } from "./utils";

interface Props {
  slotClock: SlotClockSpec | null;
  digitalMode: DigitalMode;
  activeSession: SessionSnapshot | null;
  txState: "idle" | "armed" | "transmitting";
  liveTxMessage: string | null;
  isTuning: boolean;
  txHz: number;
  armedQso: ActiveQso | null;
  armedIdentity: QsoIdentity | null;
}

export function CycleProgressBar({
  slotClock,
  digitalMode,
  activeSession,
  txState,
  liveTxMessage,
  isTuning,
  txHz,
  armedQso,
  armedIdentity,
}: Props) {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 100);
    return () => window.clearInterval(id);
  }, []);

  const spec = activeSession?.slot_clock ?? slotClock;
  const virtualMs = spec
    ? spec.epoch_ms + Math.round((nowMs - spec.anchor_wall_ms) * spec.scale)
    : nowMs;
  const slotMs = spec?.slot_ms ?? (digitalMode === "FT4" ? 7500 : 15000);
  const intoSlotMs = ((virtualMs % slotMs) + slotMs) % slotMs;
  const remainingSec = Math.max(0, (slotMs - intoSlotMs) / 1000);
  const progressPct = Math.min(100, Math.max(0, (intoSlotMs / slotMs) * 100));
  const isEven = Math.floor(virtualMs / slotMs) % 2 === 0;
  const utcStr = new Date(virtualMs).toISOString().slice(11, 19);

  const isTxPhase = isTuning || txState === "transmitting";
  const phaseLabel = isTuning ? "TUNE" : isTxPhase ? "TX" : "RX";

  let previewText = "IDLE — Click Call on any station to queue TX";
  if (isTuning) {
    previewText = "TUNE CARRIER ACTIVE";
  } else if (txState === "transmitting" && liveTxMessage) {
    previewText = `TX: ${liveTxMessage}`;
  } else if (armedQso) {
    const prefix = activeSession?.tx_enabled ? "TX: " : "QUEUED: ";
    previewText = `${prefix}${formatQsoNextTx(armedQso)}`;
  }

  return (
    <div class="mft8-telem-row">
      <div class="mft8-cycle-timer-box" data-testid="mft8-cycle-timer">
        <div class="mft8-cycle-timer-label">
          <span data-testid="mft8-utc">{utcStr}</span>
          <span
            data-testid="mft8-slot-parity"
            class={`mft8-slot-badge ${isEven ? "mft8-slot-even" : "mft8-slot-odd"}`}
          >
            {isEven ? "EVEN" : "ODD"}
          </span>
          <span
            data-testid="mft8-phase"
            style={{ color: isTxPhase ? "#fca5a5" : "#6ee7b7" }}
          >
            {phaseLabel}
          </span>
          <span data-testid="mft8-countdown" style={{ color: "#fff" }}>
            {remainingSec.toFixed(1)}s
          </span>
        </div>
        <div class="mft8-cycle-bar-track">
          <div
            class={`mft8-cycle-bar-fill ${isTxPhase ? "tx-mode" : ""}`}
            style={{ width: `${progressPct.toFixed(1)}%` }}
          />
        </div>
      </div>

      <div
        class={`mft8-tx-preview-box ${
          isTxPhase || (activeSession?.tx_enabled && armedQso) ? "armed" : ""
        }`}
        data-testid="mft8-tx-preview"
      >
        {armedIdentity && (
          <span
            class="mft8-q-pill"
            style={{ background: armedIdentity.color }}
          >
            {armedIdentity.badge}
          </span>
        )}
        <span class="mft8-tx-preview-msg">{previewText}</span>
        <span class="mft8-tx-preview-hz">{txHz} Hz</span>
      </div>
    </div>
  );
}
