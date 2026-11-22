use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tempfile::tempdir;
use tower::ServiceExt;

use digi_dx::cli::ServeArgs;
use digi_dx::command_bus::transport::GcpBridgeClientStub;
use digi_dx::command_bus::{CommandAck, CommandEnvelope, CommandOrigin, CommandStatus, ErrorCode};
use digi_dx::config::DaemonConfig;
use digi_dx::preflight::{
    CheckSeverity, CheckStatus, OverallStatus, PlatformInfo, PreflightCheck, PreflightReport,
};
use digi_dx::server::{build_router, AppState};
use digi_dx::store::StateStore;

fn test_state(auth_token: Option<&str>) -> (tempfile::TempDir, Arc<AppState>) {
    let dir = tempdir().unwrap();
    let cfg = DaemonConfig::from_serve_args(&ServeArgs {
        bind: "127.0.0.1".to_string(),
        port: 0,
        data_dir: Some(dir.path().to_path_buf()),
        auth_token: auth_token.map(str::to_string),
    });
    let store = StateStore::open(cfg.db_path()).unwrap();
    let preflight = PreflightReport {
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
    };
    let state = AppState::build_for_test(cfg, store, preflight);
    (dir, state)
}

#[tokio::test]
async fn command_bus_idempotency_validation_and_leases() {
    let (_dir, state) = test_state(None);
    let bus = &state.bus;

    // 1. station.update_config rejects QQ0DEMO
    let qq_env = CommandEnvelope {
        command_id: "cmd-qq".to_string(),
        idempotency_key: Some("idem-qq".to_string()),
        origin: CommandOrigin::LocalUi,
        actor: "tab-1".to_string(),
        radio_id: None,
        kind: "station.update_config".to_string(),
        issued_at_utc: "2026-11-21T22:00:00Z".to_string(),
        payload: json!({ "callsign": "QQ0DEMO", "grid": "FN33" }),
    };
    let qq_ack = bus.dispatch(qq_env, None).await;
    assert_eq!(qq_ack.status, CommandStatus::Rejected);
    assert_eq!(qq_ack.error_code, Some(ErrorCode::ValidationFailed));

    // 2. Duplicate idempotency_key executes only once
    let before_count = state.store.count_command_audits().unwrap();
    let cfg_env = CommandEnvelope {
        command_id: "cmd-cfg-1".to_string(),
        idempotency_key: Some("idem-station-n1mpm".to_string()),
        origin: CommandOrigin::LocalUi,
        actor: "tab-1".to_string(),
        radio_id: None,
        kind: "station.update_config".to_string(),
        issued_at_utc: "2026-11-21T22:00:01Z".to_string(),
        payload: json!({ "callsign": "n1mpm", "grid": "fn33" }),
    };
    let ack1 = bus.dispatch(cfg_env.clone(), None).await;
    assert_eq!(ack1.status, CommandStatus::Ok);
    assert_eq!(
        state.store.count_command_audits().unwrap(),
        before_count + 1
    );

    let mut cfg_retry = cfg_env;
    cfg_retry.command_id = "cmd-cfg-2".to_string();
    let ack2 = bus.dispatch(cfg_retry, None).await;
    assert_eq!(ack2.status, CommandStatus::Ok);
    assert_eq!(ack2.command_id, "cmd-cfg-2");
    assert_eq!(
        state.store.count_command_audits().unwrap(),
        before_count + 1
    );

    // 3. Lease enforcement: observer without lease gets LEASE_REQUIRED
    let no_lease_ack = bus
        .dispatch(
            CommandEnvelope {
                command_id: "cmd-tx-1".to_string(),
                idempotency_key: None,
                origin: CommandOrigin::LocalUi,
                actor: "operator-a".to_string(),
                radio_id: Some("rad_test".to_string()),
                kind: "tx.arm".to_string(),
                issued_at_utc: "2026-11-21T22:00:02Z".to_string(),
                payload: json!({ "af_hz": 1420, "slot": "even", "message": "CQ N1MPM FN33" }),
            },
            None,
        )
        .await;
    assert_eq!(no_lease_ack.error_code, Some(ErrorCode::LeaseRequired));

    // Operator A claims lease
    let claim_ack = bus
        .dispatch(
            CommandEnvelope {
                command_id: "cmd-claim".to_string(),
                idempotency_key: None,
                origin: CommandOrigin::LocalUi,
                actor: "operator-a".to_string(),
                radio_id: Some("rad_test".to_string()),
                kind: "control.claim_lease".to_string(),
                issued_at_utc: "2026-11-21T22:00:03Z".to_string(),
                payload: json!({}),
            },
            None,
        )
        .await;
    assert_eq!(claim_ack.status, CommandStatus::Ok);

    // Operator B receives LEASE_HELD
    let other_ack = bus
        .dispatch(
            CommandEnvelope {
                command_id: "cmd-tx-2".to_string(),
                idempotency_key: None,
                origin: CommandOrigin::LocalUi,
                actor: "operator-b".to_string(),
                radio_id: Some("rad_test".to_string()),
                kind: "tx.arm".to_string(),
                issued_at_utc: "2026-11-21T22:00:04Z".to_string(),
                payload: json!({ "af_hz": 1420, "slot": "even", "message": "CQ N1MPM FN33" }),
            },
            None,
        )
        .await;
    assert_eq!(other_ack.error_code, Some(ErrorCode::LeaseHeld));

    // Emergency halt succeeds for operator-b WITHOUT holding the lease!
    let halt_ack = bus
        .dispatch(
            CommandEnvelope {
                command_id: "cmd-halt".to_string(),
                idempotency_key: None,
                origin: CommandOrigin::LocalUi,
                actor: "operator-b".to_string(),
                radio_id: Some("rad_test".to_string()),
                kind: "tx.halt_emergency".to_string(),
                issued_at_utc: "2026-11-21T22:00:05Z".to_string(),
                payload: json!({}),
            },
            None,
        )
        .await;
    assert_eq!(halt_ack.status, CommandStatus::Ok);
}

