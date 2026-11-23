import { useEffect, useMemo, useState } from "preact/hooks";
import type { ChannelRosterEntry } from "../types";
import { gridDistance } from "../utils/maidenhead";

type SortColumn =
  | "callsign"
  | "role"
  | "grid"
  | "distance"
  | "snr"
  | "af"
  | "slot"
  | "age";

type DistanceUnit = "mi" | "km";

interface Props {
  entries: ChannelRosterEntry[];
  channelKey: string | null;
  band: string | null;
  myGrid: string | null;
  workedCalls: Set<string>;
  queuedCalls: Set<string>;
  sessionActive: boolean;
  onReply: (entry: ChannelRosterEntry) => void;
  onRefresh: () => void;
}

const ROSTER_WINDOW_MS = 300_000;

function loadStoredUnit(): DistanceUnit {
  try {
    return window.localStorage.getItem("digi_dx_dist_unit") === "km"
      ? "km"
      : "mi";
  } catch {
    return "mi";
  }
}

function formatAge(ageSec: number): string {
  const s = Math.max(0, Math.round(ageSec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

/**
 * Compare two nullable column values while always pinning null/undefined values
 * to the bottom regardless of ascending or descending sort direction.
 */
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

export function ChannelRosterPanel({
  entries,
  channelKey,
  band,
  myGrid,
  workedCalls,
  queuedCalls,
  sessionActive,
  onReply,
  onRefresh,
}: Props) {
  const [sortCol, setSortCol] = useState<SortColumn>("age");
  const [sortAsc, setSortAsc] = useState<boolean>(true);
  const [unit, setUnit] = useState<DistanceUnit>(loadStoredUnit);
  const [query, setQuery] = useState("");
  const [cqOnly, setCqOnly] = useState(false);
  const [hideWorked, setHideWorked] = useState(false);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 5000);
    return () => window.clearInterval(id);
  }, []);

  const toggleUnit = () => {
    const next: DistanceUnit = unit === "mi" ? "km" : "mi";
    setUnit(next);
    try {
      window.localStorage.setItem("digi_dx_dist_unit", next);
    } catch {
      // Ignore storage failures
    }
  };

  const handleSort = (col: SortColumn) => {
    if (sortCol === col) {
      setSortAsc(!sortAsc);
    } else {
      setSortCol(col);
      setSortAsc(col !== "snr");
    }
  };

  const enriched = useMemo(() => {
    const q = query.trim().toUpperCase();
    return entries
      .filter((e) => nowMs - e.last_seen_wall_ms <= ROSTER_WINDOW_MS)
      .filter((e) => {
        if (cqOnly && !e.is_cq) return false;
        if (hideWorked && workedCalls.has(e.callsign)) return false;
        if (q) {
          return (
            e.callsign.includes(q) ||
            (e.grid ?? "").includes(q) ||
            (e.station_role ?? "").toUpperCase().includes(q) ||
            e.last_message.includes(q)
          );
        }
        return true;
      })
      .map((entry) => {
        const dist = gridDistance(myGrid, entry.grid);
        const ageSec = Math.max(0, (nowMs - entry.last_seen_wall_ms) / 1000);
        return {
          entry,
          dist,
          ageSec,
          isWorked: workedCalls.has(entry.callsign),
          isQueued: queuedCalls.has(entry.callsign),
        };
      })
      .sort((a, b) => {
        let cmp = 0;
        switch (sortCol) {
          case "callsign":
            cmp = compareNullable(
              a.entry.callsign,
              b.entry.callsign,
              (x, y) => x.localeCompare(y),
              sortAsc
            );
            break;
          case "role":
            cmp = compareNullable(
              a.entry.station_role,
              b.entry.station_role,
              (x, y) => x.localeCompare(y),
              sortAsc
            );
            break;
          case "grid":
            cmp = compareNullable(
              a.entry.grid,
              b.entry.grid,
              (x, y) => x.localeCompare(y),
              sortAsc
            );
            break;
          case "distance": {
            const da = a.dist ? (unit === "km" ? a.dist.km : a.dist.miles) : null;
            const db = b.dist ? (unit === "km" ? b.dist.km : b.dist.miles) : null;
            cmp = compareNullable(da, db, (x, y) => x - y, sortAsc);
            break;
          }
          case "snr":
            cmp = compareNullable(
              a.entry.last_snr_db,
              b.entry.last_snr_db,
              (x, y) => x - y,
              sortAsc
            );
            break;
          case "af":
            cmp = compareNullable(
              a.entry.last_af_hz,
              b.entry.last_af_hz,
              (x, y) => x - y,
              sortAsc
            );
            break;
          case "slot":
            cmp = compareNullable(
              a.entry.last_slot,
              b.entry.last_slot,
              (x, y) => x.localeCompare(y),
              sortAsc
            );
            break;
          case "age":
            cmp = compareNullable(a.ageSec, b.ageSec, (x, y) => x - y, sortAsc);
            break;
        }
        if (cmp === 0) {
          return a.entry.callsign.localeCompare(b.entry.callsign);
        }
        return cmp;
      });
  }, [entries, nowMs, cqOnly, hideWorked, workedCalls, queuedCalls, query, myGrid, sortCol, sortAsc, unit]);

  const sortArrow = (col: SortColumn) => {
    if (sortCol !== col) return "";
    return sortAsc ? " ↑" : " ↓";
  };

  return (
    <section class="panel" data-testid="channel-roster-panel" aria-label="Channel Roster">
      <div class="panel-header">
        <div>
          <h2>Channel Roster ({enriched.length})</h2>
          <p class="muted mono" data-testid="roster-channel-label">
            {band ? `${band} · ` : ""}
            {channelKey ?? "FT8:unknown"} · Last 5 min
          </p>
        </div>
        <div class="panel-actions">
          <input
            type="text"
            class="input-sm mono"
            placeholder="Filter call/grid..."
            value={query}
            onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
          />
          <button
            type="button"
            class={`btn btn-xs ${cqOnly ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setCqOnly((v) => !v)}
          >
            CQ Only
          </button>
          <button
            type="button"
            class={`btn btn-xs ${hideWorked ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setHideWorked((v) => !v)}
          >
            Hide Worked
          </button>
          <button
            type="button"
            class="btn btn-secondary btn-xs"
            data-testid="roster-unit-toggle"
            onClick={toggleUnit}
          >
            Dist: {unit}
          </button>
          <button
            type="button"
            class="btn btn-secondary btn-xs"
            onClick={onRefresh}
          >
            Refresh
          </button>
        </div>
      </div>

      <div class="table-scroll">
        <table class="data-table mono">
          <thead>
            <tr>
              <th>
                <button
                  type="button"
                  class="sort-btn"
                  data-testid="roster-sort-callsign"
                  onClick={() => handleSort("callsign")}
                >
                  Call{sortArrow("callsign")}
                </button>
              </th>
              <th>
                <button
                  type="button"
                  class="sort-btn"
                  data-testid="roster-sort-role"
                  onClick={() => handleSort("role")}
                >
                  Role{sortArrow("role")}
                </button>
              </th>
              <th>
                <button
                  type="button"
                  class="sort-btn"
                  data-testid="roster-sort-grid"
                  onClick={() => handleSort("grid")}
                >
                  Grid{sortArrow("grid")}
                </button>
              </th>
              <th>
                <button
                  type="button"
                  class="sort-btn"
                  data-testid="roster-sort-distance"
                  onClick={() => handleSort("distance")}
                >
                  Dist ({unit}){sortArrow("distance")}
                </button>
              </th>
              <th>
                <button
                  type="button"
                  class="sort-btn"
                  data-testid="roster-sort-snr"
                  onClick={() => handleSort("snr")}
                >
                  SNR{sortArrow("snr")}
                </button>
              </th>
              <th>
                <button
                  type="button"
                  class="sort-btn"
                  data-testid="roster-sort-af"
                  onClick={() => handleSort("af")}
                >
                  AF{sortArrow("af")}
                </button>
              </th>
              <th>
                <button
                  type="button"
                  class="sort-btn"
                  data-testid="roster-sort-slot"
                  onClick={() => handleSort("slot")}
                >
                  Slot{sortArrow("slot")}
                </button>
              </th>
              <th>
                <button
                  type="button"
                  class="sort-btn"
                  data-testid="roster-sort-age"
                  onClick={() => handleSort("age")}
                >
                  Age{sortArrow("age")}
                </button>
              </th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {enriched.length === 0 ? (
              <tr>
                <td colspan={10} class="muted">
                  No stations seen on this channel in the last 5 minutes.
                </td>
              </tr>
            ) : (
              enriched.map(({ entry, dist, ageSec, isWorked, isQueued }) => {
                const distLabel = dist
                  ? `${unit === "km" ? dist.km : dist.miles} ${unit} (${dist.bearingDeg}°)`
                  : "—";
                const qrzCall = entry.callsign.replace(/[<>]/g, "").trim();
                return (
                  <tr
                    key={entry.callsign}
                    data-testid="roster-row"
                    class={
                      entry.calling_me
                        ? "row-mine"
                        : entry.is_cq
                        ? "row-cq"
                        : ""
                    }
                  >
                    <td style={{ fontWeight: 700 }}>{entry.callsign}</td>
                    <td>
                      {entry.station_role === "caller" ? (
                        <span
                          class="badge badge-role-caller"
                          data-testid="roster-role-badge"
                        >
                          CALLER
                        </span>
                      ) : entry.station_role === "hunter" ? (
                        <span
                          class="badge badge-role-hunter"
                          data-testid="roster-role-badge"
                        >
                          HUNTER
                        </span>
                      ) : (
                        <span class="muted">—</span>
                      )}
                    </td>
                    <td>{entry.grid ?? "—"}</td>
                    <td>{distLabel}</td>
                    <td>
                      {entry.last_snr_db >= 0
                        ? `+${entry.last_snr_db}`
                        : entry.last_snr_db}
                    </td>
                    <td>{entry.last_af_hz}</td>
                    <td>
                      <span
                        class={`slot-pill ${
                          entry.last_slot === "even" ? "slot-even" : "slot-odd"
                        }`}
                      >
                        {entry.last_slot.toUpperCase()}
                      </span>
                    </td>
                    <td>{formatAge(ageSec)}</td>
                    <td>
                      <div class="hw-badges">
                        {entry.calling_me && (
                          <span class="badge badge-fail">CALLING YOU</span>
                        )}
                        {entry.is_cq && (
                          <span class="badge badge-ok">
                            {entry.directed_cq ? `CQ ${entry.directed_cq}` : "CQ"}
                          </span>
                        )}
                        {isWorked && <span class="badge badge-muted">B4</span>}
                        {isQueued && <span class="badge badge-info">QUEUED</span>}
                      </div>
                    </td>
                    <td>
                      <div class="hw-badges">
                        <button
                          type="button"
                          class="btn btn-secondary btn-xs"
                          disabled={!sessionActive}
                          onClick={() => onReply(entry)}
                        >
                          Reply
                        </button>
                        <a
                          class="btn btn-secondary btn-xs"
                          data-testid="roster-qrz-link"
                          href={`https://www.qrz.com/db/${encodeURIComponent(qrzCall)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={`Open ${qrzCall} on QRZ.com`}
                        >
                          QRZ ↗
                        </a>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
