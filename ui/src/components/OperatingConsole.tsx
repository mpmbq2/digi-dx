import { useEffect, useState } from "preact/hooks";
import type { DaemonState } from "../hooks/useDaemonSocket";
import type { DecodeItem } from "../types";
import { WaterfallCanvas } from "./WaterfallCanvas";

interface Props {
  daemon: DaemonState;
}

export function OperatingConsole({ daemon }: Props) {
  const [selectedRadioId, setSelectedRadioId] = useState<string>("");
  const [demoScale, setDemoScale] = useState<string>("1");
  const [afInput, setAfInput] = useState<string>("1500");
  const [cqSlot, setCqSlot] = useState<"auto" | "even" | "odd">("auto");
  const [cqDirected, setCqDirected] = useState<string>("");
  const [manualSlot, setManualSlot] = useState<"even" | "odd">("even");
  const [manualMsg, setManualMsg] = useState<string>("CQ N1MPM FN33");
  const [statusMsg, setStatusMsg] = useState<{ ok: boolean; text: string } | null>(
    null
  );

  const activeSession = daemon.session?.active ? daemon.session : null;
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
    if (!(await ensureLease(effectiveRadioId))) return;
    await daemon.sendCommand("qso.set_af", { af_hz: clamped }, undefined, effectiveRadioId);
  };

  const handleReplyDecode = async (dec: DecodeItem) => {
    if (!effectiveRadioId) return;
    const tokens = dec.message.trim().split(/\s+/);
    let call = "";
    let grid: string | null = null;
    if (tokens[0] === "CQ") {
      if (tokens.length === 3) {
        call = tokens[1];
        grid = tokens[2];
      } else if (tokens.length >= 4) {
        call = tokens[2];
        grid = tokens[3];
      } else if (tokens.length === 2) {
        call = tokens[1];
      }
    } else if (tokens.length >= 2) {
      call = tokens[1];
    }
    if (!call) return;
    if (!(await ensureLease(effectiveRadioId))) return;
    await daemon.sendCommand(
      "qso.reply",
      { callsign: call, their_grid: grid, rx_slot: dec.slot, snr_db: dec.snr_db },
      undefined,
      effectiveRadioId
    );
  };

  const currentAf = activeSession?.tx_af_hz ?? Number(afInput || 1500);
  const txStateStr = daemon.txState?.state ?? activeSession?.tx_state ?? "idle";

  return (
    <div class="console-stack">
      <section class="panel" aria-label="Operating Session Controls">
        <div class="panel-header">
          <div>
            <h2>Operating Console</h2>
            <p class="muted mono">
              {selectedRadio
                ? `${selectedRadio.profile.name} · ${selectedRadio.lifecycle_state.replace(/_/g, " ")} · ${
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
                void daemon.sendCommand(
                  "qso.set_tx_enabled",
                  { enabled: !(activeSession?.tx_enabled ?? false) },
                  undefined,
                  effectiveRadioId
                )
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
                void daemon.sendCommand("qso.survey_af", {}, undefined, effectiveRadioId)
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
            <span
              class={`badge ${
                txStateStr === "transmitting"
                  ? "badge-fail"
                  : txStateStr === "armed"
                  ? "badge-warn"
                  : "badge-info"
              }`}
            >
              TX: {txStateStr.toUpperCase()}
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
              onClick={() =>
                void daemon.sendCommand(
                  "qso.call_cq",
                  {
                    ...(cqSlot === "auto" ? {} : { slot: cqSlot }),
                    directed: cqDirected.trim() || null,
                  },
                  undefined,
                  effectiveRadioId
                )
              }
            >
              Call CQ
            </button>
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              disabled={!activeSession}
              onClick={() =>
                void daemon.sendCommand("tx.cancel", {}, undefined, effectiveRadioId)
              }
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
                          void daemon.sendCommand(
                            "qso.action",
                            { qso_id: q.qso_id, action: act },
                            undefined,
                            effectiveRadioId
                          )
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
                            void daemon.sendCommand(
                              "qso.action",
                              { qso_id: q.qso_id, action: act },
                              undefined,
                              effectiveRadioId
                            )
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
                          void daemon.sendCommand(
                            "qso.action",
                            { qso_id: q.qso_id, action: "complete" },
                            undefined,
                            effectiveRadioId
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
                        void daemon.sendCommand(
                          "qso.action",
                          { qso_id: q.qso_id, action: "abandon" },
                          undefined,
                          effectiveRadioId
                        )
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
              value={manualMsg}
              onInput={(e) =>
                setManualMsg((e.currentTarget as HTMLInputElement).value.toUpperCase())
              }
            />
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              disabled={!activeSession}
              onClick={() =>
                void daemon.sendCommand(
                  "tx.arm",
                  { af_hz: currentAf, slot: manualSlot, message: manualMsg },
                  undefined,
                  effectiveRadioId
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
