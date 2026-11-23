use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;
use reqwest::header::{ACCEPT, CONTENT_TYPE, USER_AGENT};
use serde::{Deserialize, Serialize};
use serde_json::json;
use thiserror::Error;
use tokio::sync::{broadcast, Mutex as AsyncMutex};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::command_bus::WsBroadcastEvent;
use crate::domain::adif::format_adif_record;
use crate::store::{now_utc_str, QrzPushErrorItem, QrzPushSummary, StateStore, StoreError};
use crate::telemetry::TelemetryEnvelope;

const DEFAULT_INTER_REQUEST_DELAY: Duration = Duration::from_millis(150);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QrzKeySource {
    Env,
    Database,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QrzPushProgress {
    pub completed: usize,
    pub total: usize,
    pub pushed: usize,
    pub duplicates: usize,
    pub failed: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QrzStatusSnapshot {
    pub configured: bool,
    pub key_source: QrzKeySource,
    pub key_hint: Option<String>,
    pub pending_count: i64,
    pub failed_count: i64,
    pub synced_count: i64,
    pub in_progress: bool,
    pub progress: Option<QrzPushProgress>,
    pub last_push_at_utc: Option<String>,
    pub last_push_summary: Option<QrzPushSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QrzAccountStatus {
    pub book_id: Option<String>,
    pub callsign: Option<String>,
    pub qso_count: Option<u64>,
    pub confirmed_count: Option<u64>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub raw_data: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QrzInsertOutcome {
    Inserted { logid: Option<String> },
    Replaced { logid: Option<String> },
    Duplicate { reason: String },
}

#[derive(Debug, Error)]
pub enum QrzClientError {
    #[error("QRZ authentication or subscription failed: {0}")]
    Auth(String),
    #[error("QRZ rejected record: {0}")]
    Rejected(String),
    #[error("QRZ request failed: {0}")]
    Transport(String),
    #[error("QRZ returned an unrecognized response: {0}")]
    InvalidResponse(String),
}

#[derive(Debug, Error)]
pub enum QrzPushError {
    #[error("QRZ API key is not configured")]
    NotConfigured,
    #[error("A QRZ logbook push is already in progress")]
    AlreadyInProgress,
    #[error("QRZ authentication failed: {reason}")]
    AuthFailed {
        reason: String,
        summary: Box<QrzPushSummary>,
    },
    #[error("QRZ push aborted due to transport error: {reason}")]
    TransportFailed {
        reason: String,
        summary: Box<QrzPushSummary>,
    },
    #[error("database error: {0}")]
    Store(#[from] StoreError),
}

pub fn mask_api_key(key: &str) -> String {
    let trimmed = key.trim();
    let char_count = trimmed.chars().count();
    if char_count >= 8 {
        let suffix: String = trimmed
            .chars()
            .rev()
            .take(4)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        format!("••••-{suffix}")
    } else {
        "••••".to_string()
    }
}

pub fn build_user_agent(station_call: Option<&str>) -> String {
    let ver = env!("CARGO_PKG_VERSION");
    match station_call.map(str::trim).filter(|s| !s.is_empty()) {
        Some(call) => format!("digi-dx/{ver} ({})", call.to_ascii_uppercase()),
        None => format!("digi-dx/{ver}"),
    }
}

pub fn parse_qrz_kv_response(body: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let normalized = body.trim().replace(['\r', '\n'], "&");
    for (k, v) in form_urlencoded::parse(normalized.as_bytes()) {
        let key = k.trim().to_ascii_uppercase();
        if !key.is_empty() {
            map.insert(key, v.trim().to_string());
        }
    }
    map
}

fn response_result_code(map: &HashMap<String, String>) -> Option<String> {
    map.get("RESULT")
        .or_else(|| map.get("STATUS"))
        .map(|s| s.trim().to_ascii_uppercase())
        .filter(|s| !s.is_empty())
}

fn is_auth_reason(reason: &str) -> bool {
    let lower = reason.to_ascii_lowercase();
    lower.contains("invalid api key")
        || lower.contains("bad api key")
        || lower.contains("subscription")
        || lower.contains("not authorized")
        || lower.contains("user does not have")
}

pub fn parse_insert_response(body: &str) -> Result<QrzInsertOutcome, QrzClientError> {
    let map = parse_qrz_kv_response(body);
    let Some(result) = response_result_code(&map) else {
        let snippet: String = body.trim().chars().take(120).collect();
        return Err(QrzClientError::InvalidResponse(if snippet.is_empty() {
            "empty response body".to_string()
        } else {
            snippet
        }));
    };

    let logid = map
        .get("LOGID")
        .or_else(|| map.get("LOGIDS"))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let reason = map
        .get("REASON")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "QRZ rejected the record".to_string());

    match result.as_str() {
        "OK" => Ok(QrzInsertOutcome::Inserted { logid }),
        "REPLACE" => Ok(QrzInsertOutcome::Replaced { logid }),
        "AUTH" => Err(QrzClientError::Auth(reason)),
        "FAIL" => {
            if reason.to_ascii_lowercase().contains("duplicate") {
                Ok(QrzInsertOutcome::Duplicate { reason })
            } else if is_auth_reason(&reason) {
                Err(QrzClientError::Auth(reason))
            } else {
                Err(QrzClientError::Rejected(reason))
            }
        }
        other => Err(QrzClientError::InvalidResponse(format!(
            "unexpected RESULT '{other}'"
        ))),
    }
}

pub fn parse_status_response(body: &str) -> Result<QrzAccountStatus, QrzClientError> {
    let map = parse_qrz_kv_response(body);
    let Some(result) = response_result_code(&map) else {
        let snippet: String = body.trim().chars().take(120).collect();
        return Err(QrzClientError::InvalidResponse(if snippet.is_empty() {
            "empty response body".to_string()
        } else {
            snippet
        }));
    };

    let reason = map
        .get("REASON")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "QRZ status request failed".to_string());

    match result.as_str() {
        "OK" => {
            let raw_data = map.get("DATA").cloned().filter(|s| !s.is_empty());
            let mut merged = map.clone();
            if let Some(ref data) = raw_data {
                for (k, v) in parse_qrz_kv_response(data) {
                    merged.entry(k).or_insert(v);
                }
            }
            let get_nonempty = |k: &str| {
                merged
                    .get(k)
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
            };
            let get_u64 = |k: &str| get_nonempty(k).and_then(|v| v.parse::<u64>().ok());

            Ok(QrzAccountStatus {
                book_id: get_nonempty("BOOKID"),
                callsign: get_nonempty("CALLSIGN"),
                qso_count: get_u64("COUNT"),
                confirmed_count: get_u64("CONFIRMED"),
                start_date: get_nonempty("START_DATE"),
                end_date: get_nonempty("END_DATE"),
                raw_data,
            })
        }
        "AUTH" => Err(QrzClientError::Auth(reason)),
        "FAIL" => {
            if is_auth_reason(&reason) {
                Err(QrzClientError::Auth(reason))
            } else {
                Err(QrzClientError::Rejected(reason))
            }
        }
        other => Err(QrzClientError::InvalidResponse(format!(
            "unexpected RESULT '{other}'"
        ))),
    }
}

#[async_trait]
pub trait QrzClient: Send + Sync {
    async fn check_status(
        &self,
        api_key: &str,
        station_call: Option<&str>,
    ) -> Result<QrzAccountStatus, QrzClientError>;

    async fn insert_qso(
        &self,
        api_key: &str,
        adif: &str,
        station_call: Option<&str>,
    ) -> Result<QrzInsertOutcome, QrzClientError>;
}

pub struct HttpQrzClient {
    api_url: String,
    http: reqwest::Client,
}

impl HttpQrzClient {
    pub fn new(api_url: impl Into<String>) -> Self {
        let api_url = api_url.into();
        let mut builder = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15));
        if api_url.contains("127.0.0.1")
            || api_url.contains("localhost")
            || api_url.contains("[::1]")
        {
            builder = builder.no_proxy();
        }
        let http = builder.build().unwrap_or_else(|_| reqwest::Client::new());
        Self { api_url, http }
    }

    async fn post_form(
        &self,
        pairs: &[(&str, &str)],
        station_call: Option<&str>,
    ) -> Result<String, QrzClientError> {
        let form_body = {
            let mut serializer = form_urlencoded::Serializer::new(String::new());
            for (k, v) in pairs {
                serializer.append_pair(k, v);
            }
            serializer.finish()
        };

        let response = self
            .http
            .post(&self.api_url)
            .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
            .header(USER_AGENT, build_user_agent(station_call))
            .header(ACCEPT, "*/*")
            .body(form_body)
            .send()
            .await
            .map_err(|e| QrzClientError::Transport(e.to_string()))?;

        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|e| QrzClientError::Transport(e.to_string()))?;

        if !status.is_success() {
            // QRZ returns HTTP 401/403 with a structured STATUS=/RESULT=/REASON= body
            // for invalid API keys or missing XML Logbook subscriptions.
            let kv = parse_qrz_kv_response(&body);
            if response_result_code(&kv).is_some() {
                return Ok(body);
            }
            let lower = body.to_ascii_lowercase();
            if lower.contains("cloudflare") || lower.contains("cf-ray") {
                return Err(QrzClientError::Transport(format!(
                    "HTTP {status} (blocked by Cloudflare)"
                )));
            }
            return Err(QrzClientError::Transport(format!("HTTP {status}")));
        }
        Ok(body)
    }
}