#[tokio::test]
async fn auth_token_and_gcp_bridge_stub_transport_contract() {
    let (_dir, state) = test_state(Some("secret-shack-token"));
    let stub = GcpBridgeClientStub::new(false, None);

    let unauth_ack = stub
        .dispatch_inbound_frame(
            &state.bus,
            CommandEnvelope {
                command_id: "gcp-1".to_string(),
                idempotency_key: None,
                origin: CommandOrigin::LocalUi, // overridden to GcpBridge by transport
                actor: "gcp-operator".to_string(),
                radio_id: None,
                kind: "station.update_config".to_string(),
                issued_at_utc: "2026-11-21T22:05:00Z".to_string(),
                payload: json!({ "callsign": "K1ABC", "grid": "FN42" }),
            },
            Some("wrong-token"),
        )
        .await;
    assert_eq!(unauth_ack.status, CommandStatus::Rejected);
    assert_eq!(unauth_ack.error_code, Some(ErrorCode::AuthFailed));

    let ok_ack = stub
        .dispatch_inbound_frame(
            &state.bus,
            CommandEnvelope {
                command_id: "gcp-2".to_string(),
                idempotency_key: Some("gcp-idem-1".to_string()),
                origin: CommandOrigin::GcpBridge,
                actor: "gcp-operator".to_string(),
                radio_id: None,
                kind: "station.update_config".to_string(),
                issued_at_utc: "2026-11-21T22:05:01Z".to_string(),
                payload: json!({ "callsign": "K1ABC", "grid": "FN42" }),
            },
            Some("secret-shack-token"),
        )
        .await;
    assert_eq!(ok_ack.status, CommandStatus::Ok);
    let station = state.store.get_station_config().unwrap();
    assert_eq!(station.callsign.as_deref(), Some("K1ABC"));
}

#[tokio::test]
async fn http_endpoints_and_command_rest_route_work_end_to_end() {
    let (_dir, state) = test_state(Some("topsecret"));
    let app = build_router(state);

    // Health
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = res.into_body().collect().await.unwrap().to_bytes();
    let v: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["status"], "ok");

    // Preflight
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/preflight")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // Outbox stats
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/outbox/stats")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // ADIF export
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/qsos/export.adi")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let adif_bytes = res.into_body().collect().await.unwrap().to_bytes();
    assert!(String::from_utf8_lossy(&adif_bytes).contains("<ADIF_VER:5>3.1.4 "));

    // Embedded UI index serving
    let res = app
        .clone()
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let ui_bytes = res.into_body().collect().await.unwrap().to_bytes();
    let ui_html = String::from_utf8_lossy(&ui_bytes);
    assert!(ui_html.contains("Digi-Dx"));

    // POST /api/v1/commands without token -> 401 AUTH_FAILED
    let cmd_payload = json!({
        "command_id": "rest-1",
        "origin": "local_ui",
        "actor": "browser-1",
        "kind": "station.update_config",
        "payload": { "callsign": "W1AW", "grid": "FN31" }
    });
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/commands")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(cmd_payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

    // POST /api/v1/commands with valid Bearer token -> 200 OK
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/commands")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, "Bearer topsecret")
                .body(Body::from(cmd_payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let ack_bytes = res.into_body().collect().await.unwrap().to_bytes();
    let ack: CommandAck = serde_json::from_slice(&ack_bytes).unwrap();
    assert_eq!(ack.status, CommandStatus::Ok);
    let _unused: PathBuf = PathBuf::from(".");
}
