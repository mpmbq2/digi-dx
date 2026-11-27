use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tempfile::tempdir;
use tokio::time::sleep;
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

use digi_dx::cli::ServeArgs;
use digi_dx::command_bus::{CommandEnvelope, CommandOrigin, CommandStatus, WsBroadcastEvent};
use digi_dx::config::DaemonConfig;
use digi_dx::preflight::{
    CheckSeverity, CheckStatus, OverallStatus, PlatformInfo, PreflightCheck, PreflightReport,
};
use digi_dx::server::{build_router, fast_test_worker_timing, AppState};
use digi_dx::store::StateStore;
use digi_dx::supervisor::discovery::{MockDeviceScanner, OsDeviceScanner, ScannedSerialDevice};
use digi_dx::supervisor::radio_worker::RadioLifecycleState;
use digi_dx::supervisor::{build_dummy_scanner_for_test, SupervisorConfig};

fn make_preflight() -> PreflightReport {
    PreflightReport {
        overall_status: OverallStatus::Ok,
        checked_at_utc: "2026-11-21T22:00:00Z".to_string(),
        platform: PlatformInfo {
            os: "linux".to_string(),
            arch: "x86_64".to_string(),
        },
        active_ft8_decoder: "ft8_lib_fallback".to_string(),
        checks: vec![PreflightCheck {
            id: "sqlite_storage".to_string(),
            status: CheckStatus::Pass,
            severity: CheckSeverity::Fatal,
            detail: "ok".to_string(),
            remediation: None,
        }],
    }
}

fn make_cfg(dir: &std::path::Path) -> DaemonConfig {
    DaemonConfig::from_serve_args(&ServeArgs {
        bind: "127.0.0.1".to_string(),
        port: 0,
        data_dir: Some(dir.to_path_buf()),
        auth_token: None,
    })
}

async fn wait_for_state(
    state: &AppState,
    radio_id: &str,
    target: RadioLifecycleState,
    timeout: Duration,
) -> digi_dx::supervisor::radio_worker::RadioRuntimeSnapshot {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Some(snap) = state.supervisor.get_radio_snapshot(radio_id) {
            if snap.lifecycle_state == target {
                return snap;
            }
        }
        sleep(Duration::from_millis(50)).await;
    }
    let last = state.supervisor.get_radio_snapshot(radio_id);
    panic!("timed out waiting for radio {radio_id} to reach {target:?}; last={last:?}");
}

fn cmd(actor: &str, radio_id: Option<&str>, kind: &str, payload: Value) -> CommandEnvelope {
    CommandEnvelope {
        command_id: uuid::Uuid::now_v7().to_string(),
        idempotency_key: None,
        origin: CommandOrigin::LocalUi,
        actor: actor.to_string(),
        radio_id: radio_id.map(str::to_string),
        kind: kind.to_string(),
        issued_at_utc: "2026-11-21T22:00:00Z".to_string(),
        payload,
    }
}

