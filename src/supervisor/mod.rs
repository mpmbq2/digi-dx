pub mod discovery;
pub mod radio_worker;
pub mod rigctld;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock, Weak};
use std::time::Duration;

use async_trait::async_trait;
use serde::Serialize;
use serde_json::json;
use tokio::sync::{broadcast, mpsc, oneshot, Mutex as AsyncMutex};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::command_bus::{ErrorCode, WsBroadcastEvent};
use crate::config::DaemonConfig;
use crate::preflight::{resolve_executable, RIGCTLD_FALLBACK_PATHS, RIGCTL_FALLBACK_PATHS};
use crate::store::{now_utc_str, RadioProfile, StateStore, StoreError, UsbDeviceRecord};
use crate::supervisor::discovery::{
    match_profile_to_device, spawn_hotplug_watchers, DeviceScanner, MatchOutcome, OsDeviceScanner,
    ScannedSerialDevice, WatcherGuards,
};
use crate::supervisor::radio_worker::{
    CmdResult, RadioLifecycleState, RadioRuntimeSnapshot, RadioWorker, WorkerCmd, WorkerTiming,
};
use crate::supervisor::rigctld::{load_rig_capabilities, RigCapabilities};
use crate::watchdog::{PttAbortTarget, PttWatchdog};

#[derive(Debug, Clone)]
pub struct SupervisorConfig {
    pub rigctld_bin: String,
    pub rigctl_bin: String,
    pub serial_by_id_dir: PathBuf,
    pub enable_os_netlink: bool,
    pub debounce_duration: Duration,
    pub reconcile_interval: Duration,
    pub timing: WorkerTiming,
}

