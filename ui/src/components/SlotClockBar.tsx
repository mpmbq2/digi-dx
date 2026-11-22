import { useEffect, useState } from "preact/hooks";
import type { SlotClockSpec } from "../types";

interface Props {
  spec: SlotClockSpec | null;
}

export function SlotClockBar({ spec }: Props) {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 100);
    return () => window.clearInterval(id);
  }, []);

  const virtualMs = spec
    ? spec.epoch_ms + Math.round((nowMs - spec.anchor_wall_ms) * spec.scale)
    : nowMs;
  const slotMs = spec?.slot_ms ?? 15000;
  const intoSlotMs = ((virtualMs % slotMs) + slotMs) % slotMs;
  const remainingSec = Math.max(0, (slotMs - intoSlotMs) / 1000);
  const progressPct = Math.min(100, Math.max(0, (intoSlotMs / slotMs) * 100));

  const unixSecs = Math.floor(virtualMs / 1000);
  const isEven = Math.floor(unixSecs / 15) % 2 === 0;
  const utcStr = new Date(virtualMs).toISOString().slice(11, 19);

  return (
    <section class="slot-clock-bar" aria-label="Authoritative UTC Slot Clock">
      <div class="slot-clock-meta">
        <span class={`slot-pill ${isEven ? "slot-even" : "slot-odd"}`}>
          {isEven ? "EVEN SLOT" : "ODD SLOT"}
        </span>
        <span class="mono utc-readout">{utcStr} UTC</span>
        <span class="slot-countdown mono" data-testid="slot-countdown">
          Next slot in {remainingSec.toFixed(1)}s
        </span>
        <span class="muted">
          {spec ? `Daemon anchor (scale ${spec.scale}x)` : "Syncing daemon clock..."}
        </span>
      </div>
      <div class="slot-progress-track">
        <div
          class={`slot-progress-fill ${isEven ? "fill-even" : "fill-odd"}`}
          style={{ width: `${progressPct.toFixed(1)}%` }}
        />
      </div>
    </section>
  );
}
