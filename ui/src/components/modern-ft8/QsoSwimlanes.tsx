import { useEffect, useState } from "preact/hooks";
import type {
  ActiveQso,
  CompletedSessionQso,
  CqState,
  SequencerMode,
  SlotClockSpec,
  TranscriptEntry,
} from "../../types";
import { gridDistance } from "../../utils/maidenhead";
import { useCrossHighlight } from "./CrossHighlightContext";
import type { QsoIdentity, SwimlaneStage } from "./types";
import {
  extractStationTags,
  fmtSnr,
  formatQsoNextTx,
  hexToRgba,
  mapActiveQsoToStage,
  normalizeCall,
  qrzUrl,
  resolveQsoRole,
  snrClass,
} from "./utils";

interface Props {
  activeQsos: ActiveQso[];
  identities: Map<string, QsoIdentity>;
  armedQsoId: string | null;
  cqState: CqState | null;
  sequencerMode: SequencerMode;
  recentlyAdvancedQsoIds: Set<string>;
  recentlyInboundQsoIds: Set<string>;
  sessionCompletedQsos: CompletedSessionQso[];
  slotClock: SlotClockSpec | null;
  myGrid: string | null;
  rosterFreqMap: Map<string, number>;
  rosterGridMap: Map<string, string>;
  onArmQso: (q: ActiveQso, afHz: number | null) => void;
  onTogglePauseQso: (qsoId: string, pause: boolean) => void;
  onDismissQso: (qsoId: string) => void;
  onCompleteQso: (qsoId: string) => void;
  onStopCq: () => void;
  onSetSequencerMode: (mode: SequencerMode) => void;
}

const LANES: Array<{ stage: SwimlaneStage | 3; title: string; minimal: boolean }> = [
  { stage: 0, title: "1. INITIATING", minimal: false },
  { stage: 1, title: "2. SIGNAL REPORTS", minimal: false },
  { stage: 2, title: "3. RR73 / 73", minimal: false },
  { stage: 3, title: "LOGGED", minimal: true },
];

