pub mod routes;
pub mod ws;

use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use axum::routing::{get, post};
use axum::Router;
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use tracing::{error, info, warn};

use crate::assets;
use crate::command_bus::leases::ControlLeaseManager;
use crate::command_bus::{CommandBus, WsBroadcastEvent};
use crate::config::DaemonConfig;
use crate::preflight::{print_human_report, run_preflight, PreflightReport};
use crate::qso::SessionManager;
use crate::store::StateStore;
use crate::supervisor::discovery::{DeviceScanner, OsDeviceScanner};
use crate::supervisor::radio_worker::WorkerTiming;
use crate::supervisor::rigctld::{load_hamlib_models, HamlibModelEntry};
use crate::supervisor::{build_dummy_scanner_for_test, DeviceSupervisor, SupervisorConfig};
use crate::telemetry::{
    GcpPubSubSinkStub, NoopTelemetrySink, TelemetryEnvelope, TelemetryOutboxWorker, TelemetrySink,
};
use crate::watchdog::{PttAbortTarget, PttWatchdog, PttWatchdogConfig};

pub struct AppState {
    pub config: DaemonConfig,
    pub store: StateStore,
    pub bus: Arc<CommandBus>,
    pub supervisor: Arc<DeviceSupervisor>,
    pub watchdog: Arc<PttWatchdog>,
    pub sessions: Arc<SessionManager>,
    pub hamlib_models: Arc<Vec<HamlibModelEntry>>,
    pub preflight: Arc<RwLock<PreflightReport>>,
    pub ws_tx: broadcast::Sender<WsBroadcastEvent>,
    pub started_at: Instant,
    pub sink_name: String,
}

impl AppState {
    pub fn build_for_test(
        config: DaemonConfig,
        store: StateStore,
        preflight: PreflightReport,
    ) -> Arc<Self> {
        let mut sup_cfg = SupervisorConfig::from_daemon_config(&config);
        sup_cfg.enable_os_netlink = false;
        Self::build_for_test_with_supervisor(
            config,
            store,
            preflight,
            sup_cfg,
            build_dummy_scanner_for_test(vec![]),
        )
    }

    pub fn build_for_test_with_supervisor(
        config: DaemonConfig,
        store: StateStore,
        preflight: PreflightReport,
        sup_cfg: SupervisorConfig,
        scanner: Arc<dyn DeviceScanner>,
    ) -> Arc<Self> {
        Self::build_for_test_with_watchdog(
            config,
            store,
            preflight,
            sup_cfg,
            scanner,
            PttWatchdogConfig::default(),
        )
    }

    pub fn build_for_test_with_watchdog(
        config: DaemonConfig,
        store: StateStore,
        preflight: PreflightReport,
        mut sup_cfg: SupervisorConfig,
        scanner: Arc<dyn DeviceScanner>,
        watchdog_cfg: PttWatchdogConfig,
    ) -> Arc<Self> {
        sup_cfg.enable_os_netlink = false;
        let (ws_tx, _) = broadcast::channel(256);
        let leases = Arc::new(ControlLeaseManager::new());
        let supervisor = DeviceSupervisor::new(store.clone(), ws_tx.clone(), sup_cfg, scanner);
        let watchdog = PttWatchdog::new(
            watchdog_cfg,
            Arc::clone(&supervisor) as Arc<dyn PttAbortTarget>,
            store.clone(),
            ws_tx.clone(),
        );
        supervisor.attach_watchdog(Arc::downgrade(&watchdog));
        let jt9_data_dir = config.data_dir.join("jt9");
        let sessions = SessionManager::new(
            store.clone(),
            Arc::clone(&supervisor),
            Arc::clone(&watchdog),
            ws_tx.clone(),
            config.jt9_path.as_deref(),
            Some(jt9_data_dir.as_path()),
        );
        let bus = Arc::new(CommandBus::new(
            store.clone(),
            leases,
            Arc::clone(&supervisor),
            Arc::clone(&watchdog),
            Arc::clone(&sessions),
            config.auth_token.clone(),
            ws_tx.clone(),
        ));
        Arc::new(Self {
            config,
            store,
            bus,
            supervisor,
            watchdog,
            sessions,
            hamlib_models: Arc::new(vec![HamlibModelEntry {
                id: 1,
                manufacturer: "Hamlib".into(),
                model: "Dummy".into(),
                status: "Stable".into(),
            }]),
            preflight: Arc::new(RwLock::new(preflight)),
            ws_tx,
            started_at: Instant::now(),
            sink_name: "noop".to_string(),
        })
    }
}

pub fn fast_test_worker_timing() -> WorkerTiming {
    WorkerTiming {
        poll_interval: Duration::from_millis(150),
        recovery_backoffs: vec![
            Duration::from_millis(100),
            Duration::from_millis(200),
            Duration::from_millis(400),
        ],
        standby_poll_interval: Duration::from_millis(300),
    }
}

pub fn build_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/v1/health", get(routes::health))
        .route("/api/v1/preflight", get(routes::preflight))
        .route("/api/v1/station", get(routes::station))
        .route("/api/v1/devices/usb", get(routes::devices_usb))
        .route("/api/v1/devices/audio", get(routes::devices_audio))
        .route("/api/v1/hamlib/models", get(routes::hamlib_models))
        .route("/api/v1/radios", get(routes::radios))
        .route("/api/v1/radios/{radio_id}", get(routes::radio_detail))
        .route("/api/v1/commands", post(routes::dispatch_command))
        .route("/api/v1/qsos", get(routes::qsos))
        .route("/api/v1/qsos/export.adi", get(routes::qsos_export_adi))
        .route("/api/v1/roster", get(routes::roster))
        .route("/api/v1/outbox/stats", get(routes::outbox_stats))
        .route("/api/v1/ws", get(ws::ws_handler))
        .fallback(assets::serve_embedded_ui)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

