import { useEffect, useState } from "preact/hooks";
import type { DaemonState } from "../hooks/useDaemonSocket";
import type { ActiveQso, DecodeItem } from "../types";
import { WaterfallCanvas } from "./WaterfallCanvas";

interface Props {
  daemon: DaemonState;
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
      return `${q.their_call} ${q.my_call} 73`;
    default:
      return `${q.their_call} ${q.my_call}`;
  }
}

export function OperatingConsole({ daemon }: Props) {
  const [selectedRadioId, setSelectedRadioId] = useState<string>("");
  const [demoScale, setDemoScale] = useState<string>("1");
  const [afInput, setAfInput] = useState<string>("1500");
  const [cqSlot, setCqSlot] = useState<"auto" | "even" | "odd">("auto");
  const [cqDirected, setCqDirected] = useState<string>("");
  const [manualSlot, setManualSlot] = useState<"even" | "odd">("even");
  const [manualMsg, setManualMsg] = useState<string>("");
  const [manualMsgDirty, setManualMsgDirty] = useState<boolean>(false);
  const [statusMsg, setStatusMsg] = useState<{ ok: boolean; text: string } | null>(
    null
  );

  const activeSession = daemon.session?.active ? daemon.session : null;
  const effectiveCall = activeSession?.my_call || daemon.station?.callsign || "";
  const effectiveGrid4 = (activeSession?.my_grid || daemon.station?.grid || "").slice(
    0,
    4
  );
  const defaultManualCq =
    effectiveCall && effectiveGrid4
      ? `CQ ${effectiveCall} ${effectiveGrid4}`
      : effectiveCall
      ? `CQ ${effectiveCall}`
      : "";
  const stationLabel = effectiveCall
    ? `${effectiveCall}${effectiveGrid4 ? ` (${effectiveGrid4})` : ""}`
    : "station unconfigured";

  const effectiveRadioId =
    activeSession?.radio_id ||
    selectedRadioId ||
    daemon.radios[0]?.profile.radio_id ||
    "";

  const selectedRadio = daemon.radios.find(
    (r) => r.profile.radio_id === effectiveRadioId
  );

  useEffect(() => {
    if (!selectedRadioId && daemon.radios.length > 0) {
      setSelectedRadioId(daemon.radios[0].profile.radio_id);
    }
  }, [daemon.radios, selectedRadioId]);

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

  const ensureLease = async (radioId: string): Promise<boolean> => {
    const r = daemon.radios.find((x) => x.profile.radio_id === radioId);
    if (r?.lease_holder === daemon.actor) {
      return true;
    }
    const ack = await daemon.claimLease(radioId, false);
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
    if (!effectiveRadioId) {
      setStatusMsg({ ok: false, text: "Select or create a radio profile first." });
      return false;
    }
    if (!(await ensureLease(effectiveRadioId))) return false;
    let ack = await daemon.sendCommand(kind, payload, undefined, effectiveRadioId);
    if (ack.error_code === "LEASE_REQUIRED") {
      const reclaim = await daemon.claimLease(effectiveRadioId, false);
      if (reclaim.status === "ok") {
        ack = await daemon.sendCommand(kind, payload, undefined, effectiveRadioId);
      }
    }
    if (ack.status !== "ok") {
      setStatusMsg({
        ok: false,
        text: `${ack.error_code ?? "ERR"}: ${ack.error_message ?? `${kind} failed`}`,
      });
      return false;
    }
    if (okText) {
      setStatusMsg({ ok: true, text: okText });
    } else {
      setStatusMsg(null);
    }
    return true;
  };

  const handleStartLive = async () => {
    if (!effectiveRadioId) {
      setStatusMsg({ ok: false, text: "Select or create a radio profile first." });
      return;
    }
    if (!(await ensureLease(effectiveRadioId))) return;
    const ack = await daemon.sendCommand(
      "session.start",
      { demo: false },
      undefined,
      effectiveRadioId
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
    let rid = effectiveRadioId;
    if (!rid) {
      const createAck = await daemon.sendCommand("radio.create_profile", {
        name: "Demo Dummy Rig (-m 1)",
        hamlib_model: 1,
        is_dummy: true,
        ptt_method: "cat",
        auto_connect: true,
      });
      if (createAck.status !== "ok") {
        setStatusMsg({
          ok: false,
          text: `${createAck.error_code ?? "ERR"}: ${createAck.error_message ?? "Create failed"}`,
        });
        return;
      }
      const profileObj = createAck.result?.profile as { radio_id?: string } | undefined;
      rid = profileObj?.radio_id ?? "";
      if (rid) setSelectedRadioId(rid);
    }
    if (!rid) return;
    const claimAck = await daemon.claimLease(rid, false);
    if (claimAck.status !== "ok") {
      setStatusMsg({
        ok: false,
        text: `${claimAck.error_code ?? "ERR"}: ${claimAck.error_message ?? "Lease failed"}`,
      });
      return;
    }
    const ack = await daemon.sendCommand(
      "session.start",
      { demo: true, scale: Number(demoScale) },
      undefined,
      rid
    );
    setStatusMsg({
      ok: ack.status === "ok",
      text:
        ack.status === "ok"
          ? `Demo session active (${demoScale}x).`
          : `${ack.error_code ?? "ERR"}: ${ack.error_message ?? "Failed"}`,
    });
  };

  const handleStopSession = async () => {
    if (!effectiveRadioId) return;
    const ack = await daemon.sendCommand(
      "session.stop",
      {},
      undefined,
      effectiveRadioId
    );
    setStatusMsg({
      ok: ack.status === "ok",
      text: ack.status === "ok" ? "Session stopped." : `${ack.error_code}: ${ack.error_message}`,
    });
  };

  const handleSetAf = async (afHz: number) => {
    const clamped = Math.max(200, Math.min(3000, Math.round(afHz)));
    setAfInput(String(clamped));
    if (!activeSession || !effectiveRadioId) return;
    await runSessionCmd("qso.set_af", { af_hz: clamped });
  };

  const handleReplyDecode = async (dec: DecodeItem) => {
    if (!effectiveRadioId) return;
    const tokens = dec.message.trim().split(/\s+/);
    const gridRe = /^[A-R]{2}\d{2}([A-X]{2})?$/i;
    let call = "";
    let grid: string | null = null;
    if (tokens[0] === "CQ") {
      if (tokens.length === 3) {
        if (gridRe.test(tokens[2])) {
          call = tokens[1];
          grid = tokens[2];
        } else {
          call = tokens[2];
        }
      } else if (tokens.length >= 4) {
        call = tokens[2];
        if (gridRe.test(tokens[3])) {
          grid = tokens[3];
        }
      } else if (tokens.length === 2) {
        call = tokens[1];
      }
    } else if (tokens.length >= 2) {
      call = tokens[1];
    }
    if (!call) return;
    await runSessionCmd(
      "qso.reply",
      { callsign: call, their_grid: grid, rx_slot: dec.slot, snr_db: dec.snr_db },
      `Queued reply to ${call}${grid ? ` (${grid})` : ""}`
    );
  };

  const currentAf = activeSession?.tx_af_hz ?? Number(afInput || 1500);
  const txStateStr = daemon.txState?.state ?? activeSession?.tx_state ?? "idle";
  const hasActiveQueuedQso = Boolean(
    activeSession?.tx_enabled &&
      activeSession.active_qsos.some((q) => q.status === "active")
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

  return (
    <div class="console-stack">
      <section class="panel" aria-label="Operating Session Controls">
        <div class="panel-header">
          <div>
            <h2>Operating Console</h2>
            <p class="muted mono">
              {selectedRadio
                ? `${selectedRadio.profile.name} · ${selectedRadio.lifecycle_state.replace(/_/g, " ")} · ${stationLabel} · ${
                    selectedRadio.freq_hz
                      ? `${(selectedRadio.freq_hz / 1_000_000).toFixed(6)} MHz`
                      : "no VFO"
                  } · ${selectedRadio.band ?? "band n/a"} · decoder: ${
                    activeSession?.decoder_backend ?? daemon.preflight?.active_ft8_decoder ?? "auto"
                  }`
                : "No radio profile selected — Start Demo Session or configure in Hardware & Setup"}
            </p>
          </div>
          <div class="panel-actions">
            <select
              class="input-sm"
              aria-label="Active Radio"
              value={effectiveRadioId}
              onChange={(e) =>
                setSelectedRadioId((e.currentTarget as HTMLSelectElement).value)
              }
            >
              {daemon.radios.length === 0 ? (
                <option value="">-- Auto Dummy (-m 1) --</option>
              ) : (
                daemon.radios.map((r) => (
                  <option key={r.profile.radio_id} value={r.profile.radio_id}>
                    {r.profile.name} ({r.lifecycle_state.replace(/_/g, " ")})
                  </option>
                ))
              )}
            </select>
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
              disabled={Boolean(activeSession) || selectedRadio?.lifecycle_state !== "READY"}
              onClick={() => void handleStartLive()}
            >
              Start Live Session
            </button>
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              data-testid="start-demo-btn"
              disabled={Boolean(activeSession)}
              onClick={() => void handleStartDemo()}
            >
              Start Demo Session
            </button>
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              data-testid="stop-session-btn"
              disabled={!activeSession}
              onClick={() => void handleStopSession()}
            >
              Stop Session
            </button>
            <button
              type="button"
              class={`btn btn-sm ${activeSession?.tx_enabled ? "btn-primary" : "btn-secondary"}`}
              disabled={!activeSession}
              onClick={() =>
                void runSessionCmd("qso.set_tx_enabled", {
                  enabled: !(activeSession?.tx_enabled ?? false),
                })
              }
            >
              {activeSession?.tx_enabled ? "TX: ENABLED" : "TX: MUTED"}
            </button>
            <button
              type="button"
              class="btn btn-danger btn-sm"
              onClick={() =>
                void daemon.sendCommand(
                  "tx.halt_emergency",
                  {},
                  undefined,
                  effectiveRadioId || undefined
                )
              }
            >
              HALT TX
            </button>
          </div>
        </div>

        {statusMsg && (
          <div class={statusMsg.ok ? "text-ok mono" : "text-err mono"} style={{ marginBottom: "0.6rem" }}>
            {statusMsg.text}
          </div>
        )}

        {daemon.lastAlert &&
          (daemon.lastAlert.title === "FT8 TX Failed" ||
            daemon.lastAlert.severity === "fatal" ||
            daemon.lastAlert.severity === "warn") && (
            <div
              class={daemon.lastAlert.severity === "fatal" ? "radio-error mono" : "radio-standby mono"}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "0.75rem",
                marginBottom: "0.6rem",
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

        <WaterfallCanvas
          frames={daemon.waterfallFrames}
          txAfHz={currentAf}
          evenOccupiedHz={daemon.evenOccupiedHz}
          oddOccupiedHz={daemon.oddOccupiedHz}
          onSelectAf={(hz) => void handleSetAf(hz)}
        />

        <div class="af-toolbar">
          <div class="cat-group">
            <label class="muted" style={{ fontSize: "0.8rem" }}>TX AF (Hz):</label>
            <input
              type="number"
              class="mono input-xs"
              data-testid="af-input"
              min="200"
              max="3000"
              value={afInput}
              onInput={(e) => setAfInput((e.currentTarget as HTMLInputElement).value)}
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
                void runSessionCmd("qso.survey_af", {}, "Surveying band for clearest AF gap...")
              }
            >
              {activeSession?.survey_active ? "Surveying Clear AF..." : "Survey Clear AF"}
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
            <span class={`badge ${txBadgeClass}`}>
              {txBadgeLabel}
            </span>
          </div>
        </div>
      </section>

      <div class="console-grid">
        <section class="panel" aria-label="Live FT8 Decodes">
          <div class="panel-header">
            <div>
              <h2>Live Decodes ({daemon.recentDecodes.length})</h2>
              <p class="muted">Click Reply to prioritize a station in the daemon QSO queue</p>
            </div>
          </div>
          <div class="table-scroll">
            <table class="data-table mono">
              <thead>
                <tr>
                  <th>UTC</th>
                  <th>Slot</th>
                  <th>SNR</th>
                  <th>dT</th>
                  <th>AF</th>
                  <th>Message</th>
                  <th>Backend</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {daemon.recentDecodes.length === 0 ? (
                  <tr>
                    <td colspan={8} class="muted">
                      Waiting for 15s FT8 decode slot...
                    </td>
                  </tr>
                ) : (
                  daemon.recentDecodes.map((d, idx) => {
                    const isCq = d.message.startsWith("CQ ");
                    const isMine =
                      activeSession?.my_call &&
                      d.message.includes(activeSession.my_call);
                    return (
                      <tr
                        key={`${d.ts_sec}-${d.af_hz}-${idx}`}
                        class={isMine ? "row-mine" : isCq ? "row-cq" : ""}
                      >
                        <td>{new Date(d.ts_sec * 1000).toISOString().slice(11, 19)}</td>
                        <td>{d.slot.toUpperCase()}</td>
                        <td>{d.snr_db >= 0 ? `+${d.snr_db}` : d.snr_db}</td>
                        <td>{d.dt_sec.toFixed(1)}</td>
                        <td>{d.af_hz}</td>
                        <td>{d.message}</td>
                        <td>{d.decoder_backend}</td>
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
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section class="panel" aria-label="QSO Auto-Sequencer and Manual TX">
          <div class="panel-header">
            <div>
              <h2>QSO Sequencer Queue ({activeSession?.active_qsos.length ?? 0})</h2>
              <p class="muted">Daemon-owned auto-sequencer (`CQ → Grid → Rpt → R-Rpt → RR73 → 73`)</p>
            </div>
          </div>

          <div class="cq-bar">
            <select
              class="input-sm"
              value={cqSlot}
              onChange={(e) =>
                setCqSlot((e.currentTarget as HTMLSelectElement).value as "auto" | "even" | "odd")
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
                setCqDirected((e.currentTarget as HTMLInputElement).value.toUpperCase())
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
              onClick={() => void runSessionCmd("tx.cancel", {}, "Cancelled pending TX")}
            >
              Cancel TX
            </button>
          </div>

          <div class="qso-queue">
            {(activeSession?.active_qsos ?? []).length === 0 ? (
              <p class="muted">No active QSOs queued. Click Call CQ or Reply to a decode.</p>
            ) : (
              (activeSession?.active_qsos ?? []).map((q) => (
                <div key={q.qso_id} class="qso-card">
                  <div class="qso-card-top">
                    <span class="mono" style={{ fontWeight: 700 }}>
                      {q.is_cq ? "CQ CALL" : q.their_call}{" "}
                      {q.their_grid ? `(${q.their_grid})` : ""}
                    </span>
                    <div class="hw-badges">
                      <span class="badge badge-info">{q.step}</span>
                      <span class={`badge ${q.status === "active" ? "badge-ok" : "badge-warn"}`}>
                        {q.status.toUpperCase()}
                      </span>
                      <span class="badge badge-info">{q.tx_slot.toUpperCase()}</span>
                    </div>
                  </div>
                  <div class="mono" style={{ fontSize: "0.78rem", color: "var(--accent)" }}>
                    Next TX: {formatQsoStepMessage(q)} · {q.tx_slot.toUpperCase()} slot @ {currentAf} Hz
                  </div>
                  <div class="muted mono" style={{ fontSize: "0.76rem" }}>
                    Attempts: {q.attempts_on_step}/5 · Sent: {q.rst_sent ?? "—"} · Rcvd:{" "}
                    {q.rst_rcvd ?? "—"}
                  </div>
                  <div class="qso-actions">
                    {(q.status === "paused"
                      ? (["resume"] as const)
                      : (["pause"] as const)
                    ).map((act) => (
                      <button
                        key={act}
                        type="button"
                        class="btn btn-secondary btn-xs"
                        onClick={() =>
                          void runSessionCmd("qso.action", { qso_id: q.qso_id, action: act })
                        }
                      >
                        {act}
                      </button>
                    ))}
                    {(["retry", "prev_step", "next_step", "move_up", "move_down"] as const).map(
                      (act) => (
                        <button
                          key={act}
                          type="button"
                          class="btn btn-secondary btn-xs"
                          onClick={() =>
                            void runSessionCmd("qso.action", { qso_id: q.qso_id, action: act })
                          }
                        >
                          {act.replace("_", " ")}
                        </button>
                      )
                    )}
                    {!q.is_cq && (
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
                    )}
                    <button
                      type="button"
                      class="btn btn-danger btn-xs"
                      onClick={() =>
                        void runSessionCmd("qso.action", { qso_id: q.qso_id, action: "abandon" })
                      }
                    >
                      Abandon
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          <div class="manual-tx-bar">
            <select
              class="input-sm"
              value={manualSlot}
              onChange={(e) =>
                setManualSlot((e.currentTarget as HTMLSelectElement).value as "even" | "odd")
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
        </section>
      </div>
    </div>
  );
}
