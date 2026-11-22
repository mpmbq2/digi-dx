use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};
use uuid::Uuid;

use crate::store::{OutboxRow, StateStore};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelemetryEnvelope {
    pub event_id: String,
    pub schema_version: u32,
    pub station_id: String,
    pub radio_id: Option<String>,
    pub event_type: String,
    pub occurred_at_utc: String,
    pub is_demo: bool,
    pub payload: Value,
}

impl TelemetryEnvelope {
    pub fn new(
        station_id: impl Into<String>,
        radio_id: Option<String>,
        event_type: impl Into<String>,
        is_demo: bool,
        payload: Value,
    ) -> Self {
        Self {
            event_id: Uuid::now_v7().to_string(),
            schema_version: 1,
            station_id: station_id.into(),
            radio_id,
            event_type: event_type.into(),
            occurred_at_utc: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            is_demo,
            payload,
        }
    }

    pub fn from_outbox_row(row: &OutboxRow) -> Self {
        let payload = serde_json::from_str(&row.payload_json).unwrap_or(Value::Null);
        Self {
            event_id: row.event_id.clone(),
            schema_version: row.schema_version as u32,
            station_id: row.station_id.clone(),
            radio_id: row.radio_id.clone(),
            event_type: row.event_type.clone(),
            occurred_at_utc: row.occurred_at_utc.clone(),
            is_demo: row.is_demo,
            payload,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishOutcome {
    pub accepted: usize,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SinkError {
    #[error("telemetry sink is stubbed / not implemented in MVP")]
    NotImplemented,
    #[error("invalid sink configuration: {0}")]
    ConfigInvalid(String),
    #[error("transient publish failure: {0}")]
    Transient(String),
}

#[async_trait]
pub trait TelemetrySink: Send + Sync {
    fn name(&self) -> &'static str;
    async fn publish_batch(
        &self,
        events: &[TelemetryEnvelope],
    ) -> Result<PublishOutcome, SinkError>;
}

#[derive(Debug, Default)]
pub struct NoopTelemetrySink;

#[async_trait]
impl TelemetrySink for NoopTelemetrySink {
    fn name(&self) -> &'static str {
        "noop"
    }

    async fn publish_batch(
        &self,
        events: &[TelemetryEnvelope],
    ) -> Result<PublishOutcome, SinkError> {
        Ok(PublishOutcome {
            accepted: events.len(),
        })
    }
}

#[derive(Debug, Clone)]
pub struct GcpPubSubConfig {
    pub project_id: String,
    pub topic_id: String,
    pub credentials_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct GcpPubSubSinkStub {
    pub config: GcpPubSubConfig,
}

impl GcpPubSubSinkStub {
    pub fn new(
        project_id: Option<String>,
        topic_id: Option<String>,
        credentials_path: Option<PathBuf>,
    ) -> Result<Self, SinkError> {
        let project_id = project_id
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| SinkError::ConfigInvalid("missing GCP project_id".to_string()))?;
        let topic_id = topic_id
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| SinkError::ConfigInvalid("missing GCP topic_id".to_string()))?;
        let credentials_path = credentials_path
            .filter(|p| !p.as_os_str().is_empty())
            .ok_or_else(|| SinkError::ConfigInvalid("missing GCP credentials_path".to_string()))?;
        Ok(Self {
            config: GcpPubSubConfig {
                project_id,
                topic_id,
                credentials_path,
            },
        })
    }

    pub fn topic_resource_name(&self) -> String {
        format!(
            "projects/{}/topics/{}",
            self.config.project_id, self.config.topic_id
        )
    }

    pub fn build_pubsub_batch_payload(&self, events: &[TelemetryEnvelope]) -> Value {
        let messages: Vec<Value> = events
            .iter()
            .map(|ev| {
                json!({
                    "data_json": serde_json::to_string(ev).unwrap_or_else(|_| "{}".to_string()),
                    "attributes": {
                        "event_id": ev.event_id,
                        "event_type": ev.event_type,
                        "station_id": ev.station_id,
                        "is_demo": ev.is_demo.to_string(),
                    }
                })
            })
            .collect();
        json!({
            "topic": self.topic_resource_name(),
            "messages": messages,
        })
    }
}

#[async_trait]
impl TelemetrySink for GcpPubSubSinkStub {
    fn name(&self) -> &'static str {
        "gcp_pubsub_stub"
    }

    async fn publish_batch(
        &self,
        events: &[TelemetryEnvelope],
    ) -> Result<PublishOutcome, SinkError> {
        let _payload = self.build_pubsub_batch_payload(events);
        Err(SinkError::NotImplemented)
    }
}

pub fn backoff_delay_secs(attempts: i64) -> i64 {
    match attempts {
        0 | 1 => 5,
        2 => 10,
        3 => 30,
        _ => 300,
    }
}

pub const MAX_OUTBOX_ATTEMPTS: i64 = 20;

pub struct TelemetryOutboxWorker {
    store: StateStore,
    sink: Arc<dyn TelemetrySink>,
    max_rows: usize,
    retention_days: i64,
    batch_size: usize,
}

impl TelemetryOutboxWorker {
    pub fn new(
        store: StateStore,
        sink: Arc<dyn TelemetrySink>,
        max_rows: usize,
        retention_days: i64,
    ) -> Self {
        Self {
            store,
            sink,
            max_rows,
            retention_days,
            batch_size: 50,
        }
    }

