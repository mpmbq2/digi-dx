use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use digi_dx::cli::ServeArgs;
use digi_dx::command_bus::{CommandEnvelope, CommandOrigin, CommandStatus};
use digi_dx::config::DaemonConfig;
use digi_dx::preflight::{
    CheckSeverity, CheckStatus, OverallStatus, PlatformInfo, PreflightReport,
};
use digi_dx::server::{build_router, fast_test_worker_timing, AppState};
use digi_dx::store::StateStore;
use digi_dx::supervisor::radio_worker::RadioLifecycleState;
use digi_dx::supervisor::{build_dummy_scanner_for_test, SupervisorConfig};
use serde_json::{json, Value};
use tempfile::tempdir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::sleep;
use tokio_util::sync::CancellationToken;

fn make_cfg(dir: &Path) -> DaemonConfig {
    DaemonConfig::from_serve_args(&ServeArgs {
        bind: "127.0.0.1".into(),
        port: 0,
        data_dir: Some(dir.to_path_buf()),
        auth_token: None,
    })
}

fn make_preflight() -> PreflightReport {
    PreflightReport {
        overall_status: OverallStatus::Ok,
        checked_at_utc: "2026-11-21T00:00:00Z".into(),
        platform: PlatformInfo {
            os: std::env::consts::OS.into(),
            arch: std::env::consts::ARCH.into(),
        },
        active_ft8_decoder: "ft8_lib_fallback".into(),
        checks: vec![digi_dx::preflight::PreflightCheck {
            id: "sqlite_storage".into(),
            status: CheckStatus::Pass,
            severity: CheckSeverity::Fatal,
            detail: "ok".into(),
            remediation: None,
        }],
    }
}

fn cmd(actor: &str, radio_id: Option<&str>, kind: &str, payload: Value) -> CommandEnvelope {
    CommandEnvelope {
        command_id: uuid::Uuid::now_v7().to_string(),
        idempotency_key: None,
        origin: CommandOrigin::LocalUi,
        actor: actor.to_string(),
        radio_id: radio_id.map(str::to_string),
        kind: kind.to_string(),
        issued_at_utc: "2026-11-21T00:00:00Z".to_string(),
        payload,
    }
}

async fn wait_for_ready(state: &AppState, radio_id: &str) {
    let deadline = Instant::now() + Duration::from_secs(6);
    while Instant::now() < deadline {
        if let Some(snap) = state.supervisor.get_radio_snapshot(radio_id) {
            if snap.lifecycle_state == RadioLifecycleState::Ready {
                return;
            }
        }
        sleep(Duration::from_millis(50)).await;
    }
    panic!(
        "radio {radio_id} did not reach Ready state (last: {:?})",
        state.supervisor.get_radio_snapshot(radio_id)
    );
}

fn build_masked_ws_text_frame(payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(payload.len() + 10);
    frame.push(0x81); // FIN + Text
    let mask_bit = 0x80_u8;
    let len = payload.len();
    if len <= 125 {
        frame.push(mask_bit | (len as u8));
    } else if len <= 65535 {
        frame.push(mask_bit | 126);
        frame.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        frame.push(mask_bit | 127);
        frame.extend_from_slice(&(len as u64).to_be_bytes());
    }
    let mask = [0x12_u8, 0x34, 0x56, 0x78];
    frame.extend_from_slice(&mask);
    for (i, &b) in payload.iter().enumerate() {
        frame.push(b ^ mask[i % 4]);
    }
    frame
}

async fn read_next_ws_text_frame(stream: &mut TcpStream) -> String {
    let mut hdr = [0_u8; 2];
    stream.read_exact(&mut hdr).await.unwrap();
    let len_code = hdr[1] & 0x7f;
    let len = match len_code {
        126 => {
            let mut ext = [0_u8; 2];
            stream.read_exact(&mut ext).await.unwrap();
            u16::from_be_bytes(ext) as usize
        }
        127 => {
            let mut ext = [0_u8; 8];
            stream.read_exact(&mut ext).await.unwrap();
            u64::from_be_bytes(ext) as usize
        }
        n => n as usize,
    };
    let mut buf = vec![0_u8; len];
    stream.read_exact(&mut buf).await.unwrap();
    String::from_utf8(buf).unwrap()
}

