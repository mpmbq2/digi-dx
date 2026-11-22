use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::json;
use tokio::sync::{broadcast, Mutex as AsyncMutex, Notify};
use tokio::time::Instant;
use tracing::warn;

use crate::command_bus::WsBroadcastEvent;
use crate::store::{now_utc_str, StateStore};
use crate::telemetry::TelemetryEnvelope;

pub const DEFAULT_HEARTBEAT_INTERVAL_MS: u64 = 500;
pub const DEFAULT_HEARTBEAT_TIMEOUT_MS: u64 = 2_000;
/// 13,400 ms provides 100 ms CAT/serial teardown margin under the 13.5 s hard ceiling
/// while preserving > 750 ms headroom past FT8's 12.64 s active transmission.
pub const DEFAULT_MAX_TX_DURATION_MS: u64 = 13_400;

#[derive(Debug, Clone, Copy)]
pub struct PttWatchdogConfig {
    pub heartbeat_timeout: Duration,
    pub max_tx_duration: Duration,
}

impl Default for PttWatchdogConfig {
    fn default() -> Self {
        Self {
            heartbeat_timeout: Duration::from_millis(DEFAULT_HEARTBEAT_TIMEOUT_MS),
            max_tx_duration: Duration::from_millis(DEFAULT_MAX_TX_DURATION_MS),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchdogAbortReason {
    HeartbeatTimeout,
    MaxTxDurationExceeded,
    ClientDisconnected,
    UsbDetached,
    AudioFault,
    LeaseReleased,
    EmergencyHalt,
}

impl WatchdogAbortReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::HeartbeatTimeout => "heartbeat_timeout",
            Self::MaxTxDurationExceeded => "max_tx_duration_exceeded",
            Self::ClientDisconnected => "client_disconnected",
            Self::UsbDetached => "usb_detached",
            Self::AudioFault => "audio_fault",
            Self::LeaseReleased => "lease_released",
            Self::EmergencyHalt => "emergency_halt",
        }
    }
}

#[async_trait]
pub trait PttAbortTarget: Send + Sync {
    async fn abort_ptt(&self, radio_id: &str, reason: &str);
}

struct ActiveTxState {
    generation: u64,
    actor: String,
    started_at: Instant,
    last_heartbeat: Instant,
    audio_abort: Option<Arc<AtomicBool>>,
    notify: Arc<Notify>,
}

pub struct PttWatchdog {
    config: PttWatchdogConfig,
    target: Arc<dyn PttAbortTarget>,
    store: StateStore,
    ws_tx: broadcast::Sender<WsBroadcastEvent>,
    active: AsyncMutex<HashMap<String, ActiveTxState>>,
    next_gen: AtomicU64,
}

impl PttWatchdog {
    pub fn new(
        config: PttWatchdogConfig,
        target: Arc<dyn PttAbortTarget>,
        store: StateStore,
        ws_tx: broadcast::Sender<WsBroadcastEvent>,
    ) -> Arc<Self> {
        Arc::new(Self {
            config,
            target,
            store,
            ws_tx,
            active: AsyncMutex::new(HashMap::new()),
            next_gen: AtomicU64::new(1),
        })
    }

    pub async fn arm_tx(
        self: &Arc<Self>,
        radio_id: &str,
        actor: &str,
        audio_abort: Option<Arc<AtomicBool>>,
    ) {
        let now = Instant::now();
        let generation = self.next_gen.fetch_add(1, Ordering::Relaxed);
        let notify = Arc::new(Notify::new());

        {
            let mut map = self.active.lock().await;
            if let Some(prev) = map.insert(
                radio_id.to_string(),
                ActiveTxState {
                    generation,
                    actor: actor.to_string(),
                    started_at: now,
                    last_heartbeat: now,
                    audio_abort,
                    notify: Arc::clone(&notify),
                },
            ) {
                prev.notify.notify_waiters();
            }
        }

        let wd = Arc::clone(self);
        let rid = radio_id.to_string();
        tokio::spawn(async move {
            wd.monitor_tx_loop(rid, generation, notify).await;
        });
    }

    pub async fn pet_heartbeat(&self, radio_id: &str, actor: &str) -> bool {
        let mut map = self.active.lock().await;
        if let Some(entry) = map.get_mut(radio_id) {
            if entry.actor == actor {
                entry.last_heartbeat = Instant::now();
                entry.notify.notify_one();
                return true;
            }
        }
        false
    }

    pub async fn disarm_tx(&self, radio_id: &str) {
        let removed = self.active.lock().await.remove(radio_id);
        if let Some(entry) = removed {
            entry.notify.notify_waiters();
        }
    }

    pub async fn disarm_all(&self) {
        let entries: Vec<ActiveTxState> = {
            let mut map = self.active.lock().await;
            map.drain().map(|(_, v)| v).collect()
        };
        for entry in entries {
            if let Some(flag) = entry.audio_abort {
                flag.store(true, Ordering::SeqCst);
            }
            entry.notify.notify_waiters();
        }
    }

    pub async fn is_tx_armed(&self, radio_id: &str) -> bool {
        self.active.lock().await.contains_key(radio_id)
    }

    pub async fn trigger_abort(&self, radio_id: &str, reason: WatchdogAbortReason) -> bool {
        self.trigger_abort_internal(radio_id, None, reason).await
    }