#[cfg(unix)]
fn is_pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    // SAFETY: kill with signal 0 only checks process existence.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[tokio::test]
async fn dual_rigctld_dummy_cat_roundtrip_and_zero_orphans() {
    let dir = tempdir().unwrap();
    let cfg = make_cfg(dir.path());
    let store = StateStore::open(cfg.db_path()).unwrap();
    let mut sup_cfg = SupervisorConfig::from_daemon_config(&cfg);
    sup_cfg.timing = fast_test_worker_timing();
    sup_cfg.reconcile_interval = Duration::from_secs(30);

    let state = AppState::build_for_test_with_supervisor(
        cfg,
        store,
        make_preflight(),
        sup_cfg,
        build_dummy_scanner_for_test(vec![]),
    );
    let shutdown = CancellationToken::new();
    state.supervisor.start(shutdown.clone()).await;

    let ack1 = state
        .bus
        .dispatch(
            cmd(
                "tester",
                None,
                "radio.create_profile",
                json!({ "name": "Dummy Rig A", "hamlib_model": 1, "is_dummy": true, "auto_connect": true }),
            ),
            None,
        )
        .await;
    assert_eq!(ack1.status, CommandStatus::Ok);
    let rad1 = ack1.result.unwrap()["profile"]["radio_id"]
        .as_str()
        .unwrap()
        .to_string();

    let ack2 = state
        .bus
        .dispatch(
            cmd(
                "tester",
                None,
                "radio.create_profile",
                json!({ "name": "Dummy Rig B", "hamlib_model": 1, "is_dummy": true, "auto_connect": true }),
            ),
            None,
        )
        .await;
    assert_eq!(ack2.status, CommandStatus::Ok);
    let rad2 = ack2.result.unwrap()["profile"]["radio_id"]
        .as_str()
        .unwrap()
        .to_string();

    let snap1 = wait_for_state(
        &state,
        &rad1,
        RadioLifecycleState::Ready,
        Duration::from_secs(6),
    )
    .await;
    let snap2 = wait_for_state(
        &state,
        &rad2,
        RadioLifecycleState::Ready,
        Duration::from_secs(6),
    )
    .await;
    assert_ne!(snap1.rigctld_port, snap2.rigctld_port);
    let pid1 = snap1.rigctld_pid.expect("pid1");
    let pid2 = snap2.rigctld_pid.expect("pid2");

    // Claim leases and tune both rigs independently
    for (rid, freq, mode) in [
        (&rad1, 14_074_000_u64, "USB"),
        (&rad2, 7_074_000_u64, "PKTUSB"),
    ] {
        let cl = state
            .bus
            .dispatch(
                cmd("tester", Some(rid), "control.claim_lease", json!({})),
                None,
            )
            .await;
        assert_eq!(cl.status, CommandStatus::Ok);

        let sf = state
            .bus
            .dispatch(
                cmd(
                    "tester",
                    Some(rid),
                    "radio.set_freq",
                    json!({ "freq_hz": freq }),
                ),
                None,
            )
            .await;
        assert_eq!(sf.status, CommandStatus::Ok, "{sf:?}");

        let sm = state
            .bus
            .dispatch(
                cmd(
                    "tester",
                    Some(rid),
                    "radio.set_mode",
                    json!({ "mode": mode, "passband_hz": 2400 }),
                ),
                None,
            )
            .await;
        assert_eq!(sm.status, CommandStatus::Ok, "{sm:?}");

        let tc = state
            .bus
            .dispatch(cmd("tester", Some(rid), "radio.test_cat", json!({})), None)
            .await;
        assert_eq!(tc.status, CommandStatus::Ok);
        assert_eq!(tc.result.as_ref().unwrap()["freq_hz"], freq);

        let tp = state
            .bus
            .dispatch(
                cmd(
                    "tester",
                    Some(rid),
                    "radio.test_ptt",
                    json!({ "duration_ms": 80 }),
                ),
                None,
            )
            .await;
        assert_eq!(tp.status, CommandStatus::Ok, "{tp:?}");
    }

    // Check REST /api/v1/radios reflects live frequency, band, mode, and READY state
    let app = build_router(Arc::clone(&state));
    let res = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/radios")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = res.into_body().collect().await.unwrap().to_bytes();
    let v: Value = serde_json::from_slice(&body).unwrap();
    let radios = v["radios"].as_array().unwrap();
    assert_eq!(radios.len(), 2);
    assert!(radios
        .iter()
        .any(|r| r["band"] == "20m" && r["mode"] == "USB" && r["lifecycle_state"] == "READY"));
    assert!(radios
        .iter()
        .any(|r| r["band"] == "40m" && r["mode"] == "PKTUSB" && r["lifecycle_state"] == "READY"));

    state.supervisor.shutdown_all().await;
    sleep(Duration::from_millis(100)).await;
    #[cfg(unix)]
    {
        assert!(!is_pid_alive(pid1), "rigctld pid1 {pid1} leaked!");
        assert!(!is_pid_alive(pid2), "rigctld pid2 {pid2} leaked!");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn rigctld_crash_recovery_emits_lifecycle_and_outbox_events() {
    let dir = tempdir().unwrap();
    let cfg = make_cfg(dir.path());
    let store = StateStore::open(cfg.db_path()).unwrap();
    let mut sup_cfg = SupervisorConfig::from_daemon_config(&cfg);
    sup_cfg.timing = fast_test_worker_timing();
    sup_cfg.reconcile_interval = Duration::from_secs(30);

    let state = AppState::build_for_test_with_supervisor(
        cfg,
        store,
        make_preflight(),
        sup_cfg,
        build_dummy_scanner_for_test(vec![]),
    );
    let mut ws_rx = state.ws_tx.subscribe();
    let shutdown = CancellationToken::new();
    state.supervisor.start(shutdown.clone()).await;

    let ack = state
        .bus
        .dispatch(
            cmd(
                "tester",
                None,
                "radio.create_profile",
                json!({ "name": "Crash Test Rig", "hamlib_model": 1, "is_dummy": true, "rigctld_port": 4552 }),
            ),
            None,
        )
        .await;
    let rad_id = ack.result.unwrap()["profile"]["radio_id"]
        .as_str()
        .unwrap()
        .to_string();

    let snap1 = wait_for_state(
        &state,
        &rad_id,
        RadioLifecycleState::Ready,
        Duration::from_secs(6),
    )
    .await;
    let old_pid = snap1.rigctld_pid.expect("old_pid");

    // Drain prior WS events
    while ws_rx.try_recv().is_ok() {}

    // Kill rigctld with SIGKILL
    unsafe {
        libc::kill(old_pid as libc::pid_t, libc::SIGKILL);
    }

    let mut saw_degraded = false;
    let mut saw_recovering = false;
    let mut new_ready_pid: Option<u32> = None;

    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if let Ok(Ok(WsBroadcastEvent::RadioState {
            radio_id,
            lifecycle_state,
            rigctld_pid,
            ..
        })) = tokio::time::timeout(Duration::from_millis(200), ws_rx.recv()).await
        {
            if radio_id == rad_id {
                match lifecycle_state.as_str() {
                    "DEGRADED" => saw_degraded = true,
                    "RECOVERING" => saw_recovering = true,
                    "READY" if rigctld_pid.is_some() && rigctld_pid != Some(old_pid) => {
                        new_ready_pid = rigctld_pid;
                        break;
                    }
                    _ => {}
                }
            }
        }
    }

    assert!(saw_degraded, "expected DEGRADED broadcast after SIGKILL");
    assert!(saw_recovering, "expected RECOVERING broadcast");
    let new_pid = new_ready_pid.expect("expected READY with new rigctld_pid");
    assert_ne!(new_pid, old_pid);

    let tc = state
        .bus
        .dispatch(
            cmd("tester", Some(&rad_id), "radio.test_cat", json!({})),
            None,
        )
        .await;
    assert_eq!(tc.status, CommandStatus::Ok);

    let outbox = state.store.list_outbox_rows(50).unwrap();
    assert!(
        outbox.iter().any(|r| r.event_type == "radio.lifecycle"),
        "expected radio.lifecycle telemetry rows in outbox"
    );

    state.supervisor.shutdown_all().await;
    sleep(Duration::from_millis(100)).await;
    assert!(!is_pid_alive(new_pid));
}

#[cfg(unix)]
#[tokio::test]
async fn hotplug_fs_watcher_detects_attach_and_detach_in_real_time() {
    let dir = tempdir().unwrap();
    let serial_dir = dir.path().join("by-id");
    std::fs::create_dir_all(&serial_dir).unwrap();
    let serial_dir = std::fs::canonicalize(&serial_dir).unwrap_or(serial_dir);

    let cfg = make_cfg(dir.path());
    let store = StateStore::open(cfg.db_path()).unwrap();
    let mut sup_cfg = SupervisorConfig::from_daemon_config(&cfg);
    sup_cfg.serial_by_id_dir = serial_dir.clone();
    sup_cfg.debounce_duration = Duration::from_millis(50);
    // Long periodic interval proves OS notify watcher drives detection, not timer polling!
    sup_cfg.reconcile_interval = Duration::from_secs(30);
    sup_cfg.timing = fast_test_worker_timing();

    let scanner = Arc::new(OsDeviceScanner {
        serial_by_id_dir: serial_dir.clone(),
        sysfs_tty_root: dir.path().join("sys_tty"),
    });

    let state =
        AppState::build_for_test_with_supervisor(cfg, store, make_preflight(), sup_cfg, scanner);
    let mut ws_rx = state.ws_tx.subscribe();
    let shutdown = CancellationToken::new();
    state.supervisor.start(shutdown.clone()).await;

    #[cfg(target_os = "macos")]
    sleep(Duration::from_millis(200)).await;

    assert!(state.supervisor.list_usb_inventory().unwrap().is_empty());
    while ws_rx.try_recv().is_ok() {}

    // Simulate post-boot USB serial arrival using platform-appropriate device naming
    let mock_dev_name = if cfg!(target_os = "macos") {
        "cu.FTDI_Mock_Cable_ABCD"
    } else {
        "usb-FTDI_Mock_Cable_ABCD-if00-port0"
    };
    let link_path = serial_dir.join(mock_dev_name);
    std::os::unix::fs::symlink("/dev/null", &link_path).unwrap();

    let mut attached_seen = false;
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if let Ok(Ok(WsBroadcastEvent::UsbDevicesChanged { .. })) =
            tokio::time::timeout(Duration::from_millis(100), ws_rx.recv()).await
        {
            let inv = state.supervisor.list_usb_inventory().unwrap();
            if inv
                .iter()
                .any(|d| d.is_connected && d.os_path.contains("FTDI_Mock_Cable"))
            {
                attached_seen = true;
                break;
            }
        }
    }
    assert!(
        attached_seen,
        "expected real-time UsbDevicesChanged attach event"
    );

    // Simulate USB serial removal
    std::fs::remove_file(&link_path).unwrap();
    let mut detached_seen = false;
    let deadline2 = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline2 {
        if let Ok(Ok(WsBroadcastEvent::UsbDevicesChanged { .. })) =
            tokio::time::timeout(Duration::from_millis(100), ws_rx.recv()).await
        {
            let inv = state.supervisor.list_usb_inventory().unwrap();
            if inv.iter().all(|d| !d.is_connected) {
                detached_seen = true;
                break;
            }
        }
    }
    assert!(
        detached_seen,
        "expected real-time UsbDevicesChanged detach event"
    );

    state.supervisor.shutdown_all().await;
}

