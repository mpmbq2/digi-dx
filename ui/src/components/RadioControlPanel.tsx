import { useMemo, useState } from "preact/hooks";
import type {
  AudioDeviceSummary,
  CommandAck,
  HamlibModel,
  RadioSummary,
  UsbInventoryEntry,
} from "../types";

interface Props {
  actor: string;
  usbDevices: UsbInventoryEntry[];
  audioDevices: AudioDeviceSummary[];
  hamlibModels: HamlibModel[];
  radios: RadioSummary[];
  heldLeases: Record<string, string>;
  onSendCommand: (
    kind: string,
    payload: Record<string, unknown>,
    token?: string,
    radioId?: string
  ) => Promise<CommandAck>;
  onClaimLease: (radioId: string, force?: boolean) => Promise<CommandAck>;
  onReleaseLease: (radioId: string) => Promise<CommandAck>;
}

const FT8_BAND_PRESETS: Array<{ band: string; hz: number; mhz: string }> = [
  { band: "80m", hz: 3_573_000, mhz: "3.573" },
  { band: "40m", hz: 7_074_000, mhz: "7.074" },
  { band: "30m", hz: 10_136_000, mhz: "10.136" },
  { band: "20m", hz: 14_074_000, mhz: "14.074" },
  { band: "17m", hz: 18_100_000, mhz: "18.100" },
  { band: "15m", hz: 21_074_000, mhz: "21.074" },
  { band: "10m", hz: 28_074_000, mhz: "28.074" },
  { band: "6m", hz: 50_313_000, mhz: "50.313" },
];

const POPULAR_MODEL_IDS = [1, 2016, 2031, 3073, 3085, 1035, 1042, 2045];

function lifecycleBadgeClass(state: string): string {
  switch (state) {
    case "READY":
    case "ACTIVE_SESSION":
      return "badge-ok";
    case "STARTING_RIGCTLD":
    case "RECOVERING":
    case "CONFIGURED":
      return "badge-info";
    case "DEGRADED":
      return "badge-fail";
    case "DISCONNECTED":
    default:
      return "badge-warn";
  }
}

function formatFreqMhz(freqHz: number | null): string {
  if (freqHz === null || freqHz <= 0) return "—";
  return `${(freqHz / 1_000_000).toFixed(6)} MHz`;
}

function suggestModelForUsb(usb: UsbInventoryEntry): number {
  const hint = `${usb.os_path} ${usb.usb_serial ?? ""} ${usb.product ?? ""}`.toUpperCase();
  if (hint.includes("7300")) return 3073;
  if (hint.includes("705")) return 3085;
  if (hint.includes("570")) return 2016;
  if (hint.includes("590")) return 2031;
  if (hint.includes("991")) return 1035;
  return 2016;
}

