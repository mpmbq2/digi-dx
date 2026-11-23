import { useState } from "preact/hooks";
import type {
  CommandAck,
  QrzPushSummary,
  QrzStatusSnapshot,
  QsoLogItem,
} from "../types";

interface Props {
  realQsos: QsoLogItem[];
  demoQsos: QsoLogItem[];
  qrzStatus: QrzStatusSnapshot | null;
  authRequired: boolean;
  authToken: string;
  onAuthTokenChange: (token: string) => void;
  onSendCommand: (
    kind: string,
    payload: Record<string, unknown>,
    token?: string,
    radioId?: string
  ) => Promise<CommandAck>;
  onRefresh: (demo: boolean, band?: string) => Promise<void>;
  onRefreshQrz: () => Promise<void>;
}

const BAND_FILTERS = [
  "",
  "160m",
  "80m",
  "60m",
  "40m",
  "30m",
  "20m",
  "17m",
  "15m",
  "12m",
  "10m",
  "6m",
  "2m",
];

function formatPushSummaryText(summary: QrzPushSummary): string {
  const parts: string[] = [];
  if (summary.pushed > 0) {
    parts.push(`${summary.pushed} pushed`);
  }
  if (summary.duplicates > 0) {
    parts.push(`${summary.duplicates} already on QRZ`);
  }
  if (summary.failed > 0) {
    parts.push(`${summary.failed} failed`);
  }
  if (summary.skipped_demo > 0) {
    parts.push(`${summary.skipped_demo} demo skipped`);
  }
  if (parts.length === 0) {
    return "No new real QSOs to push.";
  }
  let text = parts.join(" · ");
  if (summary.aborted_reason) {
    text += ` · aborted: ${summary.aborted_reason}`;
  }
  return text;
}

