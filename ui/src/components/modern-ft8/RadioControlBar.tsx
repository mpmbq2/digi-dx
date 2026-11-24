import { useEffect, useRef, useState } from "preact/hooks";
import type { RadioSummary, SessionSnapshot } from "../../types";
import type { DigitalMode } from "./types";
import { SUBBAND_PRESETS, fmtDialMhz, normalizeCall } from "./utils";

interface Props {
  radio: RadioSummary | null;
  stationCall: string | null;
  stationGrid: string | null;
  activeSession: SessionSnapshot | null;
  otherRadioSession: SessionSnapshot | null;
  digitalMode: DigitalMode;
  pendingDialFreqHz: number | null;
  txState: "idle" | "armed" | "transmitting";
  isTuning: boolean;
  feedOnLeft: boolean;
  onToggleFlipFeed: () => void;
  onSelectBand: (band: string) => void;
  onSelectMode: (mode: DigitalMode) => void;
  onSetRfPower: (level0to1: number) => Promise<void>;
  onToggleTxEnabled: () => void;
  onHaltTx: () => void;
  onToggleTune: () => void;
  onStartLive: () => void;
  onStartDemo: (scale: number) => void;
  onStopSession: () => void;
  onCallCq: () => void;
  onStopCq: () => void;
}

const POWER_PRESETS = [10, 25, 50, 100] as const;