export function QsoSwimlanes({
  activeQsos,
  identities,
  armedQsoId,
  cqState,
  sequencerMode,
  recentlyAdvancedQsoIds,
  recentlyInboundQsoIds,
  sessionCompletedQsos,
  slotClock,
  myGrid,
  rosterFreqMap,
  rosterGridMap,
  onArmQso,
  onTogglePauseQso,
  onDismissQso,
  onCompleteQso,
  onStopCq,
  onSetSequencerMode,
}: Props) {
  const { hover } = useCrossHighlight();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    if (sessionCompletedQsos.length === 0) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [sessionCompletedQsos.length]);

  const virtualNowMs = slotClock
    ? slotClock.epoch_ms + Math.round((nowMs - slotClock.anchor_wall_ms) * slotClock.scale)
    : nowMs;

  const loggedBayItems: Array<{ item: CompletedSessionQso; cyclesLeft: number }> = [];
  const archivedItems: CompletedSessionQso[] = [];

  for (const item of sessionCompletedQsos) {
    const slotMs = slotClock?.slot_ms ?? item.slotMsAtLog ?? 15000;
    const cyclesElapsed = Math.max(
      0,
      Math.floor((virtualNowMs - item.loggedSlotStartMs) / slotMs)
    );
    const cyclesLeft = 2 - cyclesElapsed;
    if (cyclesLeft > 0) {
      loggedBayItems.push({ item, cyclesLeft });
    } else {
      archivedItems.push(item);
    }
  }

  const getLastRx = (q: ActiveQso): TranscriptEntry | null => {
    const tr = q.transcript ?? [];
    for (let i = tr.length - 1; i >= 0; i--) {
      if (tr[i].direction === "rx") return tr[i];
    }
    return null;
  };

  const realQsos = activeQsos.filter((q) => !q.is_cq);

  return (
    <section
      class="mft8-panel mft8-panel-swimlanes"
      data-testid="mft8-swimlanes-panel"
      aria-label="Active QSO Sequencers"
    >
      <div class="mft8-panel-header">
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            flexWrap: "wrap",
          }}
        >
          <h2 class="mft8-panel-title">
            Active QSO Sequencers
            <span class="mft8-count-chip" data-testid="mft8-active-qso-count">
              {realQsos.length}
            </span>
          </h2>
          {cqState && (
            <span
              class={`mft8-cq-indicator ${cqState.armed ? "armed" : ""}`}
              data-testid="mft8-cq-indicator"
              title={
                cqState.armed
                  ? "Calling CQ (Armed for next TX)"
                  : "Calling CQ (Queued behind active QSOs)"
              }
            >
              <span>
                ● CALLING CQ
                {cqState.directed_cq ? ` ${cqState.directed_cq}` : ""} ·{" "}
                {cqState.tx_slot.toUpperCase()}
                {cqState.attempts > 0 ? ` (${cqState.attempts})` : ""}
              </span>
              <button
                type="button"
                class="mft8-btn-dismiss"
                data-testid="mft8-stop-cq"
                title="Stop Calling CQ"
                onClick={onStopCq}
              >
                ×
              </button>
            </span>
          )}
        </div>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            flexWrap: "wrap",
          }}
        >
          <div class="mft8-seq-switch" role="group" aria-label="Sequencer Mode">
            <button
              type="button"
              data-testid="mft8-seq-auto"
              class={`mft8-mode-btn ${
                sequencerMode === "auto_sequence" ? "active" : ""
              }`}
              onClick={() => onSetSequencerMode("auto_sequence")}
            >
              Auto-Sequence
            </button>
            <button
              type="button"
              data-testid="mft8-seq-manual"
              class={`mft8-mode-btn ${sequencerMode === "manual" ? "active" : ""}`}
              onClick={() => onSetSequencerMode("manual")}
            >
              Manual
            </button>
          </div>
          <span style={{ fontSize: "10px", color: "var(--mft8-text-muted)" }}>
            Auto-archives after 2 cycles
          </span>
        </div>
      </div>

      <div class="mft8-swimlanes-board" data-testid="mft8-swimlanes-board">
        {LANES.map((lane) => {
          if (lane.minimal) {
            return (
              <div
                key={lane.stage}
                class="mft8-lane mft8-lane-logged"
                data-testid="mft8-logged-lane"
              >
                <div class="mft8-lane-head">
                  <span>LOGGED</span>
                  <span class="mft8-count-chip">{loggedBayItems.length}</span>
                </div>
                <div class="mft8-lane-body">
                  {loggedBayItems.length === 0 ? (
                    <div class="mft8-lane-empty" style={{ fontSize: "9.5px" }}>
                      None
                    </div>
                  ) : (
                    loggedBayItems.map(({ item, cyclesLeft }) => {
                      const call = normalizeCall(item.qso.their_call);
                      const isHovered = Boolean(
                        hover.hoveredCallsign && hover.hoveredCallsign === call
                      );
                      return (
                        <div
                          key={item.qso.qso_id}
                          data-testid="mft8-logged-chip"
                          data-callsign={call}
                          data-hz={item.qso.af_hz ?? undefined}
                          class={`mft8-logged-chip ${isHovered ? "mft8-sync-hover" : ""}`}
                          title={`Logged · Auto-archives in ${cyclesLeft} cycle(s)`}
                        >
                          <div class="mft8-logged-chip-top">
                            <span class="mft8-logged-chip-call">{call}</span>
                          </div>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: "3px",
                            }}
                          >
                            <span
                              class="mft8-logged-chip-cyc"
                              data-testid="mft8-logged-cyc"
                            >
                              {cyclesLeft} cyc
                            </span>
                            <a
                              class="mft8-btn-qrz"
                              href={qrzUrl(call)}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ padding: "0 3px", fontSize: "8.5px" }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              QRZ↗
                            </a>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            );
          }

          const laneItems = realQsos.filter(
            (q) => mapActiveQsoToStage(q) === lane.stage
          );

          return (
            <div
              key={lane.stage}
              class="mft8-lane"
              data-testid={`mft8-lane-${lane.stage}`}
            >
              <div class="mft8-lane-head">
                <span>{lane.title}</span>
                <span class="mft8-count-chip">{laneItems.length}</span>
              </div>
              <div class="mft8-lane-body">
                {laneItems.length === 0 ? (
                  <div class="mft8-lane-empty">Empty</div>
                ) : (
                  laneItems.map((q) => {
                    const identity = identities.get(q.qso_id) ?? {
                      qsoId: q.qso_id,
                      badge: "Q?",
                      color: "#38bdf8",
                      index: 1,
                    };
                    const call = normalizeCall(q.their_call);
                    const lastRx = getLastRx(q);
                    const grid = q.their_grid ?? rosterGridMap.get(call) ?? null;
                    const dist = gridDistance(myGrid, grid);
                    const afHz = lastRx?.af_hz ?? rosterFreqMap.get(call) ?? null;
                    const snr = lastRx?.snr_db ?? q.last_their_snr_db ?? null;
                    const tags = extractStationTags(
                      call,
                      lastRx?.message ?? null,
                      dist?.km ?? null
                    );
                    const isPaused = q.status === "paused";
                    const isArmed = !isPaused && q.qso_id === armedQsoId;
                    const role = resolveQsoRole(q);
                    const isAdv = recentlyAdvancedQsoIds.has(q.qso_id);
                    const isInb = recentlyInboundQsoIds.has(q.qso_id);
                    const isHovered = Boolean(
                      hover.hoveredCallsign && hover.hoveredCallsign === call
                    );
                    const animClass = isAdv
                      ? "mft8-anim-advanced"
                      : isInb
                      ? "mft8-anim-inbound"
                      : "";

                    return (
                      <div
                        key={q.qso_id}
                        data-testid="mft8-qso-strip"
                        data-qso-id={q.qso_id}
                        data-callsign={call}
                        data-hz={afHz ?? undefined}
                        data-color={identity.color}
                        class={`mft8-qso-strip ${isArmed ? "is-armed" : ""} ${
                          isPaused ? "is-paused" : ""
                        } ${animClass} ${isHovered ? "mft8-sync-hover" : ""}`}
                        style={{
                          borderLeftColor: identity.color,
                          boxShadow: `inset 3px 0 12px ${hexToRgba(identity.color, 0.14)}`,
                        }}
                        onClick={() => {
                          if (!isPaused) onArmQso(q, afHz);
                        }}
                      >
                        <div class="mft8-strip-top">
                          <div class="mft8-strip-id">
                            <span
                              class="mft8-q-pill"
                              style={{ background: identity.color }}
                            >
                              {identity.badge}
                            </span>
                            <span class="mft8-strip-call">{call}</span>
                            <span
                              data-testid="mft8-role-tag"
                              class={`mft8-tag ${
                                role === "caller"
                                  ? "mft8-tag-caller"
                                  : "mft8-tag-hunter"
                              }`}
                              title={
                                role === "caller"
                                  ? "They called CQ (you are hunting)"
                                  : "They answered your CQ (Hunter)"
                              }
                            >
                              {role === "caller" ? "CALLER" : "HUNTER"}
                            </span>
                          </div>
                          <button
                            type="button"
                            class="mft8-btn-dismiss"
                            data-testid="mft8-dismiss-qso"
                            title="Dismiss QSO"
                            onClick={(e) => {
                              e.stopPropagation();
                              onDismissQso(q.qso_id);
                            }}
                          >
                            ×
                          </button>
                        </div>

                        <div class="mft8-strip-meta">
                          <span>
                            {grid ?? "—"}
                            {dist ? ` · ${dist.km.toLocaleString()}km` : ""}
                          </span>
                          <span class={snrClass(snr)}>
                            {snr !== null ? `${fmtSnr(snr)}dB` : "—"}
                            {afHz !== null ? ` · ${afHz}Hz` : ""}
                          </span>
                        </div>

                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: "3px",
                            alignItems: "center",
                          }}
                        >
                          <span
                            data-testid="mft8-state-tag"
                            class={`mft8-tag ${
                              isArmed
                                ? "mft8-tag-armed"
                                : isPaused
                                ? "mft8-tag-paused"
                                : "mft8-tag-active"
                            }`}
                          >
                            {isArmed ? "ARMED" : isPaused ? "PAUSED" : "ACTIVE"}
                          </span>
                          {tags.map((t) => (
                            <span
                              key={t}
                              class={`mft8-tag ${
                                t === "SOTA"
                                  ? "mft8-tag-sota"
                                  : t === "POTA"
                                  ? "mft8-tag-pota"
                                  : "mft8-tag-dx"
                              }`}
                            >
                              {t}
                            </span>
                          ))}
                          {isAdv && (
                            <span class="mft8-tag mft8-tag-adv mft8-anim-pop">
                              ADVANCED
                            </span>
                          )}
                          {q.attempts_on_step >= 2 && (
                            <span class="mft8-tag mft8-tag-stall">
                              WAIT {q.attempts_on_step}c
                            </span>
                          )}
                        </div>

                        <div class="mft8-strip-msgs">
                          <div class="mft8-strip-msg-line mft8-strip-msg-rx">
                            RX: {lastRx ? lastRx.message : "Waiting..."}
                          </div>
                          <div
                            class={`mft8-strip-msg-line mft8-strip-msg-tx ${
                              isArmed ? "armed" : isPaused ? "paused" : ""
                            }`}
                          >
                            {isPaused
                              ? `PAUSED · Next: ${formatQsoNextTx(q)}`
                              : `TX: ${formatQsoNextTx(q)}`}
                          </div>
                        </div>

                        <div class="mft8-strip-footer">
                          <div style={{ display: "inline-flex", gap: "3px" }}>
                            <button
                              type="button"
                              class={`mft8-btn-arm-chip ${isArmed ? "armed" : ""}`}
                              data-testid="mft8-arm-qso"
                              disabled={isPaused}
                              title={
                                isPaused
                                  ? "Activate QSO before arming TX"
                                  : "Arm this QSO for TX"
                              }
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!isPaused) onArmQso(q, afHz);
                              }}
                            >
                              {isArmed ? "● ARMED" : "Arm TX"}
                            </button>
                            <button
                              type="button"
                              class={`mft8-btn mft8-btn-xs mft8-btn-pause ${
                                isPaused ? "is-paused" : ""
                              }`}
                              data-testid="mft8-pause-toggle"
                              title={
                                isPaused
                                  ? "Make Active (eligible for TX)"
                                  : "Pause (RX advances only, no TX)"
                              }
                              onClick={(e) => {
                                e.stopPropagation();
                                onTogglePauseQso(q.qso_id, !isPaused);
                              }}
                            >
                              {isPaused ? "Activate" : "Pause"}
                            </button>
                            <button
                              type="button"
                              class="mft8-btn mft8-btn-xs"
                              title="Log QSO Now"
                              onClick={(e) => {
                                e.stopPropagation();
                                onCompleteQso(q.qso_id);
                              }}
                            >
                              Log
                            </button>
                          </div>
                          <a
                            class="mft8-btn-qrz"
                            data-testid="mft8-strip-qrz"
                            href={qrzUrl(call)}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                          >
                            QRZ ↗
                          </a>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Collapsible Logged This Session (N) Drawer — collapsed by default */}
      <div class="mft8-session-drawer" data-testid="mft8-session-drawer">
        <button
          type="button"
          class="mft8-session-drawer-toggle"
          data-testid="mft8-session-drawer-toggle"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen((o) => !o)}
        >
          <span data-testid="mft8-session-drawer-label">
            {drawerOpen ? "▾" : "▸"} Logged This Session ({archivedItems.length})
          </span>
          <span style={{ color: "var(--mft8-text-muted)", fontWeight: 500 }}>
            {drawerOpen ? "Click to collapse" : "Click to expand archived session QSOs"}
          </span>
        </button>

        {drawerOpen && (
          <div
            class="mft8-session-drawer-body"
            data-testid="mft8-session-drawer-body"
          >
            {archivedItems.length === 0 ? (
              <div
                style={{
                  padding: "10px",
                  color: "var(--mft8-text-muted)",
                  fontSize: "10.5px",
                }}
              >
                No archived QSOs yet this session.
              </div>
            ) : (
              <table class="mft8-dense-table">
                <thead>
                  <tr>
                    <th>UTC</th>
                    <th>Callsign</th>
                    <th>Grid</th>
                    <th>Sent / Rcvd</th>
                    <th>Freq</th>
                    <th>Dist</th>
                    <th style={{ textAlign: "right" }}>QRZ</th>
                  </tr>
                </thead>
                <tbody>
                  {archivedItems.map(({ qso }) => {
                    const call = normalizeCall(qso.their_call);
                    const dist = gridDistance(myGrid, qso.their_grid);
                    const isHovered = Boolean(
                      hover.hoveredCallsign && hover.hoveredCallsign === call
                    );
                    return (
                      <tr
                        key={qso.qso_id}
                        data-testid="mft8-archived-row"
                        data-callsign={call}
                        data-hz={qso.af_hz ?? undefined}
                        class={isHovered ? "mft8-sync-hover" : undefined}
                      >
                        <td class="mft8-mono" style={{ color: "var(--mft8-text-muted)" }}>
                          {qso.completed_at_utc.slice(11, 19)}
                        </td>
                        <td
                          class="mft8-mono"
                          style={{ fontWeight: 700, color: "#e2e8f0" }}
                        >
                          {call}
                        </td>
                        <td
                          class="mft8-mono"
                          style={{ color: "var(--mft8-text-secondary)" }}
                        >
                          {qso.their_grid ?? "—"}
                        </td>
                        <td class="mft8-mono" style={{ color: "#6ee7b7" }}>
                          {qso.rst_sent ?? "--"} / {qso.rst_rcvd ?? "--"}
                        </td>
                        <td class="mft8-mono" style={{ color: "var(--mft8-text-muted)" }}>
                          {qso.af_hz ? `${qso.af_hz} Hz` : "—"}
                        </td>
                        <td
                          class="mft8-mono"
                          style={{ color: "var(--mft8-text-secondary)" }}
                        >
                          {dist ? `${dist.km.toLocaleString()} km` : "—"}
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <a
                            class="mft8-btn-qrz"
                            href={qrzUrl(call)}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            QRZ ↗
                          </a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
