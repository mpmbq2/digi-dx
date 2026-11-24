import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { DaemonState } from "../../hooks/useDaemonSocket";
import type {
  ActiveQso,
  ChannelRosterEntry,
  DecodeItem,
  RadioSummary,
  SequencerMode,
} from "../../types";
import { parseFt8Decode } from "../../utils/maidenhead";
import { CrossHighlightContext } from "./CrossHighlightContext";
import { CycleProgressBar } from "./CycleProgressBar";
import { LiveBatchFeed } from "./LiveBatchFeed";
import { ModernChannelRoster } from "./ModernChannelRoster";
import { ModernWaterfall } from "./ModernWaterfall";
import { QsoSwimlanes } from "./QsoSwimlanes";
import { RadioControlBar } from "./RadioControlBar";
import { resolveQsoIdentities } from "./qsoIdentityStore";
import type { DigitalMode, HoverState } from "./types";
import {
  getSubbandFreq,
  mapActiveQsoToStage,
  normalizeCall,
  resolveQsoRole,
} from "./utils";
import "./modern-ft8.css";

interface Props {
  daemon: DaemonState;
  radio: RadioSummary | null;
  onNavigateSetup: () => void;
}

const FEED_LEFT_STORAGE_KEY = "digi_dx_modern_feed_left";