    pub fn sink_name(&self) -> &'static str {
        self.sink.name()
    }

    pub async fn run_once(&self, now: DateTime<Utc>) -> Result<usize, String> {
        let mut flushed = 0_usize;

        // When NoopTelemetrySink is active, leave outbox rows pending for local inspection/testing
        // and only enforce local retention bounds.
        if self.sink.name() != "noop" {
            let claimed = self
                .store
                .claim_pending_outbox(self.batch_size, 30, now)
                .map_err(|e| e.to_string())?;
            if !claimed.is_empty() {
                let envelopes: Vec<TelemetryEnvelope> = claimed
                    .iter()
                    .map(TelemetryEnvelope::from_outbox_row)
                    .collect();
                match self.sink.publish_batch(&envelopes).await {
                    Ok(outcome) => {
                        let ids: Vec<String> = claimed.iter().map(|r| r.event_id.clone()).collect();
                        self.store
                            .mark_outbox_sent(&ids)
                            .map_err(|e| e.to_string())?;
                        flushed = outcome.accepted;
                    }
                    Err(err) => {
                        let err_msg = err.to_string();
                        for row in &claimed {
                            let next_attempts = row.attempts + 1;
                            let dead = next_attempts >= MAX_OUTBOX_ATTEMPTS;
                            let delay = backoff_delay_secs(next_attempts);
                            let next_at = now + Duration::seconds(delay);
                            self.store
                                .mark_outbox_retry(
                                    &row.event_id,
                                    next_attempts,
                                    next_at,
                                    dead,
                                    &err_msg,
                                )
                                .map_err(|e| e.to_string())?;
                        }
                    }
                }
            }
        }

        let pruned = self
            .store
            .enforce_outbox_retention(self.max_rows, self.retention_days, now)
            .map_err(|e| e.to_string())?;
        if pruned > 0 {
            debug!(pruned, "compacted telemetry_outbox under retention cap");
        }

        Ok(flushed)
    }

    pub async fn run(self, shutdown: CancellationToken) {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => {
                    debug!("telemetry outbox worker stopping");
                    break;
                }
                _ = interval.tick() => {
                    if let Err(err) = self.run_once(Utc::now()).await {
                        warn!(error = %err, "telemetry outbox tick error");
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tempfile::tempdir;

    struct MockFailingSink {
        should_fail: AtomicBool,
    }

    #[async_trait]
    impl TelemetrySink for MockFailingSink {
        fn name(&self) -> &'static str {
            "mock_sink"
        }

        async fn publish_batch(
            &self,
            events: &[TelemetryEnvelope],
        ) -> Result<PublishOutcome, SinkError> {
            if self.should_fail.load(Ordering::SeqCst) {
                Err(SinkError::Transient("upstream timeout".to_string()))
            } else {
                Ok(PublishOutcome {
                    accepted: events.len(),
                })
            }
        }
    }

    #[tokio::test]
    async fn outbox_retries_with_backoff_and_succeeds_after_reopen() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("digi-dx.db");
        let store = StateStore::open(&db).unwrap();
        let station_id = store.get_station_config().unwrap().station_id;

        let ev = TelemetryEnvelope::new(
            station_id,
            None,
            "station.preflight",
            false,
            json!({"overall_status": "ok"}),
        );
        store.enqueue_telemetry(&ev).unwrap();

        let sink = Arc::new(MockFailingSink {
            should_fail: AtomicBool::new(true),
        });
        let worker = TelemetryOutboxWorker::new(store.clone(), sink.clone(), 50_000, 14);

        let t0 = Utc::now();
        assert_eq!(worker.run_once(t0).await.unwrap(), 0);
        let rows = store.list_outbox_rows(10).unwrap();
        assert_eq!(rows[0].attempts, 1);
        assert_eq!(rows[0].status, "pending");

        // Re-open DB from disk to verify persistence across restarts
        let reopened = StateStore::open(&db).unwrap();
        sink.should_fail.store(false, Ordering::SeqCst);
        let worker2 = TelemetryOutboxWorker::new(reopened.clone(), sink, 50_000, 14);
        assert_eq!(
            worker2.run_once(t0 + Duration::seconds(6)).await.unwrap(),
            1
        );
        let stats = reopened.outbox_stats("mock_sink").unwrap();
        assert_eq!(stats.sent_count, 1);
        assert_eq!(stats.pending_count, 0);
    }

    #[tokio::test]
    async fn gcp_pubsub_stub_validates_config_and_returns_not_implemented() {
        assert!(matches!(
            GcpPubSubSinkStub::new(None, Some("t".into()), Some(PathBuf::from("/tmp/k.json"))),
            Err(SinkError::ConfigInvalid(_))
        ));

        let stub = GcpPubSubSinkStub::new(
            Some("my-proj".into()),
            Some("digi-dx-events".into()),
            Some(PathBuf::from("/etc/digi-dx/sa.json")),
        )
        .unwrap();
        assert_eq!(
            stub.topic_resource_name(),
            "projects/my-proj/topics/digi-dx-events"
        );

        let ev = TelemetryEnvelope::new("s1", None, "station.preflight", false, json!({}));
        let batch = stub.build_pubsub_batch_payload(std::slice::from_ref(&ev));
        assert_eq!(batch["messages"].as_array().unwrap().len(), 1);
        assert_eq!(
            stub.publish_batch(&[ev]).await,
            Err(SinkError::NotImplemented)
        );
    }
}