#[tokio::test]
async fn cable_disconnect_reconnect_and_operator_restart_lifecycle() {
    let dir = tempdir().unwrap();
    let cfg = make_cfg(dir.path());
    let store = StateStore::open(cfg.db_path()).unwrap();
    let mut sup_cfg = SupervisorConfig::from_daemon_config(&cfg);
    sup_cfg.timing = fast_test_worker_timing();
    sup_cfg.reconcile_interval = Duration::from_secs(30);

    let mock_scanner = Arc::new(MockDeviceScanner::new(vec![]));
    let state = AppState::build_for_test_with_supervisor(
        cfg,
        store,
        make_preflight(),
        sup_cfg,
        mock_scanner.clone(),
    );
    let shutdown = CancellationToken::new();
    state.supervisor.start(shutdown.clone()).await;

    // Profile bound to absent USB port starts DISCONNECTED
    let dev_key = "/tmp/nonexistent-digi-dx-serial/usb-mock-if00-port0".to_string();
    let ack_real = state
        .bus
        .dispatch(
            cmd(
                "tester",
                None,
                "radio.create_profile",
                json!({
                    "name": "Bound Mock Rig",
                    "hamlib_model": 2016,
                    "is_dummy": false,
                    "rigctld_port": 4553,
                    "serial_device_key": dev_key,
                    "auto_connect": true
                }),
            ),
            None,
        )
        .await;
    assert_eq!(ack_real.status, CommandStatus::Ok);
    let real_rid = ack_real.result.unwrap()["profile"]["radio_id"]
        .as_str()
        .unwrap()
        .to_string();

    wait_for_state(
        &state,
        &real_rid,
        RadioLifecycleState::Disconnected,
        Duration::from_secs(2),
    )
    .await;

    // Plug mock cable -> transitions out of DISCONNECTED into startup/degraded/recovering
    mock_scanner.push_device(ScannedSerialDevice {
        device_key: dev_key.clone(),
        os_path: dev_key.clone(),
        real_tty_path: Some("/dev/ttyUSB99".into()),
        usb_vid: Some("0403".into()),
        usb_pid: Some("6001".into()),
        usb_serial: Some("MOCK1".into()),
        usb_interface: Some("00".into()),
        usb_topology_path: Some("3-1".into()),
        manufacturer: Some("FTDI".into()),
        product: Some("Mock".into()),
    });
    state.supervisor.reconcile_now().await;
    sleep(Duration::from_millis(150)).await;
    let mid = state.supervisor.get_radio_snapshot(&real_rid).unwrap();
    assert_ne!(mid.lifecycle_state, RadioLifecycleState::Disconnected);

    // Unplug mock cable -> returns cleanly to DISCONNECTED
    mock_scanner.remove_device(&dev_key);
    state.supervisor.reconcile_now().await;
    wait_for_state(
        &state,
        &real_rid,
        RadioLifecycleState::Disconnected,
        Duration::from_secs(2),
    )
    .await;

    // Verify radio.restart spawns a fresh rigctld PID on a dummy profile
    let ack_dummy = state
        .bus
        .dispatch(
            cmd(
                "tester",
                None,
                "radio.create_profile",
                json!({ "name": "Restart Rig", "hamlib_model": 1, "is_dummy": true, "rigctld_port": 4554 }),
            ),
            None,
        )
        .await;
    let dum_rid = ack_dummy.result.unwrap()["profile"]["radio_id"]
        .as_str()
        .unwrap()
        .to_string();
    let s1 = wait_for_state(
        &state,
        &dum_rid,
        RadioLifecycleState::Ready,
        Duration::from_secs(6),
    )
    .await;
    let pid1 = s1.rigctld_pid.unwrap();

    let restart_ack = state
        .bus
        .dispatch(
            cmd("tester", Some(&dum_rid), "radio.restart", json!({})),
            None,
        )
        .await;
    assert_eq!(restart_ack.status, CommandStatus::Ok);
    let s2 = wait_for_state(
        &state,
        &dum_rid,
        RadioLifecycleState::Ready,
        Duration::from_secs(6),
    )
    .await;
    let pid2 = s2.rigctld_pid.unwrap();
    assert_ne!(pid1, pid2);

    state.supervisor.shutdown_all().await;
}