#[cfg(unix)]
#[tokio::test]
async fn watchdog_drops_ptt_within_2100ms_on_heartbeat_silence() {
    let dir = tempdir().unwrap();
    let cfg = make_cfg(dir.path());
    let store = StateStore::open(cfg.db_path()).unwrap();
    let mut sup_cfg = SupervisorConfig::from_daemon_config(&cfg);
    sup_cfg.timing = fast_test_worker_timing();

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
                "op-hb",
                None,
                "radio.create_profile",
                json!({
                    "name": "Watchdog HB Dummy",
                    "hamlib_model": 1,
                    "is_dummy": true,
                    "rigctld_port": 4561
                }),
            ),
            None,
        )
        .await;
    assert_eq!(ack.status, CommandStatus::Ok, "{ack:?}");
    let rad_id = ack.result.unwrap()["profile"]["radio_id"]
        .as_str()
        .unwrap()
        .to_string();
    wait_for_ready(&state, &rad_id).await;

    let claim = state
        .bus
        .dispatch(
            cmd("op-hb", Some(&rad_id), "control.claim_lease", json!({})),
            None,
        )
        .await;
    assert_eq!(claim.status, CommandStatus::Ok);
    let lease_id = claim.result.unwrap()["lease_id"]
        .as_str()
        .unwrap()
        .to_string();

    state.supervisor.set_ptt(&rad_id, true).await.unwrap();
    let audio_abort = Arc::new(AtomicBool::new(false));
    state
        .watchdog
        .arm_tx(&rad_id, "op-hb", Some(Arc::clone(&audio_abort)))
        .await;

    // Pet once at 400 ms to extend watchdog past initial 2000 ms
    sleep(Duration::from_millis(400)).await;
    let hb_time = Instant::now();
    let hb = state
        .bus
        .dispatch(
            cmd(
                "op-hb",
                Some(&rad_id),
                "control.heartbeat",
                json!({ "lease_id": lease_id }),
            ),
            None,
        )
        .await;
    assert_eq!(hb.status, CommandStatus::Ok);

    sleep(Duration::from_millis(800)).await;
    assert!(
        !audio_abort.load(Ordering::SeqCst),
        "watchdog aborted too early after heartbeat"
    );
    assert!(state.supervisor.get_radio_snapshot(&rad_id).unwrap().ptt);

    // Stop sending heartbeats and verify PTT + audio drop within < 2100 ms of last heartbeat
    let drop_at;
    let deadline = hb_time + Duration::from_millis(2100);
    loop {
        let ab = audio_abort.load(Ordering::SeqCst);
        let ptt = state.supervisor.get_radio_snapshot(&rad_id).unwrap().ptt;
        if ab && !ptt {
            drop_at = Instant::now();
            break;
        }
        assert!(
            Instant::now() < deadline,
            "watchdog did not drop PTT within 2100 ms of heartbeat silence"
        );
        sleep(Duration::from_millis(10)).await;
    }

    let since_hb = drop_at.duration_since(hb_time);
    assert!(
        since_hb < Duration::from_millis(2100),
        "drop took {:?} (>= 2100ms)",
        since_hb
    );

    let pending = state.store.list_outbox_rows(20).unwrap();
    assert!(
        pending.iter().any(|row| row.event_type == "watchdog.abort"
            && row.payload_json.contains("heartbeat_timeout")),
        "expected heartbeat_timeout watchdog.abort in outbox: {pending:?}"
    );

    shutdown.cancel();
    state.watchdog.disarm_all().await;
    state.supervisor.shutdown_all().await;
}

#[cfg(unix)]
#[tokio::test]
async fn watchdog_drops_ptt_within_200ms_on_ws_disconnect() {
    let dir = tempdir().unwrap();
    let cfg = make_cfg(dir.path());
    let store = StateStore::open(cfg.db_path()).unwrap();
    let mut sup_cfg = SupervisorConfig::from_daemon_config(&cfg);
    sup_cfg.timing = fast_test_worker_timing();

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
                "setup",
                None,
                "radio.create_profile",
                json!({
                    "name": "Watchdog WS Dummy",
                    "hamlib_model": 1,
                    "is_dummy": true,
                    "rigctld_port": 4562
                }),
            ),
            None,
        )
        .await;
    let rad_id = ack.result.unwrap()["profile"]["radio_id"]
        .as_str()
        .unwrap()
        .to_string();
    wait_for_ready(&state, &rad_id).await;

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = build_router(Arc::clone(&state));
    let srv_handle = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    let mut ws = TcpStream::connect(addr).await.unwrap();
    let req = format!(
        "GET /api/v1/ws HTTP/1.1\r\nHost: {addr}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );
    ws.write_all(req.as_bytes()).await.unwrap();

    let mut hdr_buf = Vec::new();
    let mut byte = [0_u8; 1];
    while !hdr_buf.ends_with(b"\r\n\r\n") {
        ws.read_exact(&mut byte).await.unwrap();
        hdr_buf.push(byte[0]);
    }
    let hdr_str = String::from_utf8_lossy(&hdr_buf);
    assert!(
        hdr_str.contains("101"),
        "unexpected WS upgrade response: {hdr_str}"
    );

    let init_snap = read_next_ws_text_frame(&mut ws).await;
    assert!(init_snap.contains("\"snapshot\""));

    let claim_frame = json!({
        "type": "command",
        "envelope": {
            "command_id": uuid::Uuid::now_v7().to_string(),
            "origin": "local_ui",
            "actor": "ws-op",
            "radio_id": rad_id,
            "kind": "control.claim_lease",
            "payload": {}
        }
    })
    .to_string();
    ws.write_all(&build_masked_ws_text_frame(claim_frame.as_bytes()))
        .await
        .unwrap();

    let mut saw_ack = false;
    for _ in 0..8 {
        let frame = read_next_ws_text_frame(&mut ws).await;
        if frame.contains("\"command_ack\"") && frame.contains("\"ok\"") {
            saw_ack = true;
            break;
        }
    }
    assert!(saw_ack, "did not receive claim command_ack over WS");

    state.supervisor.set_ptt(&rad_id, true).await.unwrap();
    let audio_abort = Arc::new(AtomicBool::new(false));
    state
        .watchdog
        .arm_tx(&rad_id, "ws-op", Some(Arc::clone(&audio_abort)))
        .await;
    assert!(state.supervisor.get_radio_snapshot(&rad_id).unwrap().ptt);

    // Simulate abrupt WS client disconnect
    drop(ws);
    let drop_start = Instant::now();

    let deadline = drop_start + Duration::from_millis(200);
    loop {
        let ab = audio_abort.load(Ordering::SeqCst);
        let ptt = state.supervisor.get_radio_snapshot(&rad_id).unwrap().ptt;
        if ab && !ptt {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "watchdog did not drop PTT within 200 ms of WS disconnect"
        );
        sleep(Duration::from_millis(10)).await;
    }

    srv_handle.abort();
    shutdown.cancel();
    state.watchdog.disarm_all().await;
    state.supervisor.shutdown_all().await;
}

