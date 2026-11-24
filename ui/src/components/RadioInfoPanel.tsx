import { useEffect, useMemo, useState } from "preact/hooks";
import type { DaemonState } from "../hooks/useDaemonSocket";
import type { RadioSummary } from "../types";
import {
  BAUD_RATES,
  FT8_BAND_PRESETS,
  POPULAR_MODEL_IDS,
  formatFreqMhz,
  formatLifecycleLabel,
  lifecycleBadgeClass,
} from "../utils/radioHelpers";

interface Props {
  daemon: DaemonState;
  radio: RadioSummary;
  onOpenFt8: () => void;
  onDeleted: () => void;
}

const LEVEL_META: Record<
  string,
  { label: string; min: number; max: number; step: number; unit: string; scalePct: boolean }
> = {
  RFPOWER: { label: "RF Power", min: 0, max: 1, step: 0.01, unit: "%", scalePct: true },
  AF: { label: "AF Gain", min: 0, max: 1, step: 0.01, unit: "%", scalePct: true },
  RF: { label: "RF Gain", min: 0, max: 1, step: 0.01, unit: "%", scalePct: true },
  SQL: { label: "Squelch", min: 0, max: 1, step: 0.01, unit: "%", scalePct: true },
  MICGAIN: { label: "Mic Gain", min: 0, max: 1, step: 0.01, unit: "%", scalePct: true },
  NR: { label: "NR Level", min: 0, max: 1, step: 0.01, unit: "%", scalePct: true },
  NB: { label: "NB Level", min: 0, max: 1, step: 0.01, unit: "%", scalePct: true },
  COMP: { label: "Compression", min: 0, max: 1, step: 0.01, unit: "%", scalePct: true },
  KEYSPD: { label: "CW Key Speed", min: 4, max: 60, step: 1, unit: " WPM", scalePct: false },
};

const FUNC_LABELS: Record<string, string> = {
  TUNER: "ATU / Tuner",
  NB: "Noise Blanker",
  NR: "Noise Reduction",
  COMP: "Speech Comp",
  VOX: "VOX",
  LOCK: "Dial Lock",
  ANF: "Auto Notch",
  MON: "TX Monitor",
  RIT: "RIT",
  XIT: "XIT",
};

function strengthToSUnits(db: number | null | undefined): { label: string; pct: number } {
  if (db === null || db === undefined) return { label: "—", pct: 0 };
  // Hamlib STRENGTH: 0 dB = S9, -6 dB per S-unit down to -54 (S0)
  if (db <= 0) {
    const s = Math.max(0, Math.min(9, Math.round(9 + db / 6)));
    return { label: `S${s} (${db} dB)`, pct: Math.max(4, Math.min(65, ((db + 54) / 54) * 65)) };
  }
  const over = Math.min(60, db);
  return {
    label: `S9+${over} (${db >= 0 ? "+" : ""}${db} dB)`,
    pct: 65 + (over / 60) * 35,
  };
}