#[cfg(unix)]
#[tokio::test]
async fn radio_stop_releases_rigctld_and_blocks_auto_restart_until_operator_restart() {
    let dir = tempdir().unwrap();
    let cfg = make_cfg(dir.path());
    let store = StateStore::open(cfg.db_path()).unwrap();
    let mut sup_cfg = SupervisorConfig::from_daemon_config(&cfg);
    sup_cfg.timing = fast_test_worker_timing();
    sup_cfg.reconcile_interval = Duration::from_secs(30);

    let state = AppState::build_for_test_with_supervisor(
        cfg,
        store,
        make_preflight(),
        sup_cfg,
        build_dummy_scanner_for_test(vec![]),
    );
    let shutdown = CancellationToken::new();
    state.supervisor.start(shutdown.clone()).await;

    let ack = state
        .bus
        .dispatch(
            cmd(
                "tester",
                None,
                "radio.create_profile",
                json!({ "name": "Stoppable Rig", "hamlib_model": 1, "is_dummy": true, "rigctld_port": 4555 }),
            ),
            None,
        )
        .await;
    let rid = ack.result.unwrap()["profile"]["radio_id"]
        .as_str()
        .unwrap()
        .to_string();

    let s1 = wait_for_state(
        &state,
        &rid,
        RadioLifecycleState::Ready,
        Duration::from_secs(6),
    )
    .await;
    let pid1 = s1.rigctld_pid.expect("pid1");

    let stop_ack = state
        .bus
        .dispatch(cmd("tester", Some(&rid), "radio.stop", json!({})), None)
        .await;
    assert_eq!(stop_ack.status, CommandStatus::Ok);

    let stopped = wait_for_state(
        &state,
        &rid,
        RadioLifecycleState::Configured,
        Duration::from_secs(3),
    )
    .await;
    assert!(stopped.rigctld_pid.is_none());
    sleep(Duration::from_millis(80)).await;
    assert!(
        !is_pid_alive(pid1),
        "rigctld pid1 {pid1} still alive after radio.stop"
    );

    // Periodic reconciliation must NOT auto-restart an operator-stopped worker
    state.supervisor.reconcile_now().await;
    sleep(Duration::from_millis(100)).await;
    let still_stopped = state.supervisor.get_radio_snapshot(&rid).unwrap();
    assert_eq!(
        still_stopped.lifecycle_state,
        RadioLifecycleState::Configured
    );
    assert!(still_stopped.rigctld_pid.is_none());

    // Explicit operator restart brings it back to READY
    let restart_ack = state
        .bus
        .dispatch(cmd("tester", Some(&rid), "radio.restart", json!({})), None)
        .await;
    assert_eq!(restart_ack.status, CommandStatus::Ok);
    let s2 = wait_for_state(
        &state,
        &rid,
        RadioLifecycleState::Ready,
        Duration::from_secs(6),
    )
    .await;
    assert!(s2.rigctld_pid.is_some());

    state.supervisor.shutdown_all().await;
}

