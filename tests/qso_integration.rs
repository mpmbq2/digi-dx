use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use digi_dx::cli::ServeArgs;
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
use tokio::time::{sleep, timeout};
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
        checked_at_utc: "2026-11-22T00:00:00Z".into(),
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

fn build_masked_ws_text_frame(payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(payload.len() + 10);
    frame.push(0x81);
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
    let mask = [0x42_u8, 0x19, 0x77, 0x05];
    frame.extend_from_slice(&mask);
    for (i, &b) in payload.iter().enumerate() {
        frame.push(b ^ mask[i % 4]);
    }
    frame
}

async fn read_next_ws_text_frame(stream: &mut TcpStream) -> String {
    loop {
        let mut hdr = [0_u8; 2];
        stream.read_exact(&mut hdr).await.unwrap();
        let opcode = hdr[0] & 0x0f;
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
        if opcode == 0x8 {
            panic!("unexpected WS close frame");
        }
        if opcode == 0x1 {
            return String::from_utf8(buf).unwrap();
        }
    }
}

async fn send_ws_cmd_and_wait_ack(
    stream: &mut TcpStream,
    actor: &str,
    radio_id: Option<&str>,
    kind: &str,
    payload: Value,
) -> Value {
    let cid = uuid::Uuid::now_v7().to_string();
    let frame = json!({
        "type": "command",
        "envelope": {
            "command_id": cid,
            "origin": "local_ui",
            "actor": actor,
            "radio_id": radio_id,
            "kind": kind,
            "payload": payload,
        }
    })
    .to_string();
    stream
        .write_all(&build_masked_ws_text_frame(frame.as_bytes()))
        .await
        .unwrap();

    timeout(Duration::from_secs(5), async {
        loop {
            let txt = read_next_ws_text_frame(stream).await;
            let val: Value = serde_json::from_str(&txt).unwrap();
            if val["type"] == "command_ack" && val["command_id"] == cid {
                return val;
            }
        }
    })
    .await
    .expect("timed out waiting for WS command_ack")
}

async fn http_get_raw(addr: std::net::SocketAddr, path: &str) -> (u16, String) {
    let mut sock = TcpStream::connect(addr).await.unwrap();
    let req = format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
    sock.write_all(req.as_bytes()).await.unwrap();
    let mut resp = Vec::new();
    sock.read_to_end(&mut resp).await.unwrap();
    let s = String::from_utf8(resp).unwrap();
    let (hdrs, body) = s.split_once("\r\n\r\n").unwrap();
    let status: u16 = hdrs
        .lines()
        .next()
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    (status, body.to_string())
}

#[cfg(unix)]
#[tokio::test]
async fn scaled_time_simulated_qso_completes_and_isolates_adif_export() {
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
    let snap: Value = serde_json::from_str(&read_next_ws_text_frame(&mut ws).await).unwrap();
    assert_eq!(snap["type"], "snapshot");

    let create_ack = send_ws_cmd_and_wait_ack(
        &mut ws,
        "ci-op",
        None,
        "radio.create_profile",
        json!({
            "name": "QSO Sim Dummy",
            "hamlib_model": 1,
            "is_dummy": true,
            "rigctld_port": 4570
        }),
    )
    .await;
    assert_eq!(create_ack["status"], "ok", "{create_ack}");
    let rad_id = create_ack["result"]["profile"]["radio_id"]
        .as_str()
        .unwrap()
        .to_string();

    let ready_deadline = Instant::now() + Duration::from_secs(6);
    while Instant::now() < ready_deadline {
        if state
            .supervisor
            .get_radio_snapshot(&rad_id)
            .is_some_and(|s| s.lifecycle_state == RadioLifecycleState::Ready)
        {
            break;
        }
        sleep(Duration::from_millis(50)).await;
    }

    let claim_ack = send_ws_cmd_and_wait_ack(
        &mut ws,
        "ci-op",
        Some(&rad_id),
        "control.claim_lease",
        json!({}),
    )
    .await;
    assert_eq!(claim_ack["status"], "ok", "{claim_ack}");

    let start_ack = send_ws_cmd_and_wait_ack(
        &mut ws,
        "ci-op",
        Some(&rad_id),
        "session.start",
        json!({ "demo": true, "scale": 20.0 }),
    )
    .await;
    assert_eq!(start_ack["status"], "ok", "{start_ack}");

    let cq_ack = send_ws_cmd_and_wait_ack(
        &mut ws,
        "ci-op",
        Some(&rad_id),
        "qso.call_cq",
        json!({ "slot": "even" }),
    )
    .await;
    assert_eq!(cq_ack["status"], "ok", "{cq_ack}");

    // Wait for full simulated FT8 QSO completion (CQ -> Grid -> Report -> R-Report -> RR73 -> 73)
    let completed = timeout(Duration::from_secs(15), async {
        loop {
            let txt = read_next_ws_text_frame(&mut ws).await;
            let val: Value = serde_json::from_str(&txt).unwrap();
            if val["type"] == "qso_update" && !val["completed_qso"].is_null() {
                return val["completed_qso"].clone();
            }
        }
    })
    .await
    .expect("scaled-time simulated FT8 QSO did not complete within 15s");

    assert_eq!(completed["my_call"], "QQ0DEMO");
    assert!(
        completed["their_call"].as_str().unwrap().starts_with("QQ"),
        "expected QQ* peer callsign: {completed}"
    );

    // Check real vs demo QSO isolation & ADIF zero-leakage invariant
    let (st_demo, body_demo) = http_get_raw(addr, "/api/v1/qsos?demo=true").await;
    assert_eq!(st_demo, 200);
    let demo_json: Value = serde_json::from_str(&body_demo).unwrap();
    assert_eq!(demo_json["count"], 1);

    let (st_real, body_real) = http_get_raw(addr, "/api/v1/qsos?demo=false").await;
    assert_eq!(st_real, 200);
    let real_json: Value = serde_json::from_str(&body_real).unwrap();
    assert_eq!(real_json["count"], 0);

    let (st_adif, body_adif) = http_get_raw(addr, "/api/v1/qsos/export.adi").await;
    assert_eq!(st_adif, 200);
    assert!(body_adif.contains("<ADIF_VER:5>3.1.4 "));
    assert!(body_adif.contains("<EOH>"));
    assert!(
        !body_adif.contains("<EOR>"),
        "demo QSO leaked into ADIF: {body_adif}"
    );
    assert!(
        !body_adif.contains("QQ"),
        "QQ callsign leaked into ADIF: {body_adif}"
    );

    let outbox_rows = state.store.list_outbox_rows(50).unwrap();
    assert!(
        outbox_rows
            .iter()
            .any(|r| r.event_type == "qso.completed" && r.is_demo),
        "expected is_demo=true qso.completed in outbox: {outbox_rows:?}"
    );

    let stop_ack =
        send_ws_cmd_and_wait_ack(&mut ws, "ci-op", Some(&rad_id), "session.stop", json!({})).await;
    assert_eq!(stop_ack["status"], "ok", "{stop_ack}");
    assert_eq!(stop_ack["result"]["active"], false);

    drop(ws);
    srv_handle.abort();
    shutdown.cancel();
    state.sessions.stop_if_active().await;
    state.watchdog.disarm_all().await;
    state.supervisor.shutdown_all().await;
}