#[async_trait]
impl QrzClient for HttpQrzClient {
    async fn check_status(
        &self,
        api_key: &str,
        station_call: Option<&str>,
    ) -> Result<QrzAccountStatus, QrzClientError> {
        let body = self
            .post_form(&[("KEY", api_key), ("ACTION", "STATUS")], station_call)
            .await?;
        parse_status_response(&body)
    }

    async fn insert_qso(
        &self,
        api_key: &str,
        adif: &str,
        station_call: Option<&str>,
    ) -> Result<QrzInsertOutcome, QrzClientError> {
        let body = self
            .post_form(
                &[("KEY", api_key), ("ACTION", "INSERT"), ("ADIF", adif)],
                station_call,
            )
            .await?;
        parse_insert_response(&body)
    }
}

pub struct QrzSyncService {
    store: StateStore,
    client: Arc<dyn QrzClient>,
    env_api_key: Option<String>,
    ws_tx: broadcast::Sender<WsBroadcastEvent>,
    shutdown: CancellationToken,
    push_lock: AsyncMutex<()>,
    in_progress: AtomicBool,
    live_progress: RwLock<Option<QrzPushProgress>>,
    inter_request_delay: Duration,
}

struct PushStateGuard<'a> {
    in_progress: &'a AtomicBool,
    live_progress: &'a RwLock<Option<QrzPushProgress>>,
}