pub async fn serve_daemon(config: DaemonConfig) -> Result<(), Box<dyn std::error::Error>> {
    if config.auth_token.is_none() {
        warn!(
            "DIGI_DX_AUTH_TOKEN is unset; mutating LAN commands are open (per-radio control leases still apply)"
        );
    }

    let store = StateStore::open(config.db_path())?;
    let cfg_clone = config.clone();
    let preflight_report =
        tokio::task::spawn_blocking(move || run_preflight(&cfg_clone, false)).await?;

    if preflight_report.has_fatal() {
        print_human_report(&preflight_report);
        error!("startup preflight reported FATAL check failure; aborting daemon start");
        return Err("startup preflight failed on FATAL check".into());
    }

    if let Ok(station) = store.get_station_config() {
        let env = TelemetryEnvelope::new(
            station.station_id,
            None,
            "station.preflight",
            false,
            json!({
                "overall_status": preflight_report.overall_status,
                "active_ft8_decoder": preflight_report.active_ft8_decoder,
                "platform": preflight_report.platform,
                "checks": preflight_report.checks,
            }),
        );
        if let Err(e) = store.enqueue_telemetry(&env) {
            warn!(error = %e, "failed to enqueue startup station.preflight telemetry");
        }
    }

    let sink: Arc<dyn TelemetrySink> = if config.gcp_telemetry_enabled {
        match GcpPubSubSinkStub::new(
            config.gcp_project_id.clone(),
            config.gcp_topic_id.clone(),
            config.gcp_credentials_path.clone(),
        ) {
            Ok(stub) => Arc::new(stub),
            Err(e) => {
                warn!(error = %e, "invalid GCP telemetry config; falling back to NoopTelemetrySink");
                Arc::new(NoopTelemetrySink)
            }
        }
    } else {
        Arc::new(NoopTelemetrySink)
    };
    let sink_name = sink.name().to_string();

    let shutdown = CancellationToken::new();
    let worker = TelemetryOutboxWorker::new(
        store.clone(),
        sink,
        config.outbox_max_rows,
        config.outbox_retention_days,
    );
    let worker_handle = tokio::spawn(worker.run(shutdown.clone()));

    let sup_cfg = SupervisorConfig::from_daemon_config(&config);
    let rigctl_bin = sup_cfg.rigctl_bin.clone();
    let hamlib_models = Arc::new(
        tokio::task::spawn_blocking(move || load_hamlib_models(&rigctl_bin))
            .await
            .unwrap_or_default(),
    );

    let (ws_tx, _) = broadcast::channel(256);
    let leases = Arc::new(ControlLeaseManager::new());
    let supervisor = DeviceSupervisor::new(
        store.clone(),
        ws_tx.clone(),
        sup_cfg,
        Arc::new(OsDeviceScanner::default()),
    );
    supervisor.start(shutdown.clone()).await;

    let watchdog = PttWatchdog::new(
        PttWatchdogConfig::default(),
        Arc::clone(&supervisor) as Arc<dyn PttAbortTarget>,
        store.clone(),
        ws_tx.clone(),
    );
    supervisor.attach_watchdog(Arc::downgrade(&watchdog));
    let jt9_data_dir = config.data_dir.join("jt9");
    let sessions = SessionManager::new(
        store.clone(),
        Arc::clone(&supervisor),
        Arc::clone(&watchdog),
        ws_tx.clone(),
        config.jt9_path.as_deref(),
        Some(jt9_data_dir.as_path()),
    );

    let bus = Arc::new(CommandBus::new(
        store.clone(),
        leases,
        Arc::clone(&supervisor),
        Arc::clone(&watchdog),
        Arc::clone(&sessions),
        config.auth_token.clone(),
        ws_tx.clone(),
    ));

    let state = Arc::new(AppState {
        config: config.clone(),
        store,
        bus,
        supervisor: Arc::clone(&supervisor),
        watchdog: Arc::clone(&watchdog),
        sessions: Arc::clone(&sessions),
        hamlib_models,
        preflight: Arc::new(RwLock::new(preflight_report)),
        ws_tx,
        started_at: Instant::now(),
        sink_name,
    });

    let router = build_router(state);
    let bind_addr = format!("{}:{}", config.bind, config.port);
    let listener = TcpListener::bind(&bind_addr).await?;
    let local_addr = listener.local_addr()?;
    info!("Digi-Dx v2 daemon listening on http://{local_addr}");

    let shutdown_for_srv = shutdown.clone();
    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            wait_for_shutdown_signal().await;
            info!("shutdown signal received, draining HTTP/WS server");
            shutdown_for_srv.cancel();
        })
        .await?;

    shutdown.cancel();
    sessions.stop_if_active().await;
    watchdog.disarm_all().await;
    supervisor.shutdown_all().await;
    let _ = worker_handle.await;
    info!("Digi-Dx v2 daemon exited cleanly");
    Ok(())
}

async fn wait_for_shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            sig.recv().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}
