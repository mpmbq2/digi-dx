import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type {
  AudioDeviceSummary,
  CommandAck,
  CommandEnvelope,
  ConnectionState,
  EventLogItem,
  HamlibModel,
  HealthResponse,
  OutboxStats,
  PreflightReport,
  RadioSummary,
  SlotClockSpec,
  SnapshotEvent,
  StationConfig,
  UsbInventoryEntry,
} from "../types";

function makeActorId(): string {
  const stored = window.sessionStorage.getItem("digi_dx_actor");
  if (stored) return stored;
  const created = `browser-${Math.random().toString(36).slice(2, 8)}`;
  window.sessionStorage.setItem("digi_dx_actor", created);
  return created;
}

function makeUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface DaemonState {
  actor: string;
  authToken: string;
  setAuthToken: (token: string) => void;
  connectionState: ConnectionState;
  lastHeartbeatAt: string | null;
  health: HealthResponse | null;
  preflight: PreflightReport | null;
  station: StationConfig | null;
  authRequired: boolean;
  slotClock: SlotClockSpec | null;
  outboxStats: OutboxStats | null;
  audioDevices: AudioDeviceSummary[];
  usbDevices: UsbInventoryEntry[];
  hamlibModels: HamlibModel[];
  radios: RadioSummary[];
  heldLeases: Record<string, string>;
  events: EventLogItem[];
  refreshAll: (refreshPreflight?: boolean) => Promise<void>;
  sendCommand: (
    kind: string,
    payload: Record<string, unknown>,
    token?: string,
    radioId?: string
  ) => Promise<CommandAck>;
  claimLease: (radioId: string, force?: boolean) => Promise<CommandAck>;
  releaseLease: (radioId: string) => Promise<CommandAck>;
}