impl<'a> PushStateGuard<'a> {
    fn start(
        in_progress: &'a AtomicBool,
        live_progress: &'a RwLock<Option<QrzPushProgress>>,
        initial: QrzPushProgress,
    ) -> Self {
        if let Ok(mut guard) = live_progress.write() {
            *guard = Some(initial);
        }
        in_progress.store(true, Ordering::Release);
        Self {
            in_progress,
            live_progress,
        }
    }

    fn finish(self) {
        self.clear();
        std::mem::forget(self);
    }

    fn clear(&self) {
        self.in_progress.store(false, Ordering::Release);
        if let Ok(mut guard) = self.live_progress.write() {
            *guard = None;
        }
    }
}

impl Drop for PushStateGuard<'_> {
    fn drop(&mut self) {
        self.clear();
    }
}

impl QrzSyncService {
    pub fn new(
        store: StateStore,
        client: Arc<dyn QrzClient>,
        env_api_key: Option<String>,
        ws_tx: broadcast::Sender<WsBroadcastEvent>,
        shutdown: CancellationToken,
    ) -> Self {
        Self::with_delay(
            store,
            client,
            env_api_key,
            ws_tx,
            shutdown,
            DEFAULT_INTER_REQUEST_DELAY,
        )
    }

    pub fn new_for_test(
        store: StateStore,
        client: Arc<dyn QrzClient>,
        env_api_key: Option<String>,
        ws_tx: broadcast::Sender<WsBroadcastEvent>,
        shutdown: CancellationToken,
    ) -> Self {
        Self::with_delay(store, client, env_api_key, ws_tx, shutdown, Duration::ZERO)
    }

    fn with_delay(
        store: StateStore,
        client: Arc<dyn QrzClient>,
        env_api_key: Option<String>,
        ws_tx: broadcast::Sender<WsBroadcastEvent>,
        shutdown: CancellationToken,
        inter_request_delay: Duration,
    ) -> Self {
        let cleaned_env = env_api_key
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        Self {
            store,
            client,
            env_api_key: cleaned_env,
            ws_tx,
            shutdown,
            push_lock: AsyncMutex::new(()),
            in_progress: AtomicBool::new(false),
            live_progress: RwLock::new(None),
            inter_request_delay,
        }
    }

