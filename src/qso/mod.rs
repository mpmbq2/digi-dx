pub mod sequencer;

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant as StdInstant};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc, Mutex as AsyncMutex};
use tokio::task::JoinHandle;
use tokio::time::{sleep, sleep_until, Instant as TokioInstant};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::audio::devices::AudioMatchOutcome;
use crate::audio::dsp::{WaterfallFrame, DSP_SAMPLE_RATE, FT8_SLOT_SAMPLES_12K};
use crate::audio::manager::{AudioCaptureHandle, AudioManager, AudioPlaybackHandle};
use crate::command_bus::{ErrorCode, WsBroadcastEvent};
use crate::domain::adif::QsoRecord;
use crate::domain::clock::{SlotClock, SlotClockSpec, SlotParity, UnixSecs};
use crate::domain::ft8::{validate_station_callsign, validate_station_grid};
use crate::modem::ft8_lib::Ft8LibTxModulator;
use crate::modem::simulator::SimulatedModem;
use crate::modem::{Ft8Decode, Ft8Decoder, HybridFt8Decoder, TxIntent};
use crate::store::{now_utc_str, StateStore};
use crate::supervisor::radio_worker::{CmdResult, RadioLifecycleState};
use crate::supervisor::DeviceSupervisor;
use crate::telemetry::TelemetryEnvelope;
use crate::watchdog::PttWatchdog;

use self::sequencer::{ActiveQso, QsoAction, QsoSequencer, RecentDecodeEntry};

const MIN_LIVE_SLOT_SAMPLES_12K: usize = 72_000; // >= 6 seconds captured before running decoder

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSnapshot {
    pub active: bool,
    pub radio_id: Option<String>,
    pub is_demo: bool,
    pub decoder_backend: Option<String>,
    pub my_call: Option<String>,
    pub my_grid: Option<String>,
    pub slot_clock: SlotClockSpec,
    pub tx_af_hz: u16,
    pub tx_af_occupied: bool,
    pub tx_enabled: bool,
    pub tx_state: String,
    pub armed_message: Option<String>,
    pub survey_active: bool,
    pub active_qsos: Vec<ActiveQso>,
    pub recent_decodes: Vec<RecentDecodeEntry>,
}

impl SessionSnapshot {
    pub fn idle() -> Self {
        Self {
            active: false,
            radio_id: None,
            is_demo: false,
            decoder_backend: None,
            my_call: None,
            my_grid: None,
            slot_clock: SlotClockSpec::realtime(Utc::now().timestamp_millis()),
            tx_af_hz: 1500,
            tx_af_occupied: false,
            tx_enabled: false,
            tx_state: "idle".to_string(),
            armed_message: None,
            survey_active: false,
            active_qsos: Vec::new(),
            recent_decodes: Vec::new(),
        }
    }
}

struct SessionRuntime {
    sequencer: QsoSequencer,
    clock: SlotClock,
    decoder_backend: String,
    dial_freq_hz: Option<i64>,
    audio_device_name: Option<String>,
    audio_tx_gain_db: f64,
    tx_state: String,
    armed_message: Option<String>,
    capture: Option<AudioCaptureHandle>,
    playback: Option<AudioPlaybackHandle>,
    wf_task: Option<JoinHandle<()>>,
}

impl SessionRuntime {
    fn to_snapshot(&self) -> SessionSnapshot {
        let now_ms = Utc::now().timestamp_millis();
        let cur_ts = self.clock.unix_secs_at(now_ms);
        let cur_slot = SlotParity::from_unix_secs(cur_ts);
        let occ = self
            .sequencer
            .is_af_occupied(self.sequencer.tx_af_hz, cur_slot, cur_ts);
        SessionSnapshot {
            active: true,
            radio_id: Some(self.sequencer.radio_id.clone()),
            is_demo: self.sequencer.is_demo,
            decoder_backend: Some(self.decoder_backend.clone()),
            my_call: Some(self.sequencer.my_call.clone()),
            my_grid: Some(self.sequencer.my_grid.clone()),
            slot_clock: self.clock.spec().clone(),
            tx_af_hz: self.sequencer.tx_af_hz,
            tx_af_occupied: occ.occupied,
            tx_enabled: self.sequencer.tx_enabled,
            tx_state: self.tx_state.clone(),
            armed_message: self.armed_message.clone(),
            survey_active: self.sequencer.survey.is_some(),
            active_qsos: self.sequencer.queue.clone(),
            recent_decodes: self.sequencer.recent_decodes.iter().cloned().collect(),
        }
    }
}

struct RunningSession {
    radio_id: String,
    is_demo: bool,
    actor: String,
    cancel: CancellationToken,
    runtime: Arc<AsyncMutex<SessionRuntime>>,
    task: JoinHandle<()>,
}

pub struct SessionManager {
    store: StateStore,
    supervisor: Arc<DeviceSupervisor>,
    watchdog: Arc<PttWatchdog>,
    ws_tx: broadcast::Sender<WsBroadcastEvent>,
    hybrid_decoder: Arc<HybridFt8Decoder>,
    inner: AsyncMutex<Option<RunningSession>>,
    snapshot_cache: RwLock<SessionSnapshot>,
}