#[tokio::test]
async fn lease_persists_across_test_cat_and_heartbeats() {
    let dir = tempdir().unwrap();
    let cfg = make_cfg(dir.path());
    let store = StateStore::open(cfg.db_path()).unwrap();
    let mut sup_cfg = SupervisorConfig::from_daemon_config(&cfg);
    sup_cfg.timing = fast_test_worker_timing();
    sup_cfg.reconcile_interval = Duration::from_secs(30);

    let state = AppState::build_for_test_with_supervisor(
        cfg,
        store,
        make_preflight(),
        sup_cfg,
        build_dummy_scanner_for_test(vec![]),
    );
    let shutdown = CancellationToken::new();
    state.supervisor.start(shutdown.clone()).await;

    let ack = state
        .bus
        .dispatch(
            cmd(
                "browser-1",
                None,
                "radio.create_profile",
                json!({ "name": "Lease Rig", "hamlib_model": 1, "is_dummy": true, "rigctld_port": 4556 }),
            ),
            None,
        )
        .await;
    let rid = ack.result.unwrap()["profile"]["radio_id"]
        .as_str()
        .unwrap()
        .to_string();
    wait_for_state(
        &state,
        &rid,
        RadioLifecycleState::Ready,
        Duration::from_secs(6),
    )
    .await;

    let claim = state
        .bus
        .dispatch(
            cmd("browser-1", Some(&rid), "control.claim_lease", json!({})),
            None,
        )
        .await;
    assert_eq!(claim.status, CommandStatus::Ok);
    let lease_id = claim.result.unwrap()["lease_id"]
        .as_str()
        .unwrap()
        .to_string();
    let audit_before = state.store.count_command_audits().unwrap();

    // Send heartbeats and Test CAT
    for _ in 0..3 {
        let hb = state
            .bus
            .dispatch(
                cmd(
                    "browser-1",
                    Some(&rid),
                    "control.heartbeat",
                    json!({ "lease_id": lease_id }),
                ),
                None,
            )
            .await;
        assert_eq!(hb.status, CommandStatus::Ok);
        assert_eq!(hb.result.as_ref().unwrap()["kind"], "control.heartbeat");
    }

    // Successful heartbeats must NOT bloat command_audit
    assert_eq!(state.store.count_command_audits().unwrap(), audit_before);

    let tc = state
        .bus
        .dispatch(
            cmd("browser-1", Some(&rid), "radio.test_cat", json!({})),
            None,
        )
        .await;
    assert_eq!(tc.status, CommandStatus::Ok);

    // GET /api/v1/radios still reports lease_holder == "browser-1"
    let app = build_router(Arc::clone(&state));
    let res = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/radios")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = res.into_body().collect().await.unwrap().to_bytes();
    let v: Value = serde_json::from_slice(&body).unwrap();
    let r = v["radios"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["profile"]["radio_id"] == rid)
        .unwrap();
    assert_eq!(r["lease_holder"], "browser-1");

    state.supervisor.shutdown_all().await;
}