    pub fn resolve_api_key(&self) -> Result<(Option<String>, QrzKeySource), StoreError> {
        if let Some(ref key) = self.env_api_key {
            return Ok((Some(key.clone()), QrzKeySource::Env));
        }
        if let Some(key) = self.store.get_qrz_api_key()? {
            return Ok((Some(key), QrzKeySource::Database));
        }
        Ok((None, QrzKeySource::None))
    }

    pub fn status_snapshot(&self) -> Result<QrzStatusSnapshot, StoreError> {
        let (key_opt, key_source) = self.resolve_api_key()?;
        let counts = self.store.count_qrz_qso_states()?;
        let (last_push_at_utc, last_push_summary) = self.store.get_qrz_last_push()?;
        let in_progress = self.in_progress.load(Ordering::Acquire);
        let progress = self
            .live_progress
            .read()
            .ok()
            .and_then(|guard| guard.clone());

        Ok(QrzStatusSnapshot {
            configured: key_opt.is_some(),
            key_source,
            key_hint: key_opt.as_deref().map(mask_api_key),
            pending_count: counts.pending,
            failed_count: counts.failed,
            synced_count: counts.synced,
            in_progress,
            progress,
            last_push_at_utc,
            last_push_summary,
        })
    }

    pub fn update_api_key(&self, api_key: Option<&str>) -> Result<QrzStatusSnapshot, StoreError> {
        self.store.set_qrz_api_key(api_key)?;
        let snapshot = self.status_snapshot()?;
        self.broadcast_snapshot(&snapshot);
        Ok(snapshot)
    }

    pub async fn test_connection(
        &self,
        override_api_key: Option<&str>,
    ) -> Result<QrzAccountStatus, QrzClientError> {
        let trimmed_override = override_api_key
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        let api_key = match trimmed_override {
            Some(k) => k,
            None => self
                .resolve_api_key()
                .map_err(|e| QrzClientError::Transport(e.to_string()))?
                .0
                .ok_or_else(|| QrzClientError::Auth("QRZ API key is not configured".to_string()))?,
        };

        let station_call = self
            .store
            .get_station_config()
            .ok()
            .and_then(|cfg| cfg.callsign);

        self.client
            .check_status(&api_key, station_call.as_deref())
            .await
    }