impl SessionManager {
    pub fn new(
        store: StateStore,
        supervisor: Arc<DeviceSupervisor>,
        watchdog: Arc<PttWatchdog>,
        ws_tx: broadcast::Sender<WsBroadcastEvent>,
        jt9_override: Option<&Path>,
    ) -> Arc<Self> {
        let override_buf: Option<PathBuf> = jt9_override.map(Path::to_path_buf);
        let hybrid_decoder = Arc::new(HybridFt8Decoder::new(override_buf.as_deref()));
        Arc::new(Self {
            store,
            supervisor,
            watchdog,
            ws_tx,
            hybrid_decoder,
            inner: AsyncMutex::new(None),
            snapshot_cache: RwLock::new(SessionSnapshot::idle()),
        })
    }

    pub fn snapshot(&self) -> SessionSnapshot {
        self.snapshot_cache
            .read()
            .expect("session snapshot lock poisoned")
            .clone()
    }

    fn update_snapshot_cache(&self, snap: SessionSnapshot) {
        if let Ok(mut guard) = self.snapshot_cache.write() {
            *guard = snap;
        }
    }

    pub async fn start_session(
        self: &Arc<Self>,
        radio_id: &str,
        actor: &str,
        demo: bool,
        scale_opt: Option<f64>,
    ) -> CmdResult {
        let mut guard = self.inner.lock().await;
        if let Some(ref existing) = *guard {
            return Err((
                ErrorCode::SessionAlreadyActive,
                format!(
                    "A session is already active on radio '{}'",
                    existing.radio_id
                ),
            ));
        }

        let profile = match self.store.get_radio_profile(radio_id) {
            Ok(Some(p)) => p,
            Ok(None) => {
                return Err((
                    ErrorCode::RadioNotFound,
                    format!("Radio profile '{radio_id}' not found"),
                ));
            }
            Err(e) => return Err((ErrorCode::InternalError, e.to_string())),
        };

        let scale = scale_opt.unwrap_or(1.0);
        if !demo && (scale - 1.0).abs() > f64::EPSILON {
            return Err((
                ErrorCode::ValidationFailed,
                "Scaled clock is permitted only in demo sessions".to_string(),
            ));
        }

        let now_ms = Utc::now().timestamp_millis();
        let mut clock_spec = SlotClockSpec::realtime(now_ms);
        clock_spec.scale = scale;
        let clock =
            SlotClock::new(clock_spec).map_err(|e| (ErrorCode::ValidationFailed, e.to_string()))?;

        let (my_call, my_grid) = if demo {
            ("QQ0DEMO".to_string(), "FN33".to_string())
        } else {
            let station = self
                .store
                .get_station_config()
                .map_err(|e| (ErrorCode::InternalError, e.to_string()))?;
            let call_raw = station.callsign.as_deref().unwrap_or("");
            let grid_raw = station.grid.as_deref().unwrap_or("");
            let call = validate_station_callsign(call_raw).map_err(|e| {
                (
                    ErrorCode::ConfigRequired,
                    format!(
                        "Configure a valid station callsign before starting a live session: {e}"
                    ),
                )
            })?;
            let grid = validate_station_grid(grid_raw).map_err(|e| {
                (
                    ErrorCode::ConfigRequired,
                    format!("Configure a valid station grid before starting a live session: {e}"),
                )
            })?;
            (call, grid)
        };

        let radio_snap = self.supervisor.get_radio_snapshot(radio_id);
        let dial_freq_hz = radio_snap
            .as_ref()
            .and_then(|s| s.freq_hz.and_then(|f| i64::try_from(f).ok()))
            .or(profile.last_dial_freq_hz)
            .or(Some(14_074_000));

        let mut capture_handle = None;
        let mut wf_task = None;
        let mut matched_audio_name = None;
        let decoder_backend = if demo {
            "simulated".to_string()
        } else {
            let Some(ref rs) = radio_snap else {
                return Err((
                    ErrorCode::RadioNotReady,
                    format!("Radio '{radio_id}' worker is not ready"),
                ));
            };
            if rs.lifecycle_state != RadioLifecycleState::Ready {
                return Err((
                    ErrorCode::RadioNotReady,
                    format!(
                        "Radio '{}' must be READY to start live session (currently {})",
                        radio_id,
                        rs.lifecycle_state.as_str()
                    ),
                ));
            }

            let available_audio = tokio::task::spawn_blocking(AudioManager::enumerate_devices)
                .await
                .map_err(|e| (ErrorCode::InternalError, e.to_string()))?;

            let matched = match AudioManager::match_device(
                profile.audio_device_uid.as_deref(),
                profile.audio_device_name.as_deref(),
                &available_audio,
            ) {
                AudioMatchOutcome::ExactUid(d) => d,
                AudioMatchOutcome::UsbFallback { device, warning }
                | AudioMatchOutcome::NameFallback { device, warning } => {
                    let _ = self.ws_tx.send(WsBroadcastEvent::PreflightAlert {
                        severity: "warn".to_string(),
                        title: format!("Audio Device Fallback ({})", profile.name),
                        detail: warning,
                        occurred_at_utc: now_utc_str(),
                    });
                    device
                }
                AudioMatchOutcome::NotFound => {
                    return Err((
                        ErrorCode::AudioDeviceUnavailable,
                        "Configured USB audio device not found; select an audio interface in Hardware Setup"
                            .to_string(),
                    ));
                }
            };

            let (wf_tx, mut wf_rx) = mpsc::channel::<WaterfallFrame>(16);
            let ws_for_wf = self.ws_tx.clone();
            let rid_for_wf = radio_id.to_string();
            let wd_for_fault = Arc::clone(&self.watchdog);
            let rid_for_fault = radio_id.to_string();
            let dev_name = matched.name.clone();
            let rx_ch = profile.audio_rx_channel.clone();

            let cap = tokio::task::spawn_blocking(move || {
                AudioManager::start_capture(
                    &dev_name,
                    &rx_ch,
                    Some(wf_tx),
                    Arc::new(move |detail| {
                        let wd = Arc::clone(&wd_for_fault);
                        let r = rid_for_fault.clone();
                        tokio::spawn(async move {
                            wd.on_audio_fault(&r, &detail).await;
                        });
                    }),
                )
            })
            .await
            .map_err(|e| (ErrorCode::InternalError, e.to_string()))?
            .map_err(|e| (ErrorCode::AudioDeviceUnavailable, e.to_string()))?;

            matched_audio_name = Some(matched.name);
            capture_handle = Some(cap);

            let wf_handle = tokio::spawn(async move {
                let mut last_emit = StdInstant::now() - Duration::from_secs(1);
                while let Some(frame) = wf_rx.recv().await {
                    if last_emit.elapsed() >= Duration::from_millis(250) {
                        last_emit = StdInstant::now();
                        let _ = ws_for_wf.send(WsBroadcastEvent::Waterfall {
                            radio_id: rid_for_wf.clone(),
                            min_hz: frame.min_hz,
                            max_hz: frame.max_hz,
                            bin_hz: frame.bin_hz,
                            bins_db: frame.bins_db,
                            rms_db: frame.rms_db,
                            peak_db: frame.peak_db,
                            clipped: frame.clipped,
                            even_occupied_hz: Vec::new(),
                            odd_occupied_hz: Vec::new(),
                        });
                    }
                }
            });
            wf_task = Some(wf_handle);
            self.supervisor.set_session_active(radio_id, true).await;
            self.hybrid_decoder.active_backend_name().to_string()
        };

        let seq = QsoSequencer::new(radio_id, demo, &my_call, &my_grid);
        let runtime = Arc::new(AsyncMutex::new(SessionRuntime {
            sequencer: seq,
            clock: clock.clone(),
            decoder_backend: decoder_backend.clone(),
            dial_freq_hz,
            audio_device_name: matched_audio_name,
            audio_tx_gain_db: profile.audio_tx_gain_db,
            tx_state: "idle".to_string(),
            armed_message: None,
            capture: capture_handle,
            playback: None,
            wf_task,
        }));

        let snap = {
            let rt = runtime.lock().await;
            rt.to_snapshot()
        };
        self.update_snapshot_cache(snap.clone());

        let _ = self.ws_tx.send(WsBroadcastEvent::SlotClockUpdated {
            radio_id: Some(radio_id.to_string()),
            active: true,
            is_demo: demo,
            decoder_backend: Some(decoder_backend.clone()),
            slot_clock: clock.spec().clone(),
        });
        self.broadcast_qso_update(&snap, None);
        let _ = self.ws_tx.send(WsBroadcastEvent::TxState {
            radio_id: radio_id.to_string(),
            state: "idle".to_string(),
            af_hz: Some(snap.tx_af_hz),
            slot: None,
            message: None,
            ptt_elapsed_ms: 0,
        });

        let cancel = CancellationToken::new();
        let mgr = Arc::clone(self);
        let rt_clone = Arc::clone(&runtime);
        let cancel_clone = cancel.clone();
        let actor_str = actor.to_string();
        let task = if demo {
            tokio::spawn(async move {
                mgr.run_demo_loop(rt_clone, cancel_clone).await;
            })
        } else {
            tokio::spawn(async move {
                mgr.run_live_loop(rt_clone, actor_str, cancel_clone).await;
            })
        };

        *guard = Some(RunningSession {
            radio_id: radio_id.to_string(),
            is_demo: demo,
            actor: actor.to_string(),
            cancel,
            runtime,
            task,
        });

        info!(
            radio_id,
            demo, scale, decoder_backend, "FT8 session started"
        );
        Ok(serde_json::to_value(snap).unwrap_or(Value::Null))
    }