    pub async fn on_actor_disconnected(&self, actor: &str) {
        let radio_ids: Vec<String> = {
            let map = self.active.lock().await;
            map.iter()
                .filter(|(_, state)| state.actor == actor)
                .map(|(rid, _)| rid.clone())
                .collect()
        };

        for rid in radio_ids {
            self.trigger_abort(&rid, WatchdogAbortReason::ClientDisconnected)
                .await;
        }
    }

    pub async fn on_device_detached(&self, radio_id: &str) {
        self.trigger_abort(radio_id, WatchdogAbortReason::UsbDetached)
            .await;
    }

    pub async fn on_audio_fault(&self, radio_id: &str, _detail: &str) {
        self.trigger_abort(radio_id, WatchdogAbortReason::AudioFault)
            .await;
    }

    async fn trigger_abort_internal(
        &self,
        radio_id: &str,
        expected_gen: Option<u64>,
        reason: WatchdogAbortReason,
    ) -> bool {
        let removed = {
            let mut map = self.active.lock().await;
            match expected_gen {
                Some(gen) => {
                    if map.get(radio_id).is_some_and(|e| e.generation == gen) {
                        map.remove(radio_id)
                    } else {
                        None
                    }
                }
                None => map.remove(radio_id),
            }
        };

        let Some(entry) = removed else {
            return false;
        };

        if let Some(flag) = entry.audio_abort {
            flag.store(true, Ordering::SeqCst);
        }
        entry.notify.notify_waiters();

        let elapsed_ms = entry.started_at.elapsed().as_millis() as u64;
        let reason_str = reason.as_str();
        warn!(
            radio_id,
            actor = %entry.actor,
            reason = reason_str,
            elapsed_ms,
            "PTT watchdog triggered TX abort"
        );

        self.target.abort_ptt(radio_id, reason_str).await;

        let occurred_at = now_utc_str();
        if let Ok(station) = self.store.get_station_config() {
            let ev = TelemetryEnvelope::new(
                station.station_id,
                Some(radio_id.to_string()),
                "watchdog.abort",
                false,
                json!({
                    "reason": reason_str,
                    "actor": entry.actor,
                    "elapsed_ms": elapsed_ms,
                }),
            );
            let _ = self.store.enqueue_telemetry(&ev);
        }

        let _ = self.ws_tx.send(WsBroadcastEvent::WatchdogAbort {
            radio_id: radio_id.to_string(),
            reason: reason_str.to_string(),
            elapsed_ms,
            occurred_at_utc: occurred_at,
        });

        true
    }

    async fn monitor_tx_loop(&self, radio_id: String, generation: u64, notify: Arc<Notify>) {
        loop {
            let (hb_deadline, max_deadline) = {
                let map = self.active.lock().await;
                let Some(entry) = map.get(&radio_id) else {
                    return;
                };
                if entry.generation != generation {
                    return;
                }
                (
                    entry.last_heartbeat + self.config.heartbeat_timeout,
                    entry.started_at + self.config.max_tx_duration,
                )
            };

            let now = Instant::now();
            if now >= max_deadline {
                self.trigger_abort_internal(
                    &radio_id,
                    Some(generation),
                    WatchdogAbortReason::MaxTxDurationExceeded,
                )
                .await;
                return;
            }
            if now >= hb_deadline {
                self.trigger_abort_internal(
                    &radio_id,
                    Some(generation),
                    WatchdogAbortReason::HeartbeatTimeout,
                )
                .await;
                return;
            }

            let wake = notify.notified();
            tokio::select! {
                _ = wake => continue,
                _ = tokio::time::sleep_until(max_deadline) => {
                    self.trigger_abort_internal(
                        &radio_id,
                        Some(generation),
                        WatchdogAbortReason::MaxTxDurationExceeded,
                    )
                    .await;
                    return;
                }
                _ = tokio::time::sleep_until(hb_deadline) => {
                    self.trigger_abort_internal(
                        &radio_id,
                        Some(generation),
                        WatchdogAbortReason::HeartbeatTimeout,
                    )
                    .await;
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use tempfile::tempdir;

    struct MockAbortTarget {
        calls: AtomicUsize,
    }

    #[async_trait]
    impl PttAbortTarget for MockAbortTarget {
        async fn abort_ptt(&self, _radio_id: &str, _reason: &str) {
            self.calls.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn unit_watchdog_respects_heartbeat_and_disarm() {
        let dir = tempdir().unwrap();
        let store = StateStore::open(dir.path().join("wd.db")).unwrap();
        let (ws_tx, _) = broadcast::channel(32);
        let target = Arc::new(MockAbortTarget {
            calls: AtomicUsize::new(0),
        });
        let wd = PttWatchdog::new(
            PttWatchdogConfig {
                heartbeat_timeout: Duration::from_millis(120),
                max_tx_duration: Duration::from_millis(400),
            },
            Arc::clone(&target) as Arc<dyn PttAbortTarget>,
            store,
            ws_tx,
        );

        let abort_flag = Arc::new(AtomicBool::new(false));
        wd.arm_tx("rad_1", "op1", Some(Arc::clone(&abort_flag)))
            .await;
        tokio::time::sleep(Duration::from_millis(70)).await;
        assert!(wd.pet_heartbeat("rad_1", "op1").await);
        tokio::time::sleep(Duration::from_millis(70)).await;
        assert!(!abort_flag.load(Ordering::SeqCst));
        assert_eq!(target.calls.load(Ordering::SeqCst), 0);

        wd.disarm_tx("rad_1").await;
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(!abort_flag.load(Ordering::SeqCst));
        assert_eq!(target.calls.load(Ordering::SeqCst), 0);
    }
}
