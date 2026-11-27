pub mod reconciler;
pub mod sequencer;

use std::collections::HashMap;
use std::f32::consts::PI;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
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
use crate::audio::dsp::{WaterfallFrame, DSP_SAMPLE_RATE, FT8_SAMPLE_RATE};
use crate::audio::manager::{AudioCaptureHandle, AudioManager, AudioPlaybackHandle};
use crate::command_bus::{ErrorCode, WsBroadcastEvent};
use crate::domain::adif::QsoRecord;
use crate::domain::bands::derive_band;
use crate::domain::clock::{
    SlotClock, SlotClockSpec, SlotParity, UnixSecs, DEFAULT_SLOT_MS, FT4_SLOT_MS,
};
use crate::domain::ft8::{
    infer_station_role, parse_ft8_message, validate_station_callsign, validate_station_grid,
    Ft8Payload, ParsedFt8Message,
};
use crate::modem::simulator::SimulatedModem;
use crate::modem::{
    DecodePassOptions, DecoderBackendChoice, DecoderOption, Ft8Decode, HybridFt8Decoder, ModemMode,
    QsoDecodeContext, TxIntent,
};
use crate::store::{channel_key_for_freq, now_utc_str, StateStore, UpsertChannelRosterInput};
use crate::supervisor::radio_worker::{CmdResult, RadioLifecycleState};
use crate::supervisor::DeviceSupervisor;
use crate::telemetry::TelemetryEnvelope;
use crate::watchdog::PttWatchdog;

use self::reconciler::{ReconcileOutcome, SlotDecodeReconciler};
use self::sequencer::{
    ActiveQso, CqState, QsoAction, QsoSequencer, QsoStep, RecentDecodeEntry, SequencerMode,
    TranscriptEntry,
};

const MIN_LIVE_SLOT_SAMPLES_12K: usize = 72_000; // >= 6 seconds captured before running FT8 decoder
const MIN_LIVE_SLOT_REAL_AUDIO_MS: i64 = 6_000; // >= 6 seconds real captured audio in FT8 slot
const PASS_1_LEAD_MS: i64 = 3_200; // t = 11.8s (3.2s left): fast early pass (-d 1)
const PASS_2_LEAD_MS: i64 = 1_500; // t = 13.5s (1.5s left): normal pre-close pass (-d 2)
const PASS_3_LEAD_MS: i64 = 200; // t = 14.8s (0.2s left): deep final pass (-d 3)
const FT4_MIN_LIVE_SLOT_SAMPLES_12K: usize = 36_000; // >= 3 seconds captured before FT4 decoder
const FT4_MIN_LIVE_SLOT_REAL_AUDIO_MS: i64 = 3_000; // >= 3 seconds real captured audio in FT4 slot
const FT4_PASS_1_LEAD_MS: i64 = 1_900; // t = 5.6s (1.9s left): fast early pass (-d 1)
const FT4_PASS_2_LEAD_MS: i64 = 500; // t = 7.0s (0.5s left): deep final pass (-d 3)
const LIVE_DECODE_GRACE_MS: i64 = 300; // Wait up to +300ms past slot boundary for final pass before TX
const ROSTER_STREAM_FLUSH_INTERVAL: Duration = Duration::from_millis(150);
pub const MAX_LATE_TX_START_MS: i64 = 6_000; // Late TX initiation / mid-slot hot-swap cutoff (FT8)
const FT4_MAX_LATE_TX_START_MS: i64 = 2_000; // Late TX initiation / mid-slot hot-swap cutoff (FT4)
const FT8_TX_END_OFFSET_MS: i64 = 12_700; // End FT8 TX at slot_start + 12.70 s (60 ms drain past 12.64 s)
const FT4_TX_END_OFFSET_MS: i64 = 5_450; // End FT4 TX at slot_start + 5.45 s (300ms delay + 5.04s active + 110ms drain)

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TxReconcileDecision {
    Noop,
    Start { intent: TxIntent, offset_ms: u64 },
    HotSwap { intent: TxIntent, offset_ms: u64 },
    Abort,
    TooLateWaitNextSlot,
}

/// Pure reconciliation decision for initiating, hot-swapping, or aborting a live TX slot.
pub fn decide_tx_action(
    active: Option<&TxIntent>,
    desired: Option<&TxIntent>,
    into_slot_ms: i64,
    max_late_tx_start_ms: i64,
) -> TxReconcileDecision {
    match (active, desired) {
        (None, None) => TxReconcileDecision::Noop,
        (None, Some(want)) => {
            if into_slot_ms <= max_late_tx_start_ms {
                TxReconcileDecision::Start {
                    intent: want.clone(),
                    offset_ms: into_slot_ms.max(0) as u64,
                }
            } else {
                TxReconcileDecision::TooLateWaitNextSlot
            }
        }
        (Some(_), None) => TxReconcileDecision::Abort,
        (Some(cur), Some(want)) => {
            if cur.message == want.message && cur.slot == want.slot {
                TxReconcileDecision::Noop
            } else if into_slot_ms <= max_late_tx_start_ms {
                TxReconcileDecision::HotSwap {
                    intent: want.clone(),
                    offset_ms: into_slot_ms.max(0) as u64,
                }
            } else {
                TxReconcileDecision::Abort
            }
        }
    }
}

fn default_digital_mode() -> String {
    "FT8".to_string()
}

fn normalize_digital_mode(raw: &str) -> Result<String, String> {
    let up = raw.trim().to_ascii_uppercase();
    match up.as_str() {
        "FT8" => Ok("FT8".to_string()),
        "FT4" => Ok("FT4".to_string()),
        _ => Err(format!(
            "Unsupported digital mode '{raw}' (expected FT8 or FT4)"
        )),
    }
}

fn slot_ms_for_mode(mode: &str) -> i64 {
    if mode.eq_ignore_ascii_case("FT4") {
        FT4_SLOT_MS
    } else {
        DEFAULT_SLOT_MS
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSnapshot {
    pub active: bool,
    pub radio_id: Option<String>,
    pub is_demo: bool,
    pub decoder_backend: Option<String>,
    #[serde(default = "default_digital_mode")]
    pub digital_mode: String,
    pub my_call: Option<String>,
    pub my_grid: Option<String>,
    pub slot_clock: SlotClockSpec,
    pub tx_af_hz: u16,
    pub tx_af_occupied: bool,
    pub tx_enabled: bool,
    pub tx_state: String,
    pub armed_message: Option<String>,
    pub survey_active: bool,
    #[serde(default)]
    pub sequencer_mode: SequencerMode,
    #[serde(default)]
    pub armed_qso_id: Option<String>,
    #[serde(default)]
    pub cq: Option<CqState>,
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
            digital_mode: default_digital_mode(),
            my_call: None,
            my_grid: None,
            slot_clock: SlotClockSpec::realtime(Utc::now().timestamp_millis()),
            tx_af_hz: 1500,
            tx_af_occupied: false,
            tx_enabled: false,
            tx_state: "idle".to_string(),
            armed_message: None,
            survey_active: false,
            sequencer_mode: SequencerMode::AutoSequence,
            armed_qso_id: None,
            cq: None,
            active_qsos: Vec::new(),
            recent_decodes: Vec::new(),
        }
    }
}

struct ActiveTuneHandle {
    cancel: CancellationToken,
    playback: Option<Arc<AudioPlaybackHandle>>,
    task: JoinHandle<()>,
}

struct ActiveTxHandle {
    tx_gen: u64,
    slot_ts: UnixSecs,
    intent: TxIntent,
    confirmed_intent: Arc<AsyncMutex<TxIntent>>,
    tx_cancel: CancellationToken,
    aborted_by_control: Arc<AtomicBool>,
    task: JoinHandle<()>,
}

struct SessionRuntime {
    sequencer: QsoSequencer,
    clock: SlotClock,
    digital_mode: String,
    decoder_backend: String,
    dial_freq_hz: Option<i64>,
    audio_device_name: Option<String>,
    audio_tx_gain_db: f64,
    tx_state: String,
    armed_message: Option<String>,
    capture: Option<AudioCaptureHandle>,
    playback: Option<Arc<AudioPlaybackHandle>>,
    active_tx: Option<ActiveTxHandle>,
    next_tx_gen: u64,
    tx_occurred_in_slot_ts: Option<UnixSecs>,
    wf_task: Option<JoinHandle<()>>,
}

impl SessionRuntime {
    fn did_tx_in_slot(&self, slot_ts: UnixSecs) -> bool {
        self.tx_occurred_in_slot_ts == Some(slot_ts)
            || self
                .active_tx
                .as_ref()
                .is_some_and(|t| t.slot_ts == slot_ts)
    }

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
            digital_mode: self.digital_mode.clone(),
            my_call: Some(self.sequencer.my_call.clone()),
            my_grid: Some(self.sequencer.my_grid.clone()),
            slot_clock: self.clock.spec().clone(),
            tx_af_hz: self.sequencer.tx_af_hz,
            tx_af_occupied: occ.occupied,
            tx_enabled: self.sequencer.tx_enabled,
            tx_state: self.tx_state.clone(),
            armed_message: self.armed_message.clone(),
            survey_active: self.sequencer.survey.is_some(),
            sequencer_mode: self.sequencer.mode,
            armed_qso_id: self.sequencer.armed_qso_id(),
            cq: self.sequencer.cq.clone(),
            active_qsos: self.sequencer.queue.clone(),
            recent_decodes: self.sequencer.recent_decodes.iter().cloned().collect(),
        }
    }
}

#[derive(Clone)]
struct ActiveSessionHandle {
    radio_id: String,
    is_demo: bool,
    actor: String,
    cancel: CancellationToken,
    runtime: Arc<AsyncMutex<SessionRuntime>>,
    tx_reconcile_lock: Arc<AsyncMutex<()>>,
}

struct RunningSession {
    radio_id: String,
    is_demo: bool,
    actor: String,
    cancel: CancellationToken,
    runtime: Arc<AsyncMutex<SessionRuntime>>,
    tx_reconcile_lock: Arc<AsyncMutex<()>>,
    task: JoinHandle<()>,
}