    pub async fn stop_session(&self, radio_id: Option<&str>) -> CmdResult {
        let stopped = {
            let mut guard = self.inner.lock().await;
            match (&*guard, radio_id) {
                (None, _) => {
                    return Err((
                        ErrorCode::NoActiveSession,
                        "No active FT8 session to stop".to_string(),
                    ));
                }
                (Some(s), Some(req_id)) if s.radio_id != req_id => {
                    return Err((
                        ErrorCode::NoActiveSession,
                        format!("No active session on radio '{req_id}'"),
                    ));
                }
                (Some(_), _) => guard.take().expect("checked Some"),
            }
        };

        stopped.cancel.cancel();
        let _ = stopped.task.await;

        {
            let mut rt = stopped.runtime.lock().await;
            if let Some(mut pb) = rt.playback.take() {
                pb.stop();
            }
            if let Some(mut cap) = rt.capture.take() {
                cap.stop();
            }
            if let Some(wf_h) = rt.wf_task.take() {
                wf_h.abort();
            }
            rt.sequencer.set_tx_enabled(false);
            rt.sequencer.cancel_manual_tx();
            rt.tx_state = "idle".to_string();
            rt.armed_message = None;
        }

        self.watchdog.disarm_tx(&stopped.radio_id).await;
        if !stopped.is_demo {
            let _ = self.supervisor.set_ptt(&stopped.radio_id, false).await;
            self.supervisor
                .set_session_active(&stopped.radio_id, false)
                .await;
        }

        let idle = SessionSnapshot::idle();
        self.update_snapshot_cache(idle.clone());
        let _ = self.ws_tx.send(WsBroadcastEvent::SlotClockUpdated {
            radio_id: None,
            active: false,
            is_demo: false,
            decoder_backend: None,
            slot_clock: idle.slot_clock.clone(),
        });
        let _ = self.ws_tx.send(WsBroadcastEvent::TxState {
            radio_id: stopped.radio_id.clone(),
            state: "idle".to_string(),
            af_hz: None,
            slot: None,
            message: None,
            ptt_elapsed_ms: 0,
        });
        self.broadcast_qso_update(&idle, None);

        info!(radio_id = %stopped.radio_id, "FT8 session stopped");
        Ok(serde_json::to_value(idle).unwrap_or(Value::Null))
    }

