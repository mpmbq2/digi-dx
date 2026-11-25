use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio::time::{sleep, Instant};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::command_bus::{ErrorCode, WsBroadcastEvent};
use crate::domain::bands::derive_band;
use crate::store::{now_utc_str, RadioProfile, StateStore};
use crate::supervisor::rigctld::{
    is_cat_powered_off_error, RigCapabilities, RigctldClient, RigctldError, RigctldProcess,
};
use crate::telemetry::TelemetryEnvelope;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RadioLifecycleState {
    Discovered,
    Unconfigured,
    Configured,
    StartingRigctld,
    Ready,
    ActiveSession,
    Degraded,
    Recovering,
    PoweredOff,
    Disconnected,
}

impl RadioLifecycleState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Discovered => "DISCOVERED",
            Self::Unconfigured => "UNCONFIGURED",
            Self::Configured => "CONFIGURED",
            Self::StartingRigctld => "STARTING_RIGCTLD",
            Self::Ready => "READY",
            Self::ActiveSession => "ACTIVE_SESSION",
            Self::Degraded => "DEGRADED",
            Self::Recovering => "RECOVERING",
            Self::PoweredOff => "POWERED_OFF",
            Self::Disconnected => "DISCONNECTED",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RadioLiveSettings {
    pub vfo: Option<String>,
    pub split: Option<bool>,
    pub tx_vfo: Option<String>,
    pub rit_hz: Option<i32>,
    pub xit_hz: Option<i32>,
    pub strength_db: Option<i32>,
    pub rf_power_watts: Option<f64>,
    #[serde(default)]
    pub tx_swr: Option<f64>,
    #[serde(default)]
    pub tx_swr_live: bool,
    pub levels: BTreeMap<String, f64>,
    pub funcs: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RadioRuntimeSnapshot {
    pub radio_id: String,
    pub lifecycle_state: RadioLifecycleState,
    pub bound_device_key: Option<String>,
    pub bound_serial_path: Option<String>,
    pub freq_hz: Option<u64>,
    pub band: Option<String>,
    pub mode: Option<String>,
    pub passband_hz: Option<u32>,
    pub ptt: bool,
    pub rigctld_port: u16,
    pub rigctld_pid: Option<u32>,
    pub recovery_attempts: u32,
    pub last_error: Option<String>,
    pub last_poll_utc: Option<String>,
    pub updated_at_utc: String,
    pub capabilities: Option<RigCapabilities>,
    pub settings: RadioLiveSettings,
}

impl RadioRuntimeSnapshot {
    pub fn initial(profile: &RadioProfile, capabilities: Option<RigCapabilities>) -> Self {
        let freq_hz = profile
            .last_dial_freq_hz
            .and_then(|f| u64::try_from(f).ok());
        let band = freq_hz.and_then(derive_band).map(str::to_string);
        Self {
            radio_id: profile.radio_id.clone(),
            lifecycle_state: RadioLifecycleState::Configured,
            bound_device_key: profile.serial_device_key.clone(),
            bound_serial_path: None,
            freq_hz,
            band,
            mode: None,
            passband_hz: None,
            ptt: false,
            rigctld_port: profile.rigctld_port,
            rigctld_pid: None,
            recovery_attempts: 0,
            last_error: None,
            last_poll_utc: None,
            updated_at_utc: now_utc_str(),
            capabilities,
            settings: RadioLiveSettings::default(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct WorkerTiming {
    pub poll_interval: Duration,
    pub tx_swr_initial_delay: Duration,
    pub tx_swr_poll_interval: Duration,
    pub recovery_backoffs: Vec<Duration>,
    pub standby_poll_interval: Duration,
}

impl Default for WorkerTiming {
    fn default() -> Self {
        Self {
            poll_interval: Duration::from_millis(1500),
            tx_swr_initial_delay: Duration::from_secs(1),
            tx_swr_poll_interval: Duration::from_secs(3),
            recovery_backoffs: vec![
                Duration::from_secs(1),
                Duration::from_secs(2),
                Duration::from_secs(5),
                Duration::from_secs(15),
                Duration::from_secs(15),
            ],
            standby_poll_interval: Duration::from_secs(10),
        }
    }
}

pub type CmdResult = Result<Value, (ErrorCode, String)>;

pub enum WorkerCmd {
    DeviceAttached {
        device_key: String,
        serial_path: String,
    },
    DeviceDetached,
    HardwareAmbiguous {
        reason: String,
    },
    ProfileUpdated {
        profile: Box<RadioProfile>,
        capabilities: Option<Box<RigCapabilities>>,
    },
    Restart {
        reply: Option<oneshot::Sender<CmdResult>>,
    },
    Stop {
        reply: Option<oneshot::Sender<CmdResult>>,
    },
    TestCat {
        reply: oneshot::Sender<CmdResult>,
    },
    TestPtt {
        duration_ms: u64,
        reply: oneshot::Sender<CmdResult>,
    },
    SetFreq {
        freq_hz: u64,
        reply: oneshot::Sender<CmdResult>,
    },
    SetMode {
        mode: String,
        passband_hz: u32,
        reply: oneshot::Sender<CmdResult>,
    },
    SetPtt {
        active: bool,
        reply: oneshot::Sender<CmdResult>,
    },
    SetVfo {
        vfo: String,
        reply: oneshot::Sender<CmdResult>,
    },
    SetSplit {
        enabled: bool,
        tx_vfo: String,
        reply: oneshot::Sender<CmdResult>,
    },
    SetRit {
        offset_hz: i32,
        reply: oneshot::Sender<CmdResult>,
    },
    SetXit {
        offset_hz: i32,
        reply: oneshot::Sender<CmdResult>,
    },
    SetLevel {
        name: String,
        value: f64,
        reply: oneshot::Sender<CmdResult>,
    },
    SetFunc {
        name: String,
        enabled: bool,
        reply: oneshot::Sender<CmdResult>,
    },
    AtuTune {
        reply: oneshot::Sender<CmdResult>,
    },
    RefreshSettings {
        reply: oneshot::Sender<CmdResult>,
    },
    SetSessionActive(bool),
    WatchdogAbort {
        reason: String,
    },
    EmergencyHalt,
    Shutdown,
}

struct RunningRig {
    process: RigctldProcess,
    client: RigctldClient,
}

pub struct RadioWorker {
    profile: RadioProfile,
    rigctld_bin: String,
    timing: WorkerTiming,
    store: StateStore,
    ws_tx: broadcast::Sender<WsBroadcastEvent>,
    snapshots: Arc<RwLock<HashMap<String, RadioRuntimeSnapshot>>>,
    snapshot: RadioRuntimeSnapshot,
    rx: mpsc::Receiver<WorkerCmd>,
    shutdown: CancellationToken,
    running: Option<RunningRig>,
    serial_attached: bool,
    halted_by_operator: bool,
    app_ptt_active: bool,
    atu_refresh_polls_remaining: u8,
    pending_tx_swr_at: Option<Instant>,
    pending_recovery_at: Option<Instant>,
    pending_standby_probe_at: Option<Instant>,
    poll_counter: u32,
}

impl RadioWorker {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        profile: RadioProfile,
        capabilities: Option<RigCapabilities>,
        rigctld_bin: String,
        timing: WorkerTiming,
        store: StateStore,
        ws_tx: broadcast::Sender<WsBroadcastEvent>,
        snapshots: Arc<RwLock<HashMap<String, RadioRuntimeSnapshot>>>,
        rx: mpsc::Receiver<WorkerCmd>,
        shutdown: CancellationToken,
    ) -> Self {
        let snapshot = RadioRuntimeSnapshot::initial(&profile, capabilities);
        {
            if let Ok(mut guard) = snapshots.write() {
                guard.insert(profile.radio_id.clone(), snapshot.clone());
            }
        }
        let serial_attached = profile.is_dummy || profile.hamlib_model == 1;
        Self {
            profile,
            rigctld_bin,
            timing,
            store,
            ws_tx,
            snapshots,
            snapshot,
            rx,
            shutdown,
            running: None,
            serial_attached,
            halted_by_operator: false,
            app_ptt_active: false,
            atu_refresh_polls_remaining: 0,
            pending_tx_swr_at: None,
            pending_recovery_at: None,
            pending_standby_probe_at: None,
            poll_counter: 0,
        }
    }

    pub async fn run(mut self) {
        if self.profile.is_dummy || self.profile.hamlib_model == 1 {
            if self.profile.auto_connect {
                self.start_rigctld(false).await;
            } else {
                self.set_state(
                    RadioLifecycleState::Configured,
                    Some("Auto-connect disabled".into()),
                );
            }
        } else {
            self.set_state(
                RadioLifecycleState::Disconnected,
                Some("Awaiting USB-serial device attachment".into()),
            );
        }

        let mut poll_timer = tokio::time::interval(self.timing.poll_interval);
        poll_timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            let recovery_fut = async {
                match self.pending_recovery_at {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending::<()>().await,
                }
            };
            let standby_probe_fut = async {
                match self.pending_standby_probe_at {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending::<()>().await,
                }
            };
            let tx_swr_fut = async {
                match self.pending_tx_swr_at {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending::<()>().await,
                }
            };

            tokio::select! {
                _ = self.shutdown.cancelled() => {
                    break;
                }
                _ = recovery_fut => {
                    self.pending_recovery_at = None;
                    if self.can_run_rigctld() {
                        self.start_rigctld(false).await;
                    }
                }
                _ = standby_probe_fut => {
                    self.pending_standby_probe_at = None;
                    if self.can_run_rigctld()
                        && self.profile.auto_connect
                        && !self.halted_by_operator
                        && self.running.is_none()
                    {
                        self.start_rigctld(true).await;
                    }
                }
                _ = tx_swr_fut, if self.running.is_some() && self.app_ptt_active => {
                    self.pending_tx_swr_at = None;
                    self.poll_tx_swr().await;
                    if self.running.is_some() && self.app_ptt_active {
                        self.pending_tx_swr_at = Some(Instant::now() + self.timing.tx_swr_poll_interval);
                    }
                }
                _ = poll_timer.tick(), if self.running.is_some() && !self.app_ptt_active => {
                    self.poll_rig().await;
                }
                maybe_cmd = self.rx.recv() => {
                    let Some(cmd) = maybe_cmd else {
                        break;
                    };
                    match cmd {
                        WorkerCmd::Shutdown => break,
                        other => self.handle_cmd(other).await,
                    }
                }
            }
        }

        self.teardown_rig("worker shutdown").await;
        if let Ok(mut guard) = self.snapshots.write() {
            guard.remove(&self.profile.radio_id);
        }
    }

    fn can_run_rigctld(&self) -> bool {
        self.profile.is_dummy || self.profile.hamlib_model == 1 || self.serial_attached
    }

    async fn handle_cmd(&mut self, cmd: WorkerCmd) {
        match cmd {
            WorkerCmd::DeviceAttached {
                device_key,
                serial_path,
            } => {
                let changed = self.snapshot.bound_serial_path.as_deref()
                    != Some(serial_path.as_str())
                    || !self.serial_attached;
                self.serial_attached = true;
                self.snapshot.bound_device_key = Some(device_key);
                self.snapshot.bound_serial_path = Some(serial_path.clone());

                if changed
                    && self.running.is_none()
                    && self.profile.auto_connect
                    && !self.halted_by_operator
                {
                    self.snapshot.recovery_attempts = 0;
                    self.pending_recovery_at = None;
                    self.pending_standby_probe_at = None;
                    self.set_state(
                        RadioLifecycleState::Recovering,
                        Some(format!("Serial device attached at {serial_path}")),
                    );
                    self.start_rigctld(false).await;
                } else if changed {
                    self.publish_snapshot(Some(format!("Serial device attached at {serial_path}")));
                }
            }
            WorkerCmd::DeviceDetached => {
                if self.serial_attached || self.running.is_some() {
                    self.serial_attached = false;
                    self.pending_recovery_at = None;
                    self.pending_standby_probe_at = None;
                    self.snapshot.recovery_attempts = 0;
                    self.snapshot.bound_serial_path = None;
                    self.snapshot.last_error = Some("USB serial cable detached".into());
                    self.teardown_rig("USB serial detached").await;
                    self.set_state(
                        RadioLifecycleState::Disconnected,
                        Some("USB serial device detached".into()),
                    );
                }
            }
            WorkerCmd::HardwareAmbiguous { reason } => {
                self.serial_attached = false;
                self.pending_recovery_at = None;
                self.pending_standby_probe_at = None;
                self.teardown_rig(&reason).await;
                self.snapshot.last_error = Some(reason.clone());
                self.set_state(RadioLifecycleState::Degraded, Some(reason));
            }
            WorkerCmd::ProfileUpdated {
                profile: updated,
                capabilities,
            } => {
                let updated = *updated;
                let needs_restart = updated.hamlib_model != self.profile.hamlib_model
                    || updated.is_dummy != self.profile.is_dummy
                    || updated.serial_baud_rate != self.profile.serial_baud_rate
                    || updated.civ_address != self.profile.civ_address
                    || updated.ptt_method != self.profile.ptt_method
                    || updated.rig_options_json != self.profile.rig_options_json
                    || updated.serial_device_key != self.profile.serial_device_key;

                if let Some(caps) = capabilities {
                    self.snapshot.capabilities = Some(*caps);
                }
                self.profile = updated;
                self.halted_by_operator = false;
                self.pending_standby_probe_at = None;
                if self.profile.is_dummy || self.profile.hamlib_model == 1 {
                    self.serial_attached = true;
                }
                if needs_restart && self.can_run_rigctld() && self.profile.auto_connect {
                    self.teardown_rig("profile updated").await;
                    self.snapshot.recovery_attempts = 0;
                    self.pending_recovery_at = None;
                    self.start_rigctld(false).await;
                } else {
                    self.publish_snapshot(Some("Radio profile updated".into()));
                }
            }
            WorkerCmd::Restart { reply } => {
                self.pending_recovery_at = None;
                self.pending_standby_probe_at = None;
                self.halted_by_operator = false;
                self.snapshot.recovery_attempts = 0;
                self.snapshot.last_error = None;
                self.teardown_rig("operator restart").await;
                if self.can_run_rigctld() {
                    self.start_rigctld(false).await;
                    if let Some(tx) = reply {
                        let _ = tx.send(Ok(
                            serde_json::to_value(&self.snapshot).unwrap_or(Value::Null)
                        ));
                    }
                } else {
                    self.set_state(
                        RadioLifecycleState::Disconnected,
                        Some("Cannot start: USB serial device is disconnected".into()),
                    );
                    if let Some(tx) = reply {
                        let _ = tx.send(Err((
                            ErrorCode::CatUnavailable,
                            "USB serial device is disconnected".to_string(),
                        )));
                    }
                }
            }
            WorkerCmd::Stop { reply } => {
                self.pending_recovery_at = None;
                self.pending_standby_probe_at = None;
                self.halted_by_operator = true;
                self.snapshot.recovery_attempts = 0;
                self.snapshot.last_error = None;
                self.teardown_rig("stopped by operator").await;
                self.set_state(
                    RadioLifecycleState::Configured,
                    Some("Stopped by operator — serial port released".into()),
                );
                if let Some(tx) = reply {
                    let _ = tx.send(Ok(
                        serde_json::to_value(&self.snapshot).unwrap_or(Value::Null)
                    ));
                }
            }
            WorkerCmd::TestCat { reply } => {
                let res = self.exec_test_cat().await;
                let _ = reply.send(res);
            }
            WorkerCmd::TestPtt { duration_ms, reply } => {
                let res = self.exec_test_ptt(duration_ms).await;
                let _ = reply.send(res);
            }
            WorkerCmd::SetFreq { freq_hz, reply } => {
                let res = self.exec_set_freq(freq_hz).await;
                let _ = reply.send(res);
            }
            WorkerCmd::SetMode {
                mode,
                passband_hz,
                reply,
            } => {
                let res = self.exec_set_mode(&mode, passband_hz).await;
                let _ = reply.send(res);
            }
            WorkerCmd::SetPtt { active, reply } => {
                let res = self.exec_set_ptt(active).await;
                let _ = reply.send(res);
            }
            WorkerCmd::SetVfo { vfo, reply } => {
                let res = self.exec_set_vfo(&vfo).await;
                let _ = reply.send(res);
            }
            WorkerCmd::SetSplit {
                enabled,
                tx_vfo,
                reply,
            } => {
                let res = self.exec_set_split(enabled, &tx_vfo).await;
                let _ = reply.send(res);
            }
            WorkerCmd::SetRit { offset_hz, reply } => {
                let res = self.exec_set_rit(offset_hz).await;
                let _ = reply.send(res);
            }
            WorkerCmd::SetXit { offset_hz, reply } => {
                let res = self.exec_set_xit(offset_hz).await;
                let _ = reply.send(res);
            }
            WorkerCmd::SetLevel { name, value, reply } => {
                let res = self.exec_set_level(&name, value).await;
                let _ = reply.send(res);
            }
            WorkerCmd::SetFunc {
                name,
                enabled,
                reply,
            } => {
                let res = self.exec_set_func(&name, enabled).await;
                let _ = reply.send(res);
            }
            WorkerCmd::AtuTune { reply } => {
                let res = self.exec_atu_tune().await;
                let _ = reply.send(res);
            }
            WorkerCmd::RefreshSettings { reply } => {
                let res = self.exec_refresh_settings().await;
                let _ = reply.send(res);
            }
            WorkerCmd::SetSessionActive(active) => {
                if self.running.is_some() {
                    let target = if active {
                        RadioLifecycleState::ActiveSession
                    } else {
                        RadioLifecycleState::Ready
                    };
                    self.set_state(
                        target,
                        Some(if active {
                            "FT8 session active".to_string()
                        } else {
                            "FT8 session stopped".to_string()
                        }),
                    );
                }
            }
            WorkerCmd::WatchdogAbort { reason } => {
                self.fail_closed_drop_ptt(
                    &format!("watchdog abort ({reason}) — releasing serial port"),
                    format!("Watchdog PTT drop ({reason}) confirmed RX"),
                    false,
                )
                .await;
            }
            WorkerCmd::EmergencyHalt => {
                self.fail_closed_drop_ptt(
                    "emergency TX halt — releasing serial port",
                    "Emergency PTT drop (+T 0) confirmed RX".to_string(),
                    true,
                )
                .await;
            }
            WorkerCmd::Shutdown => {}
        }
    }

    async fn start_rigctld(&mut self, is_standby_probe: bool) {
        if !is_standby_probe {
            self.set_state(
                RadioLifecycleState::StartingRigctld,
                Some(format!(
                    "Spawning rigctld -m {} on 127.0.0.1:{}",
                    self.profile.hamlib_model, self.profile.rigctld_port
                )),
            );
        }

        let serial_path = self.snapshot.bound_serial_path.clone();
        match RigctldProcess::spawn_and_connect(
            &self.rigctld_bin,
            &self.profile,
            serial_path.as_deref(),
            &self.shutdown,
        )
        .await
        {
            Ok((process, mut client)) => {
                self.pending_standby_probe_at = None;
                let pid = process.pid();
                let freq = client.get_freq().await.ok();
                let mode_pair = client.get_mode().await.ok();
                let mut ptt = client.get_ptt().await.ok().flatten().unwrap_or(false);

                if ptt {
                    warn!(
                        radio_id = %self.profile.radio_id,
                        pid,
                        "radio reported TX active immediately on connect; sending +T 0"
                    );
                    let _ = client
                        .set_ptt_with_timeout(0, Duration::from_millis(500))
                        .await;
                    sleep(Duration::from_millis(100)).await;
                    ptt = client.get_ptt().await.ok().flatten().unwrap_or(true);
                    if ptt {
                        process.shutdown_gracefully(Some(&mut client)).await;
                        self.halted_by_operator = true;
                        self.snapshot.rigctld_pid = None;
                        self.snapshot.ptt = false;
                        self.app_ptt_active = false;
                        self.atu_refresh_polls_remaining = 0;
                        let safety_msg = "Safety halt: radio reported TX active immediately on connect; rigctld stopped to release serial port. Check transceiver USB SEND / DTR / RTS menu settings.";
                        self.snapshot.last_error = Some(safety_msg.to_string());
                        self.set_state(RadioLifecycleState::Degraded, Some(safety_msg.to_string()));
                        let _ = self.ws_tx.send(WsBroadcastEvent::PreflightAlert {
                            severity: "fatal".to_string(),
                            title: format!("Safety Halt TX ({})", self.profile.name),
                            detail: safety_msg.to_string(),
                            occurred_at_utc: now_utc_str(),
                        });
                        return;
                    }
                }

                self.snapshot.rigctld_pid = Some(pid);
                self.snapshot.recovery_attempts = 0;
                self.snapshot.last_error = None;
                self.snapshot.last_poll_utc = Some(now_utc_str());
                self.snapshot.ptt = ptt;
                self.app_ptt_active = false;
                self.atu_refresh_polls_remaining = 0;
                if let Some(f) = freq {
                    self.snapshot.freq_hz = Some(f);
                    self.snapshot.band = derive_band(f).map(str::to_string);
                    let _ = self
                        .store
                        .update_radio_last_freq(&self.profile.radio_id, f as i64);
                }
                if let Some((m, pb)) = mode_pair {
                    self.snapshot.mode = Some(m);
                    self.snapshot.passband_hz = Some(pb);
                }

                let mut next_settings = self.snapshot.settings.clone();
                Self::read_all_settings(
                    &mut client,
                    self.snapshot.capabilities.as_ref(),
                    self.snapshot.freq_hz,
                    self.snapshot.mode.as_deref(),
                    &mut next_settings,
                )
                .await;
                self.snapshot.settings = next_settings;
                self.poll_counter = 0;

                self.running = Some(RunningRig { process, client });
                info!(
                    radio_id = %self.profile.radio_id,
                    pid,
                    port = self.profile.rigctld_port,
                    "rigctld ready"
                );
                self.set_state(
                    RadioLifecycleState::Ready,
                    Some(format!(
                        "rigctld (pid {pid}) connected on 127.0.0.1:{}",
                        self.profile.rigctld_port
                    )),
                );
            }
            Err(RigctldError::RadioPoweredOff(reason)) => {
                debug!(radio_id = %self.profile.radio_id, reason = %reason, "transceiver powered off / CAT unresponsive");
                self.handle_rig_powered_off(reason, is_standby_probe);
            }
            Err(err) => {
                let msg = err.to_string();
                warn!(radio_id = %self.profile.radio_id, error = %msg, "rigctld start failed");
                self.handle_rig_failure(msg).await;
            }
        }
    }

    async fn poll_rig(&mut self) {
        let Some(ref mut rig) = self.running else {
            return;
        };

        match rig.process.try_wait() {
            Ok(Some(status)) => {
                self.running = None;
                self.snapshot.rigctld_pid = None;
                self.snapshot.ptt = false;
                self.handle_rig_failure(format!("rigctld exited unexpectedly ({status})"))
                    .await;
                return;
            }
            Ok(None) => {}
            Err(e) => {
                warn!(radio_id = %self.profile.radio_id, error = %e, "try_wait error");
            }
        }

        let freq = match rig.client.get_freq().await {
            Ok(f) => f,
            Err(err) => {
                let rig_alive = rig.process.is_alive();
                let is_dummy = self.profile.is_dummy || self.profile.hamlib_model == 1;
                let powered_off = is_cat_powered_off_error(&err, is_dummy, rig_alive)
                    || (matches!(err, RigctldError::ProtocolError(ref m) if m.contains("missing Frequency"))
                        && matches!(rig.client.get_powerstat().await, Ok(Some(false))));

                if powered_off {
                    self.teardown_rig("transceiver powered off / CAT unresponsive")
                        .await;
                    self.handle_rig_powered_off(
                        format!("Transceiver powered off or CAT stopped responding ({err})"),
                        false,
                    );
                } else {
                    self.teardown_rig("CAT poll failed").await;
                    self.handle_rig_failure(format!("CAT poll failed: {err}"))
                        .await;
                }
                return;
            }
        };

        let mode_pair = rig.client.get_mode().await.ok();
        let ptt_opt = rig.client.get_ptt().await.ok().flatten();
        let strength_opt = if self
            .snapshot
            .capabilities
            .as_ref()
            .is_none_or(|c| c.get_levels.iter().any(|l| l == "STRENGTH"))
        {
            rig.client
                .get_level("STRENGTH")
                .await
                .ok()
                .flatten()
                .map(|v| v.round() as i32)
        } else {
            None
        };

        self.poll_counter = self.poll_counter.wrapping_add(1);
        let mut next_settings = self.snapshot.settings.clone();
        if let Some(s_db) = strength_opt {
            next_settings.strength_db = Some(s_db);
        }
        let refresh_full = self.poll_counter.is_multiple_of(5);
        if refresh_full {
            self.atu_refresh_polls_remaining = self.atu_refresh_polls_remaining.saturating_sub(1);
            let caps_clone = self.snapshot.capabilities.clone();
            let freq_snap = Some(freq);
            let mode_snap = mode_pair
                .as_ref()
                .map(|(m, _)| m.as_str())
                .or(self.snapshot.mode.as_deref())
                .map(str::to_string);
            Self::read_all_settings(
                &mut rig.client,
                caps_clone.as_ref(),
                freq_snap,
                mode_snap.as_deref(),
                &mut next_settings,
            )
            .await;
        } else if self.atu_refresh_polls_remaining > 0 {
            self.atu_refresh_polls_remaining -= 1;
            if self
                .snapshot
                .capabilities
                .as_ref()
                .is_none_or(|c| c.get_funcs.iter().any(|f| f == "TUNER"))
            {
                if let Ok(Some(enabled)) = rig.client.get_func("TUNER").await {
                    next_settings.funcs.insert("TUNER".to_string(), enabled);
                }
            }
        }

        let mut changed = false;
        if self.snapshot.freq_hz != Some(freq) {
            let next_band = derive_band(freq).map(str::to_string);
            if self.snapshot.band != next_band {
                next_settings.tx_swr = None;
                next_settings.tx_swr_live = false;
            }
            self.snapshot.freq_hz = Some(freq);
            self.snapshot.band = next_band;
            let _ = self
                .store
                .update_radio_last_freq(&self.profile.radio_id, freq as i64);
            changed = true;
        }
        if let Some((m, pb)) = mode_pair {
            if self.snapshot.mode.as_deref() != Some(m.as_str())
                || self.snapshot.passband_hz != Some(pb)
            {
                self.snapshot.mode = Some(m);
                self.snapshot.passband_hz = Some(pb);
                changed = true;
            }
        }
        if let Some(ptt) = ptt_opt {
            if self.snapshot.ptt != ptt {
                self.snapshot.ptt = ptt;
                changed = true;
            }
        }
        if self.snapshot.settings != next_settings {
            self.snapshot.settings = next_settings;
            changed = true;
        }

        self.snapshot.last_poll_utc = Some(now_utc_str());
        if changed {
            self.publish_snapshot(None);
        } else {
            self.sync_shared_snapshot();
        }
    }

    fn handle_rig_powered_off(&mut self, detail: String, was_standby_probe: bool) {
        self.snapshot.rigctld_pid = None;
        self.snapshot.ptt = false;
        self.snapshot.recovery_attempts = 0;
        self.snapshot.last_error = None;
        self.pending_recovery_at = None;
        self.pending_standby_probe_at =
            if self.can_run_rigctld() && self.profile.auto_connect && !self.halted_by_operator {
                Some(Instant::now() + self.timing.standby_poll_interval)
            } else {
                None
            };

        if !was_standby_probe || self.snapshot.lifecycle_state != RadioLifecycleState::PoweredOff {
            self.set_state(RadioLifecycleState::PoweredOff, Some(detail));
        } else {
            self.sync_shared_snapshot();
        }
    }

    async fn handle_rig_failure(&mut self, err_msg: String) {
        self.pending_standby_probe_at = None;
        self.snapshot.last_error = Some(err_msg.clone());
        self.snapshot.rigctld_pid = None;
        self.snapshot.ptt = false;
        self.set_state(RadioLifecycleState::Degraded, Some(err_msg));

        if !self.can_run_rigctld() {
            return;
        }

        let idx = self.snapshot.recovery_attempts as usize;
        if idx < self.timing.recovery_backoffs.len() {
            let delay = self.timing.recovery_backoffs[idx];
            self.snapshot.recovery_attempts += 1;
            self.pending_recovery_at = Some(Instant::now() + delay);
            self.set_state(
                RadioLifecycleState::Recovering,
                Some(format!(
                    "Scheduled recovery attempt {}/{} in {}ms",
                    self.snapshot.recovery_attempts,
                    self.timing.recovery_backoffs.len(),
                    delay.as_millis()
                )),
            );
        } else {
            self.pending_recovery_at = None;
            warn!(
                radio_id = %self.profile.radio_id,
                "rigctld recovery retries exhausted"
            );
        }
    }

    async fn exec_test_cat(&mut self) -> CmdResult {
        let Some(ref mut rig) = self.running else {
            return Err((
                ErrorCode::RadioNotReady,
                format!(
                    "Radio '{}' is in state {}",
                    self.profile.radio_id,
                    self.snapshot.lifecycle_state.as_str()
                ),
            ));
        };

        let freq = rig
            .client
            .get_freq()
            .await
            .map_err(|e| map_rigctld_err(e, ErrorCode::CatCommandFailed))?;
        let (mode, passband) = rig
            .client
            .get_mode()
            .await
            .map_err(|e| map_rigctld_err(e, ErrorCode::CatCommandFailed))?;

        let band = derive_band(freq).map(str::to_string);
        self.snapshot.freq_hz = Some(freq);
        self.snapshot.band = band.clone();
        self.snapshot.mode = Some(mode.clone());
        self.snapshot.passband_hz = Some(passband);
        self.snapshot.last_poll_utc = Some(now_utc_str());
        self.publish_snapshot(Some("CAT test (+f/+m) succeeded".into()));

        Ok(json!({
            "radio_id": self.profile.radio_id,
            "freq_hz": freq,
            "band": band,
            "mode": mode,
            "passband_hz": passband,
        }))
    }

    async fn exec_set_freq(&mut self, freq_hz: u64) -> CmdResult {
        let Some(ref mut rig) = self.running else {
            return Err((
                ErrorCode::RadioNotReady,
                format!(
                    "Radio '{}' is in state {}",
                    self.profile.radio_id,
                    self.snapshot.lifecycle_state.as_str()
                ),
            ));
        };

        rig.client
            .set_freq(freq_hz)
            .await
            .map_err(|e| map_rigctld_err(e, ErrorCode::CatCommandFailed))?;
        let confirmed = rig.client.get_freq().await.unwrap_or(freq_hz);
        let tuner_enabled = if self
            .snapshot
            .capabilities
            .as_ref()
            .is_none_or(|c| c.get_funcs.iter().any(|f| f == "TUNER"))
        {
            rig.client.get_func("TUNER").await.ok().flatten()
        } else {
            None
        };
        let band = derive_band(confirmed).map(str::to_string);

        self.snapshot.freq_hz = Some(confirmed);
        self.snapshot.band = band.clone();
        self.snapshot.settings.tx_swr = None;
        self.snapshot.settings.tx_swr_live = false;
        if let Some(enabled) = tuner_enabled {
            self.snapshot
                .settings
                .funcs
                .insert("TUNER".to_string(), enabled);
        }
        self.snapshot.last_poll_utc = Some(now_utc_str());
        let _ = self
            .store
            .update_radio_last_freq(&self.profile.radio_id, confirmed as i64);
        self.publish_snapshot(Some(format!("VFO tuned to {confirmed} Hz")));

        Ok(json!({
            "radio_id": self.profile.radio_id,
            "freq_hz": confirmed,
            "band": band,
        }))
    }

    async fn exec_set_mode(&mut self, mode: &str, passband_hz: u32) -> CmdResult {
        let Some(ref mut rig) = self.running else {
            return Err((
                ErrorCode::RadioNotReady,
                format!(
                    "Radio '{}' is in state {}",
                    self.profile.radio_id,
                    self.snapshot.lifecycle_state.as_str()
                ),
            ));
        };

        rig.client
            .set_mode(mode, passband_hz)
            .await
            .map_err(|e| map_rigctld_err(e, ErrorCode::CatCommandFailed))?;
        let (confirmed_mode, confirmed_pb) = rig
            .client
            .get_mode()
            .await
            .unwrap_or_else(|_| (mode.to_ascii_uppercase(), passband_hz));

        self.snapshot.mode = Some(confirmed_mode.clone());
        self.snapshot.passband_hz = Some(confirmed_pb);
        self.snapshot.last_poll_utc = Some(now_utc_str());
        self.publish_snapshot(Some(format!(
            "Mode set to {confirmed_mode} ({confirmed_pb} Hz)"
        )));

        Ok(json!({
            "radio_id": self.profile.radio_id,
            "mode": confirmed_mode,
            "passband_hz": confirmed_pb,
        }))
    }

    async fn exec_test_ptt(&mut self, duration_ms: u64) -> CmdResult {
        let capped_ms = duration_ms.clamp(1, 500);
        let ptt_val: u8 = if self.profile.ptt_method == "cat_data" {
            3
        } else {
            1
        };

        let ptt_res = {
            let Some(ref mut rig) = self.running else {
                return Err((
                    ErrorCode::RadioNotReady,
                    format!(
                        "Radio '{}' is in state {}",
                        self.profile.radio_id,
                        self.snapshot.lifecycle_state.as_str()
                    ),
                ));
            };
            rig.client.set_ptt(ptt_val).await
        };
        ptt_res.map_err(|e| map_rigctld_err(e, ErrorCode::CatCommandFailed))?;

        self.app_ptt_active = true;
        self.snapshot.ptt = true;
        self.publish_snapshot(Some(format!("PTT test pulse ({capped_ms} ms)")));

        tokio::select! {
            _ = sleep(Duration::from_millis(capped_ms)) => {}
            _ = self.shutdown.cancelled() => {}
        }

        // Unconditionally unkey PTT after pulse
        let unkey_res = match self.running {
            Some(ref mut rig) => rig.client.set_ptt(0).await,
            None => Ok(()),
        };
        self.app_ptt_active = false;
        self.snapshot.ptt = false;
        self.publish_snapshot(Some("PTT test complete (+T 0)".into()));
        unkey_res.map_err(|e| map_rigctld_err(e, ErrorCode::CatCommandFailed))?;

        Ok(json!({
            "radio_id": self.profile.radio_id,
            "ptt_tested": true,
            "duration_ms": capped_ms,
        }))
    }

    async fn exec_set_ptt(&mut self, active: bool) -> CmdResult {
        let Some(ref mut rig) = self.running else {
            return Err((
                ErrorCode::RadioNotReady,
                format!(
                    "Radio '{}' is in state {}",
                    self.profile.radio_id,
                    self.snapshot.lifecycle_state.as_str()
                ),
            ));
        };
        let ptt_val: u8 = if !active {
            0
        } else if self.profile.ptt_method == "cat_data" {
            3
        } else {
            1
        };

        rig.client
            .set_ptt(ptt_val)
            .await
            .map_err(|e| map_rigctld_err(e, ErrorCode::CatCommandFailed))?;
        self.app_ptt_active = active;
        self.snapshot.ptt = active;
        if active {
            let supports_swr = self
                .snapshot
                .capabilities
                .as_ref()
                .is_none_or(|c| c.get_levels.iter().any(|l| l == "SWR"));
            self.pending_tx_swr_at = if supports_swr {
                Some(Instant::now() + self.timing.tx_swr_initial_delay)
            } else {
                None
            };
        } else {
            self.pending_tx_swr_at = None;
            self.snapshot.settings.tx_swr_live = false;
        }
        self.publish_snapshot(Some(if active {
            format!("PTT asserted (+T {ptt_val})")
        } else {
            "PTT released (+T 0)".to_string()
        }));

        Ok(json!({
            "radio_id": self.profile.radio_id,
            "ptt": active,
        }))
    }

    async fn poll_tx_swr(&mut self) {
        let supports_swr = self
            .snapshot
            .capabilities
            .as_ref()
            .is_none_or(|c| c.get_levels.iter().any(|l| l == "SWR"));
        if !supports_swr {
            return;
        }
        let Some(ref mut rig) = self.running else {
            return;
        };
        if let Ok(Some(val)) = rig.client.get_level("SWR").await {
            if val.is_finite() && val >= 1.0 {
                let rounded = (val * 100.0).round() / 100.0;
                self.snapshot.settings.tx_swr = Some(rounded);
                self.snapshot.settings.tx_swr_live = true;
                self.snapshot.last_poll_utc = Some(now_utc_str());
                self.publish_snapshot(None);
            }
        }
    }

    async fn read_all_settings(
        client: &mut RigctldClient,
        caps: Option<&RigCapabilities>,
        freq_hz: Option<u64>,
        mode: Option<&str>,
        out: &mut RadioLiveSettings,
    ) {
        if let Ok(Some(v)) = client.get_vfo().await {
            out.vfo = Some(v);
        }
        if caps.is_none_or(|c| c.has_split) {
            if let Ok(Some((sp, tx_vfo))) = client.get_split().await {
                out.split = Some(sp);
                out.tx_vfo = tx_vfo;
            }
        }
        if caps.is_none_or(|c| c.max_rit_hz.is_some()) {
            if let Ok(Some(rit)) = client.get_rit().await {
                out.rit_hz = Some(rit);
            }
        }
        if caps.is_none_or(|c| c.max_xit_hz.is_some()) {
            if let Ok(Some(xit)) = client.get_xit().await {
                out.xit_hz = Some(xit);
            }
        }

        let level_names: Vec<String> = match caps {
            Some(c) => c.get_levels.clone(),
            None => vec![
                "RFPOWER".into(),
                "AF".into(),
                "RF".into(),
                "SQL".into(),
                "PREAMP".into(),
                "ATT".into(),
                "AGC".into(),
                "STRENGTH".into(),
            ],
        };
        for name in level_names {
            if name == "SWR" {
                continue;
            }
            if let Ok(Some(val)) = client.get_level(&name).await {
                if name == "STRENGTH" {
                    out.strength_db = Some(val.round() as i32);
                } else {
                    out.levels.insert(name.clone(), val);
                }
            }
        }

        if let (Some(&rf_pwr), Some(f_hz)) = (out.levels.get("RFPOWER"), freq_hz) {
            if let Ok(Some(mw)) = client.power2mw(rf_pwr, f_hz, mode.unwrap_or("USB")).await {
                out.rf_power_watts = Some(f64::from(mw) / 1000.0);
            }
        }

        let func_names: Vec<String> = match caps {
            Some(c) => c.get_funcs.clone(),
            None => vec![
                "TUNER".into(),
                "NB".into(),
                "NR".into(),
                "COMP".into(),
                "VOX".into(),
                "LOCK".into(),
            ],
        };
        for name in func_names {
            if let Ok(Some(enabled)) = client.get_func(&name).await {
                out.funcs.insert(name, enabled);
            }
        }
    }

    async fn exec_set_vfo(&mut self, vfo: &str) -> CmdResult {
        let Some(ref mut rig) = self.running else {
            return Err((
                ErrorCode::RadioNotReady,
                format!(
                    "Radio '{}' is in state {}",
                    self.profile.radio_id,
                    self.snapshot.lifecycle_state.as_str()
                ),
            ));
        };
        rig.client
            .set_vfo(vfo)
            .await
            .map_err(|e| map_rigctld_err(e, ErrorCode::CatCommandFailed))?;
        let confirmed = rig
            .client
            .get_vfo()
            .await
            .ok()
            .flatten()
            .unwrap_or_else(|| vfo.trim().to_string());
        self.snapshot.settings.vfo = Some(confirmed.clone());
        self.snapshot.last_poll_utc = Some(now_utc_str());
        self.publish_snapshot(Some(format!("VFO switched to {confirmed}")));
        Ok(json!({ "radio_id": self.profile.radio_id, "vfo": confirmed }))
    }

    async fn exec_set_split(&mut self, enabled: bool, tx_vfo: &str) -> CmdResult {
        let Some(ref mut rig) = self.running else {
            return Err((
                ErrorCode::RadioNotReady,
                format!(
                    "Radio '{}' is in state {}",
                    self.profile.radio_id,
                    self.snapshot.lifecycle_state.as_str()
                ),
            ));
        };
        rig.client
            .set_split(enabled, tx_vfo)
            .await
            .map_err(|e| map_rigctld_err(e, ErrorCode::CatCommandFailed))?;
        let (sp, tv) = rig
            .client
            .get_split()
            .await
            .ok()
            .flatten()
            .unwrap_or((enabled, Some(tx_vfo.to_string())));
        self.snapshot.settings.split = Some(sp);
        self.snapshot.settings.tx_vfo = tv.clone();
        self.snapshot.last_poll_utc = Some(now_utc_str());
        self.publish_snapshot(Some(format!("Split {}", if sp { "ON" } else { "OFF" })));
        Ok(json!({ "radio_id": self.profile.radio_id, "split": sp, "tx_vfo": tv }))
    }

    async fn exec_set_rit(&mut self, offset_hz: i32) -> CmdResult {
        let Some(ref mut rig) = self.running else {
            return Err((
                ErrorCode::RadioNotReady,
                format!(
                    "Radio '{}' is in state {}",
                    self.profile.radio_id,
                    self.snapshot.lifecycle_state.as_str()
                ),
            ));
        };
        rig.client
            .set_rit(offset_hz)
            .await
            .map_err(|e| map_rigctld_err(e, ErrorCode::CatCommandFailed))?;
        let confirmed = rig
            .client
            .get_rit()
            .await
            .ok()
            .flatten()
            .unwrap_or(offset_hz);
        self.snapshot.settings.rit_hz = Some(confirmed);
        self.snapshot.last_poll_utc = Some(now_utc_str());
        self.publish_snapshot(Some(format!("RIT set to {confirmed} Hz")));
        Ok(json!({ "radio_id": self.profile.radio_id, "rit_hz": confirmed }))
    }

    async fn exec_set_xit(&mut self, offset_hz: i32) -> CmdResult {
        let Some(ref mut rig) = self.running else {
            return Err((
                ErrorCode::RadioNotReady,
                format!(
                    "Radio '{}' is in state {}",
                    self.profile.radio_id,
                    self.snapshot.lifecycle_state.as_str()
                ),
            ));
        };
        rig.client
            .set_xit(offset_hz)
            .await
            .map_err(|e| map_rigctld_err(e, ErrorCode::CatCommandFailed))?;
        let confirmed = rig
            .client
            .get_xit()
            .await
            .ok()
            .flatten()
            .unwrap_or(offset_hz);
        self.snapshot.settings.xit_hz = Some(confirmed);
        self.snapshot.last_poll_utc = Some(now_utc_str());
        self.publish_snapshot(Some(format!("XIT set to {confirmed} Hz")));
        Ok(json!({ "radio_id": self.profile.radio_id, "xit_hz": confirmed }))
    }

    async fn exec_set_level(&mut self, name: &str, value: f64) -> CmdResult {
        let Some(ref mut rig) = self.running else {
            return Err((
                ErrorCode::RadioNotReady,
                format!(
                    "Radio '{}' is in state {}",
                    self.profile.radio_id,
                    self.snapshot.lifecycle_state.as_str()
                ),
            ));
        };
        let upper = name.trim().to_ascii_uppercase();
        rig.client
            .set_level(&upper, value)
            .await
            .map_err(|e| map_rigctld_err(e, ErrorCode::CatCommandFailed))?;
        let confirmed = rig
            .client
            .get_level(&upper)
            .await
            .ok()
            .flatten()
            .unwrap_or(value);
        self.snapshot
            .settings
            .levels
            .insert(upper.clone(), confirmed);
        if upper == "RFPOWER" {
            if let Some(f_hz) = self.snapshot.freq_hz {
                if let Ok(Some(mw)) = rig
                    .client
                    .power2mw(
                        confirmed,
                        f_hz,
                        self.snapshot.mode.as_deref().unwrap_or("USB"),
                    )
                    .await
                {
                    self.snapshot.settings.rf_power_watts = Some(f64::from(mw) / 1000.0);
                }
            }
        }
        self.snapshot.last_poll_utc = Some(now_utc_str());
        self.publish_snapshot(Some(format!("Level {upper} set to {confirmed}")));
        Ok(json!({
            "radio_id": self.profile.radio_id,
            "name": upper,
            "value": confirmed,
            "rf_power_watts": self.snapshot.settings.rf_power_watts,
        }))
    }

    async fn exec_set_func(&mut self, name: &str, enabled: bool) -> CmdResult {
        let upper = name.trim().to_ascii_uppercase();
        if upper == "TUNER" && (self.snapshot.ptt || self.app_ptt_active) {
            return Err((
                ErrorCode::CatCommandFailed,
                "Cannot change ATU bypass state while transmitting — halt TX first".to_string(),
            ));
        }
        let Some(ref mut rig) = self.running else {
            return Err((
                ErrorCode::RadioNotReady,
                format!(
                    "Radio '{}' is in state {}",
                    self.profile.radio_id,
                    self.snapshot.lifecycle_state.as_str()
                ),
            ));
        };
        if upper == "TUNER" && rig.client.get_ptt().await.ok().flatten() == Some(true) {
            return Err((
                ErrorCode::CatCommandFailed,
                "Cannot change ATU bypass state while transmitting — halt TX first".to_string(),
            ));
        }
        rig.client
            .set_func(&upper, enabled)
            .await
            .map_err(|e| map_rigctld_err(e, ErrorCode::CatCommandFailed))?;
        let confirmed = rig
            .client
            .get_func(&upper)
            .await
            .ok()
            .flatten()
            .unwrap_or(enabled);
        self.snapshot
            .settings
            .funcs
            .insert(upper.clone(), confirmed);
        self.snapshot.last_poll_utc = Some(now_utc_str());
        self.publish_snapshot(Some(format!(
            "Function {upper} {}",
            if confirmed { "ON" } else { "OFF" }
        )));
        Ok(json!({
            "radio_id": self.profile.radio_id,
            "name": upper,
            "enabled": confirmed,
        }))
    }

    async fn exec_atu_tune(&mut self) -> CmdResult {
        if self.snapshot.ptt || self.app_ptt_active {
            return Err((
                ErrorCode::CatCommandFailed,
                "Cannot start ATU tune while transmitting — halt TX first".to_string(),
            ));
        }

        let (has_vfo_op_tune, has_set_tuner, has_get_tuner) = {
            let caps = self.snapshot.capabilities.as_ref();
            (
                caps.is_none_or(|c| c.vfo_ops.iter().any(|op| op == "TUNE")),
                caps.is_none_or(|c| c.set_funcs.iter().any(|f| f == "TUNER")),
                caps.is_none_or(|c| c.get_funcs.iter().any(|f| f == "TUNER")),
            )
        };

        if !has_vfo_op_tune && !has_set_tuner {
            return Err((
                ErrorCode::CatCommandFailed,
                "Transceiver does not advertise CAT ATU tuning in Hamlib capabilities".to_string(),
            ));
        }

        let Some(ref mut rig) = self.running else {
            return Err((
                ErrorCode::RadioNotReady,
                format!(
                    "Radio '{}' is in state {}",
                    self.profile.radio_id,
                    self.snapshot.lifecycle_state.as_str()
                ),
            ));
        };

        if rig.client.get_ptt().await.ok().flatten() == Some(true) {
            return Err((
                ErrorCode::CatCommandFailed,
                "Cannot start ATU tune while transmitting — halt TX first".to_string(),
            ));
        }

        let method = if has_vfo_op_tune {
            match rig.client.vfo_op("TUNE").await {
                Ok(()) => "vfo_op_tune",
                Err(RigctldError::HamlibError { code: -4 | -11, .. }) if has_set_tuner => {
                    rig.client
                        .set_func("TUNER", true)
                        .await
                        .map_err(|e| map_rigctld_err(e, ErrorCode::CatCommandFailed))?;
                    "set_func_tuner"
                }
                Err(e) => return Err(map_rigctld_err(e, ErrorCode::CatCommandFailed)),
            }
        } else {
            rig.client
                .set_func("TUNER", true)
                .await
                .map_err(|e| map_rigctld_err(e, ErrorCode::CatCommandFailed))?;
            "set_func_tuner"
        };

        let tuner_enabled = if has_get_tuner {
            rig.client.get_func("TUNER").await.ok().flatten()
        } else {
            None
        };

        if let Some(enabled) = tuner_enabled {
            self.snapshot
                .settings
                .funcs
                .insert("TUNER".to_string(), enabled);
        }
        if has_get_tuner {
            self.atu_refresh_polls_remaining = 4;
        }
        self.snapshot.last_poll_utc = Some(now_utc_str());
        self.publish_snapshot(Some(format!("ATU tune triggered ({method})")));

        Ok(json!({
            "radio_id": self.profile.radio_id,
            "method": method,
            "tuner_enabled": self.snapshot.settings.funcs.get("TUNER").copied(),
        }))
    }

    async fn exec_refresh_settings(&mut self) -> CmdResult {
        let Some(ref mut rig) = self.running else {
            return Err((
                ErrorCode::RadioNotReady,
                format!(
                    "Radio '{}' is in state {}",
                    self.profile.radio_id,
                    self.snapshot.lifecycle_state.as_str()
                ),
            ));
        };
        let mut next = self.snapshot.settings.clone();
        Self::read_all_settings(
            &mut rig.client,
            self.snapshot.capabilities.as_ref(),
            self.snapshot.freq_hz,
            self.snapshot.mode.as_deref(),
            &mut next,
        )
        .await;
        self.snapshot.settings = next;
        self.snapshot.last_poll_utc = Some(now_utc_str());
        self.publish_snapshot(Some("Refreshed CAT radio settings".into()));
        Ok(json!({
            "radio_id": self.profile.radio_id,
            "settings": self.snapshot.settings,
        }))
    }

    async fn fail_closed_drop_ptt(
        &mut self,
        teardown_reason: &str,
        confirmed_detail: String,
        halt_auto_restart: bool,
    ) {
        let mut fail_closed = false;
        if let Some(ref mut rig) = self.running {
            let ptt_off = rig
                .client
                .set_ptt_with_timeout(0, Duration::from_millis(300))
                .await;
            let check =
                tokio::time::timeout(Duration::from_millis(500), rig.client.get_ptt()).await;
            let tx_still_active_or_unknown =
                ptt_off.is_err() || matches!(check, Ok(Ok(Some(true))) | Ok(Err(_)) | Err(_));
            if tx_still_active_or_unknown {
                fail_closed = true;
            }
        }
        if fail_closed {
            self.pending_recovery_at = None;
            self.pending_standby_probe_at = None;
            if halt_auto_restart {
                self.halted_by_operator = true;
            }
            self.teardown_rig(teardown_reason).await;
            self.snapshot.last_error = Some(teardown_reason.to_string());
            self.set_state(
                RadioLifecycleState::Configured,
                Some(teardown_reason.to_string()),
            );
        } else {
            self.app_ptt_active = false;
            self.pending_tx_swr_at = None;
            self.snapshot.ptt = false;
            self.snapshot.settings.tx_swr_live = false;
            self.publish_snapshot(Some(confirmed_detail));
        }
    }

    async fn teardown_rig(&mut self, reason: &str) {
        if let Some(mut rig) = self.running.take() {
            debug!(radio_id = %self.profile.radio_id, pid = rig.process.pid(), reason, "tearing down rigctld");
            rig.process.shutdown_gracefully(Some(&mut rig.client)).await;
        }
        self.snapshot.rigctld_pid = None;
        self.snapshot.ptt = false;
        self.snapshot.settings.tx_swr_live = false;
        self.app_ptt_active = false;
        self.pending_tx_swr_at = None;
        self.atu_refresh_polls_remaining = 0;
    }

    fn set_state(&mut self, new_state: RadioLifecycleState, detail: Option<String>) {
        let changed = self.snapshot.lifecycle_state != new_state;
        self.snapshot.lifecycle_state = new_state;
        self.publish_snapshot(detail.clone());

        if changed {
            if let Ok(station) = self.store.get_station_config() {
                let env = TelemetryEnvelope::new(
                    station.station_id,
                    Some(self.profile.radio_id.clone()),
                    "radio.lifecycle",
                    false,
                    json!({
                        "lifecycle_state": new_state.as_str(),
                        "rigctld_port": self.snapshot.rigctld_port,
                        "rigctld_pid": self.snapshot.rigctld_pid,
                        "bound_serial_path": self.snapshot.bound_serial_path,
                        "recovery_attempts": self.snapshot.recovery_attempts,
                        "last_error": self.snapshot.last_error,
                        "detail": detail,
                    }),
                );
                let _ = self.store.enqueue_telemetry(&env);
            }
        }
    }

    fn sync_shared_snapshot(&mut self) {
        self.snapshot.updated_at_utc = now_utc_str();
        if let Ok(mut guard) = self.snapshots.write() {
            guard.insert(self.profile.radio_id.clone(), self.snapshot.clone());
        }
    }

    fn publish_snapshot(&mut self, detail: Option<String>) {
        self.sync_shared_snapshot();
        let _ = self.ws_tx.send(WsBroadcastEvent::RadioState {
            radio_id: self.profile.radio_id.clone(),
            lifecycle_state: self.snapshot.lifecycle_state.as_str().to_string(),
            freq_hz: self.snapshot.freq_hz,
            band: self.snapshot.band.clone(),
            mode: self.snapshot.mode.clone(),
            passband_hz: self.snapshot.passband_hz,
            ptt: self.snapshot.ptt,
            bound_serial_path: self.snapshot.bound_serial_path.clone(),
            rigctld_port: Some(self.snapshot.rigctld_port),
            rigctld_pid: self.snapshot.rigctld_pid,
            last_error: self.snapshot.last_error.clone(),
            recovery_attempts: Some(self.snapshot.recovery_attempts),
            capabilities: self.snapshot.capabilities.clone().map(Box::new),
            settings: Some(Box::new(self.snapshot.settings.clone())),
            detail,
        });
    }
}

fn map_rigctld_err(err: RigctldError, default_code: ErrorCode) -> (ErrorCode, String) {
    match err {
        RigctldError::PortBusy(_) => (ErrorCode::PortUnavailable, err.to_string()),
        RigctldError::RadioPoweredOff(_)
        | RigctldError::PermissionDenied(_)
        | RigctldError::Timeout(_) => (ErrorCode::CatUnavailable, err.to_string()),
        _ => (default_code, err.to_string()),
    }
}
