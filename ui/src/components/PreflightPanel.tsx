import { useState } from "preact/hooks";
import type { PreflightCheck, PreflightReport } from "../types";

interface Props {
  report: PreflightReport | null;
  onRefresh: () => Promise<void>;
}

function statusBadgeClass(status: PreflightCheck["status"]): string {
  switch (status) {
    case "pass":
      return "badge-ok";
    case "warn":
      return "badge-warn";
    case "fail":
      return "badge-fail";
    case "info":
      return "badge-info";
  }
}

export function PreflightPanel({ report, onRefresh }: Props) {
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <section class="panel" aria-label="Startup Preflight Dependency Checks">
      <div class="panel-header">
        <div>
          <h2>Startup Preflight &amp; Dependency Health</h2>
          <p class="muted">
            {report
              ? `Platform: ${report.platform.os}/${report.platform.arch} · Checked ${report.checked_at_utc}`
              : "Loading preflight checks..."}
          </p>
        </div>
        <div class="panel-actions">
          {report && (
            <span
              class={`badge ${
                report.overall_status === "ok"
                  ? "badge-ok"
                  : report.overall_status === "ok_with_warnings"
                  ? "badge-warn"
                  : "badge-fail"
              }`}
            >
              {report.overall_status.replaceAll("_", " ").toUpperCase()}
            </span>
          )}
          <button
            class="btn btn-secondary"
            type="button"
            disabled={refreshing}
            onClick={() => void handleRefresh()}
          >
            {refreshing ? "Checking..." : "Re-run Preflight"}
          </button>
        </div>
      </div>

      {report ? (
        <div class="checks-list">
          {report.checks.map((chk) => (
            <div key={chk.id} class={`check-row check-${chk.status}`}>
              <div class="check-top">
                <div class="check-title">
                  <span class={`badge ${statusBadgeClass(chk.status)}`}>
                    {chk.status.toUpperCase()}
                  </span>
                  <span class="mono check-id">{chk.id}</span>
                  <span class="severity-tag">{chk.severity}</span>
                </div>
                <span class="check-detail">{chk.detail}</span>
              </div>
              {chk.remediation && (
                <div class="check-remediation">
                  <strong>Remediation:</strong> {chk.remediation}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p class="muted">No preflight report received yet.</p>
      )}
    </section>
  );
}
