pub mod reconciler;
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
use tracing::{debug, info, warn};

use crate::audio::devices::AudioMatchOutcome;
use crate::audio::dsp::{WaterfallFrame, DSP_SAMPLE_RATE, FT8_SAMPLE_RATE, FT8_SLOT_SAMPLES_12K};
use crate::audio::manager::{AudioCaptureHandle, AudioManager, AudioPlaybackHandle};
use crate::command_bus::{ErrorCode, WsBroadcastEvent};
use crate::domain::adif::QsoRecord;
use crate::domain::bands::derive_band;
use crate::domain::clock::{SlotClock, SlotClockSpec, SlotParity, UnixSecs};
use crate::domain::ft8::{
    infer_station_role, parse_ft8_message, validate_station_callsign, validate_station_grid,
    Ft8Payload, ParsedFt8Message,
};
use crate::modem::ft8_lib::Ft8LibTxModulator;
use crate::modem::simulator::SimulatedModem;
use crate::modem::{DecodePassOptions, Ft8Decode, HybridFt8Decoder, TxIntent};
use crate::store::{channel_key_for_freq, now_utc_str, StateStore, UpsertChannelRosterInput};
use crate::supervisor::radio_worker::{CmdResult, RadioLifecycleState};
use crate::supervisor::DeviceSupervisor;
use crate::telemetry::TelemetryEnvelope;
use crate::watchdog::PttWatchdog;

use self::reconciler::{ReconcileOutcome, SlotDecodeReconciler};
use self::sequencer::{ActiveQso, QsoAction, QsoSequencer, RecentDecodeEntry, TranscriptEntry};