export function LogbookPanel({
  realQsos,
  demoQsos,
  qrzStatus,
  authRequired,
  authToken,
  onAuthTokenChange,
  onSendCommand,
  onRefresh,
  onRefreshQrz,
}: Props) {
  const [showDemo, setShowDemo] = useState(false);
  const [bandFilter, setBandFilter] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [testingConn, setTestingConn] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [settingsFeedback, setSettingsFeedback] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [pushFeedback, setPushFeedback] = useState<{
    ok: boolean;
    text: string;
    summary?: QrzPushSummary;
  } | null>(null);

  const items = showDemo ? demoQsos : realQsos;
  const unpushedCount =
    (qrzStatus?.pending_count ?? 0) + (qrzStatus?.failed_count ?? 0);
  const isPushing = pushing || Boolean(qrzStatus?.in_progress);

  const handleBandChange = (band: string) => {
    setBandFilter(band);
    void onRefresh(showDemo, band || undefined);
  };

  const handlePushToQrz = async () => {
    if (!qrzStatus?.configured) {
      setSettingsOpen(true);
      setPushFeedback({
        ok: false,
        text: "Enter and save your QRZ Logbook API key before pushing QSOs.",
      });
      return;
    }

    setPushing(true);
    setPushFeedback(null);
    try {
      const ack = await onSendCommand("qrz.push", {}, authToken);
      const summary = ack.result as unknown as QrzPushSummary | null;
      await Promise.all([
        onRefresh(false, bandFilter || undefined),
        onRefreshQrz(),
      ]);

      if (ack.status === "ok" && summary) {
        const hasFailures = summary.failed > 0 || Boolean(summary.aborted_reason);
        setPushFeedback({
          ok: !hasFailures,
          text: formatPushSummaryText(summary),
          summary,
        });
      } else {
        setPushFeedback({
          ok: false,
          text: `${ack.error_code ?? "ERR"}: ${ack.error_message ?? "Push failed"}`,
          summary: summary ?? undefined,
        });
      }
    } catch (err) {
      setPushFeedback({ ok: false, text: String(err) });
    } finally {
      setPushing(false);
    }
  };

  const handleSaveKey = async (e: Event) => {
    e.preventDefault();
    const trimmed = apiKeyInput.trim();
    if (!trimmed) {
      setSettingsFeedback({
        ok: false,
        text: "Enter a QRZ Logbook API key first.",
      });
      return;
    }
    setSavingKey(true);
    setSettingsFeedback(null);
    try {
      const ack = await onSendCommand(
        "qrz.update_config",
        { api_key: trimmed },
        authToken
      );
      if (ack.status === "ok") {
        setApiKeyInput("");
        setSettingsFeedback({
          ok: true,
          text: "QRZ Logbook API key saved.",
        });
        await onRefreshQrz();
      } else {
        setSettingsFeedback({
          ok: false,
          text: `${ack.error_code ?? "ERR"}: ${ack.error_message ?? "Failed to save key"}`,
        });
      }
    } catch (err) {
      setSettingsFeedback({ ok: false, text: String(err) });
    } finally {
      setSavingKey(false);
    }
  };

  const handleClearKey = async () => {
    setSavingKey(true);
    setSettingsFeedback(null);
    try {
      const ack = await onSendCommand(
        "qrz.update_config",
        { api_key: null },
        authToken
      );
      if (ack.status === "ok") {
        setApiKeyInput("");
        setSettingsFeedback({
          ok: true,
          text: "Saved QRZ API key cleared.",
        });
        await onRefreshQrz();
      } else {
        setSettingsFeedback({
          ok: false,
          text: `${ack.error_code ?? "ERR"}: ${ack.error_message ?? "Failed to clear key"}`,
        });
      }
    } catch (err) {
      setSettingsFeedback({ ok: false, text: String(err) });
    } finally {
      setSavingKey(false);
    }
  };

  const handleTestConnection = async () => {
    setTestingConn(true);
    setSettingsFeedback(null);
    try {
      const trimmed = apiKeyInput.trim();
      const payload = trimmed ? { api_key: trimmed } : {};
      const ack = await onSendCommand("qrz.test_connection", payload, authToken);
      if (ack.status === "ok" && ack.result) {
        const res = ack.result as {
          book_id?: string | null;
          callsign?: string | null;
          qso_count?: number | null;
        };
        const bits: string[] = [];
        if (res.callsign) bits.push(res.callsign);
        if (res.book_id) bits.push(`Book #${res.book_id}`);
        if (typeof res.qso_count === "number") bits.push(`${res.qso_count} QSOs`);
        setSettingsFeedback({
          ok: true,
          text:
            bits.length > 0
              ? `Connected to QRZ (${bits.join(" · ")})`
              : "Connected to QRZ Logbook API.",
        });
      } else {
        setSettingsFeedback({
          ok: false,
          text: `${ack.error_code ?? "ERR"}: ${ack.error_message ?? "Connection test failed"}`,
        });
      }
    } catch (err) {
      setSettingsFeedback({ ok: false, text: String(err) });
    } finally {
      setTestingConn(false);
    }
  };

  let pushBtnLabel = "Push to QRZ";
  if (isPushing) {
    const p = qrzStatus?.progress;
    pushBtnLabel =
      p && p.total > 0
        ? `Pushing to QRZ (${p.completed}/${p.total})...`
        : "Pushing to QRZ...";
  } else if (qrzStatus?.configured) {
    pushBtnLabel =
      unpushedCount > 0 ? `Push to QRZ (${unpushedCount})` : "Push to QRZ (0 new)";
  }

  const pushBtnDisabled =
    isPushing || (Boolean(qrzStatus?.configured) && unpushedCount === 0);

  const displayedSummary =
    pushFeedback?.summary ?? qrzStatus?.last_push_summary ?? null;

  return (
    <section class="panel" aria-label="QSO Logbook and ADIF Export">
      <div class="panel-header">
        <div>
          <h2>FT8 Logbook, QRZ Sync &amp; ADIF 3.1.4 Export</h2>
          <p class="muted">
            ADIF export and QRZ sync read exclusively from `qso_log` and strictly exclude simulated `demo_qso_log` records.
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
              void onRefreshQrz();
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
            onChange={(e) =>
              handleBandChange((e.currentTarget as HTMLSelectElement).value)
            }
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
            onClick={() => {
              void onRefresh(showDemo, bandFilter || undefined);
              if (!showDemo) void onRefreshQrz();
            }}
          >
            Refresh
          </button>
          {!showDemo && (
            <>
              <button
                type="button"
                class="btn btn-primary btn-sm"
                data-testid="push-qrz-btn"
                disabled={pushBtnDisabled}
                title={
                  qrzStatus?.configured && unpushedCount === 0
                    ? "All real QSOs are already synced to QRZ"
                    : "Push new and failed real QSOs to QRZ Logbook"
                }
                onClick={() => void handlePushToQrz()}
              >
                {pushBtnLabel}
              </button>
              <button
                type="button"
                class="btn btn-secondary btn-sm"
                data-testid="qrz-settings-toggle"
                onClick={() => setSettingsOpen((open) => !open)}
              >
                {qrzStatus?.configured
                  ? `QRZ: ${qrzStatus.key_hint ?? "Configured"}`
                  : "QRZ Setup"}
              </button>
            </>
          )}
          <a
            class="btn btn-secondary btn-sm"
            data-testid="export-adif-link"
            href="/api/v1/qsos/export.adi"
            download="digi-dx.adi"
          >
            Export ADIF 3.1.4 (.adi)
          </a>
        </div>
      </div>

      {!showDemo && settingsOpen && (
        <form
          class="qrz-settings-panel"
          data-testid="qrz-settings-panel"
          onSubmit={(e) => void handleSaveKey(e)}
        >
          <div class="qrz-settings-head">
            <div>
              <strong>QRZ Logbook API Settings</strong>
              <p class="muted">
                Find your key at `logbook.qrz.com` → Settings → API Key (requires an active QRZ XML Logbook subscription).
              </p>
            </div>
            {qrzStatus?.configured && (
              <span class="badge badge-ok">
                {qrzStatus.key_source === "env" ? "ENV OVERRIDE" : "KEY SAVED"} (
                {qrzStatus.key_hint ?? "••••"})
              </span>
            )}
          </div>

          {qrzStatus?.key_source === "env" && (
            <div class="demo-inline-note" style={{ marginBottom: 0 }}>
              `DIGI_DX_QRZ_API_KEY` environment variable is set and takes precedence over the saved database key.
            </div>
          )}

          <div class="qrz-settings-fields">
            <label>
              <span>QRZ Logbook API Key</span>
              <input
                type="password"
                data-testid="qrz-api-key-input"
                placeholder={
                  qrzStatus?.configured
                    ? `Current: ${qrzStatus.key_hint ?? "••••"} (enter to replace)`
                    : "XXXX-XXXX-XXXX-XXXX"
                }
                value={apiKeyInput}
                onInput={(e) =>
                  setApiKeyInput((e.currentTarget as HTMLInputElement).value)
                }
              />
            </label>
            {authRequired && (
              <label>
                <span>Daemon Bearer Token</span>
                <input
                  type="password"
                  placeholder="DIGI_DX_AUTH_TOKEN"
                  value={authToken}
                  onInput={(e) =>
                    onAuthTokenChange((e.currentTarget as HTMLInputElement).value)
                  }
                />
              </label>
            )}
          </div>

          <div class="qrz-settings-actions">
            <button
              type="submit"
              class="btn btn-primary btn-sm"
              data-testid="qrz-save-key-btn"
              disabled={savingKey || testingConn}
            >
              {savingKey ? "Saving..." : "Save Key"}
            </button>
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              data-testid="qrz-test-btn"
              disabled={
                testingConn ||
                savingKey ||
                (!apiKeyInput.trim() && !qrzStatus?.configured)
              }
              onClick={() => void handleTestConnection()}
            >
              {testingConn ? "Testing..." : "Test Connection"}
            </button>
            <button
              type="button"
              class="btn btn-danger btn-sm"
              data-testid="qrz-clear-key-btn"
              disabled={
                savingKey ||
                testingConn ||
                qrzStatus?.key_source !== "database"
              }
              onClick={() => void handleClearKey()}
            >
              Clear Key
            </button>
            {settingsFeedback && (
              <span class={settingsFeedback.ok ? "text-ok" : "text-err"}>
                {settingsFeedback.text}
              </span>
            )}
          </div>
        </form>
      )}

      {!showDemo &&
        (isPushing || pushFeedback || qrzStatus?.last_push_at_utc) && (
          <div class="qrz-status-banner" data-testid="qrz-status-banner">
            {isPushing ? (
              <div class="qrz-status-row">
                <span class="badge badge-info">SYNCING</span>
                <span>
                  {qrzStatus?.progress
                    ? `Uploading QSO ${qrzStatus.progress.completed} of ${qrzStatus.progress.total} (${qrzStatus.progress.pushed} pushed, ${qrzStatus.progress.duplicates} already on QRZ, ${qrzStatus.progress.failed} failed)`
                    : "Starting QRZ logbook push..."}
                </span>
              </div>
            ) : pushFeedback ? (
              <div class="qrz-status-row">
                <span
                  class={`badge ${pushFeedback.ok ? "badge-ok" : "badge-fail"}`}
                >
                  {pushFeedback.ok ? "QRZ PUSHED" : "QRZ PUSH"}
                </span>
                <span class={pushFeedback.ok ? "text-ok" : "text-err"}>
                  {pushFeedback.text}
                </span>
              </div>
            ) : (
              qrzStatus?.last_push_at_utc && (
                <div class="qrz-status-row">
                  <span class="badge badge-muted">LAST QRZ PUSH</span>
                  <span class="muted">
                    {qrzStatus.last_push_at_utc.slice(0, 19).replace("T", " ")} UTC
                    {qrzStatus.last_push_summary
                      ? ` · ${formatPushSummaryText(qrzStatus.last_push_summary)}`
                      : ""}
                  </span>
                </div>
              )
            )}

            {displayedSummary && displayedSummary.errors.length > 0 && (
              <ul class="qrz-error-list mono">
                {displayedSummary.errors.map((err) => (
                  <li key={err.qso_id}>
                    <strong>{err.their_call}</strong>: {err.reason}
                  </li>
                ))}
                <li class="muted">
                  Clicking Push to QRZ again will retry failed contacts.
                </li>
              </ul>
            )}
          </div>
        )}

      {showDemo && (
        <div class="demo-inline-note">
          Showing simulated `QQ*` QSOs (`demo_qso_log`). These records are isolated from `qso_log` and never exported to ADIF or pushed to QRZ.
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
              {!showDemo && <th>QRZ</th>}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colspan={showDemo ? 9 : 10} class="muted">
                  No {showDemo ? "demo " : ""}QSOs logged yet.
                </td>
              </tr>
            ) : (
              items.map((q) => (
                <tr
                  key={q.qso_id}
                  data-testid={showDemo ? "demo-qso-row" : "real-qso-row"}
                >
                  <td>{q.completed_at_utc.slice(0, 19).replace("T", " ")}</td>
                  <td>{q.my_call}</td>
                  <td>{q.their_call}</td>
                  <td>{q.their_grid ?? "—"}</td>
                  <td>{q.band ?? "—"}</td>
                  <td>
                    {q.dial_freq_hz
                      ? (q.dial_freq_hz / 1_000_000).toFixed(6)
                      : "—"}
                  </td>
                  <td>{q.af_hz ?? "—"}</td>
                  <td>
                    {q.rst_sent ?? "—"} / {q.rst_rcvd ?? "—"}
                  </td>
                  <td>{q.completion_reason}</td>
                  {!showDemo && (
                    <td data-testid="qso-qrz-status">
                      {q.qrz_status === "synced" ? (
                        <span
                          class="badge badge-ok"
                          title={[
                            q.qrz_logid ? `QRZ LogID #${q.qrz_logid}` : "Already on QRZ",
                            q.qrz_pushed_at_utc
                              ? `pushed ${q.qrz_pushed_at_utc.slice(0, 19).replace("T", " ")}Z`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        >
                          Synced
                        </span>
                      ) : q.qrz_status === "failed" ? (
                        <span
                          class="badge badge-fail"
                          title={q.qrz_error ?? "QRZ upload failed"}
                        >
                          Failed
                        </span>
                      ) : (
                        <span
                          class="badge badge-muted"
                          title="Not yet pushed to QRZ"
                        >
                          New
                        </span>
                      )}
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