impl RunningSession {
    fn handle(&self) -> ActiveSessionHandle {
        ActiveSessionHandle {
            radio_id: self.radio_id.clone(),
            is_demo: self.is_demo,
            actor: self.actor.clone(),
            cancel: self.cancel.clone(),
            runtime: Arc::clone(&self.runtime),
            tx_reconcile_lock: Arc::clone(&self.tx_reconcile_lock),
        }
    }
}

pub struct SessionManager {
    store: StateStore,
    supervisor: Arc<DeviceSupervisor>,
    watchdog: Arc<PttWatchdog>,
    ws_tx: broadcast::Sender<WsBroadcastEvent>,
    hybrid_decoder: Arc<HybridFt8Decoder>,
    inner: AsyncMutex<Option<RunningSession>>,
    active_tunes: AsyncMutex<HashMap<String, ActiveTuneHandle>>,
    snapshot_cache: RwLock<SessionSnapshot>,
}

impl SessionManager {
    pub fn new(
        store: StateStore,
        supervisor: Arc<DeviceSupervisor>,
        watchdog: Arc<PttWatchdog>,
        ws_tx: broadcast::Sender<WsBroadcastEvent>,
        ftxr_override: Option<&Path>,
        jt9_override: Option<&Path>,
        jt9_data_dir: Option<&Path>,
    ) -> Arc<Self> {
        let ftxr_buf: Option<PathBuf> = ftxr_override.map(Path::to_path_buf);
        let jt9_buf: Option<PathBuf> = jt9_override.map(Path::to_path_buf);
        let hybrid_decoder = Arc::new(HybridFt8Decoder::with_backends(
            ftxr_buf.as_deref(),
            jt9_buf.as_deref(),
            jt9_data_dir.map(Path::to_path_buf),
        ));
        Arc::new(Self {
            store,
            supervisor,
            watchdog,
            ws_tx,
            hybrid_decoder,
            inner: AsyncMutex::new(None),
            active_tunes: AsyncMutex::new(HashMap::new()),
            snapshot_cache: RwLock::new(SessionSnapshot::idle()),
        })
    }

    pub async fn shutdown_decoder(&self) {
        self.hybrid_decoder.shutdown().await;
    }

    pub fn available_decoders(&self) -> Vec<DecoderOption> {
        self.hybrid_decoder.available_decoders()
    }

