import { Fragment } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { ActiveQso, ChannelRosterEntry, CompletedSessionQso } from "../../types";
import { gridDistance } from "../../utils/maidenhead";
import { useCrossHighlight } from "./CrossHighlightContext";
import type {
  DigitalMode,
  QsoIdentity,
  RosterFilter,
  RosterSortCol,
  RosterSortPreset,
} from "./types";
import {
  extractStationTags,
  fmtSnr,
  hexToRgba,
  normalizeCall,
  qrzUrl,
  snrClass,
} from "./utils";

interface Props {
  entries: ChannelRosterEntry[];
  activeQsos: ActiveQso[];
  identities: Map<string, QsoIdentity>;
  sessionCompletedQsos: CompletedSessionQso[];
  myGrid: string | null;
  digitalMode: DigitalMode;
  clockScale: number;
  sessionActive: boolean;
  onCallRoster: (entry: ChannelRosterEntry) => void;
  onArmQso: (q: ActiveQso, afHz: number) => void;
}

const ROSTER_WINDOW_MS = 300_000;

interface EnrichedRow {
  entry: ChannelRosterEntry;
  callNorm: string;
  distKm: number | null;
  ageSec: number;
  tags: string[];
  activeQso: ActiveQso | null;
  identity: QsoIdentity | null;
  isSessionLogged: boolean;
}

function compareNullable<T>(
  aVal: T | null | undefined,
  bVal: T | null | undefined,
  cmp: (a: T, b: T) => number,
  asc: boolean
): number {
  const aMissing = aVal === null || aVal === undefined || aVal === "";
  const bMissing = bVal === null || bVal === undefined || bVal === "";
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  const res = cmp(aVal, bVal);
  return asc ? res : -res;
}