export function useDaemonSocket(): DaemonState {
  const actorRef = useRef<string>(makeActorId());
  const wsRef = useRef<WebSocket | null>(null);
  const retryAttemptRef = useRef<number>(0);
  const leaseTimersRef = useRef<Record<string, number>>({});
  const pendingHbRef = useRef<Record<string, string>>({});
  const authTokenRef = useRef<string>("");

  const [authToken, setAuthTokenState] = useState<string>("");
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");
  const [lastHeartbeatAt, setLastHeartbeatAt] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [preflight, setPreflight] = useState<PreflightReport | null>(null);
  const [station, setStation] = useState<StationConfig | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean>(false);
  const [slotClock, setSlotClock] = useState<SlotClockSpec | null>(null);
  const [outboxStats, setOutboxStats] = useState<OutboxStats | null>(null);
  const [audioDevices, setAudioDevices] = useState<AudioDeviceSummary[]>([]);
  const [usbDevices, setUsbDevices] = useState<UsbInventoryEntry[]>([]);
  const [hamlibModels, setHamlibModels] = useState<HamlibModel[]>([]);
  const [radios, setRadios] = useState<RadioSummary[]>([]);
  const [heldLeases, setHeldLeases] = useState<Record<string, string>>({});
  const [events, setEvents] = useState<EventLogItem[]>([]);

  const setAuthToken = useCallback((token: string) => {
    authTokenRef.current = token;
    setAuthTokenState(token);
  }, []);

  const pushEvent = useCallback((kind: string, summary: string) => {
    const item: EventLogItem = {
      id: makeUuid(),
      at: new Date().toISOString().slice(11, 19) + "Z",
      kind,
      summary,
    };
    setEvents((prev) => [item, ...prev].slice(0, 50));
  }, []);

  const clearLeaseTimer = useCallback((radioId: string) => {
    const timer = leaseTimersRef.current[radioId];
    if (timer !== undefined) {
      window.clearInterval(timer);
      delete leaseTimersRef.current[radioId];
    }
    setHeldLeases((prev) => {
      if (!(radioId in prev)) return prev;
      const next = { ...prev };
      delete next[radioId];
      return next;
    });
  }, []);

  const refreshLiveState = useCallback(async () => {
    try {
      const [hRes, oRes, rRes] = await Promise.all([
        fetch("/api/v1/health"),
        fetch("/api/v1/outbox/stats"),
        fetch("/api/v1/radios"),
      ]);
      if (hRes.ok) setHealth((await hRes.json()) as HealthResponse);
      if (oRes.ok) setOutboxStats((await oRes.json()) as OutboxStats);
      if (rRes.ok) {
        const data = (await rRes.json()) as { radios: RadioSummary[] };
        setRadios(data.radios ?? []);
      }
    } catch {
      // Ignore transient network errors; WS reconnect recovers.
    }
  }, []);

  const refreshAll = useCallback(async (refreshPreflight = false) => {
    try {
      const preflightUrl = refreshPreflight
        ? "/api/v1/preflight?refresh=true"
        : "/api/v1/preflight";
      const [hRes, pRes, sRes, oRes, aRes, uRes, rRes] = await Promise.all([
        fetch("/api/v1/health"),
        fetch(preflightUrl),
        fetch("/api/v1/station"),
        fetch("/api/v1/outbox/stats"),
        fetch("/api/v1/devices/audio"),
        fetch("/api/v1/devices/usb"),
        fetch("/api/v1/radios"),
      ]);
      if (hRes.ok) setHealth((await hRes.json()) as HealthResponse);
      if (pRes.ok) setPreflight((await pRes.json()) as PreflightReport);
      if (sRes.ok) {
        const st = (await sRes.json()) as StationConfig;
        setStation(st);
        if (typeof st.auth_required === "boolean") {
          setAuthRequired(st.auth_required);
        }
      }
      if (oRes.ok) setOutboxStats((await oRes.json()) as OutboxStats);
      if (aRes.ok) {
        const data = (await aRes.json()) as { devices: AudioDeviceSummary[] };
        setAudioDevices(data.devices ?? []);
      }
      if (uRes.ok) {
        const data = (await uRes.json()) as { devices: UsbInventoryEntry[] };
        setUsbDevices(data.devices ?? []);
      }
      if (rRes.ok) {
        const data = (await rRes.json()) as { radios: RadioSummary[] };
        setRadios(data.radios ?? []);
      }
    } catch {
      // Ignore transient network errors; WS reconnect recovers.
    }
  }, []);

  useEffect(() => {
    void fetch("/api/v1/hamlib/models")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { models?: HamlibModel[] } | null) => {
        if (data?.models) setHamlibModels(data.models);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    void refreshAll(false);
    const poll = window.setInterval(() => {
      void refreshAll(false);
    }, 10000);
    return () => window.clearInterval(poll);
  }, [refreshAll]);

  useEffect(() => {
    let closed = false;
    let reconnectTimer: number | null = null;
    let pingTimer: number | null = null;

    const connect = () => {
      if (closed) return;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${window.location.host}/api/v1/ws`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      setConnectionState(
        retryAttemptRef.current > 0 ? "reconnecting" : "connecting"
      );

      ws.onopen = () => {
        retryAttemptRef.current = 0;
        setConnectionState("connected");
        setLastHeartbeatAt(new Date().toISOString());
        pushEvent("ws", "WebSocket connected to /api/v1/ws");
        pingTimer = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, 15000);
      };

      ws.onmessage = (msg) => {
        setLastHeartbeatAt(new Date().toISOString());
        try {
          const parsed = JSON.parse(msg.data as string) as Record<
            string,
            unknown
          >;
          const evType = String(parsed.type ?? "unknown");

          if (evType === "snapshot") {
            const snap = parsed as unknown as SnapshotEvent;
            setSlotClock(snap.slot_clock);
            setPreflight(snap.preflight);
            if (snap.station) setStation(snap.station);
            if (snap.outbox_stats) setOutboxStats(snap.outbox_stats);
            if (Array.isArray(snap.radios)) setRadios(snap.radios);
            if (Array.isArray(snap.usb_devices)) setUsbDevices(snap.usb_devices);
            setAuthRequired(Boolean(snap.auth_required));
            pushEvent(
              "snapshot",
              `Snapshot v${snap.server_version} (${snap.radios?.length ?? 0} radio(s), ${
                snap.usb_devices?.filter((d) => d.is_connected).length ?? 0
              } USB connected)`
            );
          } else if (evType === "pong") {
            pushEvent("pong", `Heartbeat ${String(parsed.server_time_utc ?? "")}`);
          } else if (evType === "station_updated") {
            setStation({
              station_id: String(parsed.station_id ?? ""),
              callsign: (parsed.callsign as string | null) ?? null,
              grid: (parsed.grid as string | null) ?? null,
              updated_at_utc: String(parsed.updated_at_utc ?? ""),
            });
            pushEvent(
              "station_updated",
              `Station updated to ${String(parsed.callsign ?? "—")} (${String(
                parsed.grid ?? "—"
              )})`
            );
          } else if (evType === "usb_devices_changed") {
            const devices = (parsed.devices as UsbInventoryEntry[]) ?? [];
            setUsbDevices(devices);
            const online = devices.filter((d) => d.is_connected).length;
            pushEvent(
              "usb_devices",
              `USB hot-plug update: ${online} online (${devices.length} known)`
            );
          } else if (evType === "radio_state") {
            const rid = String(parsed.radio_id ?? "");
            setRadios((prev) =>
              prev.map((r) => {
                if (r.profile.radio_id !== rid) return r;
                return {
                  ...r,
                  lifecycle_state: String(parsed.lifecycle_state ?? r.lifecycle_state),
                  freq_hz:
                    parsed.freq_hz !== undefined
                      ? (parsed.freq_hz as number | null)
                      : r.freq_hz,
                  band:
                    parsed.band !== undefined
                      ? (parsed.band as string | null)
                      : r.band,
                  mode:
                    parsed.mode !== undefined
                      ? (parsed.mode as string | null)
                      : r.mode,
                  passband_hz:
                    parsed.passband_hz !== undefined
                      ? (parsed.passband_hz as number | null)
                      : r.passband_hz,
                  ptt: typeof parsed.ptt === "boolean" ? parsed.ptt : r.ptt,
                  bound_serial_path:
                    parsed.bound_serial_path !== undefined
                      ? (parsed.bound_serial_path as string | null)
                      : r.bound_serial_path,
                  rigctld_pid:
                    parsed.rigctld_pid !== undefined
                      ? (parsed.rigctld_pid as number | null)
                      : r.rigctld_pid,
                  last_error:
                    parsed.last_error !== undefined
                      ? (parsed.last_error as string | null)
                      : r.last_error,
                  recovery_attempts:
                    typeof parsed.recovery_attempts === "number"
                      ? parsed.recovery_attempts
                      : r.recovery_attempts,
                };
              })
            );
            const freqTxt =
              typeof parsed.freq_hz === "number"
                ? ` @ ${(parsed.freq_hz / 1_000_000).toFixed(6)} MHz`
                : "";
            const detailTxt = parsed.detail ? ` — ${String(parsed.detail)}` : "";
            pushEvent(
              "radio_state",
              `${rid}: ${String(parsed.lifecycle_state)}${freqTxt}${detailTxt}`
            );
          } else if (evType === "control_lease") {
            const rid = String(parsed.radio_id ?? "");
            const held = Boolean(parsed.held);
            const holder = (parsed.holder_actor as string | null) ?? null;
            setRadios((prev) =>
              prev.map((r) =>
                r.profile.radio_id === rid ? { ...r, lease_holder: holder } : r
              )
            );
            if (!held || holder !== actorRef.current) {
              clearLeaseTimer(rid);
            }
            pushEvent(
              "control_lease",
              `Radio ${rid} lease ${held ? `claimed by ${holder}` : "released"}`
            );
          } else if (evType === "preflight_alert") {
            pushEvent(
              "preflight_alert",
              `${String(parsed.title ?? "Alert")}: ${String(parsed.detail ?? "")}`
            );
            void refreshAll(false);
          } else if (evType === "command_ack") {
            const cmdId = String(parsed.command_id ?? "");
            const hbRadioId = pendingHbRef.current[cmdId];
            if (hbRadioId !== undefined) {
              delete pendingHbRef.current[cmdId];
              if (parsed.status === "ok") {
                return;
              }
              if (
                parsed.error_code === "LEASE_REQUIRED" ||
                parsed.error_code === "LEASE_HELD"
              ) {
                clearLeaseTimer(hbRadioId);
                void refreshLiveState();
              }
            }
            const resObj = parsed.result as Record<string, unknown> | null;
            if (
              resObj?.kind === "control.heartbeat" &&
              parsed.status === "ok"
            ) {
              return;
            }
            pushEvent(
              "command_ack",
              `Ack ${cmdId.slice(0, 8)}: ${String(parsed.status)}`
            );
          } else {
            pushEvent(evType, JSON.stringify(parsed));
          }
        } catch {
          pushEvent("raw", String(msg.data));
        }
      };

      ws.onclose = () => {
        if (pingTimer !== null) {
          window.clearInterval(pingTimer);
          pingTimer = null;
        }
        if (closed) {
          setConnectionState("disconnected");
          return;
        }
        setConnectionState("reconnecting");
        const attempt = retryAttemptRef.current;
        const delayMs = attempt === 0 ? 1000 : attempt === 1 ? 2000 : 5000;
        retryAttemptRef.current += 1;
        pushEvent("ws", `Disconnected; retrying in ${delayMs}ms`);
        reconnectTimer = window.setTimeout(connect, delayMs);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (pingTimer !== null) window.clearInterval(pingTimer);
      Object.values(leaseTimersRef.current).forEach((t) => window.clearInterval(t));
      leaseTimersRef.current = {};
      wsRef.current?.close();
    };
  }, [clearLeaseTimer, pushEvent, refreshAll, refreshLiveState]);

  const sendCommand = useCallback(
    async (
      kind: string,
      payload: Record<string, unknown>,
      token?: string,
      radioId?: string
    ): Promise<CommandAck> => {
      const cmdId = makeUuid();
      const effectiveToken = token ?? authTokenRef.current;
      const envelope: CommandEnvelope = {
        command_id: cmdId,
        idempotency_key: cmdId,
        origin: "local_ui",
        actor: actorRef.current,
        radio_id: radioId ?? null,
        kind,
        issued_at_utc: new Date().toISOString(),
        payload,
      };

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (effectiveToken && effectiveToken.trim().length > 0) {
        headers.Authorization = `Bearer ${effectiveToken.trim()}`;
      }

      const res = await fetch("/api/v1/commands", {
        method: "POST",
        headers,
        body: JSON.stringify(envelope),
      });
      const ack = (await res.json()) as CommandAck;
      if (kind !== "control.heartbeat") {
        pushEvent(
          "command",
          `${kind} -> ${ack.status}${ack.error_code ? ` (${ack.error_code})` : ""}`
        );
      }
      if (ack.status === "ok" && kind !== "control.heartbeat") {
        void refreshLiveState();
      }
      return ack;
    },
    [pushEvent, refreshLiveState]
  );

  const claimLease = useCallback(
    async (radioId: string, force = false): Promise<CommandAck> => {
      const ack = await sendCommand(
        "control.claim_lease",
        { force },
        undefined,
        radioId
      );
      if (ack.status === "ok" && ack.result?.lease_id) {
        const leaseId = String(ack.result.lease_id);
        clearLeaseTimer(radioId);
        setHeldLeases((prev) => ({ ...prev, [radioId]: leaseId }));
        setRadios((prev) =>
          prev.map((r) =>
            r.profile.radio_id === radioId
              ? { ...r, lease_holder: actorRef.current }
              : r
          )
        );

        // Keep control lease (and future 2s TX watchdog) alive with 500ms heartbeats
        leaseTimersRef.current[radioId] = window.setInterval(() => {
          const ws = wsRef.current;
          const hbCmdId = makeUuid();
          const env: CommandEnvelope = {
            command_id: hbCmdId,
            origin: "local_ui",
            actor: actorRef.current,
            radio_id: radioId,
            kind: "control.heartbeat",
            issued_at_utc: new Date().toISOString(),
            payload: { lease_id: leaseId },
          };
          if (ws && ws.readyState === WebSocket.OPEN) {
            pendingHbRef.current[hbCmdId] = radioId;
            ws.send(
              JSON.stringify({
                type: "command",
                envelope: env,
                token: authTokenRef.current || undefined,
              })
            );
          } else {
            void sendCommand(
              "control.heartbeat",
              { lease_id: leaseId },
              undefined,
              radioId
            ).then((hbAck) => {
              if (
                hbAck.error_code === "LEASE_REQUIRED" ||
                hbAck.error_code === "LEASE_HELD"
              ) {
                clearLeaseTimer(radioId);
                void refreshLiveState();
              }
            });
          }
        }, 500);
      }
      return ack;
    },
    [clearLeaseTimer, refreshLiveState, sendCommand]
  );

  const releaseLease = useCallback(
    async (radioId: string): Promise<CommandAck> => {
      clearLeaseTimer(radioId);
      setRadios((prev) =>
        prev.map((r) =>
          r.profile.radio_id === radioId ? { ...r, lease_holder: null } : r
        )
      );
      return sendCommand("control.release_lease", {}, undefined, radioId);
    },
    [clearLeaseTimer, sendCommand]
  );

  return {
    actor: actorRef.current,
    authToken,
    setAuthToken,
    connectionState,
    lastHeartbeatAt,
    health,
    preflight,
    station,
    authRequired,
    slotClock,
    outboxStats,
    audioDevices,
    usbDevices,
    hamlibModels,
    radios,
    heldLeases,
    events,
    refreshAll,
    sendCommand,
    claimLease,
    releaseLease,
  };
}
