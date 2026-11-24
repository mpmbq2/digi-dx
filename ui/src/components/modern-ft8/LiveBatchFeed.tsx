import { useMemo } from "preact/hooks";
import type { ActiveQso, DecodeItem } from "../../types";
import { parseFt8Decode } from "../../utils/maidenhead";
import { useCrossHighlight } from "./CrossHighlightContext";
import type { DigitalMode, QsoIdentity } from "./types";
import {
  classifyDecodeSection,
  fmtSnr,
  fmtUtcFromSec,
  hexToRgba,
  normalizeCall,
  snrClass,
} from "./utils";

interface Props {
  decodes: DecodeItem[];
  myCall: string | null;
  digitalMode: DigitalMode;
  slotMs: number;
  activeQsos: ActiveQso[];
  identities: Map<string, QsoIdentity>;
  recentlyAdvancedQsoIds: Set<string>;
  sessionActive: boolean;
  onCallStation: (callsign: string, dec: DecodeItem) => void;
}

interface CycleBatch {
  tsSec: number;
  timeStr: string;
  parity: "EVEN" | "ODD";
  decodes: DecodeItem[];
}

function findLinkedQso(
  dec: DecodeItem,
  parsedFrom: string,
  activeQsos: ActiveQso[]
): ActiveQso | null {
  const fromNorm = normalizeCall(parsedFrom);
  if (fromNorm) {
    const direct = activeQsos.find(
      (q) => !q.is_cq && normalizeCall(q.their_call) === fromNorm
    );
    if (direct) return direct;
  }

  const tokens = dec.message
    .toUpperCase()
    .split(/\s+/)
    .map((t) => normalizeCall(t))
    .filter(Boolean);

  for (const q of activeQsos) {
    if (q.is_cq) continue;
    const target = normalizeCall(q.their_call);
    if (target && tokens.includes(target)) {
      return q;
    }
  }
  return null;
}