    pub async fn push_pending(&self) -> Result<QrzPushSummary, QrzPushError> {
        let _lock = self
            .push_lock
            .try_lock()
            .map_err(|_| QrzPushError::AlreadyInProgress)?;

        let (key_opt, _) = self.resolve_api_key()?;
        let Some(api_key) = key_opt else {
            return Err(QrzPushError::NotConfigured);
        };

        let qsos = self.store.list_unpushed_real_qsos()?;
        if qsos.is_empty() {
            let now = now_utc_str();
            return Ok(QrzPushSummary {
                total: 0,
                pushed: 0,
                duplicates: 0,
                failed: 0,
                skipped_demo: 0,
                aborted_reason: None,
                errors: Vec::new(),
                pushed_at_utc: now,
            });
        }

        let station = self.store.get_station_config().ok();
        let station_call = station.as_ref().and_then(|s| s.callsign.clone());
        let total = qsos.len();

        let state_guard = PushStateGuard::start(
            &self.in_progress,
            &self.live_progress,
            QrzPushProgress {
                completed: 0,
                total,
                pushed: 0,
                duplicates: 0,
                failed: 0,
            },
        );
        self.broadcast_current_snapshot();

        let mut pushed = 0_usize;
        let mut duplicates = 0_usize;
        let mut failed = 0_usize;
        let mut skipped_demo = 0_usize;
        let mut completed = 0_usize;
        let mut aborted_reason: Option<String> = None;
        let mut errors: Vec<QrzPushErrorItem> = Vec::new();
        let mut fatal_error: Option<QrzPushError> = None;

        for (idx, rec) in qsos.iter().enumerate() {
            if self.shutdown.is_cancelled() {
                aborted_reason = Some("Daemon shutting down".to_string());
                break;
            }

            if is_demo_callsign(&rec.my_call) || is_demo_callsign(&rec.their_call) {
                skipped_demo += 1;
                completed += 1;
                warn!(
                    qso_id = %rec.qso_id,
                    their_call = %rec.their_call,
                    "skipping QSO with non-assignable QQ* demo callsign during QRZ push"
                );
                self.update_progress(completed, total, pushed, duplicates, failed);
                self.broadcast_current_snapshot();
                continue;
            }

            let adif = format_adif_record(rec, Utc::now());
            match self
                .client
                .insert_qso(&api_key, &adif, station_call.as_deref())
                .await
            {
                Ok(QrzInsertOutcome::Inserted { logid })
                | Ok(QrzInsertOutcome::Replaced { logid }) => {
                    let pushed_at = now_utc_str();
                    self.store
                        .mark_qso_qrz_synced(&rec.qso_id, logid.as_deref(), &pushed_at)?;
                    pushed += 1;
                }
                Ok(QrzInsertOutcome::Duplicate { .. }) => {
                    let pushed_at = now_utc_str();
                    self.store
                        .mark_qso_qrz_synced(&rec.qso_id, None, &pushed_at)?;
                    duplicates += 1;
                }
                Err(QrzClientError::Rejected(reason)) => {
                    self.store.mark_qso_qrz_failed(&rec.qso_id, &reason)?;
                    failed += 1;
                    errors.push(QrzPushErrorItem {
                        qso_id: rec.qso_id.clone(),
                        their_call: rec.their_call.clone(),
                        reason,
                    });
                }
                Err(QrzClientError::Auth(reason)) => {
                    aborted_reason = Some(reason.clone());
                    let summary = build_summary(
                        total,
                        pushed,
                        duplicates,
                        failed,
                        skipped_demo,
                        aborted_reason.clone(),
                        errors.clone(),
                    );
                    let _ = self
                        .store
                        .record_qrz_push_result(&summary.pushed_at_utc, &summary);
                    fatal_error = Some(QrzPushError::AuthFailed {
                        reason,
                        summary: Box::new(summary),
                    });
                    break;
                }
                Err(QrzClientError::Transport(reason))
                | Err(QrzClientError::InvalidResponse(reason)) => {
                    aborted_reason = Some(reason.clone());
                    let summary = build_summary(
                        total,
                        pushed,
                        duplicates,
                        failed,
                        skipped_demo,
                        aborted_reason.clone(),
                        errors.clone(),
                    );
                    let _ = self
                        .store
                        .record_qrz_push_result(&summary.pushed_at_utc, &summary);
                    fatal_error = Some(QrzPushError::TransportFailed {
                        reason,
                        summary: Box::new(summary),
                    });
                    break;
                }
            }

            completed += 1;
            self.update_progress(completed, total, pushed, duplicates, failed);
            self.broadcast_current_snapshot();

            if !self.inter_request_delay.is_zero() && idx + 1 < qsos.len() {
                tokio::select! {
                    _ = tokio::time::sleep(self.inter_request_delay) => {}
                    _ = self.shutdown.cancelled() => {
                        aborted_reason = Some("Daemon shutting down".to_string());
                        break;
                    }
                }
            }
        }

        if let Some(err) = fatal_error {
            state_guard.finish();
            self.broadcast_current_snapshot();
            return Err(err);
        }

        let summary = build_summary(
            total,
            pushed,
            duplicates,
            failed,
            skipped_demo,
            aborted_reason,
            errors,
        );
        self.store
            .record_qrz_push_result(&summary.pushed_at_utc, &summary)?;
        state_guard.finish();

        if let Some(ref st) = station {
            let ev = TelemetryEnvelope::new(
                st.station_id.clone(),
                None,
                "qrz.push",
                false,
                json!({
                    "total": summary.total,
                    "pushed": summary.pushed,
                    "duplicates": summary.duplicates,
                    "failed": summary.failed,
                    "skipped_demo": summary.skipped_demo,
                    "aborted_reason": summary.aborted_reason,
                }),
            );
            let _ = self.store.enqueue_telemetry(&ev);
        }

        info!(
            total = summary.total,
            pushed = summary.pushed,
            duplicates = summary.duplicates,
            failed = summary.failed,
            "completed QRZ logbook push"
        );
        self.broadcast_current_snapshot();
        Ok(summary)
    }

    fn update_progress(
        &self,
        completed: usize,
        total: usize,
        pushed: usize,
        duplicates: usize,
        failed: usize,
    ) {
        if let Ok(mut guard) = self.live_progress.write() {
            *guard = Some(QrzPushProgress {
                completed,
                total,
                pushed,
                duplicates,
                failed,
            });
        }
    }