export function RadioControlPanel({
  actor,
  usbDevices,
  audioDevices,
  hamlibModels,
  radios,
  heldLeases,
  onSendCommand,
  onClaimLease,
  onReleaseLease,
}: Props) {
  const [showForm, setShowForm] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const [hamlibModel, setHamlibModel] = useState<number>(2016);
  const [serialKey, setSerialKey] = useState<string>("");
  const [baudRate, setBaudRate] = useState<number>(9600);
  const [civAddress, setCivAddress] = useState<string>("");
  const [pttMethod, setPttMethod] = useState<string>("cat");
  const [audioUid, setAudioUid] = useState<string>("");
  const [audioRxChannel, setAudioRxChannel] = useState<string>("mono");
  const [audioTxGainDb, setAudioTxGainDb] = useState<number>(-6);
  const [autoConnect, setAutoConnect] = useState<boolean>(true);
  const [formMsg, setFormMsg] = useState<{ ok: boolean; text: string } | null>(
    null
  );

  const [freqInputs, setFreqInputs] = useState<Record<string, string>>({});
  const [modeInputs, setModeInputs] = useState<Record<string, string>>({});
  const [pbInputs, setPbInputs] = useState<Record<string, string>>({});
  const [radioAckMsg, setRadioAckMsg] = useState<
    Record<string, { ok: boolean; text: string }>
  >({});

  const filteredModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    const list = hamlibModels.length
      ? hamlibModels
      : [{ id: 1, manufacturer: "Hamlib", model: "Dummy", status: "Stable" }];
    if (!q) {
      const top = list.filter((m) => POPULAR_MODEL_IDS.includes(m.id));
      const rest = list
        .filter((m) => !POPULAR_MODEL_IDS.includes(m.id))
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
  }, [hamlibModels, modelQuery]);

  const openAssignFormForUsb = (usb: UsbInventoryEntry) => {
    const suggested = suggestModelForUsb(usb);
    const label = usb.product || usb.manufacturer || "Transceiver";
    setProfileName(`${label} (${usb.usb_serial ?? "CAT"})`);
    setSerialKey(usb.device_key);
    setHamlibModel(suggested);
    setBaudRate(suggested === 3073 || suggested === 3085 ? 115200 : 9600);
    setPttMethod("cat");
    const usbDuplex = audioDevices.find(
      (a) => a.supports_input && a.supports_output && Boolean(a.usb_vid)
    );
    setAudioUid(usbDuplex?.device_uid ?? "");
    setAudioRxChannel("mono");
    setAudioTxGainDb(-6);
    setAutoConnect(true);
    setFormMsg(null);
    setShowForm(true);
  };

  const handleAddDummy = async () => {
    const num = radios.filter((r) => r.profile.is_dummy).length + 1;
    const ack = await onSendCommand("radio.create_profile", {
      name: `Dummy Rig #${num} (-m 1)`,
      hamlib_model: 1,
      is_dummy: true,
      ptt_method: "cat",
      auto_connect: true,
    });
    if (ack.status !== "ok") {
      setFormMsg({
        ok: false,
        text: `${ack.error_code ?? "ERR"}: ${ack.error_message ?? "Failed"}`,
      });
    }
  };

  const handleCreateProfile = async (e: Event) => {
    e.preventDefault();
    setFormMsg(null);
    const isDummy = hamlibModel === 1;
    const selectedAudio = audioDevices.find((a) => a.device_uid === audioUid);
    const ack = await onSendCommand("radio.create_profile", {
      name: profileName.trim(),
      hamlib_model: Number(hamlibModel),
      is_dummy: isDummy,
      serial_device_key: isDummy || !serialKey ? null : serialKey,
      serial_baud_rate: Number(baudRate),
      civ_address: civAddress.trim() ? civAddress.trim() : null,
      ptt_method: pttMethod,
      audio_device_uid: selectedAudio ? selectedAudio.device_uid : null,
      audio_device_name: selectedAudio ? selectedAudio.name : null,
      audio_rx_channel: audioRxChannel,
      audio_tx_gain_db: Number(audioTxGainDb),
      auto_connect: autoConnect,
    });
    if (ack.status === "ok") {
      setShowForm(false);
      setProfileName("");
      setFormMsg({ ok: true, text: "Radio profile created and worker started." });
    } else {
      setFormMsg({
        ok: false,
        text: `${ack.error_code ?? "ERR"}: ${ack.error_message ?? "Rejected"}`,
      });
    }
  };

  const runRadioCmd = async (
    radioId: string,
    kind: string,
    payload: Record<string, unknown>
  ) => {
    const ack = await onSendCommand(kind, payload, undefined, radioId);
    setRadioAckMsg((prev) => ({
      ...prev,
      [radioId]: {
        ok: ack.status === "ok",
        text:
          ack.status === "ok"
            ? `${kind} ok`
            : `${ack.error_code ?? "ERR"}: ${ack.error_message ?? "failed"}`,
      },
    }));
  };

  const ensureLeaseAndRun = async (
    radio: RadioSummary,
    kind: string,
    payload: Record<string, unknown>
  ) => {
    const rid = radio.profile.radio_id;
    const isMine = radio.lease_holder === actor;
    if (!isMine) {
      const claimAck = await onClaimLease(rid, false);
      if (claimAck.status !== "ok") {
        setRadioAckMsg((prev) => ({
          ...prev,
          [rid]: {
            ok: false,
            text: `${claimAck.error_code ?? "ERR"}: ${claimAck.error_message ?? "lease failed"}`,
          },
        }));
        return;
      }
    }
    await runRadioCmd(rid, kind, payload);
  };

  return (
    <section class="panel" aria-label="Hot-Plug USB Discovery and Supervised Radios">
      <div class="panel-header">
        <div>
          <h2>USB Serial Discovery &amp; Supervised Transceivers</h2>
          <p class="muted">
            Real-time hot-plug watcher + per-radio Hamlib `rigctld` lifecycle &amp; CAT control
          </p>
        </div>
        <div class="panel-actions">
          <button
            class="btn btn-secondary"
            type="button"
            onClick={() => void handleAddDummy()}
          >
            + Add Dummy Rig (-m 1)
          </button>
          <button
            class="btn btn-primary"
            type="button"
            onClick={() => {
              setShowForm((s) => !s);
              setFormMsg(null);
            }}
          >
            {showForm ? "Close Form" : "+ Assign / New Radio"}
          </button>
        </div>
      </div>

      {formMsg && (
        <p class={formMsg.ok ? "text-ok" : "text-err"} style={{ marginBottom: "0.75rem" }}>
          {formMsg.text}
        </p>
      )}

      {showForm && (
        <form class="profile-form" onSubmit={(e) => void handleCreateProfile(e)}>
          <label>
            <span>Profile Name</span>
            <input
              type="text"
              placeholder="e.g. Kenwood TS-570S (Shack)"
              value={profileName}
              onInput={(e) =>
                setProfileName((e.currentTarget as HTMLInputElement).value)
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
              {usbDevices.map((usb) => (
                <option key={usb.device_key} value={usb.device_key}>
                  {usb.os_path} ({usb.is_connected ? "ONLINE" : "OFFLINE"})
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Filter Hamlib Models</span>
            <input
              type="text"
              placeholder="Search e.g. TS-570, IC-7300, 3073..."
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
              {[4800, 9600, 19200, 38400, 57600, 115200].map((b) => (
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
              placeholder="e.g. 0x94 (blank for default)"
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
              {audioDevices
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
          <p class="muted" style={{ gridColumn: "1 / -1", fontSize: "0.78rem" }}>
            Safety: RTS &amp; DTR serial lines are forced OFF by default for CAT/VOX so opening the port will not key TX.
          </p>
          <div class="form-actions">
            <button class="btn btn-primary" type="submit">
              Save &amp; Start Radio Worker
            </button>
          </div>
        </form>
      )}

      <div class="radio-split-grid">
        <div>
          <h3 class="subhead">USB Serial Ports ({usbDevices.length})</h3>
          {usbDevices.length === 0 ? (
            <p class="muted">
              No USB serial CAT cables detected. Plug in a cable to see live hot-plug discovery.
            </p>
          ) : (
            <ul class="hw-list">
              {usbDevices.map((usb) => (
                <li key={usb.device_key} class="hw-item usb-item">
                  <div class="usb-meta-col">
                    <div class="hw-name mono">{usb.os_path}</div>
                    <div class="muted mono hw-meta">
                      {usb.real_tty_path ?? "unmapped"} ·{" "}
                      {usb.usb_vid && usb.usb_pid
                        ? `${usb.usb_vid}:${usb.usb_pid}`
                        : "vid:pid n/a"}
                      {usb.usb_serial ? ` · sn:${usb.usb_serial}` : ""}
                      {usb.product ? ` · ${usb.product}` : ""}
                    </div>
                  </div>
                  <div class="hw-badges">
                    <span
                      class={`badge ${usb.is_connected ? "badge-ok" : "badge-warn"}`}
                    >
                      {usb.is_connected ? "ONLINE" : "OFFLINE"}
                    </span>
                    <span class="badge badge-info">{usb.device_state}</span>
                    {!usb.assigned_radio_id && (
                      <button
                        class="btn btn-secondary btn-sm"
                        type="button"
                        onClick={() => openAssignFormForUsb(usb)}
                      >
                        Assign Rig
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 class="subhead">Supervised Radio Workers ({radios.length})</h3>
          {radios.length === 0 ? (
            <p class="muted">
              No radio profiles yet. Click &ldquo;+ Add Dummy Rig (-m 1)&rdquo; or assign a discovered USB port.
            </p>
          ) : (
            <div class="radio-cards">
              {radios.map((radio) => {
                const rid = radio.profile.radio_id;
                const holdsLease =
                  radio.lease_holder === actor ||
                  (Boolean(heldLeases[rid]) && radio.lease_holder === null);
                const freqText =
                  freqInputs[rid] ??
                  (radio.freq_hz ? String(radio.freq_hz) : "14074000");
                const modeText = modeInputs[rid] ?? radio.mode ?? "USB";
                const pbText =
                  pbInputs[rid] ??
                  (radio.passband_hz !== null ? String(radio.passband_hz) : "2400");
                const ackInfo = radioAckMsg[rid];

                return (
                  <div key={rid} class="radio-card">
                    <div class="radio-card-head">
                      <div>
                        <div class="radio-title">{radio.profile.name}</div>
                        <div class="muted mono">
                          model {radio.profile.hamlib_model} · 127.0.0.1:
                          {radio.profile.rigctld_port}
                          {radio.rigctld_pid ? ` (pid ${radio.rigctld_pid})` : ""}
                        </div>
                        {radio.bound_serial_path && (
                          <div class="muted mono" style={{ fontSize: "0.74rem" }}>
                            {radio.bound_serial_path}
                          </div>
                        )}
                        {radio.profile.audio_device_name && (
                          <div class="muted mono" style={{ fontSize: "0.72rem" }}>
                            Audio: {radio.profile.audio_device_name} ({radio.profile.audio_rx_channel ?? "mono"})
                          </div>
                        )}
                      </div>
                      <div class="hw-badges">
                        <span
                          class={`badge ${lifecycleBadgeClass(radio.lifecycle_state)}`}
                        >
                          {radio.lifecycle_state}
                        </span>
                        <span
                          class={`badge ${radio.ptt ? "badge-fail" : "badge-ok"}`}
                        >
                          {radio.ptt ? "TX" : "RX"}
                        </span>
                      </div>
                    </div>

                    <div class="vfo-strip">
                      <span class="vfo-freq mono">
                        {formatFreqMhz(radio.freq_hz)}
                      </span>
                      {radio.band && <span class="badge badge-info">{radio.band}</span>}
                      {radio.mode && (
                        <span class="mono muted">
                          {radio.mode}
                          {radio.passband_hz ? ` · ${radio.passband_hz} Hz` : ""}
                        </span>
                      )}
                      <span class="lease-tag mono muted">
                        {radio.lease_holder
                          ? holdsLease
                            ? "Lease: YOU"
                            : `Lease: ${radio.lease_holder}`
                          : "Lease: unclaimed"}
                      </span>
                    </div>

                    {radio.last_error && (
                      <div class="radio-error mono">{radio.last_error}</div>
                    )}

                    <div class="preset-row">
                      {FT8_BAND_PRESETS.map((p) => (
                        <button
                          key={p.band}
                          type="button"
                          class="btn btn-secondary btn-xs"
                          disabled={radio.lifecycle_state !== "READY"}
                          onClick={() =>
                            void ensureLeaseAndRun(radio, "radio.set_freq", {
                              freq_hz: p.hz,
                            })
                          }
                        >
                          {p.band} {p.mhz}
                        </button>
                      ))}
                    </div>

                    <div class="cat-controls">
                      <div class="cat-group">
                        <input
                          type="number"
                          class="mono input-sm"
                          value={freqText}
                          onInput={(e) =>
                            setFreqInputs((prev) => ({
                              ...prev,
                              [rid]: (e.currentTarget as HTMLInputElement).value,
                            }))
                          }
                        />
                        <button
                          type="button"
                          class="btn btn-secondary btn-sm"
                          disabled={radio.lifecycle_state !== "READY"}
                          onClick={() =>
                            void ensureLeaseAndRun(radio, "radio.set_freq", {
                              freq_hz: Number(freqText),
                            })
                          }
                        >
                          Set Hz
                        </button>
                      </div>

                      <div class="cat-group">
                        <select
                          class="input-sm"
                          value={modeText}
                          onChange={(e) =>
                            setModeInputs((prev) => ({
                              ...prev,
                              [rid]: (e.currentTarget as HTMLSelectElement).value,
                            }))
                          }
                        >
                          {["USB", "PKTUSB", "LSB", "CW", "FM", "AM"].map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                        <input
                          type="number"
                          class="mono input-xs"
                          value={pbText}
                          onInput={(e) =>
                            setPbInputs((prev) => ({
                              ...prev,
                              [rid]: (e.currentTarget as HTMLInputElement).value,
                            }))
                          }
                        />
                        <button
                          type="button"
                          class="btn btn-secondary btn-sm"
                          disabled={radio.lifecycle_state !== "READY"}
                          onClick={() =>
                            void ensureLeaseAndRun(radio, "radio.set_mode", {
                              mode: modeText,
                              passband_hz: Number(pbText),
                            })
                          }
                        >
                          Set Mode
                        </button>
                      </div>
                    </div>

                    <div class="radio-actions-row">
                      {holdsLease ? (
                        <button
                          type="button"
                          class="btn btn-secondary btn-sm"
                          onClick={() => void onReleaseLease(rid)}
                        >
                          Release Lease
                        </button>
                      ) : (
                        <button
                          type="button"
                          class="btn btn-primary btn-sm"
                          onClick={() => void onClaimLease(rid, false)}
                        >
                          Claim Control
                        </button>
                      )}
                      <button
                        type="button"
                        class="btn btn-secondary btn-sm"
                        disabled={radio.lifecycle_state !== "READY"}
                        onClick={() =>
                          void runRadioCmd(rid, "radio.test_cat", {})
                        }
                      >
                        Test CAT
                      </button>
                      <button
                        type="button"
                        class="btn btn-secondary btn-sm"
                        disabled={radio.lifecycle_state !== "READY"}
                        onClick={() =>
                          void ensureLeaseAndRun(radio, "radio.test_ptt", {
                            duration_ms: 200,
                          })
                        }
                      >
                        Test PTT (200ms)
                      </button>
                      <button
                        type="button"
                        class="btn btn-secondary btn-sm"
                        onClick={() =>
                          void runRadioCmd(rid, "radio.restart", {})
                        }
                      >
                        {radio.rigctld_pid ? "Restart Worker" : "Start Worker"}
                      </button>
                      <button
                        type="button"
                        class="btn btn-secondary btn-sm"
                        disabled={
                          radio.lifecycle_state === "CONFIGURED" ||
                          radio.lifecycle_state === "DISCONNECTED"
                        }
                        onClick={() =>
                          void runRadioCmd(rid, "radio.stop", {})
                        }
                      >
                        Stop Worker
                      </button>
                      <button
                        type="button"
                        class="btn btn-danger btn-sm"
                        onClick={() =>
                          void runRadioCmd(rid, "tx.halt_emergency", {})
                        }
                      >
                        Halt TX
                      </button>
                      <button
                        type="button"
                        class="btn btn-secondary btn-sm"
                        onClick={() =>
                          void runRadioCmd(rid, "radio.delete_profile", {})
                        }
                      >
                        Delete
                      </button>
                    </div>

                    {ackInfo && (
                      <div class={ackInfo.ok ? "text-ok mono" : "text-err mono"} style={{ fontSize: "0.78rem" }}>
                        {ackInfo.text}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
