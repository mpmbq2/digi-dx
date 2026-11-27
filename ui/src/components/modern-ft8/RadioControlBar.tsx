import { useEffect, useRef, useState } from "preact/hooks";
import type { DecoderOption, RadioSummary, SessionSnapshot } from "../../types";
import type { DigitalMode } from "./types";
import { SUBBAND_PRESETS, fmtDialMhz, normalizeCall } from "./utils";

interface Props {
  radio: RadioSummary | null;
  stationCall: string | null;
  stationGrid: string | null;
  activeSession: SessionSnapshot | null;
  otherRadioSession: SessionSnapshot | null;
  digitalMode: DigitalMode;
  activeDecoder: string;
  availableDecoders: DecoderOption[];
  pendingDialFreqHz: number | null;
  txState: "idle" | "armed" | "transmitting";
  isTuning: boolean;
  isAtuTuning: boolean;
  feedOnLeft: boolean;
  onToggleFlipFeed: () => void;
  onSelectBand: (band: string) => void;
  onSelectMode: (mode: DigitalMode) => void;
  onSelectDecoder: (decoderBackend: string) => void;
  onSetRfPower: (level0to1: number) => Promise<void>;
  onSetRfGain: (level0to1: number) => Promise<void>;
  onToggleTxEnabled: () => void;
  onHaltTx: () => void;
  onToggleTune: () => void;
  onAtuTune: () => void;
  onToggleAtuBypass: (enabled: boolean) => void;
  onStartLive: () => void;
  onStartDemo: (scale: number) => void;
  onStopSession: () => void;
  onCallCq: () => void;
  onStopCq: () => void;
}

const POWER_PRESETS = [10, 25, 50, 100] as const;

function strengthToSUnits(db: number | null | undefined): {
  shortLabel: string;
  fullLabel: string;
  pct: number;
} {
  if (db === null || db === undefined) {
    return { shortLabel: "—", fullLabel: "—", pct: 0 };
  }
  // Hamlib STRENGTH: 0 dB = S9, -6 dB per S-unit down to -54 (S0)
  if (db <= 0) {
    const s = Math.max(0, Math.min(9, Math.round(9 + db / 6)));
    return {
      shortLabel: `S${s}`,
      fullLabel: `S${s} (${db} dB)`,
      pct: Math.max(4, Math.min(65, ((db + 54) / 54) * 65)),
    };
  }
  const over = Math.min(60, db);
  return {
    shortLabel: `S9+${over}`,
    fullLabel: `S9+${over} (+${db} dB)`,
    pct: 65 + (over / 60) * 35,
  };
}

function swrToMeterPct(swr: number | null): number {
  if (swr === null) return 0;
  // Map 1.0:1 -> 8% (visible baseline) up to 3.0:1+ -> 100%
  return Math.max(8, Math.min(100, 8 + ((swr - 1.0) / 2.0) * 92));
}