export function RadioControlBar({
  radio,
  stationCall,
  stationGrid,
  activeSession,
  otherRadioSession,
  digitalMode,
  pendingDialFreqHz,
  txState,
  isTuning,
  feedOnLeft,
  onToggleFlipFeed,
  onSelectBand,
  onSelectMode,
  onSetRfPower,
  onToggleTxEnabled,
  onHaltTx,
  onToggleTune,
  onStartLive,
  onStartDemo,
  onStopSession,
  onCallCq,
  onStopCq,
}: Props) {
  const [demoMenuOpen, setDemoMenuOpen] = useState(false);
  const [demoScale, setDemoScale] = useState("1");

  const backendPower = radio?.settings?.levels?.RFPOWER;
  const rfPowerWatts = radio?.settings?.rf_power_watts ?? null;
  const supportsPower = Boolean(
    radio && (radio.capabilities?.set_levels?.includes("RFPOWER") ?? true)
  );

  const [localPowerPct, setLocalPowerPct] = useState<number>(() =>
    typeof backendPower === "number"
      ? Math.max(5, Math.min(100, Math.round(backendPower * 100)))
      : 50
  );

  const draggingRef = useRef(false);
  const committedOnPointerUpRef = useRef(false);
  const latestPctRef = useRef(localPowerPct);
  const debounceTimerRef = useRef<number | null>(null);
  const globalUpCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (
      typeof backendPower === "number" &&
      !draggingRef.current &&
      debounceTimerRef.current === null
    ) {
      const pct = Math.max(5, Math.min(100, Math.round(backendPower * 100)));
      setLocalPowerPct(pct);
      latestPctRef.current = pct;
    }
  }, [backendPower]);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
      }
      if (globalUpCleanupRef.current) {
        globalUpCleanupRef.current();
      }
    };
  }, []);

  const commitPower = (pct: number) => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    const clamped = Math.max(5, Math.min(100, Math.round(pct)));
    void onSetRfPower(Number((clamped / 100).toFixed(2)));
  };

  const scheduleDebouncedPower = (pct: number) => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null;
      commitPower(pct);
    }, 300);
  };

  const handleSliderPointerDown = () => {
    draggingRef.current = true;
    committedOnPointerUpRef.current = false;
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (globalUpCleanupRef.current) {
      globalUpCleanupRef.current();
      globalUpCleanupRef.current = null;
    }
    const onGlobalUp = () => {
      globalUpCleanupRef.current = null;
      if (!draggingRef.current) return;
      draggingRef.current = false;
      committedOnPointerUpRef.current = true;
      commitPower(latestPctRef.current);
    };
    window.addEventListener("pointerup", onGlobalUp, { once: true });
    window.addEventListener("pointercancel", onGlobalUp, { once: true });
    globalUpCleanupRef.current = () => {
      window.removeEventListener("pointerup", onGlobalUp);
      window.removeEventListener("pointercancel", onGlobalUp);
    };
  };

  const canControlCat = Boolean(
    radio &&
      (radio.lifecycle_state === "READY" ||
        radio.lifecycle_state === "ACTIVE_SESSION")
  );
  const canQsy = Boolean(
    canControlCat && !radio?.ptt && txState !== "transmitting" && !isTuning
  );

  const effectiveCall = activeSession?.my_call || stationCall || "";
  const effectiveGrid = (activeSession?.my_grid || stationGrid || "").slice(0, 4);
  const stationBadge = effectiveCall
    ? `${normalizeCall(effectiveCall)}${effectiveGrid ? ` · ${effectiveGrid}` : ""}`
    : "UNCONFIGURED";

  const statusDotClass = !radio
    ? "err"
    : canControlCat
    ? "ready"
    : radio.lifecycle_state === "DEGRADED" || radio.lifecycle_state === "DISCONNECTED"
    ? "err"
    : "warn";

  const txEnabled = Boolean(activeSession?.tx_enabled);

  return (
    <div class="mft8-telem-row" data-testid="mft8-radio-bar">
      <div class="mft8-telem-group">
        <span class="mft8-rig-pill" data-testid="mft8-station-badge">
          <span class={`mft8-status-dot ${statusDotClass}`} />
          <span>{stationBadge}</span>
          <span style={{ color: "#64748b" }}>·</span>
          <span style={{ color: canControlCat ? "#6ee7b7" : "#fcd34d" }}>
            {radio ? radio.lifecycle_state : "NO RADIO"}
          </span>
        </span>

        <select
          class="mft8-dark-select mft8-mono"
          data-testid="mft8-band-select"
          aria-label="Band Switcher"
          disabled={!canQsy}
          value={radio?.band ?? ""}
          onChange={(e) => {
            const b = (e.currentTarget as HTMLSelectElement).value;
            if (b) onSelectBand(b);
          }}
        >
          <option value="">{radio?.band ?? "Band"}</option>
          {SUBBAND_PRESETS.map((p) => (
            <option key={p.band} value={p.band}>
              {p.band}
            </option>
          ))}
        </select>

        <div
          class="mft8-mode-switch"
          role="group"
          aria-label="Digital Mode"
        >
          <button
            type="button"
            data-testid="mft8-mode-ft8"
            class={`mft8-mode-btn ${digitalMode === "FT8" ? "active" : ""}`}
            onClick={() => onSelectMode("FT8")}
          >
            FT8 15s
          </button>
          <button
            type="button"
            data-testid="mft8-mode-ft4"
            class={`mft8-mode-btn ${digitalMode === "FT4" ? "active" : ""}`}
            onClick={() => onSelectMode("FT4")}
          >
            FT4 7.5s
          </button>
        </div>

        <span
          class={`mft8-rig-pill dial ${pendingDialFreqHz !== null ? "syncing" : ""}`}
          data-testid="mft8-dial-freq"
        >
          {radio?.band ? `${radio.band} · ` : ""}
          {fmtDialMhz(radio?.freq_hz)}
          {pendingDialFreqHz !== null && (
            <span
              data-testid="mft8-freq-syncing"
              style={{ color: "#38bdf8", marginLeft: "4px" }}
            >
              ↻ SYNC
            </span>
          )}
        </span>

        <div class="mft8-pwr-box" title="RF TX Power (emits CAT command on release)">
          <span class="mft8-mono" style={{ fontSize: "9.5px", color: "#94a3b8" }}>
            PWR
          </span>
          <input
            type="range"
            min={5}
            max={100}
            step={1}
            class="mft8-pwr-slider"
            data-testid="mft8-power-slider"
            aria-label="TX Power"
            disabled={!canControlCat || !supportsPower}
            value={localPowerPct}
            onPointerDown={handleSliderPointerDown}
            onInput={(e) => {
              const pct = Math.max(
                5,
                Math.min(100, Math.round(Number((e.currentTarget as HTMLInputElement).value)))
              );
              latestPctRef.current = pct;
              setLocalPowerPct(pct);
              if (!draggingRef.current) {
                scheduleDebouncedPower(pct);
              }
            }}
            onChange={() => {
              if (committedOnPointerUpRef.current) {
                committedOnPointerUpRef.current = false;
                return;
              }
              if (draggingRef.current) return;
              scheduleDebouncedPower(latestPctRef.current);
            }}
          />
          <span class="mft8-pwr-readout" data-testid="mft8-power-readout">
            {localPowerPct}%
            {rfPowerWatts !== null ? ` ${rfPowerWatts.toFixed(0)}W` : ""}
          </span>
          <div class="mft8-pwr-presets">
            {POWER_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                class={`mft8-pwr-preset-btn ${
                  Math.abs(localPowerPct - p) <= 2 ? "active" : ""
                }`}
                data-testid={`mft8-power-preset-${p}`}
                disabled={!canControlCat || !supportsPower}
                onClick={() => {
                  latestPctRef.current = p;
                  setLocalPowerPct(p);
                  commitPower(p);
                }}
              >
                {p}%
              </button>
            ))}
          </div>
        </div>
      </div>

      <div class="mft8-telem-group">
        <button
          type="button"
          data-testid="mft8-tx-toggle"
          class={`mft8-btn ${txEnabled ? "mft8-btn-tx-armed" : "mft8-btn-rx-only"}`}
          disabled={!activeSession}
          onClick={onToggleTxEnabled}
        >
          {txEnabled ? "● TX ARMED" : "○ ENABLE TX"}
        </button>

        <button
          type="button"
          data-testid="mft8-tune-btn"
          class={`mft8-btn mft8-btn-tune ${isTuning ? "active" : ""}`}
          disabled={!radio || (!canControlCat && !activeSession?.is_demo)}
          onClick={onToggleTune}
        >
          {isTuning ? "◉ TUNING" : "TUNE"}
        </button>

        <button
          type="button"
          data-testid="mft8-halt-tx"
          class="mft8-btn mft8-btn-halt"
          disabled={!radio}
          onClick={onHaltTx}
        >
          HALT TX
        </button>

        {!activeSession ? (
          <div style={{ position: "relative", display: "inline-flex", gap: "4px" }}>
            <button
              type="button"
              data-testid="mft8-start-live"
              class="mft8-btn mft8-btn-primary"
              disabled={
                !radio ||
                Boolean(otherRadioSession) ||
                radio.lifecycle_state !== "READY"
              }
              onClick={onStartLive}
            >
              ▶ Live
            </button>
            <button
              type="button"
              data-testid="mft8-demo-toggle"
              class="mft8-btn"
              disabled={!radio || Boolean(otherRadioSession)}
              onClick={() => setDemoMenuOpen((o) => !o)}
            >
              Demo ▾
            </button>
            {demoMenuOpen && (
              <div
                style={{
                  position: "absolute",
                  top: "100%",
                  right: 0,
                  marginTop: "4px",
                  zIndex: 20,
                  background: "#111827",
                  border: "1px solid #30415c",
                  borderRadius: "6px",
                  padding: "6px",
                  display: "flex",
                  gap: "5px",
                  alignItems: "center",
                  boxShadow: "0 8px 20px rgba(0,0,0,0.45)",
                }}
              >
                <select
                  class="mft8-dark-select"
                  data-testid="mft8-demo-scale"
                  value={demoScale}
                  onChange={(e) =>
                    setDemoScale((e.currentTarget as HTMLSelectElement).value)
                  }
                >
                  <option value="1">1x</option>
                  <option value="20">20x</option>
                </select>
                <button
                  type="button"
                  data-testid="mft8-start-demo"
                  class="mft8-btn mft8-btn-primary mft8-btn-xs"
                  onClick={() => {
                    setDemoMenuOpen(false);
                    onStartDemo(Number(demoScale));
                  }}
                >
                  Start Demo
                </button>
              </div>
            )}
          </div>
        ) : (
          <>
            <button
              type="button"
              data-testid="mft8-call-cq"
              class={`mft8-btn ${
                activeSession.cq ? "mft8-btn-cq-active" : "mft8-btn-primary"
              }`}
              title={activeSession.cq ? "Stop Calling CQ" : "Call CQ"}
              onClick={activeSession.cq ? onStopCq : onCallCq}
            >
              {activeSession.cq ? "◉ Calling CQ" : "CQ"}
            </button>
            <button
              type="button"
              data-testid="mft8-stop-session"
              class="mft8-btn"
              onClick={onStopSession}
            >
              Stop
            </button>
          </>
        )}

        <button
          type="button"
          data-testid="mft8-flip-feed"
          class="mft8-btn"
          title="Swap Live Batch Feed between Right and Left"
          onClick={onToggleFlipFeed}
        >
          {feedOnLeft ? "⇄ Feed: Left" : "⇄ Flip Feed"}
        </button>
      </div>
    </div>
  );
}
