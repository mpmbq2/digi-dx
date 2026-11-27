import type {
  AudioDeviceSummary,
  ConnectionState,
  HealthResponse,
  OutboxStats,
  PreflightReport,
  RadioSummary,
  UsbInventoryEntry,
} from "../types";

interface Props {
  connectionState: ConnectionState;
  lastHeartbeatAt: string | null;
  health: HealthResponse | null;
  preflight: PreflightReport | null;
  outboxStats: OutboxStats | null;
  audioDevices: AudioDeviceSummary[];
  usbDevices: UsbInventoryEntry[];
  radios: RadioSummary[];
}

function formatUptime(secs?: number): string {
  if (secs === undefined) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function SystemHealthGrid({
  connectionState,
  lastHeartbeatAt,
  health,
  preflight,
  outboxStats,
  audioDevices,
  usbDevices,
  radios,
}: Props) {
  const decoder =
    health?.active_ft8_decoder ?? preflight?.active_ft8_decoder ?? "unknown";
  const isFtxr = decoder === "ftxr";
  const isJt9 = decoder === "jt9";
  const isFallback = !isFtxr && !isJt9;

  return (
    <section class="health-grid" aria-label="Daemon System Health">
      <div class="metric-card">
        <div class="metric-label">Daemon Health</div>
        <div class="metric-value">
          <span class="badge badge-ok">{health?.status?.toUpperCase() ?? "PENDING"}</span>
          <span class="mono">v{health?.version ?? "2.0.0"}</span>
        </div>
        <div class="metric-sub">
          Uptime: <span class="mono">{formatUptime(health?.uptime_sec)}</span>
        </div>
      </div>

      <div class="metric-card">
        <div class="metric-label">WebSocket Link</div>
        <div class="metric-value">
          <span
            class={`badge ${
              connectionState === "connected"
                ? "badge-ok"
                : connectionState === "disconnected"
                ? "badge-fail"
                : "badge-warn"
            }`}
          >
            {connectionState.toUpperCase()}
          </span>
        </div>
        <div class="metric-sub mono">
          {lastHeartbeatAt ? `Last msg ${lastHeartbeatAt.slice(11, 19)}Z` : "Awaiting frame"}
        </div>
      </div>

      <div class="metric-card">
        <div class="metric-label">FT8 / FT4 Decoder Engine</div>
        <div class="metric-value">
          <span class={`badge ${isFallback ? "badge-warn" : "badge-ok"}`}>
            {isFtxr
              ? "ftxr-modem (FT8/FT4)"
              : isJt9
              ? "WSJT-X jt9"
              : "Fallback (ft8_lib)"}
          </span>
        </div>
        <div class="metric-sub">
          {isFtxr
            ? "Pure-Rust weak-signal ftxr engine active"
            : isJt9
            ? "High-sensitivity jt9 active (legacy fallback)"
            : "Install ftxr-modem for ~-24 dB FT8/FT4 sensitivity"}
        </div>
      </div>

      <div class="metric-card">
        <div class="metric-label">Telemetry Outbox (SQLite WAL)</div>
        <div class="metric-value mono">
          {outboxStats
            ? `${outboxStats.pending_count} pending / ${outboxStats.sent_count} sent`
            : "—"}
        </div>
        <div class="metric-sub">
          Sink: <span class="mono">{outboxStats?.sink_name ?? "noop"}</span>
          {outboxStats && outboxStats.dead_letter_count > 0
            ? ` · ${outboxStats.dead_letter_count} dead`
            : ""}
        </div>
      </div>

      <div class="metric-card">
        <div class="metric-label">Hardware Inventory</div>
        <div class="metric-value mono">
          {audioDevices.length} audio · {usbDevices.length} serial
        </div>
        <div class="metric-sub">
          Configured radio profiles: <span class="mono">{radios.length}</span>
        </div>
      </div>
    </section>
  );
}