export function RadioControlBar({
  radio,
  stationCall,
  stationGrid,
  activeSession,
  otherRadioSession,
  digitalMode,
  activeDecoder,
  availableDecoders,
  pendingDialFreqHz,
  txState,
  isTuning,
  isAtuTuning,
  feedOnLeft,
  onToggleFlipFeed,
  onSelectBand,
  onSelectMode,
  onSelectDecoder,
  onSetRfPower,
  onSetRfGain,
  onToggleTxEnabled,
  onHaltTx,
  onToggleTune,
  onAtuTune,
  onToggleAtuBypass,
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

  const backendRfGain = radio?.settings?.levels?.RF;
  const supportsRfGain = Boolean(
    radio && (radio.capabilities?.set_levels?.includes("RF") ?? false)
  );

  const [localRfGainPct, setLocalRfGainPct] = useState<number>(() =>
    typeof backendRfGain === "number"
      ? Math.max(0, Math.min(100, Math.round(backendRfGain * 100)))
      : 100
  );

  const rfGainDraggingRef = useRef(false);
  const rfGainCommittedOnUpRef = useRef(false);
  const latestRfGainPctRef = useRef(localRfGainPct);
  const rfGainDebounceRef = useRef<number | null>(null);
  const rfGainGlobalUpCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (
      typeof backendRfGain === "number" &&
      !rfGainDraggingRef.current &&
      rfGainDebounceRef.current === null
    ) {
      const pct = Math.max(0, Math.min(100, Math.round(backendRfGain * 100)));
      setLocalRfGainPct(pct);
      latestRfGainPctRef.current = pct;
    }
  }, [backendRfGain]);

  useEffect(() => {
    return () => {
      if (rfGainDebounceRef.current !== null) {
        window.clearTimeout(rfGainDebounceRef.current);
      }
      if (rfGainGlobalUpCleanupRef.current) {
        rfGainGlobalUpCleanupRef.current();
      }
    };
  }, []);

  const commitRfGain = (pct: number) => {
    if (rfGainDebounceRef.current !== null) {
      window.clearTimeout(rfGainDebounceRef.current);
      rfGainDebounceRef.current = null;
    }
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    void onSetRfGain(Number((clamped / 100).toFixed(2)));
  };

  const scheduleDebouncedRfGain = (pct: number) => {
    if (rfGainDebounceRef.current !== null) {
      window.clearTimeout(rfGainDebounceRef.current);
    }
    rfGainDebounceRef.current = window.setTimeout(() => {
      rfGainDebounceRef.current = null;
      commitRfGain(pct);
    }, 300);
  };

  const handleRfGainPointerDown = () => {
    rfGainDraggingRef.current = true;
    rfGainCommittedOnUpRef.current = false;
    if (rfGainDebounceRef.current !== null) {
      window.clearTimeout(rfGainDebounceRef.current);
      rfGainDebounceRef.current = null;
    }
    if (rfGainGlobalUpCleanupRef.current) {
      rfGainGlobalUpCleanupRef.current();
      rfGainGlobalUpCleanupRef.current = null;
    }
    const onGlobalUp = () => {
      rfGainGlobalUpCleanupRef.current = null;
      if (!rfGainDraggingRef.current) return;
      rfGainDraggingRef.current = false;
      rfGainCommittedOnUpRef.current = true;
      commitRfGain(latestRfGainPctRef.current);
    };
    window.addEventListener("pointerup", onGlobalUp, { once: true });
    window.addEventListener("pointercancel", onGlobalUp, { once: true });
    rfGainGlobalUpCleanupRef.current = () => {
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

  const caps = radio?.capabilities ?? null;
  const supportsAtuTune = Boolean(
    caps &&
      ((caps.vfo_ops ?? []).includes("TUNE") ||
        (caps.set_funcs ?? []).includes("TUNER"))
  );
  const supportsAtuStatus = Boolean(
    caps &&
      ((caps.get_funcs ?? []).includes("TUNER") ||
        (caps.set_funcs ?? []).includes("TUNER"))
  );
  const supportsAtuToggle = Boolean(
    caps && (caps.set_funcs ?? []).includes("TUNER")
  );
  const rawTunerFunc = radio?.settings?.funcs?.TUNER;
  const atuEnabled: boolean | null =
    typeof rawTunerFunc === "boolean" ? rawTunerFunc : null;
  const supportsStrength = Boolean(
    caps && (caps.get_levels ?? []).includes("STRENGTH")
  );
  const supportsSwr = Boolean(
    caps && (caps.get_levels ?? []).includes("SWR")
  );
  const sMeter = strengthToSUnits(radio?.settings?.strength_db);
  const rawTxSwr = radio?.settings?.tx_swr;
  const txSwr: number | null =
    typeof rawTxSwr === "number" && Number.isFinite(rawTxSwr) && rawTxSwr >= 1
      ? rawTxSwr
      : null;
  const txSwrLive = Boolean(radio?.settings?.tx_swr_live);
  const swrToneClass =
    txSwr === null
      ? "unknown"
      : txSwr <= 1.5
      ? "good"
      : txSwr <= 2.5
      ? "warn"
      : "high";
  const isTransmitting = Boolean(
    radio?.ptt || txState === "transmitting" || isTuning
  );
  const showSwrMeter = isTransmitting && supportsSwr;
  const showRfMeter = supportsStrength || supportsSwr;

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
            disabled={
              Boolean(activeSession && !activeSession.is_demo) &&
              !(
                availableDecoders.find((d) => d.id === activeDecoder)
                  ?.supports_ft4 ?? activeDecoder === "ftxr"
              )
            }
            title={
              Boolean(activeSession && !activeSession.is_demo) &&
              !(
                availableDecoders.find((d) => d.id === activeDecoder)
                  ?.supports_ft4 ?? activeDecoder === "ftxr"
              )
                ? "FT4 requires the ftxr decoder"
                : undefined
            }
            onClick={() => onSelectMode("FT4")}
          >
            FT4 7.5s
          </button>
        </div>

        <select
          class="mft8-dark-select mft8-mono"
          data-testid="mft8-decoder-select"
          aria-label="Decoder Backend"
          title="Select FT8 / FT4 decoder engine"
          value={activeDecoder}
          onChange={(e) => {
            const next = (e.currentTarget as HTMLSelectElement).value;
            if (next) onSelectDecoder(next);
          }}
        >
          {(availableDecoders.length > 0
            ? availableDecoders
            : [
                {
                  id: "ftxr",
                  label: "ftxr-modem (FT8 / FT4)",
                  available: true,
                  supports_ft8: true,
                  supports_ft4: true,
                  is_default: true,
                },
                {
                  id: "jt9",
                  label: "WSJT-X jt9 (FT8)",
                  available: false,
                  supports_ft8: true,
                  supports_ft4: false,
                  is_default: false,
                },
                {
                  id: "ft8_lib_fallback",
                  label: "Embedded ft8_lib (FT8)",
                  available: true,
                  supports_ft8: true,
                  supports_ft4: false,
                  is_default: false,
                },
              ]
          ).map((opt) => {
            const ft4Live = Boolean(
              activeSession && !activeSession.is_demo && digitalMode === "FT4"
            );
            const ft4Conflict = ft4Live && !opt.supports_ft4;
            const disabled = !opt.available || ft4Conflict;
            const suffix = !opt.available
              ? " (not installed)"
              : ft4Conflict
              ? " (FT8 only)"
              : "";
            return (
              <option key={opt.id} value={opt.id} disabled={disabled}>
                DEC: {opt.id === "ftxr" ? "ftxr" : opt.id === "jt9" ? "jt9" : "ft8_lib"}
                {opt.supports_ft4 ? " · FT8/4" : " · FT8"}
                {suffix}
              </option>
            );
          })}
        </select>

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

        {supportsRfGain && (
          <div
            class="mft8-pwr-box"
            title="Receiver RF Gain (emits CAT command on release)"
          >
            <span class="mft8-mono" style={{ fontSize: "9.5px", color: "#94a3b8" }}>
              RF
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              class="mft8-pwr-slider"
              data-testid="mft8-rf-gain-slider"
              aria-label="RF Gain"
              disabled={!canControlCat}
              value={localRfGainPct}
              onPointerDown={handleRfGainPointerDown}
              onInput={(e) => {
                const pct = Math.max(
                  0,
                  Math.min(
                    100,
                    Math.round(Number((e.currentTarget as HTMLInputElement).value))
                  )
                );
                latestRfGainPctRef.current = pct;
                setLocalRfGainPct(pct);
                if (!rfGainDraggingRef.current) {
                  scheduleDebouncedRfGain(pct);
                }
              }}
              onChange={() => {
                if (rfGainCommittedOnUpRef.current) {
                  rfGainCommittedOnUpRef.current = false;
                  return;
                }
                if (rfGainDraggingRef.current) return;
                scheduleDebouncedRfGain(latestRfGainPctRef.current);
              }}
            />
            <span class="mft8-pwr-readout" data-testid="mft8-rf-gain-readout">
              {localRfGainPct}%
            </span>
          </div>
        )}
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

        {(supportsAtuTune || supportsAtuStatus) && (
          <div class="mft8-atu-group" data-testid="mft8-atu-group">
            {supportsAtuTune && (
              <button
                type="button"
                data-testid="mft8-atu-tune-btn"
                class={`mft8-atu-tune-btn ${isAtuTuning ? "tuning" : ""}`}
                disabled={!canControlCat || isTransmitting || isAtuTuning}
                title="Trigger transceiver internal ATU tune cycle (CAT)"
                onClick={onAtuTune}
              >
                {isAtuTuning ? "◉ ATU…" : "ATU"}
              </button>
            )}
            {supportsAtuStatus && (
              <button
                type="button"
                data-testid="mft8-atu-status"
                class={`mft8-atu-status-btn ${
                  atuEnabled === true
                    ? "on"
                    : atuEnabled === false
                    ? "bypass"
                    : "unknown"
                }`}
                disabled={
                  !canControlCat ||
                  !supportsAtuToggle ||
                  isTransmitting ||
                  isAtuTuning
                }
                title={
                  atuEnabled === true
                    ? supportsAtuToggle
                      ? "Internal ATU active (inline) — click to bypass"
                      : "Internal ATU active (inline)"
                    : atuEnabled === false
                    ? supportsAtuToggle
                      ? "Internal ATU in bypass — click to enable"
                      : "Internal ATU in bypass"
                    : "Waiting for ATU status readback"
                }
                onClick={() => {
                  if (supportsAtuToggle) {
                    onToggleAtuBypass(!(atuEnabled ?? false));
                  }
                }}
              >
                <span
                  class={`mft8-atu-dot ${
                    atuEnabled === true
                      ? "on"
                      : atuEnabled === false
                      ? "bypass"
                      : ""
                  }`}
                />
                <span>
                  {atuEnabled === true
                    ? "ON"
                    : atuEnabled === false
                    ? "BYPASS"
                    : "—"}
                </span>
              </button>
            )}
          </div>
        )}

        {showRfMeter && (
          <div
            data-testid="mft8-rf-meter"
            class={`mft8-rf-meter ${
              showSwrMeter ? `tx ${swrToneClass}` : "rx"
            }`}
            title={
              showSwrMeter
                ? txSwr !== null
                  ? `TX SWR: ${txSwr.toFixed(1)}:1${txSwrLive ? " (live)" : ""}`
                  : "TX SWR (measuring 1s after TX start)"
                : `RX S-Meter: ${sMeter.fullLabel}${
                    txSwr !== null ? ` · Last TX SWR: ${txSwr.toFixed(1)}:1` : ""
                  }`
            }
          >
            <span class="mft8-rf-meter-tag">
              {showSwrMeter ? "SWR" : "S"}
            </span>
            <div class="mft8-rf-meter-track">
              <div
                class={`mft8-rf-meter-fill ${
                  showSwrMeter ? `swr ${swrToneClass}` : "smeter"
                }`}
                style={{
                  width: `${
                    showSwrMeter ? swrToMeterPct(txSwr) : sMeter.pct
                  }%`,
                }}
              />
            </div>
            <span class="mft8-rf-meter-val" data-testid="mft8-rf-meter-val">
              {showSwrMeter
                ? txSwr !== null
                  ? `${txSwr.toFixed(1)}:1`
                  : "…"
                : sMeter.shortLabel}
            </span>
          </div>
        )}

        <button
          type="button"
          data-testid="mft8-tune-btn"
          class={`mft8-btn mft8-btn-tune ${isTuning ? "active" : ""}`}
          title="Transmit audio carrier tone (for external tuner or ALC check)"
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