export function ModernChannelRoster({
  entries,
  activeQsos,
  identities,
  sessionCompletedQsos,
  myGrid,
  digitalMode,
  clockScale,
  sessionActive,
  onCallRoster,
  onArmQso,
}: Props) {
  const { hover } = useCrossHighlight();
  const [sortPreset, setSortPreset] = useState<RosterSortPreset>("fresh_dist");
  const [colSort, setColSort] = useState<{
    col: RosterSortCol;
    dir: "asc" | "desc";
  } | null>(null);
  const [filter, setFilter] = useState<RosterFilter>("all");
  const [search, setSearch] = useState("");
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const freshThresholdSec = digitalMode === "FT4" ? 15 : 30;

  const activeByCall = useMemo(() => {
    const map = new Map<string, ActiveQso>();
    for (const q of activeQsos) {
      if (!q.is_cq) {
        map.set(normalizeCall(q.their_call), q);
      }
    }
    return map;
  }, [activeQsos]);

  const loggedCallSet = useMemo(() => {
    const set = new Set<string>();
    for (const item of sessionCompletedQsos) {
      set.add(normalizeCall(item.qso.their_call));
    }
    return set;
  }, [sessionCompletedQsos]);

  const rows = useMemo<EnrichedRow[]>(() => {
    const qUpper = search.trim().toUpperCase();
    const enriched = entries
      .filter((e) => nowMs - e.last_seen_wall_ms <= ROSTER_WINDOW_MS)
      .map((entry): EnrichedRow => {
        const callNorm = normalizeCall(entry.callsign);
        const dist = gridDistance(myGrid, entry.grid);
        const distKm = dist ? dist.km : null;
        const ageSec = Math.max(
          0,
          Math.round(((nowMs - entry.last_seen_wall_ms) * clockScale) / 1000)
        );
        const tags = extractStationTags(callNorm, entry.last_message, distKm);
        const activeQso = activeByCall.get(callNorm) ?? null;
        const identity = activeQso ? identities.get(activeQso.qso_id) ?? null : null;
        const isSessionLogged = !activeQso && loggedCallSet.has(callNorm);
        return {
          entry,
          callNorm,
          distKm,
          ageSec,
          tags,
          activeQso,
          identity,
          isSessionLogged,
        };
      })
      .filter((r) => {
        if (filter === "cq" && !r.entry.is_cq) return false;
        if (
          filter === "sotapota" &&
          !r.tags.includes("SOTA") &&
          !r.tags.includes("POTA")
        ) {
          return false;
        }
        if (filter === "inqso" && !r.activeQso) return false;
        if (qUpper) {
          const matchCall = r.callNorm.includes(qUpper);
          const matchGrid = (r.entry.grid ?? "").toUpperCase().includes(qUpper);
          if (!matchCall && !matchGrid) return false;
        }
        return true;
      });

    enriched.sort((a, b) => {
      if (colSort) {
        const asc = colSort.dir === "asc";
        let cmp = 0;
        switch (colSort.col) {
          case "callsign":
            cmp = a.callNorm.localeCompare(b.callNorm) * (asc ? 1 : -1);
            break;
          case "grid":
            cmp = compareNullable(
              a.entry.grid,
              b.entry.grid,
              (x, y) => x.localeCompare(y),
              asc
            );
            break;
          case "dist":
            cmp = compareNullable(a.distKm, b.distKm, (x, y) => x - y, asc);
            break;
          case "snr":
            cmp = (a.entry.last_snr_db - b.entry.last_snr_db) * (asc ? 1 : -1);
            break;
          case "freq":
            cmp = (a.entry.last_af_hz - b.entry.last_af_hz) * (asc ? 1 : -1);
            break;
          case "slot":
            cmp = a.entry.last_slot.localeCompare(b.entry.last_slot) * (asc ? 1 : -1);
            break;
          case "age":
            cmp = (a.ageSec - b.ageSec) * (asc ? 1 : -1);
            break;
        }
        return cmp !== 0 ? cmp : a.callNorm.localeCompare(b.callNorm);
      }

      if (sortPreset === "fresh_dist") {
        const aF = a.ageSec <= freshThresholdSec ? 0 : 1;
        const bF = b.ageSec <= freshThresholdSec ? 0 : 1;
        if (aF !== bF) return aF - bF;
        const cmp = compareNullable(a.distKm, b.distKm, (x, y) => x - y, false);
        return cmp !== 0 ? cmp : a.callNorm.localeCompare(b.callNorm);
      }
      if (sortPreset === "strict_dist") {
        if (a.ageSec !== b.ageSec) return a.ageSec - b.ageSec;
        return compareNullable(a.distKm, b.distKm, (x, y) => x - y, false);
      }
      if (sortPreset === "snr_desc") {
        return b.entry.last_snr_db - a.entry.last_snr_db;
      }
      if (sortPreset === "dist_desc") {
        return compareNullable(a.distKm, b.distKm, (x, y) => x - y, false);
      }
      if (sortPreset === "freq_asc") {
        return a.entry.last_af_hz - b.entry.last_af_hz;
      }
      return 0;
    });

    return enriched;
  }, [
    entries,
    nowMs,
    clockScale,
    myGrid,
    activeByCall,
    identities,
    loggedCallSet,
    filter,
    search,
    colSort,
    sortPreset,
    freshThresholdSec,
  ]);

  const toggleColSort = (col: RosterSortCol) => {
    if (colSort && colSort.col === col) {
      setColSort({ col, dir: colSort.dir === "asc" ? "desc" : "asc" });
    } else {
      const defaultAsc =
        col === "callsign" || col === "grid" || col === "freq" || col === "age";
      setColSort({ col, dir: defaultAsc ? "asc" : "desc" });
    }
  };

  const renderSortHead = (col: RosterSortCol, label: string) => {
    const isSorted = colSort?.col === col;
    const arrow = isSorted ? (colSort?.dir === "asc" ? " ▲" : " ▼") : "";
    return (
      <th
        class={`sortable ${isSorted ? "sorted" : ""}`}
        data-testid={`mft8-roster-sort-${col}`}
        onClick={() => toggleColSort(col)}
      >
        {label}
        {arrow}
      </th>
    );
  };

  const showFreshBuckets = !colSort && sortPreset === "fresh_dist";
  let addedFreshHdr = false;
  let addedStaleHdr = false;

  return (
    <section
      class="mft8-panel mft8-panel-roster"
      data-testid="mft8-roster-panel"
      aria-label="Channel Roster"
    >
      <div class="mft8-panel-header">
        <h2 class="mft8-panel-title">
          Channel Roster
          <span class="mft8-count-chip" data-testid="mft8-roster-count">
            {rows.length}
          </span>
        </h2>

        <div class="mft8-roster-controls">
          <select
            class="mft8-dark-select"
            data-testid="mft8-roster-sort-preset"
            aria-label="Roster Sort Preset"
            value={sortPreset}
            onChange={(e) => {
              setSortPreset(
                (e.currentTarget as HTMLSelectElement).value as RosterSortPreset
              );
              setColSort(null);
            }}
          >
            <option value="fresh_dist">Fresh (≤2 cyc) → Distance ↓</option>
            <option value="strict_dist">Strict Last Seen → Distance ↓</option>
            <option value="snr_desc">SNR ↓</option>
            <option value="dist_desc">Distance ↓</option>
            <option value="freq_asc">Freq ↑</option>
          </select>

          <div class="mft8-pill-group" role="group" aria-label="Roster Quick Filter">
            {(
              [
                { id: "all", label: "All" },
                { id: "cq", label: "CQ Only" },
                { id: "sotapota", label: "SOTA/POTA" },
                { id: "inqso", label: "Active QSOs" },
              ] as const
            ).map((f) => (
              <button
                key={f.id}
                type="button"
                data-testid={`mft8-filter-${f.id}`}
                class={`mft8-filter-pill ${filter === f.id ? "active" : ""}`}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>

          <input
            type="text"
            class="mft8-dark-input"
            data-testid="mft8-roster-search"
            placeholder="Call / Grid..."
            aria-label="Search callsign or grid"
            value={search}
            onInput={(e) => setSearch((e.currentTarget as HTMLInputElement).value)}
          />
        </div>
      </div>

      <div class="mft8-table-scroll">
        <table class="mft8-dense-table" data-testid="mft8-roster-table">
          <thead>
            <tr>
              <th>QSO</th>
              {renderSortHead("callsign", "Callsign")}
              {renderSortHead("grid", "Grid")}
              {renderSortHead("dist", "Dist (km)")}
              {renderSortHead("snr", "SNR")}
              {renderSortHead("freq", "Freq")}
              {renderSortHead("slot", "Slot")}
              {renderSortHead("age", "Age")}
              <th>Last Message</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={10}
                  style={{
                    textAlign: "center",
                    color: "var(--mft8-text-muted)",
                    padding: "14px",
                  }}
                >
                  No stations on this channel match the current filter.
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const isFresh = r.ageSec <= freshThresholdSec;
                let dividerRow: preact.JSX.Element | null = null;
                if (showFreshBuckets) {
                  if (isFresh && !addedFreshHdr) {
                    addedFreshHdr = true;
                    dividerRow = (
                      <tr class="bucket-divider">
                        <td colSpan={10}>
                          ● FRESH WINDOW (≤{freshThresholdSec}s · 2 cycles) — Even &amp;
                          Odd stable while sorted by Distance ↓
                        </td>
                      </tr>
                    );
                  } else if (!isFresh && !addedStaleHdr) {
                    addedStaleHdr = true;
                    dividerRow = (
                      <tr class="bucket-divider stale">
                        <td colSpan={10}>
                          ○ STALE (&gt;{freshThresholdSec}s ago)
                        </td>
                      </tr>
                    );
                  }
                }

                const slotLetter = r.entry.last_slot === "odd" ? "O" : "E";
                const isHovered = Boolean(
                  hover.hoveredCallsign && hover.hoveredCallsign === r.callNorm
                );
                const rowStyle = r.identity
                  ? { backgroundColor: hexToRgba(r.identity.color, 0.06) }
                  : undefined;

                return (
                  <Fragment key={r.entry.channel_key + ":" + r.callNorm}>
                    {dividerRow}
                    <tr
                      data-testid="mft8-roster-row"
                      data-callsign={r.callNorm}
                      data-hz={r.entry.last_af_hz}
                      data-color={r.identity?.color}
                      class={`${isFresh ? "" : "stale-row"} ${
                        isHovered ? "mft8-sync-hover" : ""
                      }`}
                      style={rowStyle}
                    >
                      <td>
                        {r.identity ? (
                          <span
                            class="mft8-q-pill"
                            style={{ background: r.identity.color }}
                          >
                            {r.identity.badge}
                          </span>
                        ) : r.isSessionLogged ? (
                          <span class="mft8-q-pill mft8-q-pill-log">LOG</span>
                        ) : null}
                      </td>
                      <td>
                        <strong class="mft8-mono" style={{ color: "#fff" }}>
                          {r.callNorm}
                        </strong>{" "}
                        {r.tags.map((t) => (
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
                      </td>
                      <td
                        class="mft8-mono"
                        style={{ color: "var(--mft8-text-secondary)" }}
                      >
                        {r.entry.grid ?? "—"}
                      </td>
                      <td
                        class="mft8-mono"
                        style={{ color: "var(--mft8-text-secondary)" }}
                      >
                        {r.distKm !== null ? r.distKm.toLocaleString() : "—"}
                      </td>
                      <td class={`mft8-mono ${snrClass(r.entry.last_snr_db)}`}>
                        {fmtSnr(r.entry.last_snr_db)}
                      </td>
                      <td class="mft8-mono" style={{ color: "var(--mft8-text-muted)" }}>
                        {r.entry.last_af_hz}
                      </td>
                      <td>
                        <span class={`mft8-slot-letter mft8-slot-${slotLetter}`}>
                          {slotLetter}
                        </span>
                      </td>
                      <td
                        class="mft8-mono"
                        style={{ color: isFresh ? "#6ee7b7" : "#64748b" }}
                      >
                        {r.ageSec}s
                      </td>
                      <td
                        class="mft8-mono mft8-roster-msg-cell"
                        title={r.entry.last_message}
                      >
                        {r.entry.last_message}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <div class="mft8-actions-cell">
                          <button
                            type="button"
                            class="mft8-btn mft8-btn-xs mft8-btn-call"
                            data-testid="mft8-roster-call-btn"
                            disabled={!sessionActive}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (r.activeQso) {
                                onArmQso(r.activeQso, r.entry.last_af_hz);
                              } else {
                                onCallRoster(r.entry);
                              }
                            }}
                          >
                            {r.activeQso ? "Arm" : "Call"}
                          </button>
                          <a
                            class="mft8-btn-qrz"
                            data-testid="mft8-roster-qrz"
                            href={qrzUrl(r.callNorm)}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                          >
                            QRZ ↗
                          </a>
                        </div>
                      </td>
                    </tr>
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