#[cfg(unix)]
#[tokio::test]
async fn powered_off_radio_detected_and_auto_recovers_on_power_on() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempdir().unwrap();
    let cfg = make_cfg(dir.path());
    let store = StateStore::open(cfg.db_path()).unwrap();

    let state_file = dir.path().join("rig_power_state.txt");
    std::fs::write(&state_file, "OFF").unwrap();

    let mock_serial = dir.path().join("usb-Icom_IC-7300_TEST-if00-port0");
    std::fs::write(&mock_serial, b"").unwrap();
    std::fs::set_permissions(&mock_serial, std::fs::Permissions::from_mode(0o600)).unwrap();

    let mock_rigctld = dir.path().join("mock_rigctld.py");
    let script = format!(
        r#"#!/usr/bin/env python3
import signal, socket, sys

signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
signal.signal(signal.SIGINT, lambda *_: sys.exit(0))

port = 4557
args = sys.argv[1:]
for i, a in enumerate(args):
    if a == "-t" and i + 1 < len(args):
        port = int(args[i + 1])

STATE_PATH = {state_path:?}

def read_state():
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return "OFF"

srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", port))
srv.listen(4)

while True:
    conn, _ = srv.accept()
    with conn:
        buf = b""
        while True:
            chunk = conn.recv(4096)
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                cmd = line.decode("utf-8", errors="replace").strip()
                st = read_state()
                if cmd == "+\\get_powerstat":
                    if st == "ON":
                        conn.sendall(b"get_powerstat:\nPower Status: 1\nRPRT 0\n")
                    elif st == "TIMEOUT":
                        conn.sendall(b"get_powerstat:\nRPRT -5\n")
                    else:
                        conn.sendall(b"get_powerstat:\nPower Status: 0\nRPRT 0\n")
                elif cmd == "+f":
                    if st == "ON":
                        conn.sendall(b"get_freq:\nFrequency: 14074000\nRPRT 0\n")
                    elif st == "TIMEOUT":
                        conn.sendall(b"get_freq:\nRPRT -5\n")
                    else:
                        conn.sendall(b"get_freq:\nRPRT -20\n")
                elif cmd == "+m":
                    conn.sendall(b"get_mode:\nMode: PKTUSB\nPassband: 2400\nRPRT 0\n")
                elif cmd == "+t":
                    conn.sendall(b"get_ptt:\nPTT: 0\nRPRT 0\n")
                elif cmd.startswith("+T"):
                    conn.sendall(b"set_ptt: 0\nRPRT 0\n")
                else:
                    conn.sendall(b"RPRT 0\n")
"#,
        state_path = state_file.display().to_string()
    );
    std::fs::write(&mock_rigctld, script).unwrap();
    std::fs::set_permissions(&mock_rigctld, std::fs::Permissions::from_mode(0o755)).unwrap();

    let mut sup_cfg = SupervisorConfig::from_daemon_config(&cfg);
    sup_cfg.rigctld_bin = mock_rigctld.display().to_string();
    sup_cfg.timing = fast_test_worker_timing();
    sup_cfg.reconcile_interval = Duration::from_secs(30);

    let dev_key = mock_serial.display().to_string();
    let scanner = Arc::new(MockDeviceScanner::new(vec![ScannedSerialDevice {
        device_key: dev_key.clone(),
        os_path: dev_key.clone(),
        real_tty_path: Some(dev_key.clone()),
        usb_vid: Some("10c4".into()),
        usb_pid: Some("ea60".into()),
        usb_serial: Some("IC-7300_TEST".into()),
        usb_interface: Some("00".into()),
        usb_topology_path: Some("3-1".into()),
        manufacturer: Some("Silicon Labs".into()),
        product: Some("CP2102".into()),
    }]));

    let state = AppState::build_for_test_with_supervisor(
        cfg,
        store,
        make_preflight(),
        sup_cfg,
        scanner.clone(),
    );
    let shutdown = CancellationToken::new();
    state.supervisor.start(shutdown.clone()).await;

    let ack = state
        .bus
        .dispatch(
            cmd(
                "tester",
                None,
                "radio.create_profile",
                json!({
                    "name": "Mock IC-7300",
                    "hamlib_model": 3073,
                    "is_dummy": false,
                    "rigctld_port": 4557,
                    "serial_device_key": dev_key,
                    "serial_baud_rate": 115200,
                    "auto_connect": true
                }),
            ),
            None,
        )
        .await;
    assert_eq!(ack.status, CommandStatus::Ok);
    let rid = ack.result.unwrap()["profile"]["radio_id"]
        .as_str()
        .unwrap()
        .to_string();

    // 1. Radio OFF with USB cable plugged -> POWERED_OFF (no error banner, no leaked PID)
    let off_snap = wait_for_state(
        &state,
        &rid,
        RadioLifecycleState::PoweredOff,
        Duration::from_secs(4),
    )
    .await;
    assert!(off_snap.last_error.is_none());
    assert!(off_snap.rigctld_pid.is_none());

    let inv_off = state.supervisor.list_usb_inventory().unwrap();
    let entry_off = inv_off
        .iter()
        .find(|u| u.device_key == dev_key)
        .expect("USB entry present");
    assert!(entry_off.is_connected);
    assert_eq!(entry_off.device_state, "POWERED_OFF");

    // 2. Wait across >2 standby probes (300ms each) -> no flicker or duplicate outbox rows
    let outbox_before = state
        .store
        .list_outbox_rows(100)
        .unwrap()
        .into_iter()
        .filter(|r| r.event_type == "radio.lifecycle")
        .count();
    sleep(Duration::from_millis(750)).await;
    let still_off = state.supervisor.get_radio_snapshot(&rid).unwrap();
    assert_eq!(still_off.lifecycle_state, RadioLifecycleState::PoweredOff);
    let outbox_after = state
        .store
        .list_outbox_rows(100)
        .unwrap()
        .into_iter()
        .filter(|r| r.event_type == "radio.lifecycle")
        .count();
    assert_eq!(outbox_before, outbox_after);

    // 3. Turn radio ON -> auto-transitions to READY with live VFO frequency
    std::fs::write(&state_file, "ON").unwrap();
    let on_snap = wait_for_state(
        &state,
        &rid,
        RadioLifecycleState::Ready,
        Duration::from_secs(4),
    )
    .await;
    assert_eq!(on_snap.freq_hz, Some(14_074_000));
    let inv_on = state.supervisor.list_usb_inventory().unwrap();
    let entry_on = inv_on.iter().find(|u| u.device_key == dev_key).unwrap();
    assert_eq!(entry_on.device_state, "READY");

    // 4. Radio stops answering CAT (RPRT -5 timeout) -> transitions cleanly to POWERED_OFF, not DEGRADED
    std::fs::write(&state_file, "TIMEOUT").unwrap();
    let timeout_off = wait_for_state(
        &state,
        &rid,
        RadioLifecycleState::PoweredOff,
        Duration::from_secs(4),
    )
    .await;
    assert!(timeout_off.last_error.is_none());

    // 5. Turn radio back ON -> auto-recovers to READY
    std::fs::write(&state_file, "ON").unwrap();
    wait_for_state(
        &state,
        &rid,
        RadioLifecycleState::Ready,
        Duration::from_secs(4),
    )
    .await;

    // 6. Unplug USB cable -> DISCONNECTED
    scanner.remove_device(&dev_key);
    state.supervisor.reconcile_now().await;
    wait_for_state(
        &state,
        &rid,
        RadioLifecycleState::Disconnected,
        Duration::from_secs(2),
    )
    .await;

    state.supervisor.shutdown_all().await;
}