    pub async fn stop_if_active(&self) {
        let has_active = self.inner.lock().await.is_some();
        if has_active {
            let _ = self.stop_session(None).await;
        }
    }

    pub async fn emergency_halt(&self, radio_id: Option<&str>) {
        let rt_opt = {
            let guard = self.inner.lock().await;
            match (&*guard, radio_id) {
                (Some(s), Some(rid)) if s.radio_id == rid => {
                    Some((s.radio_id.clone(), Arc::clone(&s.runtime)))
                }
                (Some(s), None) => Some((s.radio_id.clone(), Arc::clone(&s.runtime))),
                _ => None,
            }
        };

        if let Some((rid, rt_arc)) = rt_opt {
            let snap = {
                let mut rt = rt_arc.lock().await;
                rt.sequencer.set_tx_enabled(false);
                rt.sequencer.cancel_manual_tx();
                if let Some(mut pb) = rt.playback.take() {
                    pb.stop();
                }
                rt.tx_state = "idle".to_string();
                rt.armed_message = None;
                rt.to_snapshot()
            };
            self.update_snapshot_cache(snap.clone());
            self.broadcast_qso_update(&snap, None);
            let _ = self.ws_tx.send(WsBroadcastEvent::TxState {
                radio_id: rid,
                state: "idle".to_string(),
                af_hz: Some(snap.tx_af_hz),
                slot: None,
                message: None,
                ptt_elapsed_ms: 0,
            });
        }
    }

    pub async fn abort_active_tx(&self, radio_id: &str) {
        let rt_opt = {
            let guard = self.inner.lock().await;
            guard
                .as_ref()
                .filter(|s| s.radio_id == radio_id)
                .map(|s| Arc::clone(&s.runtime))
        };
        if let Some(rt_arc) = rt_opt {
            let snap = {
                let mut rt = rt_arc.lock().await;
                rt.sequencer.cancel_manual_tx();
                if let Some(mut pb) = rt.playback.take() {
                    pb.stop();
                }
                rt.tx_state = "idle".to_string();
                rt.armed_message = None;
                rt.to_snapshot()
            };
            self.update_snapshot_cache(snap.clone());
            let _ = self.ws_tx.send(WsBroadcastEvent::TxState {
                radio_id: radio_id.to_string(),
                state: "idle".to_string(),
                af_hz: Some(snap.tx_af_hz),
                slot: None,
                message: None,
                ptt_elapsed_ms: 0,
            });
            self.broadcast_qso_update(&snap, None);
        }
    }

    async fn get_active_runtime(
        &self,
        radio_id: &str,
    ) -> Result<(bool, String, Arc<AsyncMutex<SessionRuntime>>), (ErrorCode, String)> {
        let guard = self.inner.lock().await;
        let Some(ref s) = *guard else {
            return Err((
                ErrorCode::NoActiveSession,
                "No active FT8 session".to_string(),
            ));
        };
        if s.radio_id != radio_id {
            return Err((
                ErrorCode::NoActiveSession,
                format!(
                    "Active session belongs to radio '{}', not '{}'",
                    s.radio_id, radio_id
                ),
            ));
        }
        Ok((s.is_demo, s.actor.clone(), Arc::clone(&s.runtime)))
    }

    pub async fn arm_tx(&self, radio_id: &str, intent: TxIntent) -> CmdResult {
        let (_, _, rt_arc) = self.get_active_runtime(radio_id).await?;
        let snap = {
            let mut rt = rt_arc.lock().await;
            rt.sequencer.arm_manual_tx(intent.clone());
            rt.tx_state = "armed".to_string();
            rt.armed_message = Some(intent.message.clone());
            rt.to_snapshot()
        };
        self.update_snapshot_cache(snap.clone());
        let _ = self.ws_tx.send(WsBroadcastEvent::TxState {
            radio_id: radio_id.to_string(),
            state: "armed".to_string(),
            af_hz: Some(intent.af_hz),
            slot: Some(intent.slot.as_str().to_string()),
            message: Some(intent.message.clone()),
            ptt_elapsed_ms: 0,
        });
        self.broadcast_qso_update(&snap, None);
        Ok(json!({
            "tx_state": "armed",
            "af_hz": intent.af_hz,
            "slot": intent.slot.as_str(),
            "message": intent.message,
        }))
    }

    pub async fn cancel_tx(&self, radio_id: &str) -> CmdResult {
        self.abort_active_tx(radio_id).await;
        Ok(json!({ "tx_state": "idle", "radio_id": radio_id }))
    }

    pub async fn call_cq(
        &self,
        radio_id: &str,
        slot_opt: Option<SlotParity>,
        directed: Option<String>,
    ) -> CmdResult {
        let (_, _, rt_arc) = self.get_active_runtime(radio_id).await?;
        let (cq, snap) = {
            let mut rt = rt_arc.lock().await;
            let now_ms = Utc::now().timestamp_millis();
            let slot = slot_opt.unwrap_or_else(|| rt.clock.parity_at(now_ms).opposite());
            let cq = rt.sequencer.start_cq(slot, directed);
            (cq, rt.to_snapshot())
        };
        self.update_snapshot_cache(snap.clone());
        self.broadcast_qso_update(&snap, None);
        Ok(serde_json::to_value(cq).unwrap_or(Value::Null))
    }

