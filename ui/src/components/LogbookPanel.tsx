import { useState } from "preact/hooks";
import type { QsoLogItem } from "../types";

interface Props {
  realQsos: QsoLogItem[];
  demoQsos: QsoLogItem[];
  onRefresh: (demo: boolean, band?: string) => Promise<void>;
}

const BAND_FILTERS = ["", "160m", "80m", "60m", "40m", "30m", "20m", "17m", "15m", "12m", "10m", "6m", "2m"];

export function LogbookPanel({ realQsos, demoQsos, onRefresh }: Props) {
  const [showDemo, setShowDemo] = useState(false);
  const [bandFilter, setBandFilter] = useState("");

  const items = showDemo ? demoQsos : realQsos;

  const handleBandChange = (band: string) => {
    setBandFilter(band);
    void onRefresh(showDemo, band || undefined);
  };

  return (
    <section class="panel" aria-label="QSO Logbook and ADIF Export">
      <div class="panel-header">
        <div>
          <h2>FT8 Logbook &amp; ADIF 3.1.4 Export</h2>
          <p class="muted">
            ADIF export reads exclusively from `qso_log` and strictly excludes simulated `demo_qso_log` records.
          </p>
        </div>
        <div class="panel-actions">
          <button
            type="button"
            class={`btn btn-sm ${!showDemo ? "btn-primary" : "btn-secondary"}`}
            data-testid="tab-real-log"
            onClick={() => {
              setShowDemo(false);
              void onRefresh(false, bandFilter || undefined);
            }}
          >
            Real QSO Log ({realQsos.length})
          </button>
          <button
            type="button"
            class={`btn btn-sm ${showDemo ? "btn-primary" : "btn-secondary"}`}
            data-testid="tab-demo-log"
            onClick={() => {
              setShowDemo(true);
              void onRefresh(true, bandFilter || undefined);
            }}
          >
            Demo QSO Log ({demoQsos.length})
          </button>
          <select
            class="input-sm"
            aria-label="Filter by band"
            value={bandFilter}
            onChange={(e) => handleBandChange((e.currentTarget as HTMLSelectElement).value)}
          >
            {BAND_FILTERS.map((b) => (
              <option key={b || "all"} value={b}>
                {b ? b : "All Bands"}
              </option>
            ))}
          </select>
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            onClick={() => void onRefresh(showDemo, bandFilter || undefined)}
          >
            Refresh
          </button>
          <a
            class="btn btn-primary btn-sm"
            data-testid="export-adif-link"
            href="/api/v1/qsos/export.adi"
            download="digi-dx.adi"
          >
            Export ADIF 3.1.4 (.adi)
          </a>
        </div>
      </div>

      {showDemo && (
        <div class="demo-inline-note">
          Showing simulated `QQ*` QSOs (`demo_qso_log`). These records are isolated from `qso_log` and never exported to ADIF.
        </div>
      )}

      <div class="table-scroll">
        <table class="data-table mono">
          <thead>
            <tr>
              <th>Completed UTC</th>
              <th>My Call</th>
              <th>Their Call</th>
              <th>Grid</th>
              <th>Band</th>
              <th>Freq MHz</th>
              <th>AF</th>
              <th>RST S / R</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colspan={9} class="muted">
                  No {showDemo ? "demo " : ""}QSOs logged yet.
                </td>
              </tr>
            ) : (
              items.map((q) => (
                <tr key={q.qso_id} data-testid={showDemo ? "demo-qso-row" : "real-qso-row"}>
                  <td>{q.completed_at_utc.slice(0, 19).replace("T", " ")}</td>
                  <td>{q.my_call}</td>
                  <td>{q.their_call}</td>
                  <td>{q.their_grid ?? "—"}</td>
                  <td>{q.band ?? "—"}</td>
                  <td>{q.dial_freq_hz ? (q.dial_freq_hz / 1_000_000).toFixed(6) : "—"}</td>
                  <td>{q.af_hz ?? "—"}</td>
                  <td>
                    {q.rst_sent ?? "—"} / {q.rst_rcvd ?? "—"}
                  </td>
                  <td>{q.completion_reason}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