export function LiveBatchFeed({
  decodes,
  myCall,
  digitalMode,
  slotMs,
  activeQsos,
  identities,
  recentlyAdvancedQsoIds,
  sessionActive,
  onCallStation,
}: Props) {
  const { hover } = useCrossHighlight();

  const batches = useMemo<CycleBatch[]>(() => {
    const map = new Map<number, DecodeItem[]>();
    for (const d of decodes) {
      const arr = map.get(d.ts_sec);
      if (arr) {
        arr.push(d);
      } else {
        map.set(d.ts_sec, [d]);
      }
    }

    const sortedTs = Array.from(map.keys()).sort((a, b) => b - a).slice(0, 20);
    return sortedTs.map((tsSec) => {
      const list = (map.get(tsSec) ?? []).slice().sort((a, b) => a.af_hz - b.af_hz);
      const firstSlot = list[0]?.slot;
      const derivedParity: "EVEN" | "ODD" =
        firstSlot === "odd"
          ? "ODD"
          : firstSlot === "even"
          ? "EVEN"
          : digitalMode === "FT4" && slotMs === 7500
          ? Math.floor((tsSec * 1000) / 7500) % 2 === 0
            ? "EVEN"
            : "ODD"
          : Math.floor(tsSec / 15) % 2 === 0
          ? "EVEN"
          : "ODD";
      return {
        tsSec,
        timeStr: fmtUtcFromSec(tsSec),
        parity: derivedParity,
        decodes: list,
      };
    });
  }, [decodes, digitalMode, slotMs]);

  const renderSection = (
    batchIdx: number,
    title: string,
    secClass: string,
    sectionKey: string,
    items: Array<{ dec: DecodeItem; parsedFrom: string }>
  ) => {
    if (items.length === 0) return null;
    const isLatest = batchIdx === 0;
    return (
      <div data-testid={`mft8-feed-section-${sectionKey}`}>
        <div class={`mft8-feed-section-head ${secClass}`}>
          <span>{title}</span>
          <span>{items.length}</span>
        </div>
        {items.map(({ dec, parsedFrom }) => {
          const linkedQso = findLinkedQso(dec, parsedFrom, activeQsos);
          const identity = linkedQso ? identities.get(linkedQso.qso_id) ?? null : null;
          const rowCall = normalizeCall(
            parsedFrom || (linkedQso ? linkedQso.their_call : "")
          );
          const isHovered = Boolean(
            hover.hoveredCallsign && rowCall && hover.hoveredCallsign === rowCall
          );
          const isAdvancedHere = Boolean(
            isLatest &&
              linkedQso &&
              recentlyAdvancedQsoIds.has(linkedQso.qso_id)
          );
          const rowStyle = identity
            ? {
                borderLeftColor: identity.color,
                backgroundColor: hexToRgba(identity.color, 0.13),
              }
            : undefined;

          return (
            <div
              key={`${dec.ts_sec}-${dec.af_hz}-${dec.message}`}
              data-testid="mft8-feed-row"
              data-section={sectionKey}
              data-callsign={rowCall || undefined}
              data-hz={dec.af_hz}
              data-color={identity?.color}
              class={`mft8-decode-row ${identity ? "in-qso" : ""} ${
                isHovered ? "mft8-sync-hover" : ""
              }`}
              style={rowStyle}
              title={
                rowCall
                  ? `Click to Call / Arm ${rowCall}`
                  : dec.message
              }
              onClick={() => {
                if (rowCall && sessionActive) {
                  onCallStation(rowCall, dec);
                }
              }}
            >
              <span class={`mft8-dec-snr ${snrClass(dec.snr_db)}`}>
                {fmtSnr(dec.snr_db)}
              </span>
              <span class="mft8-dec-hz">{dec.af_hz}Hz</span>
              <span class="mft8-dec-msg">{dec.message}</span>
              <span class="mft8-dec-badges">
                {dec.decoder_metadata && (
                  <span
                    class="mft8-tag"
                    style={{
                      background: "rgba(100, 116, 139, 0.2)",
                      color: "#cbd5e1",
                      borderColor: "rgba(100, 116, 139, 0.4)",
                    }}
                  >
                    {dec.decoder_metadata}
                  </span>
                )}
                {isAdvancedHere && (
                  <span class="mft8-tag mft8-tag-adv mft8-anim-pop">↳ ADV</span>
                )}
                {identity && (
                  <span
                    class="mft8-q-pill"
                    data-testid="mft8-feed-qso-pill"
                    style={{ background: identity.color }}
                  >
                    {identity.badge}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <aside class="mft8-feed-col" aria-label="Split-Rail Live Batch Feed">
      <section class="mft8-panel mft8-feed-panel">
        <div class="mft8-panel-header">
          <h2 class="mft8-panel-title">
            Live Batch Feed
            <span class="mft8-count-chip" data-testid="mft8-feed-cycle-count">
              {batches.length} {batches.length === 1 ? "cycle" : "cycles"}
            </span>
          </h2>
          <span style={{ fontSize: "10px", color: "var(--mft8-text-muted)" }}>
            QSO colors persist across all 3 sections
          </span>
        </div>

        <div class="mft8-feed-scroll" data-testid="mft8-live-batch-feed">
          {batches.length === 0 ? (
            <div
              style={{
                padding: "20px 12px",
                textAlign: "center",
                color: "var(--mft8-text-muted)",
                fontSize: "11px",
              }}
            >
              {sessionActive
                ? `Waiting for ${digitalMode} decode cycle...`
                : "Start a session to stream live decode batches."}
            </div>
          ) : (
            batches.map((batch, bIdx) => {
              const targetingMe: Array<{ dec: DecodeItem; parsedFrom: string }> = [];
              const cqList: Array<{ dec: DecodeItem; parsedFrom: string }> = [];
              const targetingOthers: Array<{ dec: DecodeItem; parsedFrom: string }> = [];

              for (const dec of batch.decodes) {
                const parsed = parseFt8Decode(dec.message);
                const sec = classifyDecodeSection(dec.message, myCall);
                const item = { dec, parsedFrom: parsed.from };
                if (sec === "TARGETING_ME") targetingMe.push(item);
                else if (sec === "CQ") cqList.push(item);
                else targetingOthers.push(item);
              }

              return (
                <div
                  key={batch.tsSec}
                  data-testid="mft8-cycle-block"
                  data-ts-sec={batch.tsSec}
                  class={`mft8-cycle-block ${bIdx === 0 ? "" : "older"}`}
                >
                  <div class="mft8-cycle-block-head">
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                      }}
                    >
                      <span style={{ color: "#fff" }}>{batch.timeStr}</span>
                      <span
                        class={`mft8-slot-badge ${
                          batch.parity === "EVEN"
                            ? "mft8-slot-even"
                            : "mft8-slot-odd"
                        }`}
                      >
                        {batch.parity}
                      </span>
                      {bIdx === 0 && (
                        <span style={{ color: "#34d399", fontSize: "9.5px" }}>
                          LATEST
                        </span>
                      )}
                    </span>
                    <span
                      style={{
                        color: "var(--mft8-text-muted)",
                        fontSize: "9.5px",
                      }}
                    >
                      {batch.decodes.length} decodes
                    </span>
                  </div>

                  {renderSection(bIdx, "Targeting Me", "mft8-sec-me", "me", targetingMe)}
                  {renderSection(bIdx, "CQ", "mft8-sec-cq", "cq", cqList)}
                  {renderSection(
                    bIdx,
                    "Targeting Others",
                    "mft8-sec-others",
                    "others",
                    targetingOthers
                  )}
                </div>
              );
            })
          )}
        </div>
      </section>
    </aside>
  );
}