#[cfg(unix)]
#[tokio::test]
async fn serial_permission_denied_reports_degraded_not_powered_off() {
    use std::os::unix::fs::PermissionsExt;

    // SAFETY: geteuid() is always safe to call.
    if unsafe { libc::geteuid() } == 0 {
        return;
    }

    let dir = tempdir().unwrap();
    let cfg = make_cfg(dir.path());
    let store = StateStore::open(cfg.db_path()).unwrap();

    let locked_serial = dir.path().join("usb-Locked_Port-if00-port0");
    std::fs::write(&locked_serial, b"").unwrap();
    std::fs::set_permissions(&locked_serial, std::fs::Permissions::from_mode(0o000)).unwrap();

    let mut sup_cfg = SupervisorConfig::from_daemon_config(&cfg);
    sup_cfg.timing = fast_test_worker_timing();
    sup_cfg.reconcile_interval = Duration::from_secs(30);

    let dev_key = locked_serial.display().to_string();
    let scanner = Arc::new(MockDeviceScanner::new(vec![ScannedSerialDevice {
        device_key: dev_key.clone(),
        os_path: dev_key.clone(),
        real_tty_path: Some(dev_key.clone()),
        usb_vid: Some("10c4".into()),
        usb_pid: Some("ea60".into()),
        usb_serial: Some("LOCKED1".into()),
        usb_interface: Some("00".into()),
        usb_topology_path: Some("3-2".into()),
        manufacturer: Some("Silicon Labs".into()),
        product: Some("CP2102".into()),
    }]));

    let state =
        AppState::build_for_test_with_supervisor(cfg, store, make_preflight(), sup_cfg, scanner);
    let shutdown = CancellationToken::new();
    state.supervisor.start(shutdown.clone()).await;

    let ack = state
        .bus
        .dispatch(
            cmd(
                "tester",
                None,
                "radio.create_profile",
                json!({
                    "name": "Locked Serial Rig",
                    "hamlib_model": 3073,
                    "is_dummy": false,
                    "rigctld_port": 4558,
                    "serial_device_key": dev_key,
                    "serial_baud_rate": 115200,
                    "auto_connect": true
                }),
            ),
            None,
        )
        .await;
    assert_eq!(ack.status, CommandStatus::Ok);
    let rid = ack.result.unwrap()["profile"]["radio_id"]
        .as_str()
        .unwrap()
        .to_string();

    let deadline = Instant::now() + Duration::from_secs(4);
    let snap = loop {
        if let Some(s) = state.supervisor.get_radio_snapshot(&rid) {
            if s.last_error.is_some() {
                break s;
            }
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for permission-denied error on {rid}"
        );
        sleep(Duration::from_millis(50)).await;
    };

    assert_ne!(snap.lifecycle_state, RadioLifecycleState::PoweredOff);
    let err = snap.last_error.unwrap();
    assert!(
        err.contains("permission denied") || err.contains("dialout"),
        "expected permission denied / dialout hint, got: {err}"
    );

    state.supervisor.shutdown_all().await;
    let _ = std::fs::set_permissions(&locked_serial, std::fs::Permissions::from_mode(0o600));
}
