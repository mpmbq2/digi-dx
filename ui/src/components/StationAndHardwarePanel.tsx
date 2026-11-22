import { useEffect, useState } from "preact/hooks";
import type {
  AudioDeviceSummary,
  CommandAck,
  StationConfig,
} from "../types";

interface Props {
  station: StationConfig | null;
  authRequired: boolean;
  authToken: string;
  onAuthTokenChange: (token: string) => void;
  audioDevices: AudioDeviceSummary[];
  onSaveStation: (
    callsign: string,
    grid: string,
    token?: string
  ) => Promise<CommandAck>;
}

export function StationAndHardwarePanel({
  station,
  authRequired,
  authToken,
  onAuthTokenChange,
  audioDevices,
  onSaveStation,
}: Props) {
  const [callsign, setCallsign] = useState(station?.callsign ?? "");
  const [grid, setGrid] = useState(station?.grid ?? "");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(
    null
  );

  useEffect(() => {
    if (station?.callsign) setCallsign(station.callsign);
    if (station?.grid) setGrid(station.grid);
  }, [station?.callsign, station?.grid]);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setSaving(true);
    setFeedback(null);
    try {
      const ack = await onSaveStation(callsign, grid, authToken);
      if (ack.status === "ok") {
        setFeedback({
          ok: true,
          text: `Saved via CommandBus (${ack.command_id.slice(0, 8)})`,
        });
      } else {
        setFeedback({
          ok: false,
          text: `${ack.error_code ?? "ERROR"}: ${ack.error_message ?? "Rejected"}`,
        });
      }
    } catch (err) {
      setFeedback({ ok: false, text: String(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="two-col-stack">
      <section class="panel" aria-label="Station Identity Configuration">
        <div class="panel-header">
          <div>
            <h2>Station Identity</h2>
            <p class="muted mono">
              ID: {station?.station_id ?? "initializing..."}
            </p>
          </div>
          <span class={`badge ${authRequired ? "badge-info" : "badge-warn"}`}>
            {authRequired ? "TOKEN PROTECTED" : "OPEN LAN MUTATIONS"}
          </span>
        </div>

        <form class="station-form" onSubmit={(e) => void handleSubmit(e)}>
          <label>
            <span>Callsign</span>
            <input
              type="text"
              placeholder="e.g. K1ABC"
              value={callsign}
              onInput={(e) =>
                setCallsign((e.currentTarget as HTMLInputElement).value.toUpperCase())
              }
              required
            />
          </label>
          <label>
            <span>Maidenhead Grid</span>
            <input
              type="text"
              placeholder="e.g. FN42"
              value={grid}
              onInput={(e) =>
                setGrid((e.currentTarget as HTMLInputElement).value.toUpperCase())
              }
              required
            />
          </label>
          {authRequired && (
            <label>
              <span>Bearer Token</span>
              <input
                type="password"
                placeholder="DIGI_DX_AUTH_TOKEN"
                value={authToken}
                onInput={(e) =>
                  onAuthTokenChange((e.currentTarget as HTMLInputElement).value)
                }
              />
            </label>
          )}
          <div class="form-actions">
            <button class="btn btn-primary" type="submit" disabled={saving}>
              {saving ? "Saving..." : "Save via Command Bus"}
            </button>
            {feedback && (
              <span class={feedback.ok ? "text-ok" : "text-err"}>
                {feedback.text}
              </span>
            )}
          </div>
        </form>
      </section>

      <section class="panel" aria-label="Detected Audio Interfaces">
        <div class="panel-header">
          <div>
            <h2>Audio Interfaces ({audioDevices.length})</h2>
            <p class="muted">Live soundcards discovered via `cpal`</p>
          </div>
        </div>

        {audioDevices.length === 0 ? (
          <p class="muted">No audio interfaces enumerated.</p>
        ) : (
          <ul class="hw-list">
            {audioDevices.map((dev) => (
              <li key={dev.name} class="hw-item">
                <div>
                  <div class="hw-name">{dev.name}</div>
                  <div class="muted mono hw-meta">
                    {dev.host_name} · in:{dev.max_input_channels}ch · out:
                    {dev.max_output_channels}ch ·{" "}
                    {dev.default_sample_rate ? `${dev.default_sample_rate} Hz` : "rate n/a"}
                    {" · "}
                    {dev.device_uid}
                  </div>
                </div>
                <div class="hw-badges">
                  {dev.supports_input && dev.supports_output && (
                    <span class="badge badge-ok">DUPLEX</span>
                  )}
                  {dev.supports_48khz && (
                    <span class="badge badge-info">48 kHz</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