const MIN_LIVE_SLOT_SAMPLES_12K: usize = 72_000; // >= 6 seconds captured before running decoder
const MIN_LIVE_SLOT_REAL_AUDIO_MS: i64 = 6_000; // >= 6 seconds real captured audio in slot
const PASS_1_LEAD_MS: i64 = 3_200; // t = 11.8s (3.2s left): fast early pass (-d 1)
const PASS_2_LEAD_MS: i64 = 1_500; // t = 13.5s (1.5s left): normal pre-close pass (-d 2)
const PASS_3_LEAD_MS: i64 = 200; // t = 14.8s (0.2s left): deep final pass (-d 3)
const LIVE_DECODE_GRACE_MS: i64 = 300; // Wait up to +300ms past slot boundary for Pass 3 before TX
const ROSTER_STREAM_FLUSH_INTERVAL: Duration = Duration::from_millis(150);

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
        jt9_data_dir: Option<&Path>,
    ) -> Arc<Self> {
        let override_buf: Option<PathBuf> = jt9_override.map(Path::to_path_buf);
        let hybrid_decoder = Arc::new(HybridFt8Decoder::with_data_dir(
            override_buf.as_deref(),
            jt9_data_dir.map(Path::to_path_buf),
        ));
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

    #[allow(clippy::too_many_arguments)]
    pub async fn reply_qso(
        &self,
        radio_id: &str,
        callsign: &str,
        their_grid: Option<String>,
        rx_slot: SlotParity,
        snr_db: Option<i8>,
        rx_message: Option<String>,
        rx_af_hz: Option<u16>,
        rx_ts_sec: Option<i64>,
    ) -> CmdResult {
        let (_, _, rt_arc) = self.get_active_runtime(radio_id).await?;
        let initial_rx = rx_message
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty())
            .map(|message| TranscriptEntry {
                at_utc: now_utc_str(),
                direction: "rx".to_string(),
                slot_ts: rx_ts_sec.unwrap_or_else(|| Utc::now().timestamp()),
                af_hz: rx_af_hz.unwrap_or(1500),
                snr_db,
                message,
            });
        let (qso, snap) = {
            let mut rt = rt_arc.lock().await;
            let qso = rt
                .sequencer
                .start_reply_with_rx(callsign, their_grid, rx_slot, snr_db, initial_rx);
            (qso, rt.to_snapshot())
        };
        self.update_snapshot_cache(snap.clone());
        self.broadcast_qso_update(&snap, None);
        Ok(serde_json::to_value(qso).unwrap_or(Value::Null))
    }

    pub async fn qso_action(&self, radio_id: &str, qso_id: &str, action: QsoAction) -> CmdResult {
        let (_, _, rt_arc) = self.get_active_runtime(radio_id).await?;
        let live_freq = self.live_dial_freq_hz(radio_id, None);
        let (completed, snap) = {
            let mut rt = rt_arc.lock().await;
            if let Some(f) = live_freq {
                rt.dial_freq_hz = Some(f);
            }
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

    pub async fn update_live_station_identity(&self, callsign: &str, grid: &str) {
        let rt_arc = {
            let guard = self.inner.lock().await;
            let Some(ref s) = *guard else {
                return;
            };
            if s.is_demo {
                return;
            }
            Arc::clone(&s.runtime)
        };

        let call = callsign.trim().to_ascii_uppercase();
        let grid = grid.trim().to_ascii_uppercase();
        let snap = {
            let mut rt = rt_arc.lock().await;
            rt.sequencer.my_call = call.clone();
            rt.sequencer.my_grid = grid.clone();
            for q in &mut rt.sequencer.queue {
                q.my_call = call.clone();
                q.my_grid = grid.clone();
            }
            rt.to_snapshot()
        };
        self.update_snapshot_cache(snap.clone());
        self.broadcast_qso_update(&snap, None);
    }

    fn live_dial_freq_hz(&self, radio_id: &str, fallback: Option<i64>) -> Option<i64> {
        self.supervisor
            .get_radio_snapshot(radio_id)
            .and_then(|s| s.freq_hz.and_then(|f| i64::try_from(f).ok()))
            .or(fallback)
    }

    fn build_roster_input(
        is_demo: bool,
        channel_key: &str,
        band: Option<&str>,
        my_call: &str,
        dial_freq_hz: Option<i64>,
        dec: &Ft8Decode,
        increment_decode_count: bool,
    ) -> Option<UpsertChannelRosterInput> {
        let parsed = parse_ft8_message(&dec.message);
        let station_role = infer_station_role(&parsed).map(|r| r.as_str().to_string());
        let (callsign, grid, is_cq, directed_cq, calling_me) = match parsed {
            ParsedFt8Message::Cq {
                directed,
                callsign,
                grid,
                ..
            } => (callsign, grid, true, directed, false),
            ParsedFt8Message::Directed {
                to, from, payload, ..
            } => {
                let g = match payload {
                    Some(Ft8Payload::Grid(gr)) => Some(gr),
                    _ => None,
                };
                (from, g, false, None, to == my_call)
            }
            ParsedFt8Message::Raw { .. } => return None,
        };

        if callsign == my_call {
            return None;
        }
        let slot_str = SlotParity::from_unix_secs(dec.slot_ts).as_str().to_string();
        Some(UpsertChannelRosterInput {
            is_demo,
            channel_key: channel_key.to_string(),
            callsign,
            mode: "FT8".to_string(),
            dial_freq_hz,
            band: band.map(str::to_string),
            grid,
            last_snr_db: dec.snr_db,
            last_dt_sec: dec.dt_sec,
            last_af_hz: dec.af_hz,
            last_slot: slot_str,
            last_message: dec.message.clone(),
            is_cq,
            directed_cq,
            calling_me,
            station_role,
            seen_ts_sec: dec.slot_ts.0,
            increment_decode_count,
        })
    }

    fn flush_roster_batch(
        &self,
        radio_id: &str,
        is_demo: bool,
        my_call: &str,
        dial_freq_hz: Option<i64>,
        batch: &mut Vec<(Ft8Decode, bool)>,
    ) {
        if batch.is_empty() {
            return;
        }
        let channel_key = channel_key_for_freq("FT8", dial_freq_hz);
        let band = dial_freq_hz
            .and_then(|hz| u64::try_from(hz).ok())
            .and_then(derive_band)
            .map(str::to_string);
        let now_wall_ms = Utc::now().timestamp_millis();

        let mut any_written = false;
        for (dec, increment_decode_count) in batch.drain(..) {
            if let Some(input) = Self::build_roster_input(
                is_demo,
                &channel_key,
                band.as_deref(),
                my_call,
                dial_freq_hz,
                &dec,
                increment_decode_count,
            ) {
                if self
                    .store
                    .upsert_channel_roster_entry(&input, now_wall_ms)
                    .is_ok()
                {
                    any_written = true;
                }
            }
        }

        if any_written {
            if let Ok(entries) = self
                .store
                .list_channel_roster(is_demo, &channel_key, now_wall_ms)
            {
                let _ = self.ws_tx.send(WsBroadcastEvent::RosterUpdate {
                    radio_id: radio_id.to_string(),
                    is_demo,
                    channel_key,
                    band,
                    dial_freq_hz,
                    entries,
                });
            }
        }
    }

    fn record_decodes_to_roster(
        &self,
        radio_id: &str,
        is_demo: bool,
        my_call: &str,
        dial_freq_hz: Option<i64>,
        decodes: &[Ft8Decode],
    ) {
        let mut batch: Vec<(Ft8Decode, bool)> =
            decodes.iter().cloned().map(|d| (d, true)).collect();
        self.flush_roster_batch(radio_id, is_demo, my_call, dial_freq_hz, &mut batch);
    }

    fn emit_decode_event(&self, radio_id: &str, dec: &Ft8Decode) {
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
            decoder_metadata: dec.raw_metadata.clone(),
        });
    }

    fn emit_tx_error(&self, radio_id: &str, detail: String) {
        warn!(radio_id, detail = %detail, "live FT8 TX failed");
        let _ = self.ws_tx.send(WsBroadcastEvent::PreflightAlert {
            severity: "warn".to_string(),
            title: "FT8 TX Failed".to_string(),
            detail,
            occurred_at_utc: now_utc_str(),
        });
    }

    fn broadcast_qso_update(&self, snap: &SessionSnapshot, completed: Option<QsoRecord>) {
        let _ = self.ws_tx.send(WsBroadcastEvent::QsoUpdate {
            radio_id: snap.radio_id.clone(),
            active: snap.active,
            is_demo: snap.is_demo,
            my_call: snap.my_call.clone(),
            my_grid: snap.my_grid.clone(),
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

            let live_freq = self.live_dial_freq_hz(&radio_id, None);
            let (completed_rx, snap_after_rx, my_call, effective_freq) = {
                let mut rt = rt_arc.lock().await;
                if let Some(f) = live_freq {
                    rt.dial_freq_hz = Some(f);
                }
                let freq = rt.dial_freq_hz;
                let mut done_all = Vec::new();
                for dec in &rx_decodes {
                    let mut done = rt.sequencer.on_rx_decode(dec, freq);
                    done_all.append(&mut done);
                }
                let _ = rt.sequencer.maybe_finish_af_survey(next_slot_virtual_ms);
                (
                    done_all,
                    rt.to_snapshot(),
                    rt.sequencer.my_call.clone(),
                    freq,
                )
            };

            self.record_decodes_to_roster(&radio_id, true, &my_call, effective_freq, &rx_decodes);

            for dec in &rx_decodes {
                self.emit_decode_event(&radio_id, dec);
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

                let live_freq = self.live_dial_freq_hz(&radio_id, None);
                let (completed_tx, snap_after_tx) = {
                    let mut rt = rt_arc.lock().await;
                    if let Some(f) = live_freq {
                        rt.dial_freq_hz = Some(f);
                    }
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

        let session_start_ms = epoch_ms;
        let mut next_slot_ms = (epoch_ms.div_euclid(slot_ms) + 1) * slot_ms;
        let first_slot_start_ms = next_slot_ms - slot_ms;
        if session_start_ms > first_slot_start_ms {
            let into_slot_ms = (session_start_ms - first_slot_start_ms).max(0) as usize;
            let lead_samples = (into_slot_ms.saturating_mul(FT8_SAMPLE_RATE as usize)) / 1000;
            let rt = rt_arc.lock().await;
            if let Some(ref c) = rt.capture {
                c.seed_leading_silence(lead_samples);
            }
        }

        let mut last_slot_was_tx = false;
        let mut active_pass3: Option<JoinHandle<()>> = None;

        loop {
            let slot_start_ms = next_slot_ms - slot_ms;
            let finished_slot_ts = UnixSecs(slot_start_ms.div_euclid(1000));
            let real_audio_start_ms = slot_start_ms.max(session_start_ms);

            if !last_slot_was_tx {
                let reconciler =
                    Arc::new(AsyncMutex::new(SlotDecodeReconciler::new(finished_slot_ts)));

                // Pass 1 (~11.8s): fast early decode (-d 1)
                let pass1_at_ms = next_slot_ms - PASS_1_LEAD_MS;
                if !sleep_until_wall_ms_or_cancel(pass1_at_ms, &cancel).await {
                    break;
                }
                if let Some(bg) = active_pass3.take() {
                    let _ = bg.await;
                }
                if self.should_decode_slot(&rt_arc, real_audio_start_ms).await {
                    if let Some(pcm_12k) = self.snapshot_prepared_slot_pcm(&rt_arc).await {
                        self.run_streaming_pass(
                            1,
                            finished_slot_ts,
                            pcm_12k,
                            DecodePassOptions {
                                depth: 1,
                                timeout: Duration::from_millis(1_500),
                                generate_wisdom_if_missing: false,
                                fallback_on_empty_timeout: false,
                            },
                            &radio_id,
                            &rt_arc,
                            &reconciler,
                            &cancel,
                        )
                        .await;
                    }
                }

                // Pass 2 (~13.5s): normal pre-close decode (-d 2)
                let pass2_at_ms = next_slot_ms - PASS_2_LEAD_MS;
                if !sleep_until_wall_ms_or_cancel(pass2_at_ms, &cancel).await {
                    self.flush_slot_telemetry(&radio_id, None, &reconciler)
                        .await;
                    break;
                }
                if self.should_decode_slot(&rt_arc, real_audio_start_ms).await {
                    if let Some(pcm_12k) = self.snapshot_prepared_slot_pcm(&rt_arc).await {
                        self.run_streaming_pass(
                            2,
                            finished_slot_ts,
                            pcm_12k,
                            DecodePassOptions {
                                depth: 2,
                                timeout: Duration::from_millis(1_200),
                                generate_wisdom_if_missing: false,
                                fallback_on_empty_timeout: false,
                            },
                            &radio_id,
                            &rt_arc,
                            &reconciler,
                            &cancel,
                        )
                        .await;
                    }
                }

                // Pass 3 (~14.8s): deep final pass (-d 3), spawned so TX can never be stalled
                let pass3_at_ms = next_slot_ms - PASS_3_LEAD_MS;
                if !sleep_until_wall_ms_or_cancel(pass3_at_ms, &cancel).await {
                    self.flush_slot_telemetry(&radio_id, None, &reconciler)
                        .await;
                    break;
                }
                let mut pass3_handle =
                    if self.should_decode_slot(&rt_arc, real_audio_start_ms).await {
                        self.snapshot_prepared_slot_pcm(&rt_arc)
                            .await
                            .map(|pcm_12k| {
                                let mgr_p3 = Arc::clone(&self);
                                let rt_p3 = Arc::clone(&rt_arc);
                                let rec_p3 = Arc::clone(&reconciler);
                                let rid_p3 = radio_id.clone();
                                let cancel_p3 = cancel.clone();
                                tokio::spawn(async move {
                                    mgr_p3
                                        .run_streaming_pass(
                                            3,
                                            finished_slot_ts,
                                            pcm_12k,
                                            DecodePassOptions {
                                                depth: 3,
                                                timeout: Duration::from_millis(3_500),
                                                generate_wisdom_if_missing: true,
                                                fallback_on_empty_timeout: true,
                                            },
                                            &rid_p3,
                                            &rt_p3,
                                            &rec_p3,
                                            &cancel_p3,
                                        )
                                        .await;
                                    let dial_freq = mgr_p3.live_dial_freq_hz(&rid_p3, None);
                                    mgr_p3
                                        .flush_slot_telemetry(&rid_p3, dial_freq, &rec_p3)
                                        .await;
                                })
                            })
                    } else {
                        None
                    };

                if let Some(ref mut handle) = pass3_handle {
                    let deadline_ms = next_slot_ms + LIVE_DECODE_GRACE_MS;
                    let grace_ms = (deadline_ms - Utc::now().timestamp_millis()).max(1) as u64;
                    tokio::select! {
                        _ = cancel.cancelled() => {
                            let _ = handle.await;
                            break;
                        }
                        _ = &mut *handle => {
                            pass3_handle = None;
                        }
                        _ = sleep(Duration::from_millis(grace_ms)) => {
                            debug!(radio_id = %radio_id, "live FT8 deep pass continuing asynchronously past TX grace window");
                        }
                    }
                    active_pass3 = pass3_handle;
                } else {
                    let dial_freq = self.live_dial_freq_hz(&radio_id, None);
                    self.flush_slot_telemetry(&radio_id, dial_freq, &reconciler)
                        .await;
                }
            }

            if cancel.is_cancelled() {
                break;
            }
            if !sleep_until_wall_ms_or_cancel(next_slot_ms, &cancel).await {
                break;
            }

            let active_slot_ts = UnixSecs(next_slot_ms.div_euclid(1000));
            let active_parity = SlotParity::from_unix_secs(active_slot_ts);
            let live_freq = self.live_dial_freq_hz(&radio_id, None);
            let tx_plan = {
                let now_roll_ms = Utc::now().timestamp_millis();
                let overshoot_ms = (now_roll_ms - next_slot_ms).max(0) as usize;
                let keep_tail_samples =
                    (overshoot_ms.saturating_mul(FT8_SAMPLE_RATE as usize)) / 1000;
                let mut rt = rt_arc.lock().await;
                if let Some(ref c) = rt.capture {
                    c.reset_for_new_slot(keep_tail_samples);
                }
                if let Some(f) = live_freq {
                    rt.dial_freq_hz = Some(f);
                }
                let _ = rt.sequencer.maybe_finish_af_survey(next_slot_ms);
                if rt.tx_state != "transmitting" {
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
                } else {
                    None
                }
            };

            if let Some((intent, Some(audio_dev), gain_db, dial_freq_hz)) = tx_plan {
                last_slot_was_tx = true;
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
            } else {
                last_slot_was_tx = false;
            }

            next_slot_ms += slot_ms;
            let after_ms = Utc::now().timestamp_millis();
            if next_slot_ms <= after_ms {
                next_slot_ms = (after_ms.div_euclid(slot_ms) + 1) * slot_ms;
            }
        }

        if let Some(bg) = active_pass3.take() {
            let _ = bg.await;
        }
    }

    async fn should_decode_slot(
        &self,
        rt_arc: &Arc<AsyncMutex<SessionRuntime>>,
        real_audio_start_ms: i64,
    ) -> bool {
        let now_ms = Utc::now().timestamp_millis();
        if now_ms - real_audio_start_ms < MIN_LIVE_SLOT_REAL_AUDIO_MS {
            return false;
        }
        let rt = rt_arc.lock().await;
        rt.capture
            .as_ref()
            .is_some_and(|c| c.buffered_len() >= MIN_LIVE_SLOT_SAMPLES_12K)
    }

    async fn snapshot_prepared_slot_pcm(
        &self,
        rt_arc: &Arc<AsyncMutex<SessionRuntime>>,
    ) -> Option<Vec<f32>> {
        let raw = {
            let rt = rt_arc.lock().await;
            rt.capture.as_ref().map(|c| c.snapshot_slot_samples())?
        };
        if raw.len() < MIN_LIVE_SLOT_SAMPLES_12K {
            return None;
        }
        Some(prepare_slot_pcm_12k(raw))
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_streaming_pass(
        &self,
        pass_num: u8,
        slot_ts: UnixSecs,
        pcm_12k: Vec<f32>,
        opts: DecodePassOptions,
        radio_id: &str,
        rt_arc: &Arc<AsyncMutex<SessionRuntime>>,
        reconciler: &Arc<AsyncMutex<SlotDecodeReconciler>>,
        cancel: &CancellationToken,
    ) {
        let (dec_tx, mut dec_rx) = mpsc::unbounded_channel::<Ft8Decode>();
        let decoder = Arc::clone(&self.hybrid_decoder);
        let cancel_dec = cancel.clone();
        let rid_err = radio_id.to_string();

        let decode_task = tokio::spawn(async move {
            if let Err(e) = decoder
                .decode_slot_streaming(slot_ts, &pcm_12k, opts, dec_tx, cancel_dec)
                .await
            {
                warn!(radio_id = %rid_err, pass = pass_num, error = %e, "live FT8 decode pass failed");
            }
        });

        let mut roster_batch: Vec<(Ft8Decode, bool)> = Vec::new();
        let mut last_roster_flush = StdInstant::now();
        let mut my_call_cached = String::new();
        let mut dial_freq_cached = None;

        while let Some(dec) = dec_rx.recv().await {
            let outcome = {
                let mut rec = reconciler.lock().await;
                rec.ingest(pass_num, dec)
            };
            if matches!(outcome, ReconcileOutcome::Duplicate) {
                continue;
            }
            let (my_call, dial_freq) = self
                .ingest_live_decode_outcome(radio_id, rt_arc, outcome, &mut roster_batch)
                .await;
            my_call_cached = my_call;
            dial_freq_cached = dial_freq;

            if last_roster_flush.elapsed() >= ROSTER_STREAM_FLUSH_INTERVAL {
                self.flush_roster_batch(
                    radio_id,
                    false,
                    &my_call_cached,
                    dial_freq_cached,
                    &mut roster_batch,
                );
                last_roster_flush = StdInstant::now();
            }
        }

        if !roster_batch.is_empty() {
            if my_call_cached.is_empty() {
                let rt = rt_arc.lock().await;
                my_call_cached = rt.sequencer.my_call.clone();
                dial_freq_cached = rt.dial_freq_hz;
            }
            self.flush_roster_batch(
                radio_id,
                false,
                &my_call_cached,
                dial_freq_cached,
                &mut roster_batch,
            );
        }

        let _ = decode_task.await;
    }

    async fn ingest_live_decode_outcome(
        &self,
        radio_id: &str,
        rt_arc: &Arc<AsyncMutex<SessionRuntime>>,
        outcome: ReconcileOutcome,
        roster_batch: &mut Vec<(Ft8Decode, bool)>,
    ) -> (String, Option<i64>) {
        let live_freq = self.live_dial_freq_hz(radio_id, None);
        match outcome {
            ReconcileOutcome::New(dec) => {
                let (completed, snap, dial_freq, my_call) = {
                    let mut rt = rt_arc.lock().await;
                    if let Some(f) = live_freq {
                        rt.dial_freq_hz = Some(f);
                    }
                    let freq = rt.dial_freq_hz;
                    let done = rt.sequencer.on_rx_decode(&dec, freq);
                    (done, rt.to_snapshot(), freq, rt.sequencer.my_call.clone())
                };
                self.emit_decode_event(radio_id, &dec);
                for rec in &completed {
                    self.persist_completed_qso(radio_id, rec);
                }
                self.update_snapshot_cache(snap.clone());
                self.broadcast_qso_update(&snap, completed.last().cloned());
                roster_batch.push((dec, true));
                (my_call, dial_freq)
            }
            ReconcileOutcome::Refined { previous, updated } => {
                let (qso_changed, snap, dial_freq, my_call) = {
                    let mut rt = rt_arc.lock().await;
                    if let Some(f) = live_freq {
                        rt.dial_freq_hz = Some(f);
                    }
                    let freq = rt.dial_freq_hz;
                    let qso_changed = rt.sequencer.on_rx_decode_refined(&previous, &updated);
                    (
                        qso_changed,
                        rt.to_snapshot(),
                        freq,
                        rt.sequencer.my_call.clone(),
                    )
                };
                self.emit_decode_event(radio_id, &updated);
                self.update_snapshot_cache(snap.clone());
                if qso_changed {
                    self.broadcast_qso_update(&snap, None);
                }
                roster_batch.push((updated, false));
                (my_call, dial_freq)
            }
            ReconcileOutcome::Duplicate => (String::new(), live_freq),
        }
    }

    async fn flush_slot_telemetry(
        &self,
        radio_id: &str,
        dial_freq: Option<i64>,
        reconciler: &Arc<AsyncMutex<SlotDecodeReconciler>>,
    ) {
        let decodes = {
            let mut rec = reconciler.lock().await;
            rec.take_final_for_telemetry()
        };
        if decodes.is_empty() {
            return;
        }
        let station_id = self.store.get_station_config().ok().map(|s| s.station_id);
        let Some(sid) = station_id else {
            return;
        };
        for dec in decodes {
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
                    "decoder_metadata": dec.raw_metadata,
                }),
            );
            let _ = self.store.enqueue_telemetry(&env);
        }
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
                self.emit_tx_error(
                    radio_id,
                    format!(
                        "Failed to modulate FT8 TX waveform '{}': {e}",
                        intent.message
                    ),
                );
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
                self.emit_tx_error(
                    radio_id,
                    format!("Failed to open TX audio playback stream on '{audio_dev}': {e}"),
                );
                return;
            }
            Err(e) => {
                self.emit_tx_error(radio_id, format!("TX playback task error: {e}"));
                return;
            }
        };

        let abort_flag = playback.abort_handle();
        if let Err((_, msg)) = self.supervisor.set_ptt(radio_id, true).await {
            let mut pb = playback;
            pb.stop();
            self.emit_tx_error(radio_id, format!("Failed to assert CAT PTT for TX: {msg}"));
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

async fn sleep_until_wall_ms_or_cancel(target_wall_ms: i64, cancel: &CancellationToken) -> bool {
    let now_ms = Utc::now().timestamp_millis();
    if now_ms < target_wall_ms {
        let wait_ms = (target_wall_ms - now_ms) as u64;
        tokio::select! {
            _ = cancel.cancelled() => return false,
            _ = sleep(Duration::from_millis(wait_ms)) => {}
        }
    }
    !cancel.is_cancelled()
}

fn prepare_slot_pcm_12k(mut raw: Vec<f32>) -> Vec<f32> {
    if raw.len() > FT8_SLOT_SAMPLES_12K {
        let start = raw.len() - FT8_SLOT_SAMPLES_12K;
        raw.drain(..start);
    }
    if raw.len() < FT8_SLOT_SAMPLES_12K {
        raw.resize(FT8_SLOT_SAMPLES_12K, 0.0);
    }
    raw
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