    pub async fn reply_qso(
        &self,
        radio_id: &str,
        callsign: &str,
        their_grid: Option<String>,
        rx_slot: SlotParity,
        snr_db: Option<i8>,
    ) -> CmdResult {
        let (_, _, rt_arc) = self.get_active_runtime(radio_id).await?;
        let (qso, snap) = {
            let mut rt = rt_arc.lock().await;
            let qso = rt
                .sequencer
                .start_reply(callsign, their_grid, rx_slot, snr_db);
            (qso, rt.to_snapshot())
        };
        self.update_snapshot_cache(snap.clone());
        self.broadcast_qso_update(&snap, None);
        Ok(serde_json::to_value(qso).unwrap_or(Value::Null))
    }

    pub async fn qso_action(&self, radio_id: &str, qso_id: &str, action: QsoAction) -> CmdResult {
        let (_, _, rt_arc) = self.get_active_runtime(radio_id).await?;
        let (completed, snap) = {
            let mut rt = rt_arc.lock().await;
            let freq = rt.dial_freq_hz;
            let completed = rt
                .sequencer
                .apply_action(qso_id, action, freq)
                .map_err(|msg| (ErrorCode::ValidationFailed, msg))?;
            (completed, rt.to_snapshot())
        };

        if let Some(ref rec) = completed {
            self.persist_completed_qso(radio_id, rec);
        }
        self.update_snapshot_cache(snap.clone());
        self.broadcast_qso_update(&snap, completed.clone());
        Ok(json!({
            "active_qsos": snap.active_qsos,
            "completed_qso": completed,
        }))
    }

    pub async fn survey_af(&self, radio_id: &str) -> CmdResult {
        let (_, _, rt_arc) = self.get_active_runtime(radio_id).await?;
        let snap = {
            let mut rt = rt_arc.lock().await;
            let vnow = rt.clock.virtual_ms_at(Utc::now().timestamp_millis()).0;
            let slot_ms = rt.clock.spec().slot_ms;
            rt.sequencer.begin_af_survey(vnow, slot_ms);
            rt.to_snapshot()
        };
        self.update_snapshot_cache(snap.clone());
        self.broadcast_qso_update(&snap, None);
        Ok(json!({ "survey_active": true }))
    }

    pub async fn set_af(&self, radio_id: &str, af_hz: u16) -> CmdResult {
        let (_, _, rt_arc) = self.get_active_runtime(radio_id).await?;
        let snap = {
            let mut rt = rt_arc.lock().await;
            rt.sequencer.set_af(af_hz);
            rt.to_snapshot()
        };
        self.update_snapshot_cache(snap.clone());
        self.broadcast_qso_update(&snap, None);
        Ok(json!({
            "tx_af_hz": snap.tx_af_hz,
            "tx_af_occupied": snap.tx_af_occupied,
        }))
    }

    pub async fn set_tx_enabled(&self, radio_id: &str, enabled: bool) -> CmdResult {
        let (_, _, rt_arc) = self.get_active_runtime(radio_id).await?;
        let snap = {
            let mut rt = rt_arc.lock().await;
            rt.sequencer.set_tx_enabled(enabled);
            if !enabled {
                if let Some(mut pb) = rt.playback.take() {
                    pb.stop();
                }
                rt.tx_state = "idle".to_string();
            }
            rt.to_snapshot()
        };
        if !enabled {
            self.watchdog.disarm_tx(radio_id).await;
            let _ = self.supervisor.set_ptt(radio_id, false).await;
        }
        self.update_snapshot_cache(snap.clone());
        self.broadcast_qso_update(&snap, None);
        Ok(json!({ "tx_enabled": snap.tx_enabled }))
    }

    fn persist_completed_qso(&self, radio_id: &str, rec: &QsoRecord) {
        let is_demo = self.snapshot_cache.read().ok().is_some_and(|s| s.is_demo);
        let res = if is_demo {
            self.store.insert_demo_qso(rec)
        } else {
            self.store.insert_qso(rec)
        };
        if let Err(e) = res {
            warn!(error = %e, "failed to persist completed QSO");
        }
        if let Ok(station) = self.store.get_station_config() {
            let env = TelemetryEnvelope::new(
                station.station_id,
                Some(radio_id.to_string()),
                "qso.completed",
                is_demo,
                json!({
                    "qso_id": rec.qso_id,
                    "my_call": rec.my_call,
                    "their_call": rec.their_call,
                    "their_grid": rec.their_grid,
                    "band": rec.band,
                    "dial_freq_hz": rec.dial_freq_hz,
                    "af_hz": rec.af_hz,
                    "rst_sent": rec.rst_sent,
                    "rst_rcvd": rec.rst_rcvd,
                    "completion_reason": rec.completion_reason,
                }),
            );
            let _ = self.store.enqueue_telemetry(&env);
        }
    }

    fn broadcast_qso_update(&self, snap: &SessionSnapshot, completed: Option<QsoRecord>) {
        let _ = self.ws_tx.send(WsBroadcastEvent::QsoUpdate {
            radio_id: snap.radio_id.clone(),
            active: snap.active,
            is_demo: snap.is_demo,
            tx_enabled: snap.tx_enabled,
            tx_af_hz: snap.tx_af_hz,
            tx_af_occupied: snap.tx_af_occupied,
            survey_active: snap.survey_active,
            active_qsos: snap.active_qsos.clone(),
            completed_qso: completed.map(Box::new),
        });
    }

