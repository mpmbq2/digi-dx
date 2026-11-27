import { Fragment } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { DaemonState } from "../hooks/useDaemonSocket";
import type {
  ActiveQso,
  ChannelRosterEntry,
  DecodeItem,
  RadioSummary,
  TranscriptEntry,
} from "../types";
import { gridDistance, parseFt8Decode } from "../utils/maidenhead";
import { FT8_BAND_PRESETS, formatFreqMhz, formatLifecycleLabel } from "../utils/radioHelpers";
import { ChannelRosterPanel } from "./ChannelRosterPanel";
import { WaterfallCanvas } from "./WaterfallCanvas";

interface Props {
  daemon: DaemonState;
  radio: RadioSummary;
  onNavigateInfo: () => void;
}

function formatQsoStepMessage(q: ActiveQso): string {
  const grid4 = (q.my_grid || "").slice(0, 4);
  const snr = Math.max(-50, Math.min(49, q.last_their_snr_db ?? -10));
  const snrStr =
    snr >= 0
      ? `+${String(snr).padStart(2, "0")}`
      : `-${String(Math.abs(snr)).padStart(2, "0")}`;
  switch (q.step) {
    case "calling_cq":
      return q.directed_cq
        ? `CQ ${q.directed_cq} ${q.my_call} ${grid4}`.trim()
        : `CQ ${q.my_call} ${grid4}`.trim();
    case "send_grid":
      return `${q.their_call} ${q.my_call} ${grid4}`.trim();
    case "send_report":
      return `${q.their_call} ${q.my_call} ${snrStr}`;
    case "send_r_report":
      return `${q.their_call} ${q.my_call} R${snrStr}`;
    case "send_rr73":
      return `${q.their_call} ${q.my_call} RR73`;
    case "send_73":
    case "send73":
      return `${q.their_call} ${q.my_call} 73`;
    default:
      return `${q.their_call} ${q.my_call}`;
  }
}