    fn broadcast_current_snapshot(&self) {
        if let Ok(snapshot) = self.status_snapshot() {
            self.broadcast_snapshot(&snapshot);
        }
    }

    fn broadcast_snapshot(&self, snapshot: &QrzStatusSnapshot) {
        let _ = self.ws_tx.send(WsBroadcastEvent::QrzSyncUpdate {
            status: Box::new(snapshot.clone()),
        });
    }
}

fn build_summary(
    total: usize,
    pushed: usize,
    duplicates: usize,
    failed: usize,
    skipped_demo: usize,
    aborted_reason: Option<String>,
    errors: Vec<QrzPushErrorItem>,
) -> QrzPushSummary {
    QrzPushSummary {
        total,
        pushed,
        duplicates,
        failed,
        skipped_demo,
        aborted_reason,
        errors,
        pushed_at_utc: now_utc_str(),
    }
}

fn is_demo_callsign(raw: &str) -> bool {
    raw.trim()
        .trim_matches(|c| c == '<' || c == '>')
        .trim()
        .to_ascii_uppercase()
        .starts_with("QQ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_api_keys_safely() {
        assert_eq!(mask_api_key("1234-5678-9ABC-DEF0"), "••••-DEF0");
        assert_eq!(mask_api_key("  abcd1234  "), "••••-1234");
        assert_eq!(mask_api_key("short"), "••••");
    }

    #[test]
    fn builds_descriptive_user_agent() {
        let ua_with_call = build_user_agent(Some("n1mpm"));
        assert!(ua_with_call.starts_with("digi-dx/"));
        assert!(ua_with_call.ends_with("(N1MPM)"));

        let ua_without_call = build_user_agent(None);
        assert!(ua_without_call.starts_with("digi-dx/"));
        assert!(!ua_without_call.contains('('));
    }

    #[test]
    fn parses_insert_responses() {
        assert_eq!(
            parse_insert_response("RESULT=OK&LOGID=424242&COUNT=1\n").unwrap(),
            QrzInsertOutcome::Inserted {
                logid: Some("424242".to_string())
            }
        );

        assert_eq!(
            parse_insert_response("RESULT=REPLACE&LOGID=99").unwrap(),
            QrzInsertOutcome::Replaced {
                logid: Some("99".to_string())
            }
        );

        assert!(matches!(
            parse_insert_response("STATUS=FAIL&REASON=Unable+to+add+QSO+to+database%3A+duplicate")
                .unwrap(),
            QrzInsertOutcome::Duplicate { .. }
        ));

        assert!(matches!(
            parse_insert_response("RESULT=FAIL&REASON=add_qso: outside date range"),
            Err(QrzClientError::Rejected(_))
        ));

        assert!(matches!(
            parse_insert_response("RESULT=AUTH&REASON=invalid api key"),
            Err(QrzClientError::Auth(_))
        ));

        assert!(matches!(
            parse_insert_response(
                "RESULT=FAIL&REASON=User does not have a valid QRZ XML subscription"
            ),
            Err(QrzClientError::Auth(_))
        ));

        assert!(matches!(
            parse_insert_response("<html>502 Bad Gateway</html>"),
            Err(QrzClientError::InvalidResponse(_))
        ));
    }

    #[test]
    fn parses_status_responses_both_unencoded_and_encoded_data() {
        let raw_unencoded =
            "RESULT=OK&DATA=BOOKID=123&CALLSIGN=N1MPM&COUNT=42&CONFIRMED=10&START_DATE=2020-01-01&END_DATE=2030-01-01";
        let st = parse_status_response(raw_unencoded).unwrap();
        assert_eq!(st.book_id.as_deref(), Some("123"));
        assert_eq!(st.callsign.as_deref(), Some("N1MPM"));
        assert_eq!(st.qso_count, Some(42));
        assert_eq!(st.confirmed_count, Some(10));
        assert_eq!(st.start_date.as_deref(), Some("2020-01-01"));
        assert_eq!(st.end_date.as_deref(), Some("2030-01-01"));

        let encoded = "RESULT=OK&DATA=BOOKID%3D77%26CALLSIGN%3DW1AW%26COUNT%3D5";
        let st2 = parse_status_response(encoded).unwrap();
        assert_eq!(st2.book_id.as_deref(), Some("77"));
        assert_eq!(st2.callsign.as_deref(), Some("W1AW"));
        assert_eq!(st2.qso_count, Some(5));
    }
}