#[cfg(unix)]
#[tokio::test]
async fn watchdog_enforces_hard_13_5s_tx_ceiling_despite_heartbeats() {
    let dir = tempdir().unwrap();
    let cfg = make_cfg(dir.path());
    let store = StateStore::open(cfg.db_path()).unwrap();
    let mut sup_cfg = SupervisorConfig::from_daemon_config(&cfg);
    sup_cfg.timing = fast_test_worker_timing();

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
                "op-ceil",
                None,
                "radio.create_profile",
                json!({
                    "name": "Watchdog Ceiling Dummy",
                    "hamlib_model": 1,
                    "is_dummy": true,
                    "rigctld_port": 4563
                }),
            ),
            None,
        )
        .await;
    let rad_id = ack.result.unwrap()["profile"]["radio_id"]
        .as_str()
        .unwrap()
        .to_string();
    wait_for_ready(&state, &rad_id).await;

    let claim = state
        .bus
        .dispatch(
            cmd("op-ceil", Some(&rad_id), "control.claim_lease", json!({})),
            None,
        )
        .await;
    let lease_id = claim.result.unwrap()["lease_id"]
        .as_str()
        .unwrap()
        .to_string();

    state.supervisor.set_ptt(&rad_id, true).await.unwrap();
    let audio_abort = Arc::new(AtomicBool::new(false));
    let started = Instant::now();
    state
        .watchdog
        .arm_tx(&rad_id, "op-ceil", Some(Arc::clone(&audio_abort)))
        .await;

    let hb_state = Arc::clone(&state);
    let hb_rid = rad_id.clone();
    let hb_abort = Arc::clone(&audio_abort);
    let hb_task = tokio::spawn(async move {
        while !hb_abort.load(Ordering::SeqCst) {
            sleep(Duration::from_millis(500)).await;
            if hb_abort.load(Ordering::SeqCst) {
                break;
            }
            let _ = hb_state
                .bus
                .dispatch(
                    cmd(
                        "op-ceil",
                        Some(&hb_rid),
                        "control.heartbeat",
                        json!({ "lease_id": lease_id }),
                    ),
                    None,
                )
                .await;
        }
    });

    let hard_deadline = started + Duration::from_millis(13_500);
    let triggered_at;
    loop {
        let ab = audio_abort.load(Ordering::SeqCst);
        let ptt = state.supervisor.get_radio_snapshot(&rad_id).unwrap().ptt;
        if ab && !ptt {
            triggered_at = Instant::now();
            break;
        }
        assert!(
            Instant::now() <= hard_deadline,
            "runaway TX exceeded 13.5 s hard ceiling!"
        );
        sleep(Duration::from_millis(10)).await;
    }
    hb_task.abort();

    let elapsed = triggered_at.duration_since(started);
    assert!(
        elapsed >= Duration::from_millis(13_200) && elapsed <= Duration::from_millis(13_500),
        "hard ceiling fired at {:?} (expected 13.2s..=13.5s)",
        elapsed
    );

    let pending = state.store.list_outbox_rows(20).unwrap();
    assert!(
        pending.iter().any(|row| row.event_type == "watchdog.abort"
            && row.payload_json.contains("max_tx_duration_exceeded")),
        "expected max_tx_duration_exceeded in outbox: {pending:?}"
    );

    shutdown.cancel();
    state.watchdog.disarm_all().await;
    state.supervisor.shutdown_all().await;
}