export function OperatingConsole({ daemon, radio, onNavigateInfo }: Props) {
  const rid = radio.profile.radio_id;
  const [demoScale, setDemoScale] = useState<string>("1");
  const [showDemoMenu, setShowDemoMenu] = useState<boolean>(false);
  const [afInput, setAfInput] = useState<string>("1500");
  const [decodeFilter, setDecodeFilter] = useState<"all" | "cq" | "mine">("all");
  const [cqSlot, setCqSlot] = useState<"auto" | "even" | "odd">("auto");
  const [cqDirected, setCqDirected] = useState<string>("");
  const [manualSlot, setManualSlot] = useState<"even" | "odd">("even");
  const [manualMsg, setManualMsg] = useState<string>("");
  const [manualMsgDirty, setManualMsgDirty] = useState<boolean>(false);
  const [draggedQsoId, setDraggedQsoId] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<{ ok: boolean; text: string } | null>(
    null
  );

  const activeSession =
    daemon.session?.active && daemon.session.radio_id === rid
      ? daemon.session
      : null;
  const otherRadioSession =
    daemon.session?.active && daemon.session.radio_id !== rid
      ? daemon.session
      : null;

  const effectiveCall = activeSession?.my_call || daemon.station?.callsign || "";
  const effectiveGrid = activeSession?.my_grid || daemon.station?.grid || "";
  const effectiveGrid4 = effectiveGrid.slice(0, 4);
  const defaultManualCq =
    effectiveCall && effectiveGrid4
      ? `CQ ${effectiveCall} ${effectiveGrid4}`
      : effectiveCall
      ? `CQ ${effectiveCall}`
      : "";
  const stationLabel = effectiveCall
    ? `${effectiveCall}${effectiveGrid4 ? ` (${effectiveGrid4})` : ""}`
    : "station unconfigured";

  useEffect(() => {
    if (activeSession?.tx_af_hz) {
      setAfInput(String(activeSession.tx_af_hz));
    }
  }, [activeSession?.tx_af_hz]);

  useEffect(() => {
    if (!manualMsgDirty && defaultManualCq) {
      setManualMsg(defaultManualCq);
    }
  }, [defaultManualCq, manualMsgDirty]);

  // Reload persisted SQLite Channel Roster whenever the radio frequency or demo mode changes
  useEffect(() => {
    void daemon.refreshRoster(
      radio.freq_hz ?? null,
      Boolean(activeSession?.is_demo),
      "FT8"
    );
  }, [radio.freq_hz, activeSession?.is_demo, rid, daemon.refreshRoster]);

  const ensureLease = async (): Promise<boolean> => {
    if (radio.lease_holder === daemon.actor) {
      return true;
    }
    const ack = await daemon.claimLease(rid, false);
    if (ack.status !== "ok") {
      setStatusMsg({
        ok: false,
        text: `${ack.error_code ?? "ERR"}: ${ack.error_message ?? "Lease failed"}`,
      });
      return false;
    }
    return true;
  };

  const runSessionCmd = async (
    kind: string,
    payload: Record<string, unknown>,
    okText?: string
  ): Promise<boolean> => {
    if (!(await ensureLease())) return false;
    let ack = await daemon.sendCommand(kind, payload, undefined, rid);
    if (ack.error_code === "LEASE_REQUIRED") {
      const reclaim = await daemon.claimLease(rid, false);
      if (reclaim.status === "ok") {
        ack = await daemon.sendCommand(kind, payload, undefined, rid);
      }
    }
    if (ack.status !== "ok") {
      setStatusMsg({
        ok: false,
        text: `${ack.error_code ?? "ERR"}: ${ack.error_message ?? `${kind} failed`}`,
      });
      return false;
    }
    setStatusMsg(okText ? { ok: true, text: okText } : null);
    return true;
  };

  const handleBandQsy = async (freqHz: number) => {
    if (!freqHz) return;
    await runSessionCmd("radio.set_freq", { freq_hz: freqHz });
  };

  const handleSelectDecoder = async (decoderBackend: string) => {
    const ack = await daemon.setDecoderBackend(decoderBackend);
    const active =
      typeof ack.result?.active_ft8_decoder === "string"
        ? ack.result.active_ft8_decoder
        : decoderBackend;
    setStatusMsg({
      ok: ack.status === "ok",
      text:
        ack.status === "ok"
          ? `Decoder switched to ${active}.`
          : `${ack.error_code ?? "ERR"}: ${
              ack.error_message ?? "Failed to switch decoder"
            }`,
    });
  };

  const handleStartLive = async () => {
    if (!(await ensureLease())) return;
    const ack = await daemon.sendCommand(
      "session.start",
      { demo: false, decoder_backend: daemon.activeDecoder },
      undefined,
      rid
    );
    setStatusMsg({
      ok: ack.status === "ok",
      text:
        ack.status === "ok"
          ? "Live FT8 session started."
          : `${ack.error_code ?? "ERR"}: ${ack.error_message ?? "Failed"}`,
    });
  };

  const handleStartDemo = async () => {
    if (!(await ensureLease())) return;
    const ack = await daemon.sendCommand(
      "session.start",
      { demo: true, scale: Number(demoScale) },
      undefined,
      rid
    );
    if (ack.status === "ok") setShowDemoMenu(false);
    setStatusMsg({
      ok: ack.status === "ok",
      text:
        ack.status === "ok"
          ? `Demo session active (${demoScale}x).`
          : `${ack.error_code ?? "ERR"}: ${ack.error_message ?? "Failed"}`,
    });
  };

  const handleStopSession = async () => {
    const ack = await daemon.sendCommand("session.stop", {}, undefined, rid);
    setStatusMsg({
      ok: ack.status === "ok",
      text:
        ack.status === "ok"
          ? "Session stopped."
          : `${ack.error_code ?? "ERR"}: ${ack.error_message ?? "Failed"}`,
    });
  };

  const handleSetAf = async (afHz: number) => {
    const clamped = Math.max(200, Math.min(3000, Math.round(afHz)));
    setAfInput(String(clamped));
    if (!activeSession) return;
    await runSessionCmd("qso.set_af", { af_hz: clamped });
  };

  const handleReplyDecode = async (dec: DecodeItem) => {
    const parsed = parseFt8Decode(dec.message);
    if (!parsed.from) return;
    await runSessionCmd(
      "qso.reply",
      {
        callsign: parsed.from,
        their_grid: parsed.grid,
        rx_slot: dec.slot,
        snr_db: dec.snr_db,
        rx_message: dec.message,
        rx_af_hz: dec.af_hz,
        rx_ts_sec: dec.ts_sec,
      },
      `Queued reply to ${parsed.from}${parsed.grid ? ` (${parsed.grid})` : ""}`
    );
  };

  const handleReplyRoster = async (entry: ChannelRosterEntry) => {
    await runSessionCmd(
      "qso.reply",
      {
        callsign: entry.callsign,
        their_grid: entry.grid,
        rx_slot: entry.last_slot,
        snr_db: entry.last_snr_db,
        rx_message: entry.last_message,
        rx_af_hz: entry.last_af_hz,
        rx_ts_sec: entry.last_seen_ts_sec,
      },
      `Queued reply to ${entry.callsign}${entry.grid ? ` (${entry.grid})` : ""}`
    );
  };

  const handleReorderDrop = async (targetQsoId: string) => {
    if (!draggedQsoId || draggedQsoId === targetQsoId || !activeSession) return;
    const queue = activeSession.active_qsos;
    const fromIdx = queue.findIndex((q) => q.qso_id === draggedQsoId);
    const toIdx = queue.findIndex((q) => q.qso_id === targetQsoId);
    setDraggedQsoId(null);
    if (fromIdx < 0 || toIdx < 0) return;
    const stepKind = toIdx < fromIdx ? "move_up" : "move_down";
    const steps = Math.abs(toIdx - fromIdx);
    for (let i = 0; i < steps; i++) {
      await runSessionCmd("qso.action", {
        qso_id: draggedQsoId,
        action: stepKind,
      });
    }
  };

  const currentAf = activeSession?.tx_af_hz ?? Number(afInput || 1500);
  const txStateStr = daemon.txState?.state ?? activeSession?.tx_state ?? "idle";
  const hasActiveQueuedQso = Boolean(
    activeSession?.tx_enabled &&
      (Boolean(activeSession?.cq?.armed) ||
        Boolean(activeSession?.armed_qso_id) ||
        activeSession.active_qsos.some((q) => q.status === "active"))
  );
  const txBadgeClass =
    txStateStr === "transmitting"
      ? "badge-fail"
      : txStateStr === "armed" || (txStateStr === "idle" && hasActiveQueuedQso)
      ? "badge-warn"
      : "badge-info";
  const txBadgeLabel =
    txStateStr === "idle" && hasActiveQueuedQso
      ? "TX: QUEUED"
      : `TX: ${txStateStr.toUpperCase()}`;

  const canQsy =
    (radio.lifecycle_state === "READY" ||
      radio.lifecycle_state === "ACTIVE_SESSION") &&
    !radio.ptt &&
    txStateStr !== "transmitting";

  const filteredDecodes = useMemo(() => {
    return daemon.recentDecodes.filter((d) => {
      if (decodeFilter === "cq") return d.message.startsWith("CQ ");
      if (decodeFilter === "mine") {
        return Boolean(effectiveCall && d.message.includes(effectiveCall));
      }
      return true;
    });
  }, [daemon.recentDecodes, decodeFilter, effectiveCall]);

  const workedCalls = useMemo(() => {
    const isDemo = Boolean(activeSession?.is_demo);
    const log = isDemo ? daemon.demoQsos : daemon.realQsos;
    const worked = isDemo ? daemon.workedDemoCalls : daemon.workedRealCalls;
    const set = new Set<string>();
    for (const call of worked) {
      const norm = call.replace(/[<>]/g, "").trim().toUpperCase();
      if (norm) set.add(norm);
    }
    for (const item of log) {
      if (!radio.band || !item.band || item.band === radio.band) {
        const norm = item.their_call.replace(/[<>]/g, "").trim().toUpperCase();
        if (norm) set.add(norm);
      }
    }
    return set;
  }, [
    activeSession?.is_demo,
    daemon.demoQsos,
    daemon.realQsos,
    daemon.workedDemoCalls,
    daemon.workedRealCalls,
    radio.band,
  ]);

  const queuedCalls = useMemo(() => {
    const set = new Set<string>();
    for (const q of activeSession?.active_qsos ?? []) {
      if (!q.is_cq) set.add(q.their_call);
    }
    return set;
  }, [activeSession?.active_qsos]);

  const firstActiveId = useMemo(() => {
    if (activeSession?.armed_qso_id) {
      return activeSession.armed_qso_id;
    }
    return (
      activeSession?.active_qsos.find((q) => q.status === "active")?.qso_id ??
      null
    );
  }, [activeSession?.armed_qso_id, activeSession?.active_qsos]);

  return (
    <div class="console-stack" data-testid="ft8-console">
      {/* 3-Zone Operating Header */}
      <section class="panel" aria-label="Operating Session Controls">
        <div class="operating-header-grid">
          {/* Zone 1: Band / VFO Quick Switch */}
          <div class="op-zone">
            <div class="op-zone-label muted">Band &amp; VFO</div>
            <div class="op-zone-row">
              <span class="vfo-freq mono" style={{ fontSize: "1rem" }}>
                {formatFreqMhz(radio.freq_hz)}
              </span>
              <select
                class="input-sm"
                data-testid="ft8-band-select"
                aria-label="FT8 Band Preset"
                disabled={!canQsy}
                value={
                  FT8_BAND_PRESETS.find((b) => b.band === radio.band)?.hz ?? ""
                }
                onChange={(e) => {
                  const hz = Number((e.currentTarget as HTMLSelectElement).value);
                  if (hz > 0) void handleBandQsy(hz);
                }}
              >
                <option value="">{radio.band ?? "Band..."}</option>
                {FT8_BAND_PRESETS.map((p) => (
                  <option key={p.band} value={p.hz}>
                    {p.band} ({p.mhz} MHz)
                  </option>
                ))}
              </select>
              {radio.mode && <span class="badge badge-info">{radio.mode}</span>}
              <label
                class="muted mono"
                style={{
                  fontSize: "0.75rem",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.3rem",
                }}
              >
                <span>Decoder</span>
                <select
                  class="input-sm"
                  data-testid="ft8-decoder-select"
                  aria-label="FT8 Decoder Backend"
                  value={daemon.activeDecoder}
                  onChange={(e) => {
                    const next = (e.currentTarget as HTMLSelectElement).value;
                    if (next) void handleSelectDecoder(next);
                  }}
                >
                  {(daemon.availableDecoders.length > 0
                    ? daemon.availableDecoders
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
                    const ft4Conflict =
                      Boolean(
                        activeSession &&
                          !activeSession.is_demo &&
                          activeSession.digital_mode === "FT4"
                      ) && !opt.supports_ft4;
                    const disabled = !opt.available || ft4Conflict;
                    const suffix = !opt.available
                      ? " (not installed)"
                      : ft4Conflict
                      ? " (FT8 only)"
                      : "";
                    return (
                      <option key={opt.id} value={opt.id} disabled={disabled}>
                        {opt.label}
                        {suffix}
                      </option>
                    );
                  })}
                </select>
              </label>
              <button
                type="button"
                class="btn btn-secondary btn-xs"
                onClick={onNavigateInfo}
              >
                Rig Settings
              </button>
            </div>
            <p class="muted mono" style={{ fontSize: "0.74rem", marginTop: "0.2rem" }}>
              {radio.profile.name} · {formatLifecycleLabel(radio.lifecycle_state)} · {stationLabel} · decoder:{" "}
              {activeSession?.is_demo
                ? `simulated (${daemon.activeDecoder})`
                : activeSession?.decoder_backend ?? daemon.activeDecoder}
            </p>
          </div>

          {/* Zone 2: Session Start / Stop & Compact Demo Mode */}
          <div class="op-zone">
            <div class="op-zone-label muted">Session Control</div>
            <div class="op-zone-row">
              {!activeSession ? (
                <>
                  <button
                    type="button"
                    class="btn btn-primary btn-sm"
                    disabled={
                      Boolean(otherRadioSession) ||
                      radio.lifecycle_state !== "READY"
                    }
                    onClick={() => void handleStartLive()}
                  >
                    Start Live FT8
                  </button>
                  <button
                    type="button"
                    class="btn btn-secondary btn-sm"
                    data-testid="demo-menu-toggle"
                    disabled={Boolean(otherRadioSession)}
                    onClick={() => setShowDemoMenu((s) => !s)}
                  >
                    Demo Mode ▾
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  class="btn btn-secondary btn-sm"
                  data-testid="stop-session-btn"
                  onClick={() => void handleStopSession()}
                >
                  Stop {activeSession.is_demo ? "Demo" : "Live"} Session
                </button>
              )}
            </div>
            {showDemoMenu && !activeSession && (
              <div class="demo-popover">
                <select
                  class="input-sm"
                  data-testid="demo-scale-select"
                  aria-label="Demo Clock Speed"
                  value={demoScale}
                  onChange={(e) =>
                    setDemoScale((e.currentTarget as HTMLSelectElement).value)
                  }
                >
                  <option value="1">Demo 1x (Real-Time)</option>
                  <option value="20">Demo 20x (Fast)</option>
                </select>
                <button
                  type="button"
                  class="btn btn-primary btn-sm"
                  data-testid="start-demo-btn"
                  onClick={() => void handleStartDemo()}
                >
                  Start Demo Session
                </button>
              </div>
            )}
          </div>

          {/* Zone 3: TX Safety Gate */}
          <div class="op-zone op-zone-right">
            <div class="op-zone-label muted">TX Safety</div>
            <div class="op-zone-row">
              <button
                type="button"
                class={`btn btn-sm ${
                  activeSession?.tx_enabled ? "btn-primary" : "btn-secondary"
                }`}
                data-testid="tx-enable-toggle"
                disabled={!activeSession}
                onClick={() =>
                  void runSessionCmd("qso.set_tx_enabled", {
                    enabled: !(activeSession?.tx_enabled ?? false),
                  })
                }
              >
                {activeSession?.tx_enabled ? "TX: ENABLED" : "TX: MUTED"}
              </button>
              <span class={`badge ${txBadgeClass}`}>{txBadgeLabel}</span>
              <button
                type="button"
                class="btn btn-danger btn-sm"
                onClick={() =>
                  void daemon.sendCommand("tx.halt_emergency", {}, undefined, rid)
                }
              >
                HALT TX
              </button>
            </div>
          </div>
        </div>

        {otherRadioSession && (
          <div class="demo-inline-note" style={{ marginTop: "0.6rem" }}>
            Another radio ({otherRadioSession.radio_id}) currently holds the active FT8 session. Stop that session before starting one here.
          </div>
        )}

        {statusMsg && (
          <div
            class={statusMsg.ok ? "text-ok mono" : "text-err mono"}
            style={{ marginTop: "0.6rem" }}
          >
            {statusMsg.text}
          </div>
        )}

        {daemon.lastAlert &&
          (daemon.lastAlert.title === "FT8 TX Failed" ||
            daemon.lastAlert.severity === "fatal" ||
            daemon.lastAlert.severity === "warn") && (
            <div
              class={
                daemon.lastAlert.severity === "fatal"
                  ? "radio-error mono"
                  : "radio-standby mono"
              }
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "0.75rem",
                marginTop: "0.6rem",
              }}
            >
              <span>
                <strong>{daemon.lastAlert.title}:</strong> {daemon.lastAlert.detail}
              </span>
              <button
                type="button"
                class="btn btn-secondary btn-xs"
                onClick={() => daemon.clearAlert()}
              >
                Dismiss
              </button>
            </div>
          )}
      </section>

      {/* Top Row: 2/3 Waterfall (Left) + 1/3 Live Decodes (Right) */}
      <div class="ft8-top-grid">
        <section class="panel" aria-label="Passband Waterfall">
          <WaterfallCanvas
            frames={daemon.waterfallFrames}
            txAfHz={currentAf}
            evenOccupiedHz={daemon.evenOccupiedHz}
            oddOccupiedHz={daemon.oddOccupiedHz}
            onSelectAf={(hz) => void handleSetAf(hz)}
          />

          <div class="af-toolbar">
            <div class="cat-group">
              <label class="muted" style={{ fontSize: "0.8rem" }}>
                TX AF (Hz):
              </label>
              <input
                type="number"
                class="mono input-xs"
                data-testid="af-input"
                min="200"
                max="3000"
                value={afInput}
                onInput={(e) =>
                  setAfInput((e.currentTarget as HTMLInputElement).value)
                }
              />
              <button
                type="button"
                class="btn btn-secondary btn-sm"
                data-testid="set-af-btn"
                onClick={() => void handleSetAf(Number(afInput))}
              >
                Set AF
              </button>
              <button
                type="button"
                class="btn btn-secondary btn-sm"
                disabled={!activeSession}
                onClick={() =>
                  void runSessionCmd(
                    "qso.survey_af",
                    {},
                    "Surveying band for clearest AF gap..."
                  )
                }
              >
                {activeSession?.survey_active
                  ? "Surveying Clear AF..."
                  : "Survey Clear AF"}
              </button>
            </div>
            <div class="hw-badges">
              <span class="badge badge-info" data-testid="active-af-badge">
                TX AF: {currentAf} Hz
              </span>
              {activeSession?.tx_af_occupied ? (
                <span class="badge badge-warn">OCCUPIED AF (±50 Hz)</span>
              ) : (
                <span class="badge badge-ok">CLEAR AF</span>
              )}
            </div>
          </div>
        </section>

        <section
          class="panel"
          data-testid="live-decodes-panel"
          aria-label="Live FT8 Decodes"
        >
          <div class="panel-header">
            <div>
              <h2>Live Decodes ({filteredDecodes.length})</h2>
            </div>
            <div class="seg-group">
              {(["all", "cq", "mine"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  class={`btn btn-xs ${
                    decodeFilter === f ? "btn-primary" : "btn-secondary"
                  }`}
                  onClick={() => setDecodeFilter(f)}
                >
                  {f === "all" ? "All" : f === "cq" ? "CQ" : "To Me"}
                </button>
              ))}
            </div>
          </div>

          <div class="table-scroll table-scroll-compact">
            <table class="data-table mono">
              <thead>
                <tr>
                  <th>UTC</th>
                  <th>Slot</th>
                  <th>SNR</th>
                  <th>AF</th>
                  <th>Message</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filteredDecodes.length === 0 ? (
                  <tr>
                    <td colspan={6} class="muted">
                      {activeSession
                        ? "Waiting for 15s FT8 decode slot..."
                        : "Start a session to stream live decodes."}
                    </td>
                  </tr>
                ) : (
                  filteredDecodes.map((d, idx) => {
                    const isCq = d.message.startsWith("CQ ");
                    const isMine = Boolean(
                      effectiveCall && d.message.includes(effectiveCall)
                    );
                    const parsed = parseFt8Decode(d.message);
                    const fromNorm = parsed.from
                      .replace(/[<>]/g, "")
                      .trim()
                      .toUpperCase();
                    const isWorked = Boolean(fromNorm && workedCalls.has(fromNorm));
                    const showCycleGap =
                      idx > 0 && d.ts_sec !== filteredDecodes[idx - 1].ts_sec;
                    return (
                      <Fragment
                        key={`${d.ts_sec}-${d.message}-${Math.round(d.af_hz / 30)}`}
                      >
                        {showCycleGap && (
                          <tr
                            class="decode-cycle-gap"
                            data-testid="decode-cycle-divider"
                            aria-hidden="true"
                          >
                            <td colspan={6}>
                              <div class="decode-cycle-gap-inner">
                                <span class="decode-cycle-line" />
                                <span class="decode-cycle-label mono">
                                  {new Date(d.ts_sec * 1000)
                                    .toISOString()
                                    .slice(11, 19)}{" "}
                                  UTC · {d.slot === "even" ? "EVEN" : "ODD"}
                                </span>
                                <span class="decode-cycle-line" />
                              </div>
                            </td>
                          </tr>
                        )}
                        <tr
                          class={`${isMine ? "row-mine" : isCq ? "row-cq" : ""} ${
                            isWorked ? "row-worked" : ""
                          }`.trim()}
                        >
                          <td>
                            {new Date(d.ts_sec * 1000).toISOString().slice(11, 19)}
                          </td>
                          <td>
                            <span
                              class={`slot-pill ${
                                d.slot === "even" ? "slot-even" : "slot-odd"
                              }`}
                            >
                              {d.slot === "even" ? "E" : "O"}
                            </span>
                          </td>
                          <td>{d.snr_db >= 0 ? `+${d.snr_db}` : d.snr_db}</td>
                          <td>{d.af_hz}</td>
                          <td class="msg-cell">
                            <div class="msg-cell-inner">
                              <span class="msg-cell-text">{d.message}</span>
                              {d.decoder_metadata && (
                                <span
                                  data-testid="decode-meta-tag"
                                  class={`decode-meta-tag ${
                                    d.decoder_metadata.includes("?")
                                      ? "decode-meta-uncertain"
                                      : "decode-meta-ap"
                                  }`}
                                  title={
                                    d.decoder_metadata.includes("?")
                                      ? `Low-confidence AP decode (${d.decoder_metadata})`
                                      : `A Priori (AP) assisted decode (${d.decoder_metadata})`
                                  }
                                >
                                  {d.decoder_metadata}
                                </span>
                              )}
                            </div>
                          </td>
                          <td>
                            <button
                              type="button"
                              class="btn btn-secondary btn-xs"
                              disabled={!activeSession}
                              onClick={() => void handleReplyDecode(d)}
                            >
                              Reply
                            </button>
                          </td>
                        </tr>
                      </Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {/* Bottom Row: Channel Roster (Left) + Ordered Multi-QSO Sequencer (Right) */}
      <div class="ft8-bottom-grid">
        <ChannelRosterPanel
          entries={daemon.channelRoster}
          channelKey={daemon.rosterChannelKey}
          band={radio.band}
          myGrid={effectiveGrid || null}
          workedCalls={workedCalls}
          queuedCalls={queuedCalls}
          sessionActive={Boolean(activeSession)}
          onReply={(entry) => void handleReplyRoster(entry)}
          onRefresh={() =>
            void daemon.refreshRoster(
              radio.freq_hz ?? null,
              Boolean(activeSession?.is_demo),
              "FT8"
            )
          }
        />

        <section class="panel" aria-label="QSO Auto-Sequencer Queue">
          <div class="panel-header">
            <div>
              <h2>QSO Sequencer Queue ({activeSession?.active_qsos.length ?? 0})</h2>
              <p class="muted">
                CQ replies enqueue Active; unsolicited calls enqueue Paused until resumed. Drag or reorder priority.
              </p>
            </div>
          </div>

          <div class="cq-bar">
            <select
              class="input-sm"
              value={cqSlot}
              onChange={(e) =>
                setCqSlot(
                  (e.currentTarget as HTMLSelectElement).value as
                    | "auto"
                    | "even"
                    | "odd"
                )
              }
            >
              <option value="auto">Auto Slot</option>
              <option value="even">Even Slot</option>
              <option value="odd">Odd Slot</option>
            </select>
            <input
              type="text"
              class="input-sm mono"
              placeholder="Directed (e.g. DX)"
              value={cqDirected}
              onInput={(e) =>
                setCqDirected(
                  (e.currentTarget as HTMLInputElement).value.toUpperCase()
                )
              }
            />
            <button
              type="button"
              class="btn btn-primary btn-sm"
              data-testid="call-cq-btn"
              disabled={!activeSession}
              onClick={() => {
                const payload = {
                  ...(cqSlot === "auto" ? {} : { slot: cqSlot }),
                  directed: cqDirected.trim() || null,
                };
                void runSessionCmd(
                  "qso.call_cq",
                  payload,
                  `CQ queued${effectiveCall ? ` (${effectiveCall} ${effectiveGrid4})` : ""}`
                );
              }}
            >
              Call CQ
            </button>
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              disabled={!activeSession}
              onClick={() =>
                void runSessionCmd("tx.cancel", {}, "Cancelled pending TX")
              }
            >
              Cancel TX
            </button>
            {activeSession?.cq && (
              <>
                <span class="badge badge-warn mono">
                  CALLING CQ ({activeSession.cq.tx_slot.toUpperCase()})
                </span>
                <button
                  type="button"
                  class="btn btn-secondary btn-sm"
                  onClick={() =>
                    void runSessionCmd("qso.stop_cq", {}, "Stopped CQ")
                  }
                >
                  Stop CQ
                </button>
              </>
            )}
          </div>

          <div class="qso-queue">
            {(activeSession?.active_qsos ?? []).length === 0 ? (
              <p class="muted">
                No QSOs in queue. Click Call CQ or Reply to a station in the Channel Roster.
              </p>
            ) : (
              (activeSession?.active_qsos ?? []).map((q, idx) => {
                const isHeadActive = q.qso_id === firstActiveId;
                const dist = gridDistance(effectiveGrid, q.their_grid);
                const transcript = q.transcript ?? [];
                let lastRx: TranscriptEntry | null = null;
                for (let i = transcript.length - 1; i >= 0; i--) {
                  if (transcript[i].direction === "rx") {
                    lastRx = transcript[i];
                    break;
                  }
                }
                const liveTxMsg =
                  daemon.txState?.state === "transmitting"
                    ? daemon.txState.message
                    : activeSession?.tx_state === "transmitting"
                    ? activeSession.armed_message
                    : null;
                const liveTxAf =
                  daemon.txState?.state === "transmitting"
                    ? daemon.txState.af_hz ?? currentAf
                    : currentAf;
                const cleanCall = q.their_call.replace(/^<|>$/g, "");
                const isSendingThis = Boolean(
                  isHeadActive &&
                    txStateStr === "transmitting" &&
                    liveTxMsg &&
                    (q.is_cq
                      ? liveTxMsg.startsWith("CQ ")
                      : liveTxMsg.replace(/[<>]/g, "").includes(cleanCall))
                );
                const displayTxMsg =
                  isSendingThis && liveTxMsg ? liveTxMsg : formatQsoStepMessage(q);
                const displayTxAf = isSendingThis ? liveTxAf : currentAf;
                return (
                  <div
                    key={q.qso_id}
                    data-testid="qso-card"
                    class={`qso-card ${
                      isHeadActive
                        ? "qso-card-head"
                        : q.status === "paused"
                        ? "qso-card-paused"
                        : ""
                    }`}
                    draggable
                    onDragStart={() => setDraggedQsoId(q.qso_id)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => void handleReorderDrop(q.qso_id)}
                  >
                    <div class="qso-card-top">
                      <span class="mono" style={{ fontWeight: 700 }}>
                        #{idx + 1} {q.is_cq ? "CQ CALL" : q.their_call}{" "}
                        {q.their_grid ? `(${q.their_grid})` : ""}
                        {dist ? ` · ${dist.miles} mi` : ""}
                      </span>
                      <div class="hw-badges">
                        <span
                          class={`badge ${
                            isSendingThis
                              ? "badge-fail"
                              : isHeadActive
                              ? "badge-ok"
                              : q.status === "paused"
                              ? "badge-warn"
                              : "badge-info"
                          }`}
                        >
                          {isSendingThis
                            ? "SENDING"
                            : isHeadActive
                            ? "NEXT TX"
                            : q.status === "paused"
                            ? "PAUSED"
                            : "QUEUED"}
                        </span>
                        <span
                          class={`slot-pill ${
                            q.tx_slot === "even" ? "slot-even" : "slot-odd"
                          }`}
                        >
                          {q.tx_slot.toUpperCase()}
                        </span>
                        <span class="badge badge-muted">{q.step}</span>
                      </div>
                    </div>

                    <div class="qso-msg-stack">
                      {!q.is_cq && (
                        <div class="qso-msg-box qso-msg-rx">
                          <div class="qso-msg-head">
                            <span class="qso-dir-tag qso-dir-rx">LAST RX</span>
                            {lastRx && (
                              <span class="muted mono" style={{ fontSize: "0.7rem" }}>
                                {lastRx.snr_db !== null
                                  ? `${
                                      lastRx.snr_db >= 0
                                        ? `+${lastRx.snr_db}`
                                        : lastRx.snr_db
                                    } dB · `
                                  : ""}
                                {lastRx.af_hz} Hz ·{" "}
                                {new Date(lastRx.slot_ts * 1000)
                                  .toISOString()
                                  .slice(11, 19)}
                                Z
                              </span>
                            )}
                          </div>
                          <div
                            class={`qso-msg-text mono${lastRx ? "" : " muted"}`}
                            data-testid="qso-last-rx-msg"
                          >
                            {lastRx ? lastRx.message : "Waiting for reply..."}
                          </div>
                        </div>
                      )}

                      <div
                        class={`qso-msg-box ${
                          isSendingThis ? "qso-msg-tx-live" : "qso-msg-tx"
                        }`}
                      >
                        <div class="qso-msg-head">
                          <span
                            class={`qso-dir-tag ${
                              isSendingThis ? "qso-dir-tx-live" : "qso-dir-tx"
                            }`}
                          >
                            {isSendingThis
                              ? "SENDING TX"
                              : isHeadActive
                              ? "NEXT TX"
                              : "QUEUED TX"}
                          </span>
                          <span class="qso-af-pill mono" data-testid="qso-tx-af">
                            AF {displayTxAf} Hz
                          </span>
                        </div>
                        <div class="qso-msg-text mono" data-testid="qso-tx-msg">
                          {displayTxMsg}
                        </div>
                      </div>
                    </div>
                    <div class="muted mono" style={{ fontSize: "0.75rem" }}>
                      Attempts: {q.attempts_on_step}/5 · Sent: {q.rst_sent ?? "—"} · Rcvd:{" "}
                      {q.rst_rcvd ?? "—"}
                    </div>

                    <div class="qso-actions">
                      {q.status === "paused" ? (
                        <button
                          type="button"
                          class="btn btn-primary btn-xs"
                          onClick={() =>
                            void runSessionCmd("qso.action", {
                              qso_id: q.qso_id,
                              action: "resume",
                            })
                          }
                        >
                          Resume
                        </button>
                      ) : (
                        <>
                          {!isHeadActive && (
                            <button
                              type="button"
                              class="btn btn-primary btn-xs"
                              onClick={() =>
                                void runSessionCmd("qso.action", {
                                  qso_id: q.qso_id,
                                  action: "arm",
                                })
                              }
                            >
                              Arm
                            </button>
                          )}
                          <button
                            type="button"
                            class="btn btn-secondary btn-xs"
                            onClick={() =>
                              void runSessionCmd("qso.action", {
                                qso_id: q.qso_id,
                                action: "pause",
                              })
                            }
                          >
                            Pause
                          </button>
                        </>
                      )}
                      {idx > 0 && (
                        <>
                          <button
                            type="button"
                            class="btn btn-secondary btn-xs"
                            title="Move to top of queue"
                            onClick={() =>
                              void runSessionCmd("qso.action", {
                                qso_id: q.qso_id,
                                action: "move_to_top",
                              })
                            }
                          >
                            Top
                          </button>
                          <button
                            type="button"
                            class="btn btn-secondary btn-xs"
                            onClick={() =>
                              void runSessionCmd("qso.action", {
                                qso_id: q.qso_id,
                                action: "move_up",
                              })
                            }
                          >
                            ↑
                          </button>
                        </>
                      )}
                      {idx + 1 < (activeSession?.active_qsos.length ?? 0) && (
                        <button
                          type="button"
                          class="btn btn-secondary btn-xs"
                          onClick={() =>
                            void runSessionCmd("qso.action", {
                              qso_id: q.qso_id,
                              action: "move_down",
                            })
                          }
                        >
                          ↓
                        </button>
                      )}
                      {!q.is_cq && (
                        <>
                          <a
                            class="btn btn-secondary btn-xs"
                            data-testid="qso-qrz-link"
                            href={`https://www.qrz.com/db/${encodeURIComponent(
                              cleanCall
                            )}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={`Look up ${cleanCall} on QRZ.com`}
                          >
                            QRZ ↗
                          </a>
                          <button
                            type="button"
                            class="btn btn-primary btn-xs"
                            onClick={() =>
                              void runSessionCmd(
                                "qso.action",
                                { qso_id: q.qso_id, action: "complete" },
                                `Logged QSO with ${q.their_call}`
                              )
                            }
                          >
                            Log Now
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        class="btn btn-danger btn-xs"
                        onClick={() =>
                          void runSessionCmd("qso.action", {
                            qso_id: q.qso_id,
                            action: "abandon",
                          })
                        }
                      >
                        Abandon
                      </button>
                    </div>

                    <details class="qso-overrides">
                      <summary class="muted">Step overrides</summary>
                      <div class="qso-actions" style={{ marginTop: "0.35rem" }}>
                        {(["retry", "prev_step", "next_step"] as const).map(
                          (act) => (
                            <button
                              key={act}
                              type="button"
                              class="btn btn-secondary btn-xs"
                              onClick={() =>
                                void runSessionCmd("qso.action", {
                                  qso_id: q.qso_id,
                                  action: act,
                                })
                              }
                            >
                              {act.replace("_", " ")}
                            </button>
                          )
                        )}
                      </div>
                    </details>
                  </div>
                );
              })
            )}
          </div>

          <details class="manual-tx-details">
            <summary class="muted">Manual TX Override</summary>
            <div class="manual-tx-bar">
              <select
                class="input-sm"
                value={manualSlot}
                onChange={(e) =>
                  setManualSlot(
                    (e.currentTarget as HTMLSelectElement).value as "even" | "odd"
                  )
                }
              >
                <option value="even">Even</option>
                <option value="odd">Odd</option>
              </select>
              <input
                type="text"
                class="input-sm mono"
                placeholder={defaultManualCq || "e.g. CQ K1ABC FN42"}
                value={manualMsg}
                onInput={(e) => {
                  const val = (e.currentTarget as HTMLInputElement).value.toUpperCase();
                  setManualMsg(val);
                  setManualMsgDirty(val.trim().length > 0);
                }}
              />
              <button
                type="button"
                class="btn btn-secondary btn-sm"
                disabled={!activeSession || !manualMsg.trim()}
                onClick={() =>
                  void runSessionCmd(
                    "tx.arm",
                    { af_hz: currentAf, slot: manualSlot, message: manualMsg },
                    `Armed manual TX: ${manualMsg}`
                  )
                }
              >
                Arm Manual TX
              </button>
            </div>
          </details>
        </section>
      </div>
    </div>
  );
}