function loadFeedOnLeft(): boolean {
  try {
    return window.localStorage.getItem(FEED_LEFT_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function ModernFt8Console({ daemon, radio, onNavigateSetup }: Props) {
  const rid = radio?.profile.radio_id ?? null;
  const activeSession =
    rid && daemon.session?.active && daemon.session.radio_id === rid
      ? daemon.session
      : null;
  const otherRadioSession =
    rid && daemon.session?.active && daemon.session.radio_id !== rid
      ? daemon.session
      : null;

  const [feedOnLeft, setFeedOnLeft] = useState<boolean>(loadFeedOnLeft);
  const [preferredMode, setPreferredMode] = useState<DigitalMode>(() =>
    activeSession?.digital_mode === "FT4" ? "FT4" : "FT8"
  );
  const [rxHz, setRxHz] = useState<number>(1500);
  const [pendingDialFreqHz, setPendingDialFreqHz] = useState<number | null>(null);
  const [atuTuning, setAtuTuning] = useState<boolean>(false);
  const atuTimerRef = useRef<number | null>(null);
  const [statusMsg, setStatusMsg] = useState<{ ok: boolean; text: string } | null>(
    null
  );

  const [hover, setHoverState] = useState<HoverState>({
    hoveredCallsign: null,
    hoveredFreqHz: null,
    hoveredColor: null,
  });
  const hoverRef = useRef<HoverState>(hover);

  const setHovered = useCallback(
    (callsign: string | null, hz: number | null, color: string | null) => {
      const norm = callsign ? normalizeCall(callsign) : null;
      const cur = hoverRef.current;
      if (
        cur.hoveredCallsign === norm &&
        cur.hoveredFreqHz === hz &&
        cur.hoveredColor === color
      ) {
        return;
      }
      const next: HoverState = {
        hoveredCallsign: norm,
        hoveredFreqHz: hz,
        hoveredColor: color,
      };
      hoverRef.current = next;
      setHoverState(next);
    },
    []
  );

  const effectiveMode: DigitalMode = activeSession
    ? activeSession.digital_mode === "FT4" ||
      activeSession.slot_clock?.slot_ms === 7500
      ? "FT4"
      : "FT8"
    : preferredMode;

  useEffect(() => {
    if (activeSession?.digital_mode === "FT4" || activeSession?.digital_mode === "FT8") {
      setPreferredMode(activeSession.digital_mode);
    }
  }, [activeSession?.digital_mode]);

  // Clear pending dial-frequency sync indicator once rig readback matches
  useEffect(() => {
    if (
      pendingDialFreqHz !== null &&
      typeof radio?.freq_hz === "number" &&
      Math.abs(radio.freq_hz - pendingDialFreqHz) <= 500
    ) {
      setPendingDialFreqHz(null);
    }
  }, [pendingDialFreqHz, radio?.freq_hz]);

  // Reload persisted SQLite Channel Roster whenever dial freq, demo mode, or digital mode changes
  useEffect(() => {
    if (!rid) return;
    void daemon.refreshRoster(
      radio?.freq_hz ?? null,
      Boolean(activeSession?.is_demo),
      effectiveMode
    );
  }, [rid, radio?.freq_hz, activeSession?.is_demo, effectiveMode, daemon.refreshRoster]);

  // Safety: ensure momentary TUNE is released on unmount if active
  const isTuning = Boolean(
    rid &&
      daemon.txState?.radio_id === rid &&
      daemon.txState.state === "transmitting" &&
      daemon.txState.message === "TUNE"
  );
  const isTuningRef = useRef(isTuning);
  isTuningRef.current = isTuning;
  const ridRef = useRef(rid);
  ridRef.current = rid;
  const sendCmdRef = useRef(daemon.sendCommand);
  sendCmdRef.current = daemon.sendCommand;

  useEffect(() => {
    return () => {
      if (atuTimerRef.current !== null) {
        window.clearTimeout(atuTimerRef.current);
        atuTimerRef.current = null;
      }
      if (isTuningRef.current && ridRef.current) {
        void sendCmdRef.current("tx.tune", { enabled: false }, undefined, ridRef.current);
      }
    };
  }, []);

  const ensureLease = useCallback(async (): Promise<boolean> => {
    if (!rid || !radio) return false;
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
  }, [rid, radio, daemon]);

  const runRadioCmd = useCallback(
    async (
      kind: string,
      payload: Record<string, unknown>,
      okText?: string
    ): Promise<boolean> => {
      if (!rid) return false;
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
      if (okText) {
        setStatusMsg({ ok: true, text: okText });
      } else {
        setStatusMsg(null);
      }
      return true;
    },
    [rid, ensureLease, daemon]
  );

  const toggleFlipFeed = () => {
    setFeedOnLeft((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(FEED_LEFT_STORAGE_KEY, String(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  };

  const handleSelectBand = async (band: string) => {
    const hz = getSubbandFreq(band, effectiveMode);
    if (!hz || !rid) return;
    setPendingDialFreqHz(hz);
    const ok = await runRadioCmd("radio.set_freq", { freq_hz: hz });
    if (!ok) setPendingDialFreqHz(null);
  };

  const handleSelectMode = async (mode: DigitalMode) => {
    setPreferredMode(mode);
    if (activeSession) {
      await runRadioCmd("session.set_mode", { mode });
    }
    if (
      radio?.band &&
      (radio.lifecycle_state === "READY" ||
        radio.lifecycle_state === "ACTIVE_SESSION") &&
      !radio.ptt
    ) {
      const subbandHz = getSubbandFreq(radio.band, mode);
      if (subbandHz && subbandHz !== radio.freq_hz) {
        setPendingDialFreqHz(subbandHz);
        const ok = await runRadioCmd("radio.set_freq", { freq_hz: subbandHz });
        if (!ok) setPendingDialFreqHz(null);
      }
    }
  };

  const handleSetRfPower = async (level0to1: number) => {
    await runRadioCmd("radio.set_level", { name: "RFPOWER", value: level0to1 });
  };

  const handleToggleTune = async () => {
    const next = !isTuning;
    await runRadioCmd("tx.tune", {
      enabled: next,
      af_hz: activeSession?.tx_af_hz ?? 1500,
    });
  };

  const handleAtuTune = async () => {
    if (atuTimerRef.current !== null) {
      window.clearTimeout(atuTimerRef.current);
      atuTimerRef.current = null;
    }
    setAtuTuning(true);
    const ok = await runRadioCmd("radio.atu_tune", {}, "Internal ATU tune triggered");
    if (!ok) {
      setAtuTuning(false);
      return;
    }
    atuTimerRef.current = window.setTimeout(() => {
      atuTimerRef.current = null;
      setAtuTuning(false);
    }, 1800);
  };

  const handleToggleAtuBypass = async (enabled: boolean) => {
    await runRadioCmd(
      "radio.set_func",
      { name: "TUNER", enabled },
      enabled ? "Internal ATU enabled" : "Internal ATU set to bypass"
    );
  };

  const handleHaltTx = async () => {
    if (!rid) return;
    await daemon.sendCommand("tx.halt_emergency", {}, undefined, rid);
  };

  const handleCommitTxHz = useCallback(
    (hz: number) => {
      const clamped = Math.max(200, Math.min(3000, Math.round(hz)));
      if (!activeSession) return;
      void runRadioCmd("qso.set_af", { af_hz: clamped });
    },
    [activeSession, runRadioCmd]
  );

  const activeQsos = activeSession?.active_qsos ?? [];
  const realQsos = useMemo(
    () => activeQsos.filter((q) => !q.is_cq),
    [activeQsos]
  );
  const sessionKey = activeSession
    ? `${activeSession.radio_id}:${activeSession.is_demo ? "demo" : "live"}:${activeSession.slot_clock.anchor_wall_ms}`
    : "";

  const identities = useMemo(
    () => resolveQsoIdentities(sessionKey, realQsos),
    [sessionKey, realQsos]
  );

  // Track stage advances and new inbound QSOs for swimlane / feed animations
  const prevStageMapRef = useRef<Map<string, { stage: number; step: string }>>(new Map());
  const [recentAdvMap, setRecentAdvMap] = useState<Record<string, number>>({});
  const [recentInbMap, setRecentInbMap] = useState<Record<string, number>>({});

  useEffect(() => {
    const prevMap = prevStageMapRef.current;
    const nextMap = new Map<string, { stage: number; step: string }>();
    const newlyAdv: string[] = [];
    const newlyInb: string[] = [];

    for (const q of realQsos) {
      const stage = mapActiveQsoToStage(q);
      nextMap.set(q.qso_id, { stage, step: q.step });
      const prev = prevMap.get(q.qso_id);
      if (!prev) {
        if (resolveQsoRole(q) === "hunter" || stage === 0) {
          newlyInb.push(q.qso_id);
        }
      } else if (stage > prev.stage || q.step !== prev.step) {
        newlyAdv.push(q.qso_id);
      }
    }
    prevStageMapRef.current = nextMap;

    const now = Date.now();
    if (newlyAdv.length > 0) {
      setRecentAdvMap((prev) => {
        const next = { ...prev };
        for (const id of newlyAdv) next[id] = now;
        return next;
      });
    }
    if (newlyInb.length > 0) {
      setRecentInbMap((prev) => {
        const next = { ...prev };
        for (const id of newlyInb) next[id] = now;
        return next;
      });
    }
  }, [realQsos]);

  useEffect(() => {
    const hasAny =
      Object.keys(recentAdvMap).length > 0 || Object.keys(recentInbMap).length > 0;
    if (!hasAny) return;
    const timer = window.setTimeout(() => {
      const cutoff = Date.now() - 2200;
      setRecentAdvMap((prev) => {
        const next: Record<string, number> = {};
        for (const [k, ts] of Object.entries(prev)) {
          if (ts > cutoff) next[k] = ts;
        }
        return next;
      });
      setRecentInbMap((prev) => {
        const next: Record<string, number> = {};
        for (const [k, ts] of Object.entries(prev)) {
          if (ts > cutoff) next[k] = ts;
        }
        return next;
      });
    }, 2300);
    return () => window.clearTimeout(timer);
  }, [recentAdvMap, recentInbMap]);

  const recentlyAdvancedQsoIds = useMemo(
    () => new Set(Object.keys(recentAdvMap)),
    [recentAdvMap]
  );
  const recentlyInboundQsoIds = useMemo(
    () => new Set(Object.keys(recentInbMap)),
    [recentInbMap]
  );

  const rosterFreqMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of daemon.channelRoster) {
      map.set(normalizeCall(e.callsign), e.last_af_hz);
    }
    return map;
  }, [daemon.channelRoster]);

  const rosterGridMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of daemon.channelRoster) {
      if (e.grid) map.set(normalizeCall(e.callsign), e.grid);
    }
    return map;
  }, [daemon.channelRoster]);

  const workedCalls = useMemo(() => {
    const isDemo = Boolean(activeSession?.is_demo);
    const worked = isDemo ? daemon.workedDemoCalls : daemon.workedRealCalls;
    const log = isDemo ? daemon.demoQsos : daemon.realQsos;
    const set = new Set<string>();
    for (const call of worked) {
      const norm = normalizeCall(call);
      if (norm) set.add(norm);
    }
    for (const item of log) {
      const norm = normalizeCall(item.their_call);
      if (norm) set.add(norm);
    }
    for (const item of daemon.sessionCompletedQsos) {
      const norm = normalizeCall(item.qso.their_call);
      if (norm) set.add(norm);
    }
    return set;
  }, [
    activeSession?.is_demo,
    daemon.workedDemoCalls,
    daemon.workedRealCalls,
    daemon.demoQsos,
    daemon.realQsos,
    daemon.sessionCompletedQsos,
  ]);

  const armedQso = useMemo(() => {
    const id = activeSession?.armed_qso_id;
    if (!id) return null;
    return realQsos.find((q) => q.qso_id === id && q.status === "active") ?? null;
  }, [activeSession?.armed_qso_id, realQsos]);
  const armedIdentity = armedQso ? identities.get(armedQso.qso_id) ?? null : null;
  const cqState = activeSession?.cq ?? null;
  const sequencerMode: SequencerMode =
    activeSession?.sequencer_mode ?? "auto_sequence";

  const handleArmQso = async (q: ActiveQso, afHz: number | null) => {
    if (afHz !== null) {
      setRxHz(afHz);
    }
    if (q.status === "paused") return;
    await runRadioCmd("qso.action", { qso_id: q.qso_id, action: "arm" });
  };

  const handleSelectExistingQso = async (q: ActiveQso, afHz: number | null) => {
    if (afHz !== null) {
      setRxHz(afHz);
    }
    if (q.status === "paused") {
      await runRadioCmd("qso.action", { qso_id: q.qso_id, action: "resume" });
    }
    await runRadioCmd("qso.action", { qso_id: q.qso_id, action: "arm" });
  };

  const handleTogglePauseQso = async (qsoId: string, pause: boolean) => {
    await runRadioCmd("qso.action", {
      qso_id: qsoId,
      action: pause ? "pause" : "resume",
    });
  };

  const handleStopCq = async () => {
    await runRadioCmd("qso.stop_cq", {});
  };

  const handleSetSequencerMode = async (mode: SequencerMode) => {
    await runRadioCmd("qso.set_sequencer_mode", { mode });
  };

  const handleCallDecode = async (callsign: string, dec: DecodeItem) => {
    const existing = realQsos.find(
      (q) => normalizeCall(q.their_call) === normalizeCall(callsign)
    );
    if (existing) {
      await handleSelectExistingQso(existing, dec.af_hz);
      return;
    }
    setRxHz(dec.af_hz);
    const parsed = parseFt8Decode(dec.message);
    await runRadioCmd(
      "qso.reply",
      {
        callsign: normalizeCall(callsign),
        their_grid: parsed.grid,
        rx_slot: dec.slot,
        snr_db: dec.snr_db,
        rx_message: dec.message,
        rx_af_hz: dec.af_hz,
        rx_ts_sec: dec.ts_sec,
      },
      `Queued reply to ${normalizeCall(callsign)}`
    );
  };

  const handleCallRoster = async (entry: ChannelRosterEntry) => {
    setRxHz(entry.last_af_hz);
    await runRadioCmd(
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
      `Queued reply to ${entry.callsign}`
    );
  };

  const effectiveTxState: "idle" | "armed" | "transmitting" =
    (rid && daemon.txState?.radio_id === rid ? daemon.txState.state : null) ??
    activeSession?.tx_state ??
    "idle";
  const liveTxMessage =
    rid && daemon.txState?.radio_id === rid && daemon.txState.state === "transmitting"
      ? daemon.txState.message
      : activeSession?.armed_message ?? null;

  const effectiveMyCall = activeSession?.my_call ?? daemon.station?.callsign ?? null;
  const effectiveMyGrid = activeSession?.my_grid ?? daemon.station?.grid ?? null;
  const txHz = activeSession?.tx_af_hz ?? 1500;

  // Delegated cross-highlight hover handler (scoped exclusively to Modern FT8 UI)
  const handlePointerOver = (e: MouseEvent) => {
    const target = (e.target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-callsign]"
    );
    if (!target) {
      if (hoverRef.current.hoveredCallsign !== null) {
        setHovered(null, null, null);
      }
      return;
    }
    const call = target.getAttribute("data-callsign");
    if (!call) {
      setHovered(null, null, null);
      return;
    }
    const norm = normalizeCall(call);
    const hzAttr = Number(target.getAttribute("data-hz"));
    let hz = Number.isFinite(hzAttr) && hzAttr > 0 ? hzAttr : null;
    let color = target.getAttribute("data-color");

    const q = realQsos.find((x) => normalizeCall(x.their_call) === norm);
    if (q) {
      color = identities.get(q.qso_id)?.color ?? color;
      if (!hz) hz = rosterFreqMap.get(norm) ?? null;
    }
    if (!hz) {
      hz = rosterFreqMap.get(norm) ?? null;
    }
    setHovered(norm, hz, color || "#38bdf8");
  };

  const handleMouseLeave = () => {
    setHovered(null, null, null);
  };

  if (!radio) {
    return (
      <div class="modern-ft8-root" data-testid="modern-ft8-console">
        <div
          class="mft8-panel"
          style={{ padding: "1.5rem", alignItems: "flex-start", gap: "0.75rem" }}
        >
          <h2 class="mft8-panel-title">No Transceiver Configured</h2>
          <p style={{ color: "var(--mft8-text-secondary)", margin: 0 }}>
            Add a USB CAT transceiver or a Hamlib Dummy Rig (-m 1) in Hardware &amp;
            Setup to operate the Modern FT8 UI console.
          </p>
          <button
            type="button"
            class="mft8-btn mft8-btn-primary"
            onClick={onNavigateSetup}
          >
            ← Open Hardware &amp; Setup
          </button>
        </div>
      </div>
    );
  }

  return (
    <CrossHighlightContext.Provider value={{ hover, hoverRef, setHovered }}>
      <div
        class="modern-ft8-root"
        data-testid="modern-ft8-console"
        style={
          hover.hoveredColor
            ? ({ "--mft8-hover-color": hover.hoveredColor } as Record<string, string>)
            : undefined
        }
        onMouseOver={handlePointerOver}
        onMouseLeave={handleMouseLeave}
      >
        <div
          class={`mft8-grid ${feedOnLeft ? "mft8-feed-left" : ""}`}
          data-testid="mft8-grid"
        >
          {/* 2/3 PRIMARY WORKSPACE: Top Controls + Waterfall -> Swimlanes -> Roster */}
          <div class="mft8-main-col">
            <section class="mft8-panel mft8-panel-top">
              <div class="mft8-telemetry-bar">
                <RadioControlBar
                  radio={radio}
                  stationCall={daemon.station?.callsign ?? null}
                  stationGrid={daemon.station?.grid ?? null}
                  activeSession={activeSession}
                  otherRadioSession={otherRadioSession}
                  digitalMode={effectiveMode}
                  pendingDialFreqHz={pendingDialFreqHz}
                  txState={effectiveTxState}
                  isTuning={isTuning}
                  isAtuTuning={atuTuning}
                  feedOnLeft={feedOnLeft}
                  onToggleFlipFeed={toggleFlipFeed}
                  onSelectBand={(b) => void handleSelectBand(b)}
                  onSelectMode={(m) => void handleSelectMode(m)}
                  onSetRfPower={handleSetRfPower}
                  onToggleTxEnabled={() =>
                    void runRadioCmd("qso.set_tx_enabled", {
                      enabled: !(activeSession?.tx_enabled ?? false),
                    })
                  }
                  onHaltTx={() => void handleHaltTx()}
                  onToggleTune={() => void handleToggleTune()}
                  onAtuTune={() => void handleAtuTune()}
                  onToggleAtuBypass={(enabled) => void handleToggleAtuBypass(enabled)}
                  onStartLive={() =>
                    void runRadioCmd(
                      "session.start",
                      { demo: false, mode: effectiveMode },
                      `Live ${effectiveMode} session started`
                    )
                  }
                  onStartDemo={(scale) =>
                    void runRadioCmd(
                      "session.start",
                      { demo: true, scale, mode: effectiveMode },
                      `Demo ${effectiveMode} session active (${scale}x)`
                    )
                  }
                  onStopSession={() =>
                    void daemon.sendCommand("session.stop", {}, undefined, rid ?? undefined)
                  }
                  onCallCq={() => void runRadioCmd("qso.call_cq", {})}
                  onStopCq={() => void handleStopCq()}
                />

                <CycleProgressBar
                  slotClock={daemon.slotClock}
                  digitalMode={effectiveMode}
                  activeSession={activeSession}
                  txState={effectiveTxState}
                  liveTxMessage={liveTxMessage}
                  isTuning={isTuning}
                  txHz={txHz}
                  armedQso={armedQso}
                  armedIdentity={armedIdentity}
                  cqState={cqState}
                />
              </div>

              {(otherRadioSession || statusMsg) && (
                <div
                  class={`mft8-alert-strip ${
                    statusMsg && !statusMsg.ok ? "err" : ""
                  }`}
                >
                  <span>
                    {otherRadioSession
                      ? `Another radio (${otherRadioSession.radio_id}) holds the active session.`
                      : statusMsg?.text}
                  </span>
                  {statusMsg && (
                    <button
                      type="button"
                      class="mft8-btn-dismiss"
                      onClick={() => setStatusMsg(null)}
                    >
                      ×
                    </button>
                  )}
                </div>
              )}

              <ModernWaterfall
                frames={daemon.waterfallFrames}
                rxHz={rxHz}
                txHz={txHz}
                txEnabled={Boolean(activeSession?.tx_enabled)}
                evenOccupiedHz={daemon.evenOccupiedHz}
                oddOccupiedHz={daemon.oddOccupiedHz}
                activeQsos={realQsos}
                identities={identities}
                rosterFreqMap={rosterFreqMap}
                onChangeRxHz={setRxHz}
                onCommitTxHz={handleCommitTxHz}
              />
            </section>

            <QsoSwimlanes
              activeQsos={realQsos}
              identities={identities}
              armedQsoId={armedQso?.qso_id ?? null}
              cqState={cqState}
              sequencerMode={sequencerMode}
              recentlyAdvancedQsoIds={recentlyAdvancedQsoIds}
              recentlyInboundQsoIds={recentlyInboundQsoIds}
              sessionCompletedQsos={daemon.sessionCompletedQsos}
              slotClock={activeSession?.slot_clock ?? daemon.slotClock}
              myGrid={effectiveMyGrid}
              rosterFreqMap={rosterFreqMap}
              rosterGridMap={rosterGridMap}
              onArmQso={(q, afHz) => void handleArmQso(q, afHz)}
              onTogglePauseQso={(qsoId, pause) =>
                void handleTogglePauseQso(qsoId, pause)
              }
              onDismissQso={(qsoId) =>
                void runRadioCmd("qso.action", { qso_id: qsoId, action: "abandon" })
              }
              onCompleteQso={(qsoId) =>
                void runRadioCmd("qso.action", { qso_id: qsoId, action: "complete" })
              }
              onStopCq={() => void handleStopCq()}
              onSetSequencerMode={(mode) => void handleSetSequencerMode(mode)}
            />

            <ModernChannelRoster
              entries={daemon.channelRoster}
              activeQsos={realQsos}
              identities={identities}
              workedCalls={workedCalls}
              myGrid={effectiveMyGrid}
              digitalMode={effectiveMode}
              clockScale={
                activeSession?.slot_clock?.scale ?? daemon.slotClock?.scale ?? 1
              }
              sessionActive={Boolean(activeSession)}
              onCallRoster={(entry) => void handleCallRoster(entry)}
              onArmQso={(q, afHz) => void handleSelectExistingQso(q, afHz)}
            />
          </div>

          {/* 1/3 SIDE RAIL: SPLIT-RAIL LIVE BATCH FEED */}
          <LiveBatchFeed
            decodes={daemon.recentDecodes}
            myCall={effectiveMyCall}
            digitalMode={effectiveMode}
            slotMs={
              activeSession?.slot_clock?.slot_ms ??
              daemon.slotClock?.slot_ms ??
              (effectiveMode === "FT4" ? 7500 : 15000)
            }
            activeQsos={realQsos}
            identities={identities}
            workedCalls={workedCalls}
            recentlyAdvancedQsoIds={recentlyAdvancedQsoIds}
            sessionActive={Boolean(activeSession)}
            onCallStation={(call, dec) => void handleCallDecode(call, dec)}
          />
        </div>
      </div>
    </CrossHighlightContext.Provider>
  );
}