    pub fn active_decoder_backend(&self) -> &'static str {
        self.hybrid_decoder.active_backend_name()
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
        self.start_session_with_mode(radio_id, actor, demo, scale_opt, None)
            .await
    }

    pub async fn start_session_with_mode(
        self: &Arc<Self>,
        radio_id: &str,
        actor: &str,
        demo: bool,
        scale_opt: Option<f64>,
        mode_opt: Option<&str>,
    ) -> CmdResult {
        self.start_session_with_options(radio_id, actor, demo, scale_opt, mode_opt, None)
            .await
    }

    pub async fn start_session_with_options(
        self: &Arc<Self>,
        radio_id: &str,
        actor: &str,
        demo: bool,
        scale_opt: Option<f64>,
        mode_opt: Option<&str>,
        decoder_opt: Option<&str>,
    ) -> CmdResult {
        let digital_mode = match mode_opt {
            Some(raw) => {
                normalize_digital_mode(raw).map_err(|msg| (ErrorCode::ValidationFailed, msg))?
            }
            None => default_digital_mode(),
        };
        let requested_decoder = match decoder_opt.map(str::trim).filter(|s| !s.is_empty()) {
            Some(raw) => {
                let choice = DecoderBackendChoice::parse(raw).ok_or_else(|| {
                    (
                        ErrorCode::ValidationFailed,
                        format!(
                            "Unsupported decoder backend '{raw}'; expected ftxr, jt9, ft8_lib_fallback, or auto"
                        ),
                    )
                })?;
                if !self.hybrid_decoder.is_choice_available(choice) {
                    return Err((
                        ErrorCode::ValidationFailed,
                        format!("Decoder backend '{raw}' is not available on this host"),
                    ));
                }
                Some(choice)
            }
            None => None,
        };
        let effective_choice =
            requested_decoder.unwrap_or_else(|| self.hybrid_decoder.selected_choice());
        if !demo
            && ModemMode::from_mode_str(&digital_mode) == ModemMode::Ft4
            && !self
                .hybrid_decoder
                .supports_mode_for_choice(effective_choice, ModemMode::Ft4)
        {
            return Err((
                ErrorCode::ValidationFailed,
                "FT4 mode requires the ftxr decoder".to_string(),
            ));
        }

        self.stop_tune(Some(radio_id)).await;

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
        clock_spec.slot_ms = slot_ms_for_mode(&digital_mode);
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
            if let Some(choice) = requested_decoder {
                let _ = self.hybrid_decoder.set_backend(choice);
                let _ = self.ws_tx.send(WsBroadcastEvent::DecoderConfigUpdated {
                    active_decoder: self.hybrid_decoder.active_backend_name().to_string(),
                    available_decoders: self.hybrid_decoder.available_decoders(),
                });
            }
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
            if let Some(choice) = requested_decoder {
                let _ = self.hybrid_decoder.set_backend(choice);
                let _ = self.ws_tx.send(WsBroadcastEvent::DecoderConfigUpdated {
                    active_decoder: self.hybrid_decoder.active_backend_name().to_string(),
                    available_decoders: self.hybrid_decoder.available_decoders(),
                });
            }
            self.supervisor.set_session_active(radio_id, true).await;
            self.hybrid_decoder.warm_up().await;
            self.hybrid_decoder.reset_session().await;
            self.hybrid_decoder.active_backend_name().to_string()
        };

        let seq = QsoSequencer::new(radio_id, demo, &my_call, &my_grid);
        let runtime = Arc::new(AsyncMutex::new(SessionRuntime {
            sequencer: seq,
            clock: clock.clone(),
            digital_mode: digital_mode.clone(),
            decoder_backend: decoder_backend.clone(),
            dial_freq_hz,
            audio_device_name: matched_audio_name,
            audio_tx_gain_db: profile.audio_tx_gain_db,
            tx_state: "idle".to_string(),
            armed_message: None,
            capture: capture_handle,
            playback: None,
            active_tx: None,
            next_tx_gen: 1,
            tx_occurred_in_slot_ts: None,
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
            digital_mode: Some(digital_mode.clone()),
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
        let tx_reconcile_lock = Arc::new(AsyncMutex::new(()));
        let session_handle = ActiveSessionHandle {
            radio_id: radio_id.to_string(),
            is_demo: demo,
            actor: actor.to_string(),
            cancel: cancel.clone(),
            runtime: Arc::clone(&runtime),
            tx_reconcile_lock: Arc::clone(&tx_reconcile_lock),
        };
        let mgr = Arc::clone(self);
        let task = if demo {
            let rt_clone = Arc::clone(&runtime);
            let cancel_clone = cancel.clone();
            tokio::spawn(async move {
                mgr.run_demo_loop(rt_clone, cancel_clone).await;
            })
        } else {
            tokio::spawn(async move {
                mgr.run_live_loop(session_handle).await;
            })
        };

        *guard = Some(RunningSession {
            radio_id: radio_id.to_string(),
            is_demo: demo,
            actor: actor.to_string(),
            cancel,
            runtime,
            tx_reconcile_lock,
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

        let (active_tx, pb_opt) = {
            let mut rt = stopped.runtime.lock().await;
            let active_tx = rt.active_tx.take();
            if let Some(ref active) = active_tx {
                active.aborted_by_control.store(true, Ordering::SeqCst);
                active.tx_cancel.cancel();
            }
            let pb = rt.playback.take();
            if let Some(ref pb) = pb {
                pb.abort();
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
            (active_tx, pb)
        };
        if let Some(pb) = pb_opt {
            pb.stop();
        }
        if let Some(active) = active_tx {
            let _ = active.task.await;
        }

        self.stop_tune(Some(&stopped.radio_id)).await;
        self.watchdog.disarm_tx(&stopped.radio_id).await;
        if !stopped.is_demo {
            let _ = self.supervisor.set_ptt(&stopped.radio_id, false).await;
            self.supervisor
                .set_session_active(&stopped.radio_id, false)
                .await;
            self.hybrid_decoder.reset_session().await;
        }

        let idle = SessionSnapshot::idle();
        self.update_snapshot_cache(idle.clone());
        let _ = self.ws_tx.send(WsBroadcastEvent::SlotClockUpdated {
            radio_id: None,
            active: false,
            is_demo: false,
            decoder_backend: None,
            digital_mode: None,
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
        self.stop_tune(None).await;
        let has_active = self.inner.lock().await.is_some();
        if has_active {
            let _ = self.stop_session(None).await;
        }
    }

    pub async fn emergency_halt(&self, radio_id: Option<&str>) {
        self.stop_tune(radio_id).await;
        let session_opt = {
            let guard = self.inner.lock().await;
            match (&*guard, radio_id) {
                (Some(s), Some(rid)) if s.radio_id == rid => Some(s.handle()),
                (Some(s), None) => Some(s.handle()),
                _ => None,
            }
        };

        if let Some(session) = session_opt {
            let _reconcile_guard = session.tx_reconcile_lock.lock().await;
            {
                let mut rt = session.runtime.lock().await;
                rt.sequencer.set_tx_enabled(false);
                rt.sequencer.cancel_manual_tx();
            }
            self.abort_current_tx_locked(&session).await;
        }
    }

    pub async fn abort_active_tx(&self, radio_id: &str) {
        self.stop_tune(Some(radio_id)).await;
        let session_opt = {
            let guard = self.inner.lock().await;
            guard
                .as_ref()
                .filter(|s| s.radio_id == radio_id)
                .map(RunningSession::handle)
        };
        if let Some(session) = session_opt {
            let _reconcile_guard = session.tx_reconcile_lock.lock().await;
            {
                let mut rt = session.runtime.lock().await;
                rt.sequencer.cancel_manual_tx();
            }
            self.abort_current_tx_locked(&session).await;
        }
    }

    pub async fn set_decoder_backend(&self, raw: &str) -> CmdResult {
        let choice = DecoderBackendChoice::parse(raw).ok_or_else(|| {
            (
                ErrorCode::ValidationFailed,
                format!(
                    "Unsupported decoder backend '{}'; expected ftxr, jt9, ft8_lib_fallback, or auto",
                    raw.trim()
                ),
            )
        })?;

        let active_session = {
            let guard = self.inner.lock().await;
            guard.as_ref().map(RunningSession::handle)
        };

        if let Some(ref session) = active_session {
            let mut rt = session.runtime.lock().await;
            if !rt.sequencer.is_demo
                && ModemMode::from_mode_str(&rt.digital_mode) == ModemMode::Ft4
                && !self
                    .hybrid_decoder
                    .supports_mode_for_choice(choice, ModemMode::Ft4)
            {
                return Err((
                    ErrorCode::ValidationFailed,
                    "Cannot switch away from ftxr while a live FT4 session is active; switch to FT8 first"
                        .to_string(),
                ));
            }
            let resolved = self
                .hybrid_decoder
                .set_backend(choice)
                .map_err(|e| (ErrorCode::ValidationFailed, e.to_string()))?;
            if !rt.sequencer.is_demo {
                rt.decoder_backend = resolved.to_string();
                let snap = rt.to_snapshot();
                let clock_spec = rt.clock.spec().clone();
                let mode = rt.digital_mode.clone();
                drop(rt);
                if resolved == "ftxr" {
                    self.hybrid_decoder.warm_up().await;
                    self.hybrid_decoder.reset_session().await;
                }
                self.update_snapshot_cache(snap.clone());
                let _ = self.ws_tx.send(WsBroadcastEvent::SlotClockUpdated {
                    radio_id: Some(session.radio_id.clone()),
                    active: true,
                    is_demo: false,
                    decoder_backend: Some(resolved.to_string()),
                    digital_mode: Some(mode),
                    slot_clock: clock_spec,
                });
                self.broadcast_qso_update(&snap, None);
            }
        } else {
            self.hybrid_decoder
                .set_backend(choice)
                .map_err(|e| (ErrorCode::ValidationFailed, e.to_string()))?;
        }

        let active_decoder = self.hybrid_decoder.active_backend_name().to_string();
        let available_decoders = self.hybrid_decoder.available_decoders();
        let _ = self.ws_tx.send(WsBroadcastEvent::DecoderConfigUpdated {
            active_decoder: active_decoder.clone(),
            available_decoders: available_decoders.clone(),
        });

        Ok(json!({
            "active_ft8_decoder": active_decoder,
            "available_decoders": available_decoders,
        }))
    }

    pub async fn set_session_mode(&self, radio_id: &str, mode: &str) -> CmdResult {
        let norm =
            normalize_digital_mode(mode).map_err(|msg| (ErrorCode::ValidationFailed, msg))?;
        let new_slot_ms = slot_ms_for_mode(&norm);
        let session = self.get_active_runtime(radio_id).await?;
        let (snap, clock_spec, decoder_backend, is_demo) = {
            let mut rt = session.runtime.lock().await;
            if !rt.sequencer.is_demo
                && ModemMode::from_mode_str(&norm) == ModemMode::Ft4
                && !self.hybrid_decoder.supports_mode(ModemMode::Ft4)
            {
                return Err((
                    ErrorCode::ValidationFailed,
                    "FT4 mode requires the ftxr decoder; select ftxr first".to_string(),
                ));
            }
            let now_ms = Utc::now().timestamp_millis();
            let vnow = rt.clock.virtual_ms_at(now_ms).0;
            let mut next_spec = rt.clock.spec().clone();
            next_spec.epoch_ms = vnow;
            next_spec.anchor_wall_ms = now_ms;
            next_spec.slot_ms = new_slot_ms;
            rt.clock = SlotClock::new(next_spec.clone())
                .map_err(|e| (ErrorCode::ValidationFailed, e.to_string()))?;
            rt.digital_mode = norm.clone();
            (
                rt.to_snapshot(),
                next_spec,
                rt.decoder_backend.clone(),
                rt.sequencer.is_demo,
            )
        };
        if !is_demo {
            self.hybrid_decoder.reset_session().await;
        }
        self.update_snapshot_cache(snap.clone());
        let _ = self.ws_tx.send(WsBroadcastEvent::SlotClockUpdated {
            radio_id: Some(radio_id.to_string()),
            active: true,
            is_demo,
            decoder_backend: Some(decoder_backend),
            digital_mode: Some(norm.clone()),
            slot_clock: clock_spec,
        });
        self.broadcast_qso_update(&snap, None);
        Ok(json!({
            "radio_id": radio_id,
            "mode": norm,
            "slot_ms": new_slot_ms,
        }))
    }

    pub async fn set_tune(
        self: &Arc<Self>,
        radio_id: &str,
        actor: &str,
        enabled: bool,
        af_hz: Option<u16>,
    ) -> CmdResult {
        if !enabled {
            self.stop_tune(Some(radio_id)).await;
            return Ok(json!({
                "radio_id": radio_id,
                "tuning": false,
            }));
        }

        self.stop_tune(Some(radio_id)).await;

        let active_snap = self.snapshot();
        if active_snap.active
            && !active_snap.is_demo
            && active_snap.radio_id.as_deref() == Some(radio_id)
            && active_snap.tx_state == "transmitting"
        {
            return Err((
                ErrorCode::ValidationFailed,
                "Cannot start TUNE while FT8 TX is active".to_string(),
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

        let radio_snap = self.supervisor.get_radio_snapshot(radio_id);
        let rig_ready = radio_snap.as_ref().is_some_and(|s| {
            matches!(
                s.lifecycle_state,
                RadioLifecycleState::Ready | RadioLifecycleState::ActiveSession
            )
        });
        let is_dummy_rig = profile.is_dummy || profile.hamlib_model == 1;
        let is_demo_session = active_snap.active
            && active_snap.is_demo
            && active_snap.radio_id.as_deref() == Some(radio_id);
        let af = af_hz.unwrap_or(1500).clamp(200, 3000);

        let mut playback_opt: Option<Arc<AudioPlaybackHandle>> = None;
        if !is_dummy_rig && !is_demo_session {
            if !rig_ready {
                return Err((
                    ErrorCode::RadioNotReady,
                    format!("Radio '{radio_id}' must be READY to transmit TUNE"),
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
                AudioMatchOutcome::ExactUid(d)
                | AudioMatchOutcome::UsbFallback { device: d, .. }
                | AudioMatchOutcome::NameFallback { device: d, .. } => d,
                AudioMatchOutcome::NotFound => {
                    return Err((
                        ErrorCode::AudioDeviceUnavailable,
                        "Configured USB audio device not found for TUNE".to_string(),
                    ));
                }
            };

            let pcm_48k = generate_tune_sine_48k(af, 10_000);
            let dev_name = matched.name;
            let gain_db = profile.audio_tx_gain_db;
            let wd_fault = Arc::clone(&self.watchdog);
            let rid_fault = radio_id.to_string();
            let pb = tokio::task::spawn_blocking(move || {
                AudioManager::start_playback(
                    &dev_name,
                    pcm_48k,
                    gain_db,
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
            .map_err(|e| (ErrorCode::InternalError, e.to_string()))?
            .map_err(|e| (ErrorCode::AudioDeviceUnavailable, e.to_string()))?;
            let pb = Arc::new(pb);
            let abort_flag = pb.abort_handle();
            if let Err(err) = self.supervisor.set_ptt(radio_id, true).await {
                pb.stop();
                return Err(err);
            }
            self.watchdog
                .arm_tx(radio_id, actor, Some(abort_flag))
                .await;
            playback_opt = Some(pb);
        } else {
            if rig_ready {
                let res = self.supervisor.set_ptt(radio_id, true).await;
                if !is_demo_session {
                    res?;
                }
            } else if !is_demo_session {
                return Err((
                    ErrorCode::RadioNotReady,
                    format!("Radio '{radio_id}' must be READY to transmit TUNE"),
                ));
            }
            self.watchdog.arm_tx(radio_id, actor, None).await;
        }

        let _ = self.ws_tx.send(WsBroadcastEvent::TxState {
            radio_id: radio_id.to_string(),
            state: "transmitting".to_string(),
            af_hz: Some(af),
            slot: None,
            message: Some("TUNE".to_string()),
            ptt_elapsed_ms: 0,
        });

        let cancel = CancellationToken::new();
        let cancel_task = cancel.clone();
        let mgr = Arc::clone(self);
        let rid_task = radio_id.to_string();
        let pb_task = playback_opt.clone();
        let task = tokio::spawn(async move {
            tokio::select! {
                _ = cancel_task.cancelled() => return,
                _ = sleep(Duration::from_secs(10)) => {}
            }
            {
                let mut tunes = mgr.active_tunes.lock().await;
                tunes.remove(&rid_task);
            }
            if let Some(pb) = pb_task {
                pb.stop();
            }
            mgr.watchdog.disarm_tx(&rid_task).await;
            let _ = mgr.supervisor.set_ptt(&rid_task, false).await;
            let snap = mgr.snapshot();
            let idle_af = if snap.active && snap.radio_id.as_deref() == Some(rid_task.as_str()) {
                Some(snap.tx_af_hz)
            } else {
                None
            };
            let _ = mgr.ws_tx.send(WsBroadcastEvent::TxState {
                radio_id: rid_task,
                state: "idle".to_string(),
                af_hz: idle_af,
                slot: None,
                message: None,
                ptt_elapsed_ms: 0,
            });
        });

        {
            let mut tunes = self.active_tunes.lock().await;
            tunes.insert(
                radio_id.to_string(),
                ActiveTuneHandle {
                    cancel,
                    playback: playback_opt,
                    task,
                },
            );
        }

        Ok(json!({
            "radio_id": radio_id,
            "tuning": true,
            "af_hz": af,
        }))
    }

    pub async fn stop_tune(&self, radio_id: Option<&str>) {
        let removed: Vec<(String, ActiveTuneHandle)> = {
            let mut tunes = self.active_tunes.lock().await;
            match radio_id {
                Some(rid) => tunes
                    .remove(rid)
                    .map(|h| vec![(rid.to_string(), h)])
                    .unwrap_or_default(),
                None => tunes.drain().collect(),
            }
        };
        for (rid, handle) in removed {
            handle.cancel.cancel();
            if let Some(pb) = handle.playback {
                pb.stop();
            }
            let _ = handle.task.await;
            self.watchdog.disarm_tx(&rid).await;
            let _ = self.supervisor.set_ptt(&rid, false).await;
            let snap = self.snapshot();
            let idle_af = if snap.active && snap.radio_id.as_deref() == Some(rid.as_str()) {
                Some(snap.tx_af_hz)
            } else {
                None
            };
            let _ = self.ws_tx.send(WsBroadcastEvent::TxState {
                radio_id: rid,
                state: "idle".to_string(),
                af_hz: idle_af,
                slot: None,
                message: None,
                ptt_elapsed_ms: 0,
            });
        }
    }

    async fn get_active_runtime(
        &self,
        radio_id: &str,
    ) -> Result<ActiveSessionHandle, (ErrorCode, String)> {
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
        Ok(s.handle())
    }

    pub async fn arm_tx(self: &Arc<Self>, radio_id: &str, intent: TxIntent) -> CmdResult {
        let session = self.get_active_runtime(radio_id).await?;
        let snap = {
            let mut rt = session.runtime.lock().await;
            rt.sequencer.arm_manual_tx(intent.clone());
            if rt.active_tx.is_none() {
                rt.tx_state = "armed".to_string();
                rt.armed_message = Some(intent.message.clone());
            }
            rt.to_snapshot()
        };
        self.update_snapshot_cache(snap.clone());
        if snap.tx_state != "transmitting" {
            let _ = self.ws_tx.send(WsBroadcastEvent::TxState {
                radio_id: radio_id.to_string(),
                state: "armed".to_string(),
                af_hz: Some(intent.af_hz),
                slot: Some(intent.slot.as_str().to_string()),
                message: Some(intent.message.clone()),
                ptt_elapsed_ms: 0,
            });
        }
        self.broadcast_qso_update(&snap, None);
        self.reconcile_live_tx(&session).await;
        let current = self.snapshot();
        Ok(json!({
            "tx_state": current.tx_state,
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
        self: &Arc<Self>,
        radio_id: &str,
        slot_opt: Option<SlotParity>,
        directed: Option<String>,
    ) -> CmdResult {
        let session = self.get_active_runtime(radio_id).await?;
        let (cq, snap) = {
            let mut rt = session.runtime.lock().await;
            let now_ms = Utc::now().timestamp_millis();
            let slot = slot_opt.unwrap_or_else(|| {
                let current_parity = rt.clock.parity_at(now_ms);
                if !rt.sequencer.is_demo
                    && rt.clock.ms_into_slot_virtual(now_ms) <= MAX_LATE_TX_START_MS
                {
                    current_parity
                } else {
                    current_parity.opposite()
                }
            });
            let cq = rt.sequencer.start_cq(slot, directed);
            (cq, rt.to_snapshot())
        };
        self.update_snapshot_cache(snap.clone());
        self.broadcast_qso_update(&snap, None);
        self.reconcile_live_tx(&session).await;
        Ok(serde_json::to_value(cq).unwrap_or(Value::Null))
    }

    pub async fn stop_cq(self: &Arc<Self>, radio_id: &str) -> CmdResult {
        let session = self.get_active_runtime(radio_id).await?;
        let snap = {
            let mut rt = session.runtime.lock().await;
            rt.sequencer.stop_cq();
            rt.to_snapshot()
        };
        self.update_snapshot_cache(snap.clone());
        self.broadcast_qso_update(&snap, None);
        self.reconcile_live_tx(&session).await;
        Ok(json!({
            "cq": snap.cq,
            "armed_qso_id": snap.armed_qso_id,
        }))
    }

    pub async fn set_sequencer_mode(
        self: &Arc<Self>,
        radio_id: &str,
        mode: SequencerMode,
    ) -> CmdResult {
        let session = self.get_active_runtime(radio_id).await?;
        let snap = {
            let mut rt = session.runtime.lock().await;
            rt.sequencer.set_mode(mode);
            rt.to_snapshot()
        };
        self.update_snapshot_cache(snap.clone());
        self.broadcast_qso_update(&snap, None);
        self.reconcile_live_tx(&session).await;
        Ok(json!({
            "sequencer_mode": snap.sequencer_mode,
            "armed_qso_id": snap.armed_qso_id,
            "cq": snap.cq,
        }))
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn reply_qso(
        self: &Arc<Self>,
        radio_id: &str,
        callsign: &str,
        their_grid: Option<String>,
        rx_slot: SlotParity,
        snr_db: Option<i8>,
        rx_message: Option<String>,
        rx_af_hz: Option<u16>,
        rx_ts_sec: Option<i64>,
    ) -> CmdResult {
        let session = self.get_active_runtime(radio_id).await?;
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
            let mut rt = session.runtime.lock().await;
            let qso = rt
                .sequencer
                .start_reply_with_rx(callsign, their_grid, rx_slot, snr_db, initial_rx);
            (qso, rt.to_snapshot())
        };
        self.update_snapshot_cache(snap.clone());
        self.broadcast_qso_update(&snap, None);
        self.reconcile_live_tx(&session).await;
        Ok(serde_json::to_value(qso).unwrap_or(Value::Null))
    }

    pub async fn qso_action(
        self: &Arc<Self>,
        radio_id: &str,
        qso_id: &str,
        action: QsoAction,
    ) -> CmdResult {
        let session = self.get_active_runtime(radio_id).await?;
        let live_freq = self.live_dial_freq_hz(radio_id, None);
        let (completed, snap) = {
            let mut rt = session.runtime.lock().await;
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
        self.reconcile_live_tx(&session).await;
        Ok(json!({
            "active_qsos": snap.active_qsos,
            "completed_qso": completed,
        }))
    }

    pub async fn survey_af(&self, radio_id: &str) -> CmdResult {
        let session = self.get_active_runtime(radio_id).await?;
        let snap = {
            let mut rt = session.runtime.lock().await;
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
        let session = self.get_active_runtime(radio_id).await?;
        let snap = {
            let mut rt = session.runtime.lock().await;
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

    pub async fn set_tx_enabled(self: &Arc<Self>, radio_id: &str, enabled: bool) -> CmdResult {
        let session = self.get_active_runtime(radio_id).await?;
        if !enabled {
            let _reconcile_guard = session.tx_reconcile_lock.lock().await;
            {
                let mut rt = session.runtime.lock().await;
                rt.sequencer.set_tx_enabled(false);
            }
            self.abort_current_tx_locked(&session).await;
            let snap = self.snapshot();
            return Ok(json!({ "tx_enabled": snap.tx_enabled }));
        }

        let snap = {
            let mut rt = session.runtime.lock().await;
            rt.sequencer.set_tx_enabled(true);
            rt.to_snapshot()
        };
        self.update_snapshot_cache(snap.clone());
        self.broadcast_qso_update(&snap, None);
        self.reconcile_live_tx(&session).await;
        Ok(json!({ "tx_enabled": true }))
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

    #[allow(clippy::too_many_arguments)]
    fn build_roster_input(
        is_demo: bool,
        mode: &str,
        channel_key: &str,
        band: Option<&str>,
        my_call: &str,
        dial_freq_hz: Option<i64>,
        dec: &Ft8Decode,
        increment_decode_count: bool,
        slot_override: Option<SlotParity>,
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
        let slot_str = slot_override
            .unwrap_or_else(|| SlotParity::from_unix_secs(dec.slot_ts))
            .as_str()
            .to_string();
        Some(UpsertChannelRosterInput {
            is_demo,
            channel_key: channel_key.to_string(),
            callsign,
            mode: mode.to_string(),
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

    #[allow(clippy::too_many_arguments)]
    fn flush_roster_batch(
        &self,
        radio_id: &str,
        is_demo: bool,
        mode: &str,
        my_call: &str,
        dial_freq_hz: Option<i64>,
        batch: &mut Vec<(Ft8Decode, bool)>,
        slot_override: Option<SlotParity>,
    ) {
        if batch.is_empty() {
            return;
        }
        let channel_key = channel_key_for_freq(mode, dial_freq_hz);
        let band = dial_freq_hz
            .and_then(|hz| u64::try_from(hz).ok())
            .and_then(derive_band)
            .map(str::to_string);
        let now_wall_ms = Utc::now().timestamp_millis();

        let mut any_written = false;
        for (dec, increment_decode_count) in batch.drain(..) {
            if let Some(input) = Self::build_roster_input(
                is_demo,
                mode,
                &channel_key,
                band.as_deref(),
                my_call,
                dial_freq_hz,
                &dec,
                increment_decode_count,
                slot_override,
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

    #[allow(clippy::too_many_arguments)]
    fn record_decodes_to_roster(
        &self,
        radio_id: &str,
        is_demo: bool,
        mode: &str,
        my_call: &str,
        dial_freq_hz: Option<i64>,
        decodes: &[Ft8Decode],
        slot_override: Option<SlotParity>,
    ) {
        let mut batch: Vec<(Ft8Decode, bool)> =
            decodes.iter().cloned().map(|d| (d, true)).collect();
        self.flush_roster_batch(
            radio_id,
            is_demo,
            mode,
            my_call,
            dial_freq_hz,
            &mut batch,
            slot_override,
        );
    }

    fn emit_decode_event(
        &self,
        radio_id: &str,
        dec: &Ft8Decode,
        mode: &str,
        slot_override: Option<SlotParity>,
    ) {
        let slot_str = slot_override
            .unwrap_or_else(|| SlotParity::from_unix_secs(dec.slot_ts))
            .as_str()
            .to_string();
        let _ = self.ws_tx.send(WsBroadcastEvent::Decode {
            radio_id: radio_id.to_string(),
            ts_sec: dec.slot_ts.0,
            slot: slot_str,
            snr_db: dec.snr_db,
            dt_sec: dec.dt_sec,
            af_hz: dec.af_hz,
            mode: mode.to_string(),
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
            digital_mode: Some(snap.digital_mode.clone()),
            my_call: snap.my_call.clone(),
            my_grid: snap.my_grid.clone(),
            tx_enabled: snap.tx_enabled,
            tx_af_hz: snap.tx_af_hz,
            tx_af_occupied: snap.tx_af_occupied,
            survey_active: snap.survey_active,
            sequencer_mode: snap.sequencer_mode,
            armed_qso_id: snap.armed_qso_id.clone(),
            cq: snap.cq.clone(),
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
        let (mut cur_slot_ms, mut cur_mode, mut epoch_ms, mut anchor_wall_ms, scale, radio_id) = {
            let rt = rt_arc.lock().await;
            let spec = rt.clock.spec();
            (
                spec.slot_ms,
                rt.digital_mode.clone(),
                spec.epoch_ms,
                spec.anchor_wall_ms,
                spec.scale,
                rt.sequencer.radio_id.clone(),
            )
        };

        let mut next_slot_virtual_ms = (epoch_ms.div_euclid(cur_slot_ms) + 1) * cur_slot_ms;
        loop {
            if cancel.is_cancelled() {
                break;
            }

            let mut next_wf_at = TokioInstant::now();

            loop {
                let (latest_slot_ms, latest_mode, latest_epoch, latest_anchor) = {
                    let rt = rt_arc.lock().await;
                    let spec = rt.clock.spec();
                    (
                        spec.slot_ms,
                        rt.digital_mode.clone(),
                        spec.epoch_ms,
                        spec.anchor_wall_ms,
                    )
                };
                if latest_slot_ms != cur_slot_ms || latest_mode != cur_mode {
                    cur_slot_ms = latest_slot_ms;
                    cur_mode = latest_mode;
                    epoch_ms = latest_epoch;
                    anchor_wall_ms = latest_anchor;
                    next_slot_virtual_ms = (epoch_ms.div_euclid(cur_slot_ms) + 1) * cur_slot_ms;
                }

                let target_wall_ms = anchor_wall_ms
                    + (((next_slot_virtual_ms - epoch_ms) as f64) / scale).ceil() as i64;
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
                    let cur_ts = UnixSecs((next_slot_virtual_ms - cur_slot_ms).div_euclid(1000));
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
            let display_parity = SlotParity::from_virtual_ms(next_slot_virtual_ms, cur_slot_ms);
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

            self.record_decodes_to_roster(
                &radio_id,
                true,
                &cur_mode,
                &my_call,
                effective_freq,
                &rx_decodes,
                Some(display_parity),
            );

            for dec in &rx_decodes {
                self.emit_decode_event(&radio_id, dec, &cur_mode, Some(display_parity));
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

            next_slot_virtual_ms += cur_slot_ms;
        }
    }

    async fn run_live_loop(self: Arc<Self>, session: ActiveSessionHandle) {
        let rt_arc = Arc::clone(&session.runtime);
        let cancel = session.cancel.clone();
        let radio_id = session.radio_id.clone();
        let (mut slot_ms, epoch_ms, mut cur_mode, mut last_dial_freq_hz) = {
            let rt = rt_arc.lock().await;
            let spec = rt.clock.spec();
            (
                spec.slot_ms,
                spec.epoch_ms,
                ModemMode::from_mode_str(&rt.digital_mode),
                rt.dial_freq_hz,
            )
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

        let mut active_final_pass: Option<JoinHandle<()>> = None;

        loop {
            let (latest_slot_ms, latest_mode) = {
                let rt = rt_arc.lock().await;
                (
                    rt.clock.spec().slot_ms,
                    ModemMode::from_mode_str(&rt.digital_mode),
                )
            };
            if latest_slot_ms != slot_ms || latest_mode != cur_mode {
                slot_ms = latest_slot_ms;
                cur_mode = latest_mode;
                let now_ms = Utc::now().timestamp_millis();
                next_slot_ms = (now_ms.div_euclid(slot_ms) + 1) * slot_ms;
            }

            if let Some(live_freq) = self.live_dial_freq_hz(&radio_id, None) {
                if last_dial_freq_hz.is_some() && last_dial_freq_hz != Some(live_freq) {
                    self.hybrid_decoder.reset_session().await;
                }
                last_dial_freq_hz = Some(live_freq);
            }

            let slot_start_ms = next_slot_ms - slot_ms;
            let finished_slot_ts = UnixSecs(slot_start_ms.div_euclid(1000));
            let real_audio_start_ms = slot_start_ms.max(session_start_ms);

            let slot_had_tx = {
                let rt = rt_arc.lock().await;
                rt.did_tx_in_slot(finished_slot_ts)
            };

            if !slot_had_tx {
                let reconciler =
                    Arc::new(AsyncMutex::new(SlotDecodeReconciler::new(finished_slot_ts)));

                match cur_mode {
                    ModemMode::Ft8 => {
                        // Pass 1 (~11.8s): fast early decode (-d 1)
                        let pass1_at_ms = next_slot_ms - PASS_1_LEAD_MS;
                        if !sleep_until_wall_ms_or_cancel(pass1_at_ms, &cancel).await {
                            break;
                        }
                        if let Some(bg) = active_final_pass.take() {
                            let _ = bg.await;
                        }
                        if self
                            .should_decode_slot(
                                &rt_arc,
                                cur_mode,
                                finished_slot_ts,
                                real_audio_start_ms,
                            )
                            .await
                        {
                            if let Some(pcm_12k) =
                                self.snapshot_prepared_slot_pcm(&rt_arc, cur_mode).await
                            {
                                let qso_context =
                                    Some(self.build_qso_decode_context(&rt_arc).await);
                                self.run_streaming_pass(
                                    1,
                                    finished_slot_ts,
                                    pcm_12k,
                                    DecodePassOptions {
                                        mode: cur_mode,
                                        depth: 1,
                                        timeout: Duration::from_millis(1_500),
                                        early_pass: true,
                                        qso_context,
                                        generate_wisdom_if_missing: false,
                                        fallback_on_empty_timeout: false,
                                    },
                                    &session,
                                    &reconciler,
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
                        if self
                            .should_decode_slot(
                                &rt_arc,
                                cur_mode,
                                finished_slot_ts,
                                real_audio_start_ms,
                            )
                            .await
                        {
                            if let Some(pcm_12k) =
                                self.snapshot_prepared_slot_pcm(&rt_arc, cur_mode).await
                            {
                                let qso_context =
                                    Some(self.build_qso_decode_context(&rt_arc).await);
                                self.run_streaming_pass(
                                    2,
                                    finished_slot_ts,
                                    pcm_12k,
                                    DecodePassOptions {
                                        mode: cur_mode,
                                        depth: 2,
                                        timeout: Duration::from_millis(1_200),
                                        early_pass: true,
                                        qso_context,
                                        generate_wisdom_if_missing: false,
                                        fallback_on_empty_timeout: false,
                                    },
                                    &session,
                                    &reconciler,
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
                        let mut pass3_handle = if self
                            .should_decode_slot(
                                &rt_arc,
                                cur_mode,
                                finished_slot_ts,
                                real_audio_start_ms,
                            )
                            .await
                        {
                            let qso_context = Some(self.build_qso_decode_context(&rt_arc).await);
                            self.snapshot_prepared_slot_pcm(&rt_arc, cur_mode)
                                .await
                                .map(|pcm_12k| {
                                    let mgr_p3 = Arc::clone(&self);
                                    let sess_p3 = session.clone();
                                    let rec_p3 = Arc::clone(&reconciler);
                                    let rid_p3 = radio_id.clone();
                                    tokio::spawn(async move {
                                        mgr_p3
                                            .run_streaming_pass(
                                                3,
                                                finished_slot_ts,
                                                pcm_12k,
                                                DecodePassOptions {
                                                    mode: cur_mode,
                                                    depth: 3,
                                                    timeout: Duration::from_millis(3_500),
                                                    early_pass: false,
                                                    qso_context,
                                                    generate_wisdom_if_missing: true,
                                                    fallback_on_empty_timeout: true,
                                                },
                                                &sess_p3,
                                                &rec_p3,
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
                            let grace_ms =
                                (deadline_ms - Utc::now().timestamp_millis()).max(1) as u64;
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
                            active_final_pass = pass3_handle;
                        } else {
                            let dial_freq = self.live_dial_freq_hz(&radio_id, None);
                            self.flush_slot_telemetry(&radio_id, dial_freq, &reconciler)
                                .await;
                        }
                    }
                    ModemMode::Ft4 => {
                        // FT4 Pass 1 (~5.6s): fast early decode (-d 1)
                        let pass1_at_ms = next_slot_ms - FT4_PASS_1_LEAD_MS;
                        if !sleep_until_wall_ms_or_cancel(pass1_at_ms, &cancel).await {
                            break;
                        }
                        if let Some(bg) = active_final_pass.take() {
                            let _ = bg.await;
                        }
                        if self
                            .should_decode_slot(
                                &rt_arc,
                                cur_mode,
                                finished_slot_ts,
                                real_audio_start_ms,
                            )
                            .await
                        {
                            if let Some(pcm_12k) =
                                self.snapshot_prepared_slot_pcm(&rt_arc, cur_mode).await
                            {
                                let qso_context =
                                    Some(self.build_qso_decode_context(&rt_arc).await);
                                self.run_streaming_pass(
                                    1,
                                    finished_slot_ts,
                                    pcm_12k,
                                    DecodePassOptions {
                                        mode: cur_mode,
                                        depth: 1,
                                        timeout: Duration::from_millis(900),
                                        early_pass: true,
                                        qso_context,
                                        generate_wisdom_if_missing: false,
                                        fallback_on_empty_timeout: false,
                                    },
                                    &session,
                                    &reconciler,
                                )
                                .await;
                            }
                        }

                        // FT4 Pass 2 (~7.0s): deep final pass (-d 3)
                        let pass2_at_ms = next_slot_ms - FT4_PASS_2_LEAD_MS;
                        if !sleep_until_wall_ms_or_cancel(pass2_at_ms, &cancel).await {
                            self.flush_slot_telemetry(&radio_id, None, &reconciler)
                                .await;
                            break;
                        }
                        let mut pass2_handle = if self
                            .should_decode_slot(
                                &rt_arc,
                                cur_mode,
                                finished_slot_ts,
                                real_audio_start_ms,
                            )
                            .await
                        {
                            let qso_context = Some(self.build_qso_decode_context(&rt_arc).await);
                            self.snapshot_prepared_slot_pcm(&rt_arc, cur_mode)
                                .await
                                .map(|pcm_12k| {
                                    let mgr_p2 = Arc::clone(&self);
                                    let sess_p2 = session.clone();
                                    let rec_p2 = Arc::clone(&reconciler);
                                    let rid_p2 = radio_id.clone();
                                    tokio::spawn(async move {
                                        mgr_p2
                                            .run_streaming_pass(
                                                2,
                                                finished_slot_ts,
                                                pcm_12k,
                                                DecodePassOptions {
                                                    mode: cur_mode,
                                                    depth: 3,
                                                    timeout: Duration::from_millis(1_800),
                                                    early_pass: false,
                                                    qso_context,
                                                    generate_wisdom_if_missing: false,
                                                    fallback_on_empty_timeout: false,
                                                },
                                                &sess_p2,
                                                &rec_p2,
                                            )
                                            .await;
                                        let dial_freq = mgr_p2.live_dial_freq_hz(&rid_p2, None);
                                        mgr_p2
                                            .flush_slot_telemetry(&rid_p2, dial_freq, &rec_p2)
                                            .await;
                                    })
                                })
                        } else {
                            None
                        };

                        if let Some(ref mut handle) = pass2_handle {
                            let deadline_ms = next_slot_ms + LIVE_DECODE_GRACE_MS;
                            let grace_ms =
                                (deadline_ms - Utc::now().timestamp_millis()).max(1) as u64;
                            tokio::select! {
                                _ = cancel.cancelled() => {
                                    let _ = handle.await;
                                    break;
                                }
                                _ = &mut *handle => {
                                    pass2_handle = None;
                                }
                                _ = sleep(Duration::from_millis(grace_ms)) => {
                                    debug!(radio_id = %radio_id, "live FT4 deep pass continuing asynchronously past TX grace window");
                                }
                            }
                            active_final_pass = pass2_handle;
                        } else {
                            let dial_freq = self.live_dial_freq_hz(&radio_id, None);
                            self.flush_slot_telemetry(&radio_id, dial_freq, &reconciler)
                                .await;
                        }
                    }
                }
            }

            if cancel.is_cancelled() {
                break;
            }
            if !sleep_until_wall_ms_or_cancel(next_slot_ms, &cancel).await {
                break;
            }

            {
                let now_roll_ms = Utc::now().timestamp_millis();
                let overshoot_ms = (now_roll_ms - next_slot_ms).max(0) as usize;
                let keep_tail_samples =
                    (overshoot_ms.saturating_mul(FT8_SAMPLE_RATE as usize)) / 1000;
                let mut rt = rt_arc.lock().await;
                if let Some(ref c) = rt.capture {
                    c.reset_for_new_slot(keep_tail_samples);
                }
                let _ = rt.sequencer.maybe_finish_af_survey(next_slot_ms);
            }

            self.reconcile_live_tx(&session).await;

            next_slot_ms += slot_ms;
            let after_ms = Utc::now().timestamp_millis();
            if next_slot_ms <= after_ms {
                next_slot_ms = (after_ms.div_euclid(slot_ms) + 1) * slot_ms;
            }
        }

        if let Some(bg) = active_final_pass.take() {
            let _ = bg.await;
        }
    }

    async fn build_qso_decode_context(
        &self,
        rt_arc: &Arc<AsyncMutex<SessionRuntime>>,
    ) -> QsoDecodeContext {
        let rt = rt_arc.lock().await;
        let my_call =
            (!rt.sequencer.my_call.trim().is_empty()).then(|| rt.sequencer.my_call.clone());
        let tx_freq_hz = Some(f32::from(rt.sequencer.tx_af_hz));

        let armed_id = rt.sequencer.armed_qso_id();
        let target_qso = armed_id
            .as_deref()
            .and_then(|id| rt.sequencer.queue.iter().find(|q| q.qso_id == id))
            .or_else(|| rt.sequencer.queue.first());

        if let Some(qso) = target_qso {
            let rx_freq_hz = qso
                .transcript
                .iter()
                .rev()
                .find(|t| t.direction == "rx")
                .map(|t| f32::from(t.af_hz))
                .or(tx_freq_hz);
            let qso_progress = match qso.step {
                QsoStep::CallingCq => 0,
                QsoStep::SendGrid => 1,
                QsoStep::SendReport => 2,
                QsoStep::SendRReport => 3,
                QsoStep::SendRr73 => 4,
                QsoStep::Send73 => 5,
            };
            QsoDecodeContext {
                my_call,
                dx_call: (!qso.their_call.trim().is_empty()).then(|| qso.their_call.clone()),
                dx_grid: qso.their_grid.clone(),
                rx_freq_hz,
                tx_freq_hz,
                qso_progress: Some(qso_progress),
                enable_ap: true,
            }
        } else {
            QsoDecodeContext {
                my_call,
                dx_call: None,
                dx_grid: None,
                rx_freq_hz: tx_freq_hz,
                tx_freq_hz,
                qso_progress: Some(0),
                enable_ap: true,
            }
        }
    }

    async fn should_decode_slot(
        &self,
        rt_arc: &Arc<AsyncMutex<SessionRuntime>>,
        mode: ModemMode,
        slot_ts: UnixSecs,
        real_audio_start_ms: i64,
    ) -> bool {
        let (min_real_ms, min_samples) = match mode {
            ModemMode::Ft8 => (MIN_LIVE_SLOT_REAL_AUDIO_MS, MIN_LIVE_SLOT_SAMPLES_12K),
            ModemMode::Ft4 => (
                FT4_MIN_LIVE_SLOT_REAL_AUDIO_MS,
                FT4_MIN_LIVE_SLOT_SAMPLES_12K,
            ),
        };
        let now_ms = Utc::now().timestamp_millis();
        if now_ms - real_audio_start_ms < min_real_ms {
            return false;
        }
        let rt = rt_arc.lock().await;
        if rt.did_tx_in_slot(slot_ts) {
            return false;
        }
        rt.capture
            .as_ref()
            .is_some_and(|c| c.buffered_len() >= min_samples)
    }

    async fn snapshot_prepared_slot_pcm(
        &self,
        rt_arc: &Arc<AsyncMutex<SessionRuntime>>,
        mode: ModemMode,
    ) -> Option<Vec<f32>> {
        let min_samples = match mode {
            ModemMode::Ft8 => MIN_LIVE_SLOT_SAMPLES_12K,
            ModemMode::Ft4 => FT4_MIN_LIVE_SLOT_SAMPLES_12K,
        };
        let raw = {
            let rt = rt_arc.lock().await;
            rt.capture.as_ref().map(|c| c.snapshot_slot_samples())?
        };
        if raw.len() < min_samples {
            return None;
        }
        Some(prepare_slot_pcm_12k(raw, mode.slot_samples_12k()))
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_streaming_pass(
        self: &Arc<Self>,
        pass_num: u8,
        slot_ts: UnixSecs,
        pcm_12k: Vec<f32>,
        opts: DecodePassOptions,
        session: &ActiveSessionHandle,
        reconciler: &Arc<AsyncMutex<SlotDecodeReconciler>>,
    ) {
        let (dec_tx, mut dec_rx) = mpsc::unbounded_channel::<Ft8Decode>();
        let decoder = Arc::clone(&self.hybrid_decoder);
        let cancel_dec = session.cancel.clone();
        let rid_err = session.radio_id.clone();

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
        let mut mode_cached = String::from("FT8");
        let mut dial_freq_cached = None;

        while let Some(dec) = dec_rx.recv().await {
            let outcome = {
                let mut rec = reconciler.lock().await;
                rec.ingest(pass_num, dec)
            };
            if matches!(outcome, ReconcileOutcome::Duplicate) {
                continue;
            }
            let (my_call, mode_name, dial_freq) = self
                .ingest_live_decode_outcome(session, outcome, &mut roster_batch)
                .await;
            my_call_cached = my_call;
            if !mode_name.is_empty() {
                mode_cached = mode_name;
            }
            dial_freq_cached = dial_freq;

            if last_roster_flush.elapsed() >= ROSTER_STREAM_FLUSH_INTERVAL {
                self.flush_roster_batch(
                    &session.radio_id,
                    false,
                    &mode_cached,
                    &my_call_cached,
                    dial_freq_cached,
                    &mut roster_batch,
                    None,
                );
                last_roster_flush = StdInstant::now();
            }
        }

        if !roster_batch.is_empty() {
            if my_call_cached.is_empty() {
                let rt = session.runtime.lock().await;
                my_call_cached = rt.sequencer.my_call.clone();
                mode_cached = rt.digital_mode.clone();
                dial_freq_cached = rt.dial_freq_hz;
            }
            self.flush_roster_batch(
                &session.radio_id,
                false,
                &mode_cached,
                &my_call_cached,
                dial_freq_cached,
                &mut roster_batch,
                None,
            );
        }

        let _ = decode_task.await;
    }

    async fn ingest_live_decode_outcome(
        self: &Arc<Self>,
        session: &ActiveSessionHandle,
        outcome: ReconcileOutcome,
        roster_batch: &mut Vec<(Ft8Decode, bool)>,
    ) -> (String, String, Option<i64>) {
        let radio_id = &session.radio_id;
        let rt_arc = &session.runtime;
        let live_freq = self.live_dial_freq_hz(radio_id, None);
        match outcome {
            ReconcileOutcome::New(dec) => {
                let (completed, snap, dial_freq, my_call, mode_name) = {
                    let mut rt = rt_arc.lock().await;
                    if let Some(f) = live_freq {
                        rt.dial_freq_hz = Some(f);
                    }
                    let freq = rt.dial_freq_hz;
                    let done = rt.sequencer.on_rx_decode(&dec, freq);
                    (
                        done,
                        rt.to_snapshot(),
                        freq,
                        rt.sequencer.my_call.clone(),
                        rt.digital_mode.clone(),
                    )
                };
                self.emit_decode_event(radio_id, &dec, &mode_name, None);
                for rec in &completed {
                    self.persist_completed_qso(radio_id, rec);
                }
                self.update_snapshot_cache(snap.clone());
                self.broadcast_qso_update(&snap, completed.last().cloned());
                roster_batch.push((dec, true));
                self.reconcile_live_tx(session).await;
                (my_call, mode_name, dial_freq)
            }
            ReconcileOutcome::Refined { previous, updated } => {
                let (qso_changed, snap, dial_freq, my_call, mode_name) = {
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
                        rt.digital_mode.clone(),
                    )
                };
                self.emit_decode_event(radio_id, &updated, &mode_name, None);
                self.update_snapshot_cache(snap.clone());
                if qso_changed {
                    self.broadcast_qso_update(&snap, None);
                }
                roster_batch.push((updated, false));
                (my_call, mode_name, dial_freq)
            }
            ReconcileOutcome::Duplicate => (String::new(), String::new(), live_freq),
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

    async fn abort_current_tx_locked(&self, session: &ActiveSessionHandle) {
        let (active_opt, pb_opt, snap) = {
            let mut rt = session.runtime.lock().await;
            let active = rt.active_tx.take();
            if let Some(ref a) = active {
                a.aborted_by_control.store(true, Ordering::SeqCst);
                a.tx_cancel.cancel();
            }
            let pb = rt.playback.take();
            if let Some(ref p) = pb {
                p.abort();
            }
            let had_tx = active.is_some() || pb.is_some() || rt.tx_state == "transmitting";
            rt.tx_state = "idle".to_string();
            rt.armed_message = None;
            let snap = rt.to_snapshot();
            if !had_tx {
                return;
            }
            (active, pb, snap)
        };

        if let Some(pb) = pb_opt {
            pb.stop();
        }
        self.watchdog.disarm_tx(&session.radio_id).await;
        if !session.is_demo {
            let _ = self.supervisor.set_ptt(&session.radio_id, false).await;
        }
        if let Some(active) = active_opt {
            let _ = active.task.await;
        }

        self.update_snapshot_cache(snap.clone());
        let _ = self.ws_tx.send(WsBroadcastEvent::TxState {
            radio_id: session.radio_id.clone(),
            state: "idle".to_string(),
            af_hz: Some(snap.tx_af_hz),
            slot: None,
            message: None,
            ptt_elapsed_ms: 0,
        });
        self.broadcast_qso_update(&snap, None);
    }

    /// Reconcile desired TX state against current slot time: start immediately (offset-truncated
    /// when `<= 6.0s` into the slot), hot-swap audio in place if an active QSO advances mid-TX, or
    /// abort immediately if stale/cancelled. Never called while holding `session.runtime`.
    async fn reconcile_live_tx(self: &Arc<Self>, session: &ActiveSessionHandle) {
        if session.is_demo || session.cancel.is_cancelled() {
            return;
        }
        let _reconcile_guard = session.tx_reconcile_lock.lock().await;
        if session.cancel.is_cancelled() {
            return;
        }

        let (slot_ms, mode) = {
            let rt = session.runtime.lock().await;
            (
                rt.clock.spec().slot_ms,
                ModemMode::from_mode_str(&rt.digital_mode),
            )
        };
        let max_late_tx_start_ms = match mode {
            ModemMode::Ft8 => MAX_LATE_TX_START_MS,
            ModemMode::Ft4 => FT4_MAX_LATE_TX_START_MS,
        };
        let tx_end_offset_ms = match mode {
            ModemMode::Ft8 => FT8_TX_END_OFFSET_MS,
            ModemMode::Ft4 => FT4_TX_END_OFFSET_MS,
        };
        let now_ms = Utc::now().timestamp_millis();
        let slot_start_ms = now_ms.div_euclid(slot_ms) * slot_ms;
        let slot_ts = UnixSecs(slot_start_ms.div_euclid(1000));
        let slot_parity = SlotParity::from_virtual_ms(slot_start_ms, slot_ms);
        let into_slot_ms = (now_ms - slot_start_ms).max(0);
        let live_freq = self.live_dial_freq_hz(&session.radio_id, None);

        enum Plan {
            Noop,
            Abort,
            Start {
                intent: TxIntent,
                audio_dev: String,
                gain_db: f64,
                dial_freq_hz: Option<i64>,
            },
            HotSwap {
                intent: TxIntent,
                playback: Arc<AudioPlaybackHandle>,
                expected_gen: u64,
            },
        }

        let plan = {
            let mut rt = session.runtime.lock().await;
            if let Some(f) = live_freq {
                rt.dial_freq_hz = Some(f);
            }
            let active_intent = rt
                .active_tx
                .as_ref()
                .filter(|a| a.slot_ts == slot_ts)
                .map(|a| a.intent.clone());
            let desired_intent = rt.sequencer.compose_tx_for_slot(slot_parity, now_ms);
            let decision = decide_tx_action(
                active_intent.as_ref(),
                desired_intent.as_ref(),
                into_slot_ms,
                max_late_tx_start_ms,
            );
            match decision {
                TxReconcileDecision::Noop | TxReconcileDecision::TooLateWaitNextSlot => Plan::Noop,
                TxReconcileDecision::Abort => Plan::Abort,
                TxReconcileDecision::Start { intent, .. } => {
                    if let Some(audio_dev) = rt.audio_device_name.clone() {
                        Plan::Start {
                            intent,
                            audio_dev,
                            gain_db: rt.audio_tx_gain_db,
                            dial_freq_hz: rt.dial_freq_hz,
                        }
                    } else {
                        Plan::Noop
                    }
                }
                TxReconcileDecision::HotSwap { intent, .. } => {
                    match (rt.playback.clone(), rt.active_tx.as_ref().map(|a| a.tx_gen)) {
                        (Some(playback), Some(expected_gen)) => Plan::HotSwap {
                            intent,
                            playback,
                            expected_gen,
                        },
                        _ => Plan::Abort,
                    }
                }
            }
        };

        match plan {
            Plan::Noop => {}
            Plan::Abort => {
                self.abort_current_tx_locked(session).await;
            }
            Plan::HotSwap {
                intent,
                playback,
                expected_gen,
            } => {
                let offset_ms = (Utc::now().timestamp_millis() - slot_start_ms).max(0) as u64;
                if (offset_ms as i64) > max_late_tx_start_ms {
                    self.abort_current_tx_locked(session).await;
                    return;
                }
                let af_mod = f32::from(intent.af_hz);
                let pcm_48k = match self
                    .hybrid_decoder
                    .modulate_tx_from_offset(
                        mode,
                        &intent.message,
                        af_mod,
                        DSP_SAMPLE_RATE,
                        offset_ms,
                    )
                    .await
                {
                    Ok(p) if !p.is_empty() => p,
                    Ok(_) => {
                        self.abort_current_tx_locked(session).await;
                        return;
                    }
                    Err(e) => {
                        self.emit_tx_error(
                            &session.radio_id,
                            format!(
                                "Failed to modulate hot-swap {} TX waveform '{}': {e}",
                                mode.as_str().to_ascii_uppercase(),
                                intent.message
                            ),
                        );
                        self.abort_current_tx_locked(session).await;
                        return;
                    }
                };

                let pb_swap = Arc::clone(&playback);
                let swap_res =
                    tokio::task::spawn_blocking(move || pb_swap.replace_samples(pcm_48k)).await;
                match swap_res {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => {
                        self.emit_tx_error(
                            &session.radio_id,
                            format!("Failed to hot-swap TX playback buffer: {e}"),
                        );
                        self.abort_current_tx_locked(session).await;
                        return;
                    }
                    Err(e) => {
                        self.emit_tx_error(
                            &session.radio_id,
                            format!("TX buffer hot-swap task error: {e}"),
                        );
                        self.abort_current_tx_locked(session).await;
                        return;
                    }
                }

                let snap_opt = {
                    let mut rt = session.runtime.lock().await;
                    let confirmed_arc = match rt.active_tx.as_mut() {
                        Some(a) if a.tx_gen == expected_gen => {
                            a.intent = intent.clone();
                            Some(Arc::clone(&a.confirmed_intent))
                        }
                        _ => None,
                    };
                    if let Some(arc) = confirmed_arc {
                        *arc.lock().await = intent.clone();
                        rt.armed_message = Some(intent.message.clone());
                        Some(rt.to_snapshot())
                    } else {
                        None
                    }
                };

                if let Some(snap) = snap_opt {
                    let ptt_elapsed_ms =
                        (Utc::now().timestamp_millis() - slot_start_ms).max(0) as u64;
                    self.update_snapshot_cache(snap.clone());
                    let _ = self.ws_tx.send(WsBroadcastEvent::TxState {
                        radio_id: session.radio_id.clone(),
                        state: "transmitting".to_string(),
                        af_hz: Some(intent.af_hz),
                        slot: Some(intent.slot.as_str().to_string()),
                        message: Some(intent.message),
                        ptt_elapsed_ms,
                    });
                    self.broadcast_qso_update(&snap, None);
                }
            }
            Plan::Start {
                intent,
                audio_dev,
                gain_db,
                dial_freq_hz,
            } => {
                let offset_ms = (Utc::now().timestamp_millis() - slot_start_ms).max(0) as u64;
                if (offset_ms as i64) > max_late_tx_start_ms {
                    return;
                }
                let af_mod = f32::from(intent.af_hz);
                let pcm_48k = match self
                    .hybrid_decoder
                    .modulate_tx_from_offset(
                        mode,
                        &intent.message,
                        af_mod,
                        DSP_SAMPLE_RATE,
                        offset_ms,
                    )
                    .await
                {
                    Ok(p) if !p.is_empty() => p,
                    Ok(_) => return,
                    Err(e) => {
                        self.emit_tx_error(
                            &session.radio_id,
                            format!(
                                "Failed to modulate {} TX waveform '{}': {e}",
                                mode.as_str().to_ascii_uppercase(),
                                intent.message
                            ),
                        );
                        return;
                    }
                };

                let dev_owned = audio_dev.clone();
                let wd_fault = Arc::clone(&self.watchdog);
                let rid_fault = session.radio_id.clone();
                let playback = match tokio::task::spawn_blocking(move || {
                    AudioManager::start_playback(
                        &dev_owned,
                        pcm_48k,
                        gain_db,
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
                    Ok(Ok(pb)) => Arc::new(pb),
                    Ok(Err(e)) => {
                        self.emit_tx_error(
                            &session.radio_id,
                            format!(
                                "Failed to open TX audio playback stream on '{audio_dev}': {e}"
                            ),
                        );
                        return;
                    }
                    Err(e) => {
                        self.emit_tx_error(
                            &session.radio_id,
                            format!("TX playback task error: {e}"),
                        );
                        return;
                    }
                };

                let abort_flag = playback.abort_handle();
                if let Err((_, msg)) = self.supervisor.set_ptt(&session.radio_id, true).await {
                    playback.stop();
                    self.emit_tx_error(
                        &session.radio_id,
                        format!("Failed to assert CAT PTT for TX: {msg}"),
                    );
                    return;
                }

                self.watchdog
                    .arm_tx(
                        &session.radio_id,
                        &session.actor,
                        Some(Arc::clone(&abort_flag)),
                    )
                    .await;

                let tx_cancel = CancellationToken::new();
                let aborted_by_control = Arc::new(AtomicBool::new(false));
                let confirmed_intent = Arc::new(AsyncMutex::new(intent.clone()));

                let snap = {
                    let mut rt = session.runtime.lock().await;
                    let tx_gen = rt.next_tx_gen;
                    rt.next_tx_gen = rt.next_tx_gen.wrapping_add(1).max(1);

                    let mgr_wait = Arc::clone(self);
                    let rt_wait = Arc::clone(&session.runtime);
                    let rid_wait = session.radio_id.clone();
                    let sess_cancel_wait = session.cancel.clone();
                    let tx_cancel_wait = tx_cancel.clone();
                    let aborted_ctrl_wait = Arc::clone(&aborted_by_control);
                    let abort_flag_wait = Arc::clone(&abort_flag);
                    let confirmed_wait = Arc::clone(&confirmed_intent);

                    let task = tokio::spawn(async move {
                        mgr_wait
                            .wait_for_live_tx_end(
                                rid_wait,
                                tx_gen,
                                slot_ts,
                                slot_start_ms,
                                tx_end_offset_ms,
                                dial_freq_hz,
                                rt_wait,
                                confirmed_wait,
                                abort_flag_wait,
                                aborted_ctrl_wait,
                                tx_cancel_wait,
                                sess_cancel_wait,
                            )
                            .await;
                    });

                    rt.playback = Some(Arc::clone(&playback));
                    rt.active_tx = Some(ActiveTxHandle {
                        tx_gen,
                        slot_ts,
                        intent: intent.clone(),
                        confirmed_intent,
                        tx_cancel,
                        aborted_by_control,
                        task,
                    });
                    rt.tx_occurred_in_slot_ts = Some(slot_ts);
                    rt.tx_state = "transmitting".to_string();
                    rt.armed_message = Some(intent.message.clone());
                    rt.to_snapshot()
                };

                let ptt_elapsed_ms = (Utc::now().timestamp_millis() - slot_start_ms).max(0) as u64;
                self.update_snapshot_cache(snap.clone());
                let _ = self.ws_tx.send(WsBroadcastEvent::TxState {
                    radio_id: session.radio_id.clone(),
                    state: "transmitting".to_string(),
                    af_hz: Some(intent.af_hz),
                    slot: Some(intent.slot.as_str().to_string()),
                    message: Some(intent.message),
                    ptt_elapsed_ms,
                });
                self.broadcast_qso_update(&snap, None);
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn wait_for_live_tx_end(
        &self,
        radio_id: String,
        tx_gen: u64,
        slot_ts: UnixSecs,
        slot_start_ms: i64,
        tx_end_offset_ms: i64,
        dial_freq_hz: Option<i64>,
        rt_arc: Arc<AsyncMutex<SessionRuntime>>,
        confirmed_intent: Arc<AsyncMutex<TxIntent>>,
        abort_flag: Arc<AtomicBool>,
        aborted_by_control: Arc<AtomicBool>,
        tx_cancel: CancellationToken,
        session_cancel: CancellationToken,
    ) {
        let end_wall_ms = slot_start_ms + tx_end_offset_ms;
        let wait_ms = (end_wall_ms - Utc::now().timestamp_millis()).max(50) as u64;
        let tx_end = TokioInstant::now() + Duration::from_millis(wait_ms);

        tokio::select! {
            _ = session_cancel.cancelled() => {}
            _ = tx_cancel.cancelled() => {}
            _ = sleep_until(tx_end) => {}
        }

        let aborted = abort_flag.load(Ordering::SeqCst)
            || aborted_by_control.load(Ordering::SeqCst)
            || tx_cancel.is_cancelled()
            || session_cancel.is_cancelled();

        let pb_opt = {
            let mut rt = rt_arc.lock().await;
            if !rt.active_tx.as_ref().is_some_and(|a| a.tx_gen == tx_gen) {
                return;
            }
            rt.active_tx = None;
            rt.playback.take()
        };

        self.watchdog.disarm_tx(&radio_id).await;
        let _ = self.supervisor.set_ptt(&radio_id, false).await;
        if let Some(pb) = pb_opt {
            pb.stop();
        }

        let final_intent = confirmed_intent.lock().await.clone();
        let (completed, snap) = {
            let mut rt = rt_arc.lock().await;
            let done = if !aborted {
                rt.sequencer
                    .on_tx_confirmed(slot_ts, &final_intent, dial_freq_hz)
            } else {
                None
            };
            rt.tx_state = "idle".to_string();
            rt.armed_message = None;
            (done, rt.to_snapshot())
        };

        if let Some(ref rec) = completed {
            self.persist_completed_qso(&radio_id, rec);
        }
        self.update_snapshot_cache(snap.clone());
        self.broadcast_qso_update(&snap, completed);
        let _ = self.ws_tx.send(WsBroadcastEvent::TxState {
            radio_id,
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

fn generate_tune_sine_48k(af_hz: u16, duration_ms: u64) -> Vec<f32> {
    let total_samples = ((u64::from(DSP_SAMPLE_RATE) * duration_ms) / 1000) as usize;
    let fade_samples = ((DSP_SAMPLE_RATE as usize) / 100).min(total_samples / 2);
    let omega = 2.0 * PI * f32::from(af_hz) / (DSP_SAMPLE_RATE as f32);
    let mut pcm = Vec::with_capacity(total_samples);
    for i in 0..total_samples {
        let mut env = 1.0_f32;
        if fade_samples > 0 {
            if i < fade_samples {
                let t = (i as f32) / (fade_samples as f32);
                env = 0.5 * (1.0 - (PI * t).cos());
            } else if i >= total_samples - fade_samples {
                let rem = (total_samples - 1 - i) as f32;
                let t = rem / (fade_samples as f32);
                env = 0.5 * (1.0 - (PI * t).cos());
            }
        }
        pcm.push((omega * (i as f32)).sin() * 0.65 * env);
    }
    pcm
}

fn prepare_slot_pcm_12k(mut raw: Vec<f32>, target_samples: usize) -> Vec<f32> {
    if raw.len() > target_samples {
        let start = raw.len() - target_samples;
        raw.drain(..start);
    }
    if raw.len() < target_samples {
        raw.resize(target_samples, 0.0);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_intent(slot: SlotParity, af_hz: u16, msg: &str) -> TxIntent {
        TxIntent {
            af_hz,
            slot,
            message: msg.to_string(),
        }
    }

    #[test]
    fn decide_tx_action_covers_late_start_hotswap_abort_and_noop() {
        let cq = mk_intent(SlotParity::Even, 1500, "CQ N1MPM FN33");
        let rep = mk_intent(SlotParity::Even, 1500, "K1ABC N1MPM -08");
        let rr73 = mk_intent(SlotParity::Even, 1500, "K1ABC N1MPM RR73");

        // Idle -> None
        assert_eq!(
            decide_tx_action(None, None, 1_000, MAX_LATE_TX_START_MS),
            TxReconcileDecision::Noop
        );

        // Idle -> Start at 0ms and at 6000ms cutoff
        assert_eq!(
            decide_tx_action(None, Some(&cq), 0, MAX_LATE_TX_START_MS),
            TxReconcileDecision::Start {
                intent: cq.clone(),
                offset_ms: 0
            }
        );
        assert_eq!(
            decide_tx_action(None, Some(&cq), 6_000, MAX_LATE_TX_START_MS),
            TxReconcileDecision::Start {
                intent: cq.clone(),
                offset_ms: 6_000
            }
        );

        // Idle -> TooLateWaitNextSlot past 6000ms
        assert_eq!(
            decide_tx_action(None, Some(&cq), 6_001, MAX_LATE_TX_START_MS),
            TxReconcileDecision::TooLateWaitNextSlot
        );

        // Active -> None => Abort regardless of offset
        assert_eq!(
            decide_tx_action(Some(&cq), None, 2_000, MAX_LATE_TX_START_MS),
            TxReconcileDecision::Abort
        );
        assert_eq!(
            decide_tx_action(Some(&cq), None, 9_000, MAX_LATE_TX_START_MS),
            TxReconcileDecision::Abort
        );

        // Active -> same message & slot (even if AF changed) => Noop
        let cq_new_af = mk_intent(SlotParity::Even, 1800, "CQ N1MPM FN33");
        assert_eq!(
            decide_tx_action(Some(&cq), Some(&cq_new_af), 2_000, MAX_LATE_TX_START_MS),
            TxReconcileDecision::Noop
        );

        // Active -> different message within <= 6000ms => HotSwap
        assert_eq!(
            decide_tx_action(Some(&rep), Some(&rr73), 1_200, MAX_LATE_TX_START_MS),
            TxReconcileDecision::HotSwap {
                intent: rr73.clone(),
                offset_ms: 1_200
            }
        );
        assert_eq!(
            decide_tx_action(Some(&rep), Some(&rr73), 6_000, MAX_LATE_TX_START_MS),
            TxReconcileDecision::HotSwap {
                intent: rr73.clone(),
                offset_ms: 6_000
            }
        );

        // Active -> different message past 6000ms => Abort stale TX immediately
        assert_eq!(
            decide_tx_action(Some(&rep), Some(&rr73), 6_001, MAX_LATE_TX_START_MS),
            TxReconcileDecision::Abort
        );
    }
}