    async fn run_demo_loop(
        self: Arc<Self>,
        rt_arc: Arc<AsyncMutex<SessionRuntime>>,
        cancel: CancellationToken,
    ) {
        let mut sim = SimulatedModem::default();
        let (slot_ms, epoch_ms, anchor_wall_ms, scale, radio_id) = {
            let rt = rt_arc.lock().await;
            let spec = rt.clock.spec();
            (
                spec.slot_ms,
                spec.epoch_ms,
                spec.anchor_wall_ms,
                spec.scale,
                rt.sequencer.radio_id.clone(),
            )
        };

        let mut next_slot_virtual_ms = (epoch_ms.div_euclid(slot_ms) + 1) * slot_ms;
        loop {
            if cancel.is_cancelled() {
                break;
            }

            let target_wall_ms =
                anchor_wall_ms + (((next_slot_virtual_ms - epoch_ms) as f64) / scale).ceil() as i64;
            let mut next_wf_at = TokioInstant::now();

            loop {
                let now_ms = Utc::now().timestamp_millis();
                if now_ms >= target_wall_ms {
                    break;
                }
                let rem_ms = (target_wall_ms - now_ms) as u64;
                let sleep_dur = Duration::from_millis(rem_ms.min(250));
                tokio::select! {
                    _ = cancel.cancelled() => return,
                    _ = sleep(sleep_dur) => {}
                }
                if next_wf_at.elapsed() >= Duration::from_millis(240) {
                    next_wf_at = TokioInstant::now();
                    let cur_ts = UnixSecs((next_slot_virtual_ms - slot_ms).div_euclid(1000));
                    let (even_occ, odd_occ, tx_af) = {
                        let rt = rt_arc.lock().await;
                        let (e, o) = rt.sequencer.occupied_afs_by_parity(cur_ts);
                        (e, o, rt.sequencer.tx_af_hz)
                    };
                    let wf = synthesize_demo_waterfall(&even_occ, &odd_occ, tx_af);
                    let _ = self.ws_tx.send(WsBroadcastEvent::Waterfall {
                        radio_id: radio_id.clone(),
                        min_hz: wf.min_hz,
                        max_hz: wf.max_hz,
                        bin_hz: wf.bin_hz,
                        bins_db: wf.bins_db,
                        rms_db: wf.rms_db,
                        peak_db: wf.peak_db,
                        clipped: false,
                        even_occupied_hz: even_occ,
                        odd_occupied_hz: odd_occ,
                    });
                }
            }

            if cancel.is_cancelled() {
                break;
            }

            let slot_ts = UnixSecs(next_slot_virtual_ms.div_euclid(1000));
            let slot_parity = SlotParity::from_unix_secs(slot_ts);
            let rx_decodes = sim.advance_slot(slot_ts);

            let (completed_rx, snap_after_rx) = {
                let mut rt = rt_arc.lock().await;
                let freq = rt.dial_freq_hz;
                let mut done_all = Vec::new();
                for dec in &rx_decodes {
                    let mut done = rt.sequencer.on_rx_decode(dec, freq);
                    done_all.append(&mut done);
                }
                let _ = rt.sequencer.maybe_finish_af_survey(next_slot_virtual_ms);
                (done_all, rt.to_snapshot())
            };

            for dec in &rx_decodes {
                let _ = self.ws_tx.send(WsBroadcastEvent::Decode {
                    radio_id: radio_id.clone(),
                    ts_sec: dec.slot_ts.0,
                    slot: slot_parity.as_str().to_string(),
                    snr_db: dec.snr_db,
                    dt_sec: dec.dt_sec,
                    af_hz: dec.af_hz,
                    mode: "FT8".to_string(),
                    message: dec.message.clone(),
                    decoder_backend: dec.decoder_backend.clone(),
                });
            }

            for rec in &completed_rx {
                self.persist_completed_qso(&radio_id, rec);
            }
            self.update_snapshot_cache(snap_after_rx.clone());
            self.broadcast_qso_update(&snap_after_rx, completed_rx.last().cloned());

            let tx_intent = {
                let rt = rt_arc.lock().await;
                rt.sequencer
                    .compose_tx_for_slot(slot_parity, next_slot_virtual_ms)
            };

            if let Some(intent) = tx_intent {
                let _ = self.ws_tx.send(WsBroadcastEvent::TxState {
                    radio_id: radio_id.clone(),
                    state: "transmitting".to_string(),
                    af_hz: Some(intent.af_hz),
                    slot: Some(intent.slot.as_str().to_string()),
                    message: Some(intent.message.clone()),
                    ptt_elapsed_ms: 0,
                });

                sim.register_local_tx(slot_ts, &intent);

                let (completed_tx, snap_after_tx) = {
                    let mut rt = rt_arc.lock().await;
                    let freq = rt.dial_freq_hz;
                    let completed = rt.sequencer.on_tx_confirmed(slot_ts, &intent, freq);
                    rt.tx_state = "idle".to_string();
                    rt.armed_message = None;
                    (completed, rt.to_snapshot())
                };

                if let Some(ref rec) = completed_tx {
                    self.persist_completed_qso(&radio_id, rec);
                }
                self.update_snapshot_cache(snap_after_tx.clone());
                self.broadcast_qso_update(&snap_after_tx, completed_tx);
                let _ = self.ws_tx.send(WsBroadcastEvent::TxState {
                    radio_id: radio_id.clone(),
                    state: "idle".to_string(),
                    af_hz: Some(snap_after_tx.tx_af_hz),
                    slot: None,
                    message: None,
                    ptt_elapsed_ms: 0,
                });
            }

            next_slot_virtual_ms += slot_ms;
        }
    }