export function RadioInfoPanel({ daemon, radio, onOpenFt8, onDeleted }: Props) {
  const rid = radio.profile.radio_id;
  const caps = radio.capabilities;
  const settings = radio.settings;
  const isReady = radio.lifecycle_state === "READY";
  const canControlCat = isReady || radio.lifecycle_state === "ACTIVE_SESSION";

  const [freqInput, setFreqInput] = useState(
    radio.freq_hz ? String(radio.freq_hz) : "14074000"
  );
  const [modeInput, setModeInput] = useState(radio.mode ?? "USB");
  const [pbInput, setPbInput] = useState(
    radio.passband_hz !== null ? String(radio.passband_hz) : "2400"
  );
  const [ritInput, setRitInput] = useState(String(settings?.rit_hz ?? 0));
  const [xitInput, setXitInput] = useState(String(settings?.xit_hz ?? 0));
  const [localLevels, setLocalLevels] = useState<Record<string, number>>({});
  const [statusMsg, setStatusMsg] = useState<{ ok: boolean; text: string } | null>(
    null
  );
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Profile editor state
  const [profName, setProfName] = useState(radio.profile.name);
  const [modelQuery, setModelQuery] = useState("");
  const [hamlibModel, setHamlibModel] = useState(radio.profile.hamlib_model);
  const [serialKey, setSerialKey] = useState(radio.profile.serial_device_key ?? "");
  const [baudRate, setBaudRate] = useState(radio.profile.serial_baud_rate);
  const [civAddress, setCivAddress] = useState(radio.profile.civ_address ?? "");
  const [pttMethod, setPttMethod] = useState(radio.profile.ptt_method);
  const [audioUid, setAudioUid] = useState(radio.profile.audio_device_uid ?? "");
  const [audioRxChannel, setAudioRxChannel] = useState(
    radio.profile.audio_rx_channel ?? "mono"
  );
  const [audioTxGainDb, setAudioTxGainDb] = useState(
    radio.profile.audio_tx_gain_db ?? -6
  );
  const [autoConnect, setAutoConnect] = useState(radio.profile.auto_connect);

  useEffect(() => {
    if (radio.freq_hz) setFreqInput(String(radio.freq_hz));
  }, [radio.freq_hz]);

  useEffect(() => {
    if (radio.mode) setModeInput(radio.mode);
    if (radio.passband_hz !== null) setPbInput(String(radio.passband_hz));
  }, [radio.mode, radio.passband_hz]);

  useEffect(() => {
    if (settings?.rit_hz !== null && settings?.rit_hz !== undefined) {
      setRitInput(String(settings.rit_hz));
    }
    if (settings?.xit_hz !== null && settings?.xit_hz !== undefined) {
      setXitInput(String(settings.xit_hz));
    }
  }, [settings?.rit_hz, settings?.xit_hz]);

  useEffect(() => {
    setProfName(radio.profile.name);
    setHamlibModel(radio.profile.hamlib_model);
    setSerialKey(radio.profile.serial_device_key ?? "");
    setBaudRate(radio.profile.serial_baud_rate);
    setCivAddress(radio.profile.civ_address ?? "");
    setPttMethod(radio.profile.ptt_method);
    setAudioUid(radio.profile.audio_device_uid ?? "");
    setAudioRxChannel(radio.profile.audio_rx_channel ?? "mono");
    setAudioTxGainDb(radio.profile.audio_tx_gain_db ?? -6);
    setAutoConnect(radio.profile.auto_connect);
    setConfirmDelete(false);
    setLocalLevels({});
  }, [rid, radio.profile]);

  const filteredModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    const list = daemon.hamlibModels.length
      ? daemon.hamlibModels
      : [{ id: 1, manufacturer: "Hamlib", model: "Dummy", status: "Stable" }];
    if (!q) {
      const top = list.filter(
        (m) => POPULAR_MODEL_IDS.includes(m.id) || m.id === hamlibModel
      );
      const rest = list
        .filter((m) => !POPULAR_MODEL_IDS.includes(m.id) && m.id !== hamlibModel)
        .slice(0, 60);
      return [...top, ...rest];
    }
    return list
      .filter(
        (m) =>
          String(m.id).includes(q) ||
          m.manufacturer.toLowerCase().includes(q) ||
          m.model.toLowerCase().includes(q)
      )
      .slice(0, 80);
  }, [daemon.hamlibModels, modelQuery, hamlibModel]);

  const holdsLease =
    radio.lease_holder === daemon.actor ||
    (Boolean(daemon.heldLeases[rid]) && radio.lease_holder === null);

  const ensureLeaseAndRun = async (
    kind: string,
    payload: Record<string, unknown>,
    okText?: string
  ) => {
    if (!holdsLease) {
      const claimAck = await daemon.claimLease(rid, false);
      if (claimAck.status !== "ok") {
        setStatusMsg({
          ok: false,
          text: `${claimAck.error_code ?? "ERR"}: ${claimAck.error_message ?? "Lease failed"}`,
        });
        return;
      }
    }
    const ack = await daemon.sendCommand(kind, payload, undefined, rid);
    setStatusMsg({
      ok: ack.status === "ok",
      text:
        ack.status === "ok"
          ? okText ?? `${kind} ok`
          : `${ack.error_code ?? "ERR"}: ${ack.error_message ?? `${kind} failed`}`,
    });
  };

  const runDirectCmd = async (
    kind: string,
    payload: Record<string, unknown>,
    okText?: string
  ) => {
    const ack = await daemon.sendCommand(kind, payload, undefined, rid);
    setStatusMsg({
      ok: ack.status === "ok",
      text:
        ack.status === "ok"
          ? okText ?? `${kind} ok`
          : `${ack.error_code ?? "ERR"}: ${ack.error_message ?? `${kind} failed`}`,
    });
    return ack;
  };

  const handleSaveProfile = async (e: Event) => {
    e.preventDefault();
    const isDummy = hamlibModel === 1;
    const selectedAudio = daemon.audioDevices.find(
      (a) => a.device_uid === audioUid
    );
    await runDirectCmd(
      "radio.update_profile",
      {
        radio_id: rid,
        name: profName.trim(),
        hamlib_model: Number(hamlibModel),
        is_dummy: isDummy,
        serial_device_key: isDummy ? "" : serialKey,
        serial_baud_rate: Number(baudRate),
        civ_address: civAddress.trim(),
        ptt_method: pttMethod,
        audio_device_uid: selectedAudio ? selectedAudio.device_uid : "",
        audio_device_name: selectedAudio ? selectedAudio.name : "",
        audio_rx_channel: audioRxChannel,
        audio_tx_gain_db: Number(audioTxGainDb),
        auto_connect: autoConnect,
      },
      "Radio profile updated"
    );
  };

  const modeChoices = useMemo(() => {
    if (caps?.modes && caps.modes.length > 0) return caps.modes;
    return ["USB", "PKTUSB", "LSB", "CW", "FM", "AM"];
  }, [caps?.modes]);

  const sliderLevels = useMemo(() => {
    const setList = caps?.set_levels ?? [];
    return setList.filter((name) => Boolean(LEVEL_META[name]));
  }, [caps?.set_levels]);

  const funcChoices = useMemo(() => {
    return caps?.set_funcs ?? [];
  }, [caps?.set_funcs]);

  const sMeter = strengthToSUnits(settings?.strength_db);

  return (
    <div class="console-stack" data-testid="radio-info-panel">
      {/* Live Telemetry & Status Header */}
      <section class="panel" aria-label="Radio Live Status">
        <div class="panel-header">
          <div>
            <h2>{radio.profile.name}</h2>
            <p class="muted mono">
              Hamlib #{radio.profile.hamlib_model} · 127.0.0.1:{radio.profile.rigctld_port}
              {radio.rigctld_pid ? ` (pid ${radio.rigctld_pid})` : ""}
              {radio.bound_serial_path ? ` · ${radio.bound_serial_path}` : ""}
            </p>
          </div>
          <div class="panel-actions">
            <span class={`badge ${lifecycleBadgeClass(radio.lifecycle_state)}`}>
              {formatLifecycleLabel(radio.lifecycle_state)}
            </span>
            {canControlCat && (
              <span class={`badge ${radio.ptt ? "badge-fail" : "badge-ok"}`}>
                {radio.ptt ? "TX" : "RX"}
              </span>
            )}
            {holdsLease ? (
              <button
                type="button"
                class="btn btn-secondary btn-sm"
                onClick={() => void daemon.releaseLease(rid)}
              >
                Release Lease
              </button>
            ) : (
              <button
                type="button"
                class="btn btn-primary btn-sm"
                onClick={() => void daemon.claimLease(rid, false)}
              >
                Claim Control
              </button>
            )}
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              disabled={!canControlCat}
              onClick={() =>
                void runDirectCmd("radio.refresh_settings", {}, "CAT settings refreshed")
              }
            >
              Refresh CAT
            </button>
            <button
              type="button"
              class="btn btn-danger btn-sm"
              onClick={() => void runDirectCmd("tx.halt_emergency", {}, "Emergency halt sent")}
            >
              Halt TX
            </button>
            <button
              type="button"
              class="btn btn-primary btn-sm"
              onClick={onOpenFt8}
            >
              FT8 Operation →
            </button>
          </div>
        </div>

        <div class="vfo-strip">
          <span class="vfo-freq mono">{formatFreqMhz(radio.freq_hz)}</span>
          {radio.band && <span class="badge badge-info">{radio.band}</span>}
          {settings?.vfo && <span class="badge badge-muted">{settings.vfo}</span>}
          {settings?.split && (
            <span class="badge badge-warn">
              SPLIT {settings.tx_vfo ? `→ ${settings.tx_vfo}` : ""}
            </span>
          )}
          {radio.mode && (
            <span class="mono muted">
              {radio.mode}
              {radio.passband_hz ? ` · ${radio.passband_hz} Hz` : ""}
            </span>
          )}
          {settings?.rf_power_watts !== null && settings?.rf_power_watts !== undefined && (
            <span class="badge badge-info">{settings.rf_power_watts.toFixed(1)} W</span>
          )}
          <div class="s-meter" title="Receiver S-Meter">
            <span class="muted mono" style={{ fontSize: "0.74rem" }}>
              S: {sMeter.label}
            </span>
            <div class="s-meter-track">
              <div class="s-meter-fill" style={{ width: `${sMeter.pct}%` }} />
            </div>
          </div>
          <span class="lease-tag mono muted">
            {radio.lease_holder
              ? holdsLease
                ? "Lease: YOU"
                : `Lease: ${radio.lease_holder}`
              : "Lease: unclaimed"}
          </span>
        </div>

        {radio.last_error && (
          <div class="radio-error mono" style={{ marginTop: "0.6rem" }}>
            {radio.last_error}
          </div>
        )}
        {radio.lifecycle_state === "POWERED_OFF" && (
          <div class="radio-standby" style={{ marginTop: "0.6rem" }}>
            USB cable is plugged in, but transceiver is not responding to CAT (appears powered off — if turned on, verify baud rate &amp; CI-V).
          </div>
        )}
        {statusMsg && (
          <div
            class={statusMsg.ok ? "text-ok mono" : "text-err mono"}
            style={{ marginTop: "0.55rem" }}
          >
            {statusMsg.text}
          </div>
        )}
      </section>

      <div class="main-grid">
        {/* VFO, Band, Mode, Split, RIT/XIT */}
        <section class="panel" aria-label="Frequency, Mode and VFO Controls">
          <div class="panel-header">
            <div>
              <h2>VFO, Band &amp; Mode</h2>
              <p class="muted">
                Quick FT8 dial presets and full transceiver VFO / mode controls
              </p>
            </div>
          </div>

          <div class="console-stack" style={{ gap: "0.75rem" }}>
            <div class="preset-row">
              {FT8_BAND_PRESETS.map((p) => (
                <button
                  key={p.band}
                  type="button"
                  class={`btn btn-xs ${
                    radio.band === p.band ? "btn-primary" : "btn-secondary"
                  }`}
                  disabled={!isReady}
                  onClick={() =>
                    void ensureLeaseAndRun(
                      "radio.set_freq",
                      { freq_hz: p.hz },
                      `Tuned to ${p.band} (${p.mhz} MHz)`
                    )
                  }
                >
                  {p.band} {p.mhz}
                </button>
              ))}
            </div>

            <div class="cat-controls">
              <div class="cat-group">
                <label class="muted" style={{ fontSize: "0.78rem" }}>
                  Dial Hz:
                </label>
                <input
                  type="number"
                  class="mono input-sm"
                  value={freqInput}
                  onInput={(e) =>
                    setFreqInput((e.currentTarget as HTMLInputElement).value)
                  }
                />
                <button
                  type="button"
                  class="btn btn-secondary btn-sm"
                  disabled={!isReady}
                  onClick={() =>
                    void ensureLeaseAndRun("radio.set_freq", {
                      freq_hz: Number(freqInput),
                    })
                  }
                >
                  Set Hz
                </button>
              </div>

              <div class="cat-group">
                <label class="muted" style={{ fontSize: "0.78rem" }}>
                  Mode:
                </label>
                <select
                  class="input-sm"
                  aria-label="Rig Mode"
                  value={modeInput}
                  onChange={(e) =>
                    setModeInput((e.currentTarget as HTMLSelectElement).value)
                  }
                >
                  {modeChoices.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  class="mono input-xs"
                  aria-label="Passband Hz"
                  value={pbInput}
                  onInput={(e) =>
                    setPbInput((e.currentTarget as HTMLInputElement).value)
                  }
                />
                <button
                  type="button"
                  class="btn btn-secondary btn-sm"
                  disabled={!isReady}
                  onClick={() =>
                    void ensureLeaseAndRun("radio.set_mode", {
                      mode: modeInput,
                      passband_hz: Number(pbInput),
                    })
                  }
                >
                  Set Mode
                </button>
              </div>
            </div>

            {caps && caps.vfos.length > 0 && (
              <div class="cat-controls">
                <span class="muted" style={{ fontSize: "0.78rem" }}>
                  Active VFO:
                </span>
                <div class="seg-group">
                  {caps.vfos.map((vfo) => (
                    <button
                      key={vfo}
                      type="button"
                      class={`btn btn-xs ${
                        settings?.vfo === vfo ? "btn-primary" : "btn-secondary"
                      }`}
                      disabled={!isReady}
                      onClick={() =>
                        void ensureLeaseAndRun("radio.set_vfo", { vfo })
                      }
                    >
                      {vfo}
                    </button>
                  ))}
                </div>

                {caps.has_split && (
                  <button
                    type="button"
                    class={`btn btn-xs ${
                      settings?.split ? "btn-primary" : "btn-secondary"
                    }`}
                    disabled={!isReady}
                    onClick={() =>
                      void ensureLeaseAndRun("radio.set_split", {
                        enabled: !(settings?.split ?? false),
                        tx_vfo: settings?.vfo === "VFOB" ? "VFOA" : "VFOB",
                      })
                    }
                  >
                    Split: {settings?.split ? "ON" : "OFF"}
                  </button>
                )}
              </div>
            )}

            {(caps?.max_rit_hz || caps?.max_xit_hz) && (
              <div class="cat-controls">
                {caps.max_rit_hz && (
                  <div class="cat-group">
                    <label class="muted" style={{ fontSize: "0.78rem" }}>
                      RIT (Hz):
                    </label>
                    <input
                      type="number"
                      class="mono input-xs"
                      min={-caps.max_rit_hz}
                      max={caps.max_rit_hz}
                      value={ritInput}
                      onInput={(e) =>
                        setRitInput((e.currentTarget as HTMLInputElement).value)
                      }
                    />
                    <button
                      type="button"
                      class="btn btn-secondary btn-xs"
                      disabled={!isReady}
                      onClick={() =>
                        void ensureLeaseAndRun("radio.set_rit", {
                          offset_hz: Number(ritInput),
                        })
                      }
                    >
                      Set RIT
                    </button>
                  </div>
                )}
                {caps.max_xit_hz && (
                  <div class="cat-group">
                    <label class="muted" style={{ fontSize: "0.78rem" }}>
                      XIT (Hz):
                    </label>
                    <input
                      type="number"
                      class="mono input-xs"
                      min={-caps.max_xit_hz}
                      max={caps.max_xit_hz}
                      value={xitInput}
                      onInput={(e) =>
                        setXitInput((e.currentTarget as HTMLInputElement).value)
                      }
                    />
                    <button
                      type="button"
                      class="btn btn-secondary btn-xs"
                      disabled={!isReady}
                      onClick={() =>
                        void ensureLeaseAndRun("radio.set_xit", {
                          offset_hz: Number(xitInput),
                        })
                      }
                    >
                      Set XIT
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Dynamic RF, Receiver & DSP Settings */}
        <section class="panel" aria-label="Transceiver RF and DSP Settings">
          <div class="panel-header">
            <div>
              <h2>RF, Receiver &amp; DSP Settings</h2>
              <p class="muted">
                Dynamically discovered from Hamlib model #{radio.profile.hamlib_model} capabilities
              </p>
            </div>
          </div>

          {!canControlCat && (
            <div class="demo-inline-note">
              Radio CAT is currently offline ({formatLifecycleLabel(radio.lifecycle_state)}). Below are the settings supported by this model once connected.
            </div>
          )}

          <div class="console-stack" style={{ gap: "0.85rem" }}>
            {/* Discrete Preamp / ATT / AGC */}
            {caps && (caps.preamp_db.length > 0 || caps.att_db.length > 0 || caps.agc_levels.length > 0) && (
              <div class="discrete-settings">
                {caps.preamp_db.length > 0 && (
                  <div class="setting-row">
                    <span class="muted">Preamp</span>
                    <div class="seg-group">
                      {caps.preamp_db.map((db) => {
                        const cur = Math.round(settings?.levels?.PREAMP ?? 0);
                        return (
                          <button
                            key={db}
                            type="button"
                            class={`btn btn-xs ${
                              cur === db ? "btn-primary" : "btn-secondary"
                            }`}
                            disabled={!isReady}
                            onClick={() =>
                              void ensureLeaseAndRun("radio.set_level", {
                                name: "PREAMP",
                                value: db,
                              })
                            }
                          >
                            {db === 0 ? "Off" : `${db} dB`}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {caps.att_db.length > 0 && (
                  <div class="setting-row">
                    <span class="muted">Attenuator</span>
                    <div class="seg-group">
                      {caps.att_db.map((db) => {
                        const cur = Math.round(settings?.levels?.ATT ?? 0);
                        return (
                          <button
                            key={db}
                            type="button"
                            class={`btn btn-xs ${
                              cur === db ? "btn-primary" : "btn-secondary"
                            }`}
                            disabled={!isReady}
                            onClick={() =>
                              void ensureLeaseAndRun("radio.set_level", {
                                name: "ATT",
                                value: db,
                              })
                            }
                          >
                            {db === 0 ? "Off" : `${db} dB`}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {caps.agc_levels.length > 0 && (
                  <div class="setting-row">
                    <span class="muted">AGC</span>
                    <div class="seg-group">
                      {caps.agc_levels.map((opt) => {
                        const cur = Math.round(settings?.levels?.AGC ?? -1);
                        return (
                          <button
                            key={opt.value}
                            type="button"
                            class={`btn btn-xs ${
                              cur === opt.value ? "btn-primary" : "btn-secondary"
                            }`}
                            disabled={!isReady}
                            onClick={() =>
                              void ensureLeaseAndRun("radio.set_level", {
                                name: "AGC",
                                value: opt.value,
                              })
                            }
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Continuous Level Sliders */}
            {sliderLevels.length > 0 && (
              <div class="sliders-grid">
                {sliderLevels.map((name) => {
                  const meta = LEVEL_META[name];
                  const val =
                    localLevels[name] ??
                    settings?.levels?.[name] ??
                    meta.min;
                  const displayVal = meta.scalePct
                    ? `${Math.round(val * 100)}${meta.unit}`
                    : `${Math.round(val)}${meta.unit}`;
                  return (
                    <label key={name} class="setting-slider">
                      <div class="setting-slider-top">
                        <span>{meta.label}</span>
                        <span class="mono" style={{ color: "var(--accent)" }}>
                          {displayVal}
                          {name === "RFPOWER" &&
                          settings?.rf_power_watts !== null &&
                          settings?.rf_power_watts !== undefined
                            ? ` (${settings.rf_power_watts.toFixed(1)} W)`
                            : ""}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={meta.min}
                        max={meta.max}
                        step={meta.step}
                        value={val}
                        disabled={!isReady}
                        onInput={(e) => {
                          const v = Number((e.currentTarget as HTMLInputElement).value);
                          setLocalLevels((prev) => ({ ...prev, [name]: v }));
                        }}
                        onChange={(e) => {
                          const v = Number((e.currentTarget as HTMLInputElement).value);
                          void ensureLeaseAndRun("radio.set_level", { name, value: v });
                        }}
                      />
                    </label>
                  );
                })}
              </div>
            )}

            {/* Toggle Function Chips */}
            {(funcChoices.length > 0 ||
              (caps?.vfo_ops ?? []).includes("TUNE")) && (
              <div>
                <h3 class="subhead">Transceiver Functions</h3>
                <div class="func-chips">
                  {(caps?.vfo_ops ?? []).includes("TUNE") && (
                    <button
                      type="button"
                      data-testid="radio-info-atu-tune"
                      class="btn btn-xs btn-secondary func-chip"
                      disabled={!isReady || radio.ptt}
                      onClick={() =>
                        void ensureLeaseAndRun(
                          "radio.atu_tune",
                          {},
                          "Internal ATU tune triggered"
                        )
                      }
                    >
                      Run ATU Tune
                    </button>
                  )}
                  {funcChoices.map((fnName) => {
                    const active = Boolean(settings?.funcs?.[fnName]);
                    return (
                      <button
                        key={fnName}
                        type="button"
                        data-testid={`func-toggle-${fnName}`}
                        class={`btn btn-xs func-chip ${
                          active ? "btn-primary" : "btn-secondary"
                        }`}
                        disabled={!isReady}
                        onClick={() =>
                          void ensureLeaseAndRun("radio.set_func", {
                            name: fnName,
                            enabled: !active,
                          })
                        }
                      >
                        {FUNC_LABELS[fnName] ?? fnName}: {active ? "ON" : "OFF"}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Radio Profile, Hardware & Worker Lifecycle */}
      <section class="panel" aria-label="Radio Profile and Worker Configuration">
        <div class="panel-header">
          <div>
            <h2>Radio Profile, Audio &amp; Worker Supervision</h2>
            <p class="muted">
              Update serial/CAT parameters, bind USB audio interface, test PTT, or manage `rigctld`.
            </p>
          </div>
          <div class="panel-actions">
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              disabled={!isReady}
              onClick={() =>
                void runDirectCmd("radio.test_cat", {}, "CAT (+f/+m) check passed")
              }
            >
              Test CAT
            </button>
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              disabled={!isReady}
              onClick={() =>
                void ensureLeaseAndRun(
                  "radio.test_ptt",
                  { duration_ms: 200 },
                  "200ms PTT pulse test completed"
                )
              }
            >
              Test PTT (200ms)
            </button>
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              onClick={() => void runDirectCmd("radio.restart", {}, "Worker restarted")}
            >
              {radio.rigctld_pid
                ? "Restart Worker"
                : radio.lifecycle_state === "POWERED_OFF"
                ? "Probe Now"
                : "Start Worker"}
            </button>
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              disabled={
                radio.lifecycle_state === "CONFIGURED" ||
                radio.lifecycle_state === "DISCONNECTED"
              }
              onClick={() => void runDirectCmd("radio.stop", {}, "Worker stopped")}
            >
              Stop Worker
            </button>
            {confirmDelete ? (
              <>
                <button
                  type="button"
                  class="btn btn-danger btn-sm"
                  onClick={async () => {
                    const ack = await runDirectCmd("radio.delete_profile", {});
                    if (ack.status === "ok") onDeleted();
                  }}
                >
                  Confirm Delete
                </button>
                <button
                  type="button"
                  class="btn btn-secondary btn-sm"
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                class="btn btn-danger btn-sm"
                onClick={() => setConfirmDelete(true)}
              >
                Delete Profile
              </button>
            )}
          </div>
        </div>

        <form class="profile-form" onSubmit={(e) => void handleSaveProfile(e)}>
          <label>
            <span>Profile Name</span>
            <input
              type="text"
              value={profName}
              onInput={(e) =>
                setProfName((e.currentTarget as HTMLInputElement).value)
              }
              required
            />
          </label>
          <label>
            <span>Serial Port (`/dev/serial/by-id`)</span>
            <select
              value={serialKey}
              onChange={(e) =>
                setSerialKey((e.currentTarget as HTMLSelectElement).value)
              }
            >
              <option value="">-- Dummy / No Serial Port --</option>
              {daemon.usbDevices.map((usb) => (
                <option key={usb.device_key} value={usb.device_key}>
                  {usb.os_path} ({usb.is_connected ? "USB PLUGGED" : "UNPLUGGED"})
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Filter Hamlib Models</span>
            <input
              type="text"
              placeholder="Search model..."
              value={modelQuery}
              onInput={(e) =>
                setModelQuery((e.currentTarget as HTMLInputElement).value)
              }
            />
          </label>
          <label>
            <span>Hamlib Rig Model</span>
            <select
              value={hamlibModel}
              onChange={(e) =>
                setHamlibModel(Number((e.currentTarget as HTMLSelectElement).value))
              }
            >
              {filteredModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id} — {m.manufacturer} {m.model}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Baud Rate</span>
            <select
              value={baudRate}
              onChange={(e) =>
                setBaudRate(Number((e.currentTarget as HTMLSelectElement).value))
              }
            >
              {BAUD_RATES.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>PTT Method</span>
            <select
              value={pttMethod}
              onChange={(e) =>
                setPttMethod((e.currentTarget as HTMLSelectElement).value)
              }
            >
              <option value="cat">CAT (+T 1)</option>
              <option value="cat_data">CAT Data (+T 3)</option>
              <option value="rts">Serial RTS</option>
              <option value="dtr">Serial DTR</option>
              <option value="vox">VOX / SignaLink</option>
            </select>
          </label>
          <label>
            <span>Icom CI-V Hex (optional)</span>
            <input
              type="text"
              placeholder="e.g. 0x94"
              value={civAddress}
              onInput={(e) =>
                setCivAddress((e.currentTarget as HTMLInputElement).value)
              }
            />
          </label>
          <label>
            <span>Audio Interface (USB UID)</span>
            <select
              value={audioUid}
              onChange={(e) =>
                setAudioUid((e.currentTarget as HTMLSelectElement).value)
              }
            >
              <option value="">-- Unassigned / Demo Only --</option>
              {daemon.audioDevices
                .filter((a) => a.supports_input && a.supports_output)
                .map((dev) => (
                  <option key={dev.device_uid} value={dev.device_uid}>
                    {dev.usb_vid ? `[USB ${dev.usb_vid}:${dev.usb_pid}] ` : ""}
                    {dev.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            <span>RX Audio Channel</span>
            <select
              value={audioRxChannel}
              onChange={(e) =>
                setAudioRxChannel((e.currentTarget as HTMLSelectElement).value)
              }
            >
              <option value="mono">Mono Mix</option>
              <option value="left">Left</option>
              <option value="right">Right</option>
            </select>
          </label>
          <label>
            <span>TX Audio Gain (dB)</span>
            <input
              type="number"
              step="1"
              min="-30"
              max="0"
              value={audioTxGainDb}
              onInput={(e) =>
                setAudioTxGainDb(Number((e.currentTarget as HTMLInputElement).value))
              }
            />
          </label>
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={autoConnect}
              onChange={(e) =>
                setAutoConnect((e.currentTarget as HTMLInputElement).checked)
              }
            />
            <span>Auto-connect `rigctld` on startup &amp; hot-plug</span>
          </label>
          <div class="form-actions">
            <button class="btn btn-primary btn-sm" type="submit">
              Save Radio Profile
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