impl SupervisorConfig {
    pub fn from_daemon_config(cfg: &DaemonConfig) -> Self {
        let rigctld_bin = cfg
            .rigctld_path
            .as_ref()
            .map(|p| p.display().to_string())
            .or_else(|| {
                resolve_executable("rigctld", None, RIGCTLD_FALLBACK_PATHS)
                    .map(|p| p.display().to_string())
            })
            .unwrap_or_else(|| "rigctld".to_string());
        let rigctl_bin = cfg
            .rigctl_path
            .as_ref()
            .map(|p| p.display().to_string())
            .or_else(|| {
                resolve_executable("rigctl", None, RIGCTL_FALLBACK_PATHS)
                    .map(|p| p.display().to_string())
            })
            .unwrap_or_else(|| "rigctl".to_string());

        let default_scanner = OsDeviceScanner::default();
        Self {
            rigctld_bin,
            rigctl_bin,
            serial_by_id_dir: default_scanner.serial_by_id_dir,
            enable_os_netlink: cfg!(target_os = "linux"),
            debounce_duration: Duration::from_millis(250),
            reconcile_interval: Duration::from_secs(5),
            timing: WorkerTiming::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct UsbInventoryEntry {
    pub device_key: String,
    pub os_path: String,
    pub real_tty_path: Option<String>,
    pub usb_vid: Option<String>,
    pub usb_pid: Option<String>,
    pub usb_serial: Option<String>,
    pub usb_interface: Option<String>,
    pub usb_topology_path: Option<String>,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub is_connected: bool,
    pub assigned_radio_id: Option<String>,
    pub device_state: String,
    pub source: String,
    pub first_seen_utc: String,
    pub last_seen_utc: String,
}

struct WorkerHandle {
    tx: mpsc::Sender<WorkerCmd>,
    cancel: CancellationToken,
    join: JoinHandle<()>,
}

pub struct DeviceSupervisor {
    store: StateStore,
    ws_tx: broadcast::Sender<WsBroadcastEvent>,
    config: SupervisorConfig,
    scanner: Arc<dyn DeviceScanner>,
    snapshots: Arc<RwLock<HashMap<String, RadioRuntimeSnapshot>>>,
    capabilities_cache: Mutex<HashMap<i64, RigCapabilities>>,
    workers: AsyncMutex<HashMap<String, WorkerHandle>>,
    reconcile_lock: AsyncMutex<()>,
    last_connected_keys: Mutex<Option<Vec<String>>>,
    topology_warned: Mutex<HashSet<String>>,
    watchdog: Mutex<Option<Weak<PttWatchdog>>>,
    shutdown: Mutex<Option<CancellationToken>>,
    watcher_guards: Mutex<Option<WatcherGuards>>,
}

impl DeviceSupervisor {
    pub fn new(
        store: StateStore,
        ws_tx: broadcast::Sender<WsBroadcastEvent>,
        config: SupervisorConfig,
        scanner: Arc<dyn DeviceScanner>,
    ) -> Arc<Self> {
        Arc::new(Self {
            store,
            ws_tx,
            config,
            scanner,
            snapshots: Arc::new(RwLock::new(HashMap::new())),
            capabilities_cache: Mutex::new(HashMap::new()),
            workers: AsyncMutex::new(HashMap::new()),
            reconcile_lock: AsyncMutex::new(()),
            last_connected_keys: Mutex::new(None),
            topology_warned: Mutex::new(HashSet::new()),
            watchdog: Mutex::new(None),
            shutdown: Mutex::new(None),
            watcher_guards: Mutex::new(None),
        })
    }

    pub fn attach_watchdog(&self, watchdog: Weak<PttWatchdog>) {
        let mut guard = self.watchdog.lock().expect("watchdog lock poisoned");
        *guard = Some(watchdog);
    }

    pub async fn start(self: &Arc<Self>, shutdown: CancellationToken) {
        {
            let mut guard = self.shutdown.lock().expect("shutdown lock poisoned");
            *guard = Some(shutdown.clone());
        }

        self.reconcile_now().await;

        let sup = Arc::clone(self);
        let handle = tokio::runtime::Handle::current();
        let guards = spawn_hotplug_watchers(
            &self.config.serial_by_id_dir,
            self.config.enable_os_netlink,
            self.config.debounce_duration,
            self.config.reconcile_interval,
            shutdown,
            Arc::new(move || {
                let s = Arc::clone(&sup);
                handle.spawn(async move {
                    s.reconcile_now().await;
                });
            }),
        );

        let mut wg = self.watcher_guards.lock().expect("watcher lock poisoned");
        *wg = Some(guards);
    }

    pub async fn reconcile_now(&self) {
        let _guard = self.reconcile_lock.lock().await;
        let scanned = self.scanner.scan_serial();
        let now = now_utc_str();

        let connected_keys: Vec<String> = scanned.iter().map(|d| d.device_key.clone()).collect();
        for dev in &scanned {
            let rec = UsbDeviceRecord {
                device_key: dev.device_key.clone(),
                os_path: dev.os_path.clone(),
                real_tty_path: dev.real_tty_path.clone(),
                usb_vid: dev.usb_vid.clone(),
                usb_pid: dev.usb_pid.clone(),
                usb_serial: dev.usb_serial.clone(),
                usb_interface: dev.usb_interface.clone(),
                usb_topology_path: dev.usb_topology_path.clone(),
                manufacturer: dev.manufacturer.clone(),
                product: dev.product.clone(),
                is_connected: true,
                first_seen_utc: now.clone(),
                last_seen_utc: now.clone(),
            };
            if let Err(e) = self.store.upsert_usb_device(&rec) {
                warn!(device_key = %dev.device_key, error = %e, "failed to upsert usb_device");
            }
        }
        let _ = self
            .store
            .mark_usb_devices_disconnected_except(&connected_keys);

        let keys_changed = {
            let mut prev = self
                .last_connected_keys
                .lock()
                .expect("last_connected_keys lock poisoned");
            let changed = prev.as_ref() != Some(&connected_keys);
            *prev = Some(connected_keys);
            changed
        };

        let profiles = match self.store.list_radio_profiles() {
            Ok(p) => p,
            Err(e) => {
                warn!(error = %e, "failed to list radio_profiles during reconcile");
                return;
            }
        };

        let mut worker_cmds: Vec<(mpsc::Sender<WorkerCmd>, WorkerCmd)> = Vec::new();
        {
            let mut workers = self.workers.lock().await;
            let active_ids: HashSet<String> = profiles.iter().map(|p| p.radio_id.clone()).collect();

            // Stop workers whose profiles no longer exist
            let stale_ids: Vec<String> = workers
                .keys()
                .filter(|id| !active_ids.contains(*id))
                .cloned()
                .collect();
            for stale_id in stale_ids {
                if let Some(h) = workers.remove(&stale_id) {
                    h.cancel.cancel();
                    let _ = h.tx.send(WorkerCmd::Shutdown).await;
                    let _ = h.join.await;
                }
            }

            for profile in &profiles {
                if !workers.contains_key(&profile.radio_id) {
                    let h = self.spawn_worker(profile.clone());
                    workers.insert(profile.radio_id.clone(), h);
                }
                if profile.is_dummy || profile.hamlib_model == 1 {
                    continue;
                }
                let Some(handle) = workers.get(&profile.radio_id) else {
                    continue;
                };

                let hist = profile
                    .serial_device_key
                    .as_deref()
                    .and_then(|k| self.store.get_usb_device(k).ok().flatten());
                match match_profile_to_device(profile, hist.as_ref(), &scanned) {
                    MatchOutcome::Matched {
                        device,
                        topology_warning,
                    } => {
                        if let Some(warn_msg) = topology_warning {
                            let should_alert = {
                                let mut w = self
                                    .topology_warned
                                    .lock()
                                    .expect("topology_warned lock poisoned");
                                w.insert(profile.radio_id.clone())
                            };
                            if should_alert {
                                let _ = self.ws_tx.send(WsBroadcastEvent::PreflightAlert {
                                    severity: "warn".to_string(),
                                    title: format!("Serial-less USB Fallback ({})", profile.name),
                                    detail: warn_msg,
                                    occurred_at_utc: now.clone(),
                                });
                            }
                        }
                        worker_cmds.push((
                            handle.tx.clone(),
                            WorkerCmd::DeviceAttached {
                                device_key: device.device_key,
                                serial_path: device.os_path,
                            },
                        ));
                    }
                    MatchOutcome::Ambiguous(reason) => {
                        worker_cmds
                            .push((handle.tx.clone(), WorkerCmd::HardwareAmbiguous { reason }));
                    }
                    MatchOutcome::NotFound => {
                        if let Some(wd) = self
                            .watchdog
                            .lock()
                            .expect("watchdog lock poisoned")
                            .as_ref()
                            .and_then(Weak::upgrade)
                        {
                            let rid = profile.radio_id.clone();
                            tokio::spawn(async move {
                                wd.on_device_detached(&rid).await;
                            });
                        }
                        worker_cmds.push((handle.tx.clone(), WorkerCmd::DeviceDetached));
                    }
                }
            }
        }

        for (tx, cmd) in worker_cmds {
            let _ = tx.send(cmd).await;
        }

        if keys_changed {
            debug!(count = scanned.len(), "USB serial inventory changed");
            if let Ok(inv) = self.list_usb_inventory() {
                let _ = self.ws_tx.send(WsBroadcastEvent::UsbDevicesChanged {
                    devices: serde_json::to_value(inv).unwrap_or_else(|_| json!([])),
                });
            }
        }
    }

    pub fn get_capabilities_for_model(&self, model_id: i64) -> Option<RigCapabilities> {
        if model_id <= 0 {
            return None;
        }
        if let Ok(guard) = self.capabilities_cache.lock() {
            if let Some(cached) = guard.get(&model_id) {
                return Some(cached.clone());
            }
        }
        let loaded = load_rig_capabilities(&self.config.rigctl_bin, model_id)?;
        if let Ok(mut guard) = self.capabilities_cache.lock() {
            guard.insert(model_id, loaded.clone());
        }
        Some(loaded)
    }

    fn spawn_worker(&self, profile: RadioProfile) -> WorkerHandle {
        let (tx, rx) = mpsc::channel(32);
        let root_cancel = self
            .shutdown
            .lock()
            .expect("shutdown lock poisoned")
            .clone()
            .unwrap_or_default();
        let worker_cancel = root_cancel.child_token();
        let caps = self.get_capabilities_for_model(profile.hamlib_model);

        let worker = RadioWorker::new(
            profile,
            caps,
            self.config.rigctld_bin.clone(),
            self.config.timing.clone(),
            self.store.clone(),
            self.ws_tx.clone(),
            Arc::clone(&self.snapshots),
            rx,
            worker_cancel.clone(),
        );
        let join = tokio::spawn(worker.run());
        WorkerHandle {
            tx,
            cancel: worker_cancel,
            join,
        }
    }

    pub async fn on_profile_created(&self, profile: RadioProfile) {
        let radio_id = profile.radio_id.clone();
        {
            let mut workers = self.workers.lock().await;
            workers
                .entry(radio_id)
                .or_insert_with(|| self.spawn_worker(profile));
        }
        self.reconcile_now().await;
    }

    pub async fn on_profile_updated(&self, profile: RadioProfile) {
        let caps = self.get_capabilities_for_model(profile.hamlib_model);
        let tx_opt = {
            let workers = self.workers.lock().await;
            workers.get(&profile.radio_id).map(|h| h.tx.clone())
        };
        if let Some(tx) = tx_opt {
            let _ = tx
                .send(WorkerCmd::ProfileUpdated {
                    profile: Box::new(profile),
                    capabilities: caps.map(Box::new),
                })
                .await;
        }
        self.reconcile_now().await;
    }

    pub async fn on_profile_deleted(&self, radio_id: &str) {
        let removed = {
            let mut workers = self.workers.lock().await;
            workers.remove(radio_id)
        };
        if let Some(h) = removed {
            h.cancel.cancel();
            let _ = h.tx.send(WorkerCmd::Shutdown).await;
            let _ = h.join.await;
        }
        if let Ok(inv) = self.list_usb_inventory() {
            let _ = self.ws_tx.send(WsBroadcastEvent::UsbDevicesChanged {
                devices: serde_json::to_value(inv).unwrap_or_else(|_| json!([])),
            });
        }
    }

    pub async fn restart_radio(&self, radio_id: &str) -> CmdResult {
        let tx = self.worker_sender(radio_id).await?;
        let (reply_tx, reply_rx) = oneshot::channel();
        tx.send(WorkerCmd::Restart {
            reply: Some(reply_tx),
        })
        .await
        .map_err(|_| (ErrorCode::InternalError, "radio worker stopped".to_string()))?;
        reply_rx.await.map_err(|_| {
            (
                ErrorCode::InternalError,
                "radio worker dropped reply".into(),
            )
        })?
    }

    pub async fn stop_radio(&self, radio_id: &str) -> CmdResult {
        let tx = self.worker_sender(radio_id).await?;
        let (reply_tx, reply_rx) = oneshot::channel();
        tx.send(WorkerCmd::Stop {
            reply: Some(reply_tx),
        })
        .await
        .map_err(|_| (ErrorCode::InternalError, "radio worker stopped".to_string()))?;
        reply_rx.await.map_err(|_| {
            (
                ErrorCode::InternalError,
                "radio worker dropped reply".into(),
            )
        })?
    }

    pub async fn test_cat(&self, radio_id: &str) -> CmdResult {
        let tx = self.worker_sender(radio_id).await?;
        let (reply_tx, reply_rx) = oneshot::channel();
        tx.send(WorkerCmd::TestCat { reply: reply_tx })
            .await
            .map_err(|_| (ErrorCode::InternalError, "radio worker stopped".to_string()))?;
        reply_rx.await.map_err(|_| {
            (
                ErrorCode::InternalError,
                "radio worker dropped reply".into(),
            )
        })?
    }

    pub async fn test_ptt(&self, radio_id: &str, duration_ms: u64) -> CmdResult {
        let tx = self.worker_sender(radio_id).await?;
        let (reply_tx, reply_rx) = oneshot::channel();
        tx.send(WorkerCmd::TestPtt {
            duration_ms,
            reply: reply_tx,
        })
        .await
        .map_err(|_| (ErrorCode::InternalError, "radio worker stopped".to_string()))?;
        reply_rx.await.map_err(|_| {
            (
                ErrorCode::InternalError,
                "radio worker dropped reply".into(),
            )
        })?
    }

    pub async fn set_freq(&self, radio_id: &str, freq_hz: u64) -> CmdResult {
        let tx = self.worker_sender(radio_id).await?;
        let (reply_tx, reply_rx) = oneshot::channel();
        tx.send(WorkerCmd::SetFreq {
            freq_hz,
            reply: reply_tx,
        })
        .await
        .map_err(|_| (ErrorCode::InternalError, "radio worker stopped".to_string()))?;
        reply_rx.await.map_err(|_| {
            (
                ErrorCode::InternalError,
                "radio worker dropped reply".into(),
            )
        })?
    }

    pub async fn set_mode(&self, radio_id: &str, mode: &str, passband_hz: u32) -> CmdResult {
        let tx = self.worker_sender(radio_id).await?;
        let (reply_tx, reply_rx) = oneshot::channel();
        tx.send(WorkerCmd::SetMode {
            mode: mode.to_string(),
            passband_hz,
            reply: reply_tx,
        })
        .await
        .map_err(|_| (ErrorCode::InternalError, "radio worker stopped".to_string()))?;
        reply_rx.await.map_err(|_| {
            (
                ErrorCode::InternalError,
                "radio worker dropped reply".into(),
            )
        })?
    }

    pub async fn set_vfo(&self, radio_id: &str, vfo: &str) -> CmdResult {
        let tx = self.worker_sender(radio_id).await?;
        let (reply_tx, reply_rx) = oneshot::channel();
        tx.send(WorkerCmd::SetVfo {
            vfo: vfo.to_string(),
            reply: reply_tx,
        })
        .await
        .map_err(|_| (ErrorCode::InternalError, "radio worker stopped".to_string()))?;
        reply_rx.await.map_err(|_| {
            (
                ErrorCode::InternalError,
                "radio worker dropped reply".into(),
            )
        })?
    }

    pub async fn set_split(&self, radio_id: &str, enabled: bool, tx_vfo: &str) -> CmdResult {
        let tx = self.worker_sender(radio_id).await?;
        let (reply_tx, reply_rx) = oneshot::channel();
        tx.send(WorkerCmd::SetSplit {
            enabled,
            tx_vfo: tx_vfo.to_string(),
            reply: reply_tx,
        })
        .await
        .map_err(|_| (ErrorCode::InternalError, "radio worker stopped".to_string()))?;
        reply_rx.await.map_err(|_| {
            (
                ErrorCode::InternalError,
                "radio worker dropped reply".into(),
            )
        })?
    }

    pub async fn set_rit(&self, radio_id: &str, offset_hz: i32) -> CmdResult {
        let tx = self.worker_sender(radio_id).await?;
        let (reply_tx, reply_rx) = oneshot::channel();
        tx.send(WorkerCmd::SetRit {
            offset_hz,
            reply: reply_tx,
        })
        .await
        .map_err(|_| (ErrorCode::InternalError, "radio worker stopped".to_string()))?;
        reply_rx.await.map_err(|_| {
            (
                ErrorCode::InternalError,
                "radio worker dropped reply".into(),
            )
        })?
    }

    pub async fn set_xit(&self, radio_id: &str, offset_hz: i32) -> CmdResult {
        let tx = self.worker_sender(radio_id).await?;
        let (reply_tx, reply_rx) = oneshot::channel();
        tx.send(WorkerCmd::SetXit {
            offset_hz,
            reply: reply_tx,
        })
        .await
        .map_err(|_| (ErrorCode::InternalError, "radio worker stopped".to_string()))?;
        reply_rx.await.map_err(|_| {
            (
                ErrorCode::InternalError,
                "radio worker dropped reply".into(),
            )
        })?
    }

    pub async fn set_level(&self, radio_id: &str, name: &str, value: f64) -> CmdResult {
        let tx = self.worker_sender(radio_id).await?;
        let (reply_tx, reply_rx) = oneshot::channel();
        tx.send(WorkerCmd::SetLevel {
            name: name.to_string(),
            value,
            reply: reply_tx,
        })
        .await
        .map_err(|_| (ErrorCode::InternalError, "radio worker stopped".to_string()))?;
        reply_rx.await.map_err(|_| {
            (
                ErrorCode::InternalError,
                "radio worker dropped reply".into(),
            )
        })?
    }

    pub async fn set_func(&self, radio_id: &str, name: &str, enabled: bool) -> CmdResult {
        let tx = self.worker_sender(radio_id).await?;
        let (reply_tx, reply_rx) = oneshot::channel();
        tx.send(WorkerCmd::SetFunc {
            name: name.to_string(),
            enabled,
            reply: reply_tx,
        })
        .await
        .map_err(|_| (ErrorCode::InternalError, "radio worker stopped".to_string()))?;
        reply_rx.await.map_err(|_| {
            (
                ErrorCode::InternalError,
                "radio worker dropped reply".into(),
            )
        })?
    }

    pub async fn atu_tune(&self, radio_id: &str) -> CmdResult {
        let tx = self.worker_sender(radio_id).await?;
        let (reply_tx, reply_rx) = oneshot::channel();
        tx.send(WorkerCmd::AtuTune { reply: reply_tx })
            .await
            .map_err(|_| (ErrorCode::InternalError, "radio worker stopped".to_string()))?;
        reply_rx.await.map_err(|_| {
            (
                ErrorCode::InternalError,
                "radio worker dropped reply".into(),
            )
        })?
    }

    pub async fn refresh_settings(&self, radio_id: &str) -> CmdResult {
        let tx = self.worker_sender(radio_id).await?;
        let (reply_tx, reply_rx) = oneshot::channel();
        tx.send(WorkerCmd::RefreshSettings { reply: reply_tx })
            .await
            .map_err(|_| (ErrorCode::InternalError, "radio worker stopped".to_string()))?;
        reply_rx.await.map_err(|_| {
            (
                ErrorCode::InternalError,
                "radio worker dropped reply".into(),
            )
        })?
    }

    pub async fn emergency_halt(&self, radio_id: Option<&str>) {
        let targets: Vec<mpsc::Sender<WorkerCmd>> = {
            let workers = self.workers.lock().await;
            match radio_id {
                Some(rid) => workers
                    .get(rid)
                    .map(|h| vec![h.tx.clone()])
                    .unwrap_or_default(),
                None => workers.values().map(|h| h.tx.clone()).collect(),
            }
        };
        for tx in targets {
            let _ = tx.send(WorkerCmd::EmergencyHalt).await;
        }
    }

    pub async fn set_ptt(&self, radio_id: &str, active: bool) -> CmdResult {
        let tx = self.worker_sender(radio_id).await?;
        let (reply_tx, reply_rx) = oneshot::channel();
        tx.send(WorkerCmd::SetPtt {
            active,
            reply: reply_tx,
        })
        .await
        .map_err(|_| (ErrorCode::InternalError, "radio worker stopped".to_string()))?;
        reply_rx.await.map_err(|_| {
            (
                ErrorCode::InternalError,
                "radio worker dropped reply".into(),
            )
        })?
    }

    pub async fn watchdog_abort(&self, radio_id: &str, reason: String) {
        let tx_opt = {
            let workers = self.workers.lock().await;
            workers.get(radio_id).map(|h| h.tx.clone())
        };
        if let Some(tx) = tx_opt {
            let _ = tx.send(WorkerCmd::WatchdogAbort { reason }).await;
        }
    }

    pub async fn set_session_active(&self, radio_id: &str, active: bool) {
        let tx_opt = {
            let workers = self.workers.lock().await;
            workers.get(radio_id).map(|h| h.tx.clone())
        };
        if let Some(tx) = tx_opt {
            let _ = tx.send(WorkerCmd::SetSessionActive(active)).await;
        }
    }

    pub async fn shutdown_all(&self) {
        if let Some(cancel) = self.shutdown.lock().expect("shutdown lock poisoned").take() {
            cancel.cancel();
        }
        {
            let mut wg = self.watcher_guards.lock().expect("watcher lock poisoned");
            *wg = None;
        }

        let handles: Vec<WorkerHandle> = {
            let mut workers = self.workers.lock().await;
            workers.drain().map(|(_, h)| h).collect()
        };
        for h in handles {
            let _ = h.tx.send(WorkerCmd::Shutdown).await;
            let _ = h.join.await;
        }
        info!("all radio workers and rigctld subprocesses shut down");
    }

    async fn worker_sender(
        &self,
        radio_id: &str,
    ) -> Result<mpsc::Sender<WorkerCmd>, (ErrorCode, String)> {
        if let Some(tx) = self
            .workers
            .lock()
            .await
            .get(radio_id)
            .map(|h| h.tx.clone())
        {
            return Ok(tx);
        }
        match self.store.get_radio_profile(radio_id) {
            Ok(Some(_)) => Err((
                ErrorCode::RadioNotReady,
                format!("Worker for radio '{radio_id}' is not active yet"),
            )),
            Ok(None) => Err((
                ErrorCode::RadioNotFound,
                format!("Radio profile '{radio_id}' not found"),
            )),
            Err(e) => Err((ErrorCode::InternalError, e.to_string())),
        }
    }

    pub fn get_radio_snapshot(&self, radio_id: &str) -> Option<RadioRuntimeSnapshot> {
        self.snapshots
            .read()
            .ok()
            .and_then(|g| g.get(radio_id).cloned())
    }

    pub fn list_radio_snapshots(&self) -> Vec<RadioRuntimeSnapshot> {
        self.snapshots
            .read()
            .map(|g| g.values().cloned().collect())
            .unwrap_or_default()
    }

    pub fn active_ready_count(&self) -> usize {
        self.snapshots
            .read()
            .map(|g| {
                g.values()
                    .filter(|s| {
                        matches!(
                            s.lifecycle_state,
                            RadioLifecycleState::Ready | RadioLifecycleState::ActiveSession
                        )
                    })
                    .count()
            })
            .unwrap_or(0)
    }

    pub fn any_ptt_active(&self) -> bool {
        self.snapshots
            .read()
            .map(|g| g.values().any(|s| s.ptt))
            .unwrap_or(false)
    }

    pub fn list_usb_inventory(&self) -> Result<Vec<UsbInventoryEntry>, StoreError> {
        let devices = self.store.list_usb_devices()?;
        let profiles = self.store.list_radio_profiles()?;
        let snapshots = self.snapshots.read().map(|g| g.clone()).unwrap_or_default();

        Ok(devices
            .into_iter()
            .map(|d| {
                let assigned = profiles
                    .iter()
                    .find(|p| p.serial_device_key.as_deref() == Some(d.device_key.as_str()));
                let device_state = if !d.is_connected {
                    "DISCONNECTED".to_string()
                } else if let Some(prof) = assigned {
                    snapshots
                        .get(&prof.radio_id)
                        .map(|s| s.lifecycle_state.as_str().to_string())
                        .unwrap_or_else(|| "CONFIGURED".to_string())
                } else {
                    "UNCONFIGURED".to_string()
                };

                UsbInventoryEntry {
                    device_key: d.device_key,
                    os_path: d.os_path,
                    real_tty_path: d.real_tty_path,
                    usb_vid: d.usb_vid,
                    usb_pid: d.usb_pid,
                    usb_serial: d.usb_serial,
                    usb_interface: d.usb_interface,
                    usb_topology_path: d.usb_topology_path,
                    manufacturer: d.manufacturer,
                    product: d.product,
                    is_connected: d.is_connected,
                    assigned_radio_id: assigned.map(|p| p.radio_id.clone()),
                    device_state,
                    source: "supervisor".to_string(),
                    first_seen_utc: d.first_seen_utc,
                    last_seen_utc: d.last_seen_utc,
                }
            })
            .collect())
    }
}

pub fn build_dummy_scanner_for_test(devices: Vec<ScannedSerialDevice>) -> Arc<dyn DeviceScanner> {
    Arc::new(crate::supervisor::discovery::MockDeviceScanner::new(
        devices,
    ))
}

#[async_trait]
impl PttAbortTarget for DeviceSupervisor {
    async fn abort_ptt(&self, radio_id: &str, reason: &str) {
        self.watchdog_abort(radio_id, reason.to_string()).await;
    }
}
