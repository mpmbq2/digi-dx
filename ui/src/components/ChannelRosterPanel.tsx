import { useEffect, useMemo, useState } from "preact/hooks";
import type { ChannelRosterEntry } from "../types";
import { gridDistance } from "../utils/maidenhead";

type SortColumn =
  | "callsign"
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
      // Default SNR descending, others ascending
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
            cmp = a.entry.callsign.localeCompare(b.entry.callsign);
            break;
          case "grid":
            cmp = (a.entry.grid ?? "ZZZZ").localeCompare(b.entry.grid ?? "ZZZZ");
            break;
          case "distance": {
            const da = a.dist ? (unit === "km" ? a.dist.km : a.dist.miles) : Number.MAX_SAFE_INTEGER;
            const db = b.dist ? (unit === "km" ? b.dist.km : b.dist.miles) : Number.MAX_SAFE_INTEGER;
            cmp = da - db;
            break;
          }
          case "snr":
            cmp = a.entry.last_snr_db - b.entry.last_snr_db;
            break;
          case "af":
            cmp = a.entry.last_af_hz - b.entry.last_af_hz;
            break;
          case "slot":
            cmp = a.entry.last_slot.localeCompare(b.entry.last_slot);
            break;
          case "age":
            cmp = a.ageSec - b.ageSec;
            break;
        }
        if (cmp === 0) {
          cmp = a.entry.callsign.localeCompare(b.entry.callsign);
        }
        return sortAsc ? cmp : -cmp;
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
                <td colspan={9} class="muted">
                  No stations seen on this channel in the last 5 minutes.
                </td>
              </tr>
            ) : (
              enriched.map(({ entry, dist, ageSec, isWorked, isQueued }) => {
                const distLabel = dist
                  ? `${unit === "km" ? dist.km : dist.miles} ${unit} (${dist.bearingDeg}°)`
                  : "—";
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
                      <button
                        type="button"
                        class="btn btn-secondary btn-xs"
                        disabled={!sessionActive}
                        onClick={() => onReply(entry)}
                      >
                        Reply
                      </button>
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
