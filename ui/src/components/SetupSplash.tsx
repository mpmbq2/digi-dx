import { useMemo, useState } from "preact/hooks";
import type { DaemonState } from "../hooks/useDaemonSocket";
import type { UsbInventoryEntry } from "../types";
import {
  BAUD_RATES,
  POPULAR_MODEL_IDS,
  formatFreqMhz,
  formatLifecycleLabel,
  lifecycleBadgeClass,
} from "../utils/radioHelpers";
import { PreflightPanel } from "./PreflightPanel";
import { StationAndHardwarePanel } from "./StationAndHardwarePanel";
import { SystemHealthGrid } from "./SystemHealthGrid";

interface Props {
  daemon: DaemonState;
  onOpenRadio: (radioId: string, tab: "info" | "ft8") => void;
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

export function SetupSplash({ daemon, onOpenRadio }: Props) {
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
  const [diagOpenOverride, setDiagOpenOverride] = useState<boolean | null>(null);

  const preflightHasIssue =
    daemon.preflight?.overall_status === "ok_with_warnings" ||
    daemon.preflight?.overall_status === "fatal";
  const showDiagnostics = diagOpenOverride ?? preflightHasIssue;

  const filteredModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    const list = daemon.hamlibModels.length
      ? daemon.hamlibModels
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
  }, [daemon.hamlibModels, modelQuery]);

  const openAssignFormForUsb = (usb: UsbInventoryEntry) => {
    const suggested = suggestModelForUsb(usb);
    const label = usb.product || usb.manufacturer || "Transceiver";
    setProfileName(`${label} (${usb.usb_serial ?? "CAT"})`);
    setSerialKey(usb.device_key);
    setHamlibModel(suggested);
    setBaudRate(suggested === 3073 || suggested === 3085 ? 115200 : 9600);
    setPttMethod("cat");
    const usbDuplex = daemon.audioDevices.find(
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
    setFormMsg(null);
    const num = daemon.radios.filter((r) => r.profile.is_dummy).length + 1;
    const ack = await daemon.sendCommand("radio.create_profile", {
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
    const selectedAudio = daemon.audioDevices.find(
      (a) => a.device_uid === audioUid
    );
    const ack = await daemon.sendCommand("radio.create_profile", {
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

  const stationConfigured = Boolean(
    daemon.station?.callsign && daemon.station?.grid
  );

  return (
    <div class="console-stack" data-testid="setup-splash">
      <section class="panel" aria-label="Configured Radios">
        <div class="panel-header">
          <div>
            <h2>Station Transceivers ({daemon.radios.length})</h2>
            <p class="muted">
              Select a radio to inspect or adjust live CAT settings and launch FT8 operation.
            </p>
          </div>
          <div class="panel-actions">
            <button
              class="btn btn-secondary btn-sm"
              type="button"
              data-testid="add-dummy-btn"
              onClick={() => void handleAddDummy()}
            >
              + Add Dummy Rig (-m 1)
            </button>
            <button
              class="btn btn-primary btn-sm"
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

        {!stationConfigured && (
          <div class="demo-inline-note">
            Station Callsign &amp; Maidenhead Grid are not configured yet — set them below before starting a live FT8 session.
          </div>
        )}

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

        {daemon.radios.length === 0 ? (
          <div class="empty-fleet-box">
            <p class="muted">
              No radio profiles configured yet. Assign a plugged-in USB serial CAT cable below or add a Hamlib Dummy Rig to explore &amp; test FT8 in Demo Mode.
            </p>
          </div>
        ) : (
          <div class="radio-fleet-grid">
            {daemon.radios.map((radio) => {
              const rid = radio.profile.radio_id;
              const isSessionHere =
                daemon.session?.active && daemon.session.radio_id === rid;
              return (
                <article
                  key={rid}
                  class="fleet-card"
                  data-testid={`radio-card-${rid}`}
                >
                  <div
                    class="fleet-card-body"
                    onClick={() => onOpenRadio(rid, "info")}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onOpenRadio(rid, "info");
                      }
                    }}
                  >
                    <div class="radio-card-head">
                      <div>
                        <div class="radio-title">{radio.profile.name}</div>
                        <div class="muted mono" style={{ fontSize: "0.76rem" }}>
                          Hamlib #{radio.profile.hamlib_model} · {radio.profile.ptt_method.toUpperCase()} ·{" "}
                          {radio.profile.is_dummy ? "Dummy" : `${radio.profile.serial_baud_rate} baud`}
                        </div>
                      </div>
                      <div class="hw-badges">
                        <span
                          class={`badge ${lifecycleBadgeClass(radio.lifecycle_state)}`}
                        >
                          {formatLifecycleLabel(radio.lifecycle_state)}
                        </span>
                        {isSessionHere && (
                          <span class="badge badge-info">
                            {daemon.session?.is_demo ? "DEMO" : "FT8 LIVE"}
                          </span>
                        )}
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
                    </div>

                    <div class="muted mono" style={{ fontSize: "0.74rem" }}>
                      {radio.bound_serial_path
                        ? `CAT: ${radio.bound_serial_path}`
                        : radio.profile.serial_device_key
                        ? `CAT: ${radio.profile.serial_device_key}`
                        : "CAT: loopback dummy"}
                      <br />
                      Audio: {radio.profile.audio_device_name ?? "Unassigned (Demo only)"}
                    </div>

                    {radio.last_error && (
                      <div class="radio-error mono">{radio.last_error}</div>
                    )}
                    {radio.lifecycle_state === "POWERED_OFF" && (
                      <div class="radio-standby">
                        USB cable connected — transceiver powered off or CAT silent.
                      </div>
                    )}
                  </div>

                  <div class="fleet-card-actions">
                    <button
                      type="button"
                      class="btn btn-secondary btn-sm"
                      data-testid={`open-radio-info-${rid}`}
                      onClick={() => onOpenRadio(rid, "info")}
                    >
                      Radio Info &amp; Controls →
                    </button>
                    <button
                      type="button"
                      class="btn btn-primary btn-sm"
                      data-testid={`open-radio-ft8-${rid}`}
                      onClick={() => onOpenRadio(rid, "ft8")}
                    >
                      FT8 Operation →
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <div class="main-grid">
        <StationAndHardwarePanel
          station={daemon.station}
          authRequired={daemon.authRequired}
          authToken={daemon.authToken}
          onAuthTokenChange={daemon.setAuthToken}
          audioDevices={daemon.audioDevices}
          onSaveStation={(call, grid, token) =>
            daemon.sendCommand(
              "station.update_config",
              { callsign: call, grid },
              token
            )
          }
        />

        <section class="panel" aria-label="USB Serial Hot-Plug Discovery">
          <div class="panel-header">
            <div>
              <h2>USB Serial CAT Cables ({daemon.usbDevices.length})</h2>
              <p class="muted">
                Live hot-plug watcher for `/dev/serial/by-id` devices
              </p>
            </div>
          </div>
          {daemon.usbDevices.length === 0 ? (
            <p class="muted">
              No USB serial CAT cables detected. Plug in a cable to assign it to a transceiver profile.
            </p>
          ) : (
            <ul class="hw-list">
              {daemon.usbDevices.map((usb) => {
                const assignedRadio = usb.assigned_radio_id
                  ? daemon.radios.find(
                      (r) => r.profile.radio_id === usb.assigned_radio_id
                    )
                  : undefined;
                const liveState = !usb.is_connected
                  ? "DISCONNECTED"
                  : assignedRadio
                  ? assignedRadio.lifecycle_state
                  : usb.device_state;
                return (
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
                        class={`badge ${usb.is_connected ? "badge-info" : "badge-muted"}`}
                      >
                        {usb.is_connected ? "USB PLUGGED" : "UNPLUGGED"}
                      </span>
                      <span class={`badge ${lifecycleBadgeClass(liveState)}`}>
                        {formatLifecycleLabel(liveState)}
                      </span>
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
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <section class="panel" aria-label="System Health and Preflight Diagnostics">
        <div class="panel-header" style={{ marginBottom: showDiagnostics ? "0.85rem" : 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
            <h2>System Health &amp; Preflight Diagnostics</h2>
            <span
              class={`badge ${
                daemon.preflight?.overall_status === "ok"
                  ? "badge-ok"
                  : daemon.preflight?.overall_status === "ok_with_warnings"
                  ? "badge-warn"
                  : daemon.preflight?.overall_status === "fatal"
                  ? "badge-fail"
                  : "badge-info"
              }`}
            >
              {(daemon.preflight?.overall_status ?? "PENDING").replaceAll("_", " ").toUpperCase()}
            </span>
            <span class="muted mono">
              Decoder: {daemon.preflight?.active_ft8_decoder ?? "auto"} · Outbox:{" "}
              {daemon.outboxStats?.pending_count ?? 0} pending
            </span>
          </div>
          <div class="panel-actions">
            <a
              class="btn btn-secondary btn-sm"
              href="/api/v1/preflight"
              target="_blank"
              rel="noreferrer"
            >
              Preflight JSON
            </a>
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              onClick={() => setDiagOpenOverride(!showDiagnostics)}
            >
              {showDiagnostics ? "Hide Diagnostics" : "Show Diagnostics"}
            </button>
          </div>
        </div>

        {showDiagnostics && (
          <div class="console-stack">
            <SystemHealthGrid
              connectionState={daemon.connectionState}
              lastHeartbeatAt={daemon.lastHeartbeatAt}
              health={daemon.health}
              preflight={daemon.preflight}
              outboxStats={daemon.outboxStats}
              audioDevices={daemon.audioDevices}
              usbDevices={daemon.usbDevices}
              radios={daemon.radios}
            />
            <PreflightPanel
              report={daemon.preflight}
              onRefresh={() => daemon.refreshAll(true)}
            />
          </div>
        )}
      </section>
    </div>
  );
}