    async fn run_live_loop(
        self: Arc<Self>,
        rt_arc: Arc<AsyncMutex<SessionRuntime>>,
        actor: String,
        cancel: CancellationToken,
    ) {
        let (slot_ms, epoch_ms, radio_id) = {
            let rt = rt_arc.lock().await;
            let spec = rt.clock.spec();
            (spec.slot_ms, spec.epoch_ms, rt.sequencer.radio_id.clone())
        };

        let mut next_slot_ms = (epoch_ms.div_euclid(slot_ms) + 1) * slot_ms;
        loop {
            let wait_ms = (next_slot_ms - Utc::now().timestamp_millis()).max(10) as u64;
            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = sleep(Duration::from_millis(wait_ms)) => {}
            }
            if cancel.is_cancelled() {
                break;
            }

            let finished_slot_ts = UnixSecs((next_slot_ms - slot_ms).div_euclid(1000));
            let active_slot_ts = UnixSecs(next_slot_ms.div_euclid(1000));
            let active_parity = SlotParity::from_unix_secs(active_slot_ts);

            let captured = {
                let rt = rt_arc.lock().await;
                rt.capture.as_ref().map(|c| c.drain_slot_samples())
            };

            if let Some(mut pcm_12k) = captured {
                if pcm_12k.len() >= MIN_LIVE_SLOT_SAMPLES_12K {
                    if pcm_12k.len() > FT8_SLOT_SAMPLES_12K {
                        let start = pcm_12k.len() - FT8_SLOT_SAMPLES_12K;
                        pcm_12k.drain(..start);
                    }
                    let decoder = Arc::clone(&self.hybrid_decoder);
                    let rt_decode = Arc::clone(&rt_arc);
                    let mgr_decode = Arc::clone(&self);
                    let rid_decode = radio_id.clone();
                    tokio::spawn(async move {
                        match decoder.decode_slot(finished_slot_ts, &pcm_12k).await {
                            Ok(decodes) => {
                                mgr_decode
                                    .process_live_decodes(&rid_decode, &rt_decode, &decodes)
                                    .await;
                            }
                            Err(e) => {
                                warn!(radio_id = %rid_decode, error = %e, "live FT8 decode failed");
                            }
                        }
                    });
                }
            }

            let tx_plan = {
                let mut rt = rt_arc.lock().await;
                let _ = rt.sequencer.maybe_finish_af_survey(next_slot_ms);
                rt.sequencer
                    .compose_tx_for_slot(active_parity, next_slot_ms)
                    .map(|intent| {
                        (
                            intent,
                            rt.audio_device_name.clone(),
                            rt.audio_tx_gain_db,
                            rt.dial_freq_hz,
                        )
                    })
            };

            if let Some((intent, Some(audio_dev), gain_db, dial_freq_hz)) = tx_plan {
                let mgr_tx = Arc::clone(&self);
                let rt_tx = Arc::clone(&rt_arc);
                let rid_tx = radio_id.clone();
                let actor_tx = actor.clone();
                let cancel_tx = cancel.clone();
                tokio::spawn(async move {
                    mgr_tx
                        .execute_live_tx(
                            &rid_tx,
                            &actor_tx,
                            active_slot_ts,
                            &intent,
                            &audio_dev,
                            gain_db,
                            dial_freq_hz,
                            rt_tx,
                            cancel_tx,
                        )
                        .await;
                });
            }

            next_slot_ms += slot_ms;
        }
    }

    async fn process_live_decodes(
        &self,
        radio_id: &str,
        rt_arc: &Arc<AsyncMutex<SessionRuntime>>,
        decodes: &[Ft8Decode],
    ) {
        if decodes.is_empty() {
            return;
        }
        let (completed, snap, dial_freq) = {
            let mut rt = rt_arc.lock().await;
            let freq = rt.dial_freq_hz;
            let mut done_all = Vec::new();
            for dec in decodes {
                let mut done = rt.sequencer.on_rx_decode(dec, freq);
                done_all.append(&mut done);
            }
            (done_all, rt.to_snapshot(), freq)
        };

        let station_id = self.store.get_station_config().ok().map(|s| s.station_id);
        for dec in decodes {
            let slot_str = SlotParity::from_unix_secs(dec.slot_ts).as_str().to_string();
            let _ = self.ws_tx.send(WsBroadcastEvent::Decode {
                radio_id: radio_id.to_string(),
                ts_sec: dec.slot_ts.0,
                slot: slot_str,
                snr_db: dec.snr_db,
                dt_sec: dec.dt_sec,
                af_hz: dec.af_hz,
                mode: "FT8".to_string(),
                message: dec.message.clone(),
                decoder_backend: dec.decoder_backend.clone(),
            });
            if let Some(ref sid) = station_id {
                let env = TelemetryEnvelope::new(
                    sid.clone(),
                    Some(radio_id.to_string()),
                    "ft8.decode",
                    false,
                    json!({
                        "slot_ts": dec.slot_ts.0,
                        "dial_freq_hz": dial_freq,
                        "snr_db": dec.snr_db,
                        "dt_sec": dec.dt_sec,
                        "af_hz": dec.af_hz,
                        "message": dec.message,
                        "decoder_backend": dec.decoder_backend,
                    }),
                );
                let _ = self.store.enqueue_telemetry(&env);
            }
        }

        for rec in &completed {
            self.persist_completed_qso(radio_id, rec);
        }
        self.update_snapshot_cache(snap.clone());
        self.broadcast_qso_update(&snap, completed.last().cloned());
    }

    #[allow(clippy::too_many_arguments)]
    async fn execute_live_tx(
        &self,
        radio_id: &str,
        actor: &str,
        slot_ts: UnixSecs,
        intent: &TxIntent,
        audio_dev: &str,
        tx_gain_db: f64,
        dial_freq_hz: Option<i64>,
        rt_arc: Arc<AsyncMutex<SessionRuntime>>,
        cancel: CancellationToken,
    ) {
        let pcm_48k = match Ft8LibTxModulator::modulate_pcm(
            &intent.message,
            f32::from(intent.af_hz),
            DSP_SAMPLE_RATE,
        ) {
            Ok(p) => p,
            Err(e) => {
                warn!(radio_id, error = %e, "failed to modulate FT8 TX waveform");
                return;
            }
        };

        let dev_owned = audio_dev.to_string();
        let wd_fault = Arc::clone(&self.watchdog);
        let rid_fault = radio_id.to_string();
        let playback = match tokio::task::spawn_blocking(move || {
            AudioManager::start_playback(
                &dev_owned,
                pcm_48k,
                tx_gain_db,
                Arc::new(move |detail| {
                    let wd = Arc::clone(&wd_fault);
                    let r = rid_fault.clone();
                    tokio::spawn(async move {
                        wd.on_audio_fault(&r, &detail).await;
                    });
                }),
            )
        })
        .await
        {
            Ok(Ok(pb)) => pb,
            Ok(Err(e)) => {
                warn!(radio_id, error = %e, "failed to open TX audio playback stream");
                return;
            }
            Err(e) => {
                warn!(radio_id, error = %e, "TX playback spawn error");
                return;
            }
        };

        let abort_flag = playback.abort_handle();
        if let Err((_, msg)) = self.supervisor.set_ptt(radio_id, true).await {
            let mut pb = playback;
            pb.stop();
            warn!(radio_id, error = %msg, "failed to assert CAT PTT for TX");
            return;
        }

        self.watchdog
            .arm_tx(radio_id, actor, Some(Arc::clone(&abort_flag)))
            .await;

        {
            let mut rt = rt_arc.lock().await;
            rt.playback = Some(playback);
            rt.tx_state = "transmitting".to_string();
            rt.armed_message = Some(intent.message.clone());
            self.update_snapshot_cache(rt.to_snapshot());
        }

        let _ = self.ws_tx.send(WsBroadcastEvent::TxState {
            radio_id: radio_id.to_string(),
            state: "transmitting".to_string(),
            af_hz: Some(intent.af_hz),
            slot: Some(intent.slot.as_str().to_string()),
            message: Some(intent.message.clone()),
            ptt_elapsed_ms: 0,
        });

        let tx_end = TokioInstant::now() + Duration::from_millis(12_700);
        tokio::select! {
            _ = cancel.cancelled() => {}
            _ = sleep_until(tx_end) => {}
        }

        let aborted = abort_flag.load(Ordering::SeqCst);
        self.watchdog.disarm_tx(radio_id).await;
        let _ = self.supervisor.set_ptt(radio_id, false).await;

        let (completed, snap) = {
            let mut rt = rt_arc.lock().await;
            if let Some(mut pb) = rt.playback.take() {
                pb.stop();
            }
            let done = if !aborted && !cancel.is_cancelled() {
                rt.sequencer.on_tx_confirmed(slot_ts, intent, dial_freq_hz)
            } else {
                None
            };
            rt.tx_state = "idle".to_string();
            rt.armed_message = None;
            (done, rt.to_snapshot())
        };

        if let Some(ref rec) = completed {
            self.persist_completed_qso(radio_id, rec);
        }
        self.update_snapshot_cache(snap.clone());
        self.broadcast_qso_update(&snap, completed);
        let _ = self.ws_tx.send(WsBroadcastEvent::TxState {
            radio_id: radio_id.to_string(),
            state: "idle".to_string(),
            af_hz: Some(snap.tx_af_hz),
            slot: None,
            message: None,
            ptt_elapsed_ms: 0,
        });
    }
}

fn synthesize_demo_waterfall(even_occ: &[u16], odd_occ: &[u16], tx_af: u16) -> WaterfallFrame {
    let min_hz = 200.0_f32;
    let max_hz = 3000.0_f32;
    let num_bins = 140_usize;
    let bin_hz = (max_hz - min_hz) / (num_bins as f32);
    let mut bins_db = Vec::with_capacity(num_bins);

    for i in 0..num_bins {
        let hz = min_hz + (i as f32 + 0.5) * bin_hz;
        let mut lvl = -72.0_f32;
        for &sig_hz in even_occ.iter().chain(odd_occ.iter()) {
            let dist = (hz - f32::from(sig_hz)).abs();
            if dist < 50.0 {
                lvl = lvl.max(-24.0 - dist * 0.8);
            }
        }
        if (hz - f32::from(tx_af)).abs() < 15.0 {
            lvl = lvl.max(-62.0);
        }
        bins_db.push(lvl);
    }

    WaterfallFrame {
        min_hz,
        max_hz,
        bin_hz,
        bins_db,
        rms_db: -42.0,
        peak_db: -24.0,
        clipped: false,
    }
}
