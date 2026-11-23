use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, Request, StatusCode};
use axum::routing::post;
use axum::{response::IntoResponse, Router};
use http_body_util::BodyExt;
use rusqlite::Connection;
use serde_json::{json, Value};
use tempfile::tempdir;
use tokio::net::TcpListener;
use tower::ServiceExt;

use digi_dx::cli::ServeArgs;
use digi_dx::command_bus::{CommandAck, CommandStatus, ErrorCode};
use digi_dx::config::DaemonConfig;
use digi_dx::domain::adif::QsoRecord;
use digi_dx::preflight::{
    CheckSeverity, CheckStatus, OverallStatus, PlatformInfo, PreflightCheck, PreflightReport,
};
use digi_dx::server::{build_router, AppState};
use digi_dx::store::StateStore;

#[derive(Debug, Clone)]
struct RecordedQrzRequest {
    user_agent: Option<String>,
    params: HashMap<String, String>,
}

struct MockQrzState {
    requests: Mutex<Vec<RecordedQrzRequest>>,
    status_response: Mutex<(StatusCode, String)>,
    insert_responses: Mutex<VecDeque<(StatusCode, String)>>,
    default_insert_response: Mutex<(StatusCode, String)>,
    delay_ms: AtomicU64,
}

impl MockQrzState {
    fn new() -> Self {
        Self {
            requests: Mutex::new(Vec::new()),
            status_response: Mutex::new((
                StatusCode::OK,
                "RESULT=OK&DATA=BOOKID=99&CALLSIGN=N1MPM&COUNT=42&CONFIRMED=15".to_string(),
            )),
            insert_responses: Mutex::new(VecDeque::new()),
            default_insert_response: Mutex::new((
                StatusCode::OK,
                "RESULT=OK&LOGID=1001&COUNT=1".to_string(),
            )),
            delay_ms: AtomicU64::new(0),
        }
    }

    fn take_requests(&self) -> Vec<RecordedQrzRequest> {
        let mut guard = self.requests.lock().unwrap();
        std::mem::take(&mut *guard)
    }
}

async fn mock_qrz_handler(
    State(state): State<Arc<MockQrzState>>,
    headers: HeaderMap,
    body: String,
) -> impl IntoResponse {
    let delay = state.delay_ms.load(Ordering::Relaxed);
    if delay > 0 {
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }

    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let params: HashMap<String, String> = form_urlencoded::parse(body.as_bytes())
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let action = params
        .get("ACTION")
        .map(|s| s.to_ascii_uppercase())
        .unwrap_or_default();

    state
        .requests
        .lock()
        .unwrap()
        .push(RecordedQrzRequest { user_agent, params });

    if action == "STATUS" {
        let (code, text) = state.status_response.lock().unwrap().clone();
        return (code, text);
    }

    if let Some((code, text)) = state.insert_responses.lock().unwrap().pop_front() {
        return (code, text);
    }

    state.default_insert_response.lock().unwrap().clone()
}

async fn spawn_mock_qrz() -> (String, Arc<MockQrzState>, tokio::task::JoinHandle<()>) {
    let mock_state = Arc::new(MockQrzState::new());
    let app = Router::new()
        .route("/api", post(mock_qrz_handler))
        .with_state(Arc::clone(&mock_state));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}/api"), mock_state, handle)
}

fn test_state_with_qrz_url(
    qrz_api_url: String,
    auth_token: Option<&str>,
) -> (tempfile::TempDir, Arc<AppState>) {
    let dir = tempdir().unwrap();
    let mut cfg = DaemonConfig::from_serve_args(&ServeArgs {
        bind: "127.0.0.1".to_string(),
        port: 0,
        data_dir: Some(dir.path().to_path_buf()),
        auth_token: auth_token.map(str::to_string),
    });
    cfg.qrz_api_url = qrz_api_url;
    cfg.qrz_api_key = None;

    let store = StateStore::open(cfg.db_path()).unwrap();
    let preflight = PreflightReport {
        overall_status: OverallStatus::Ok,
        checked_at_utc: "2026-11-23T12:00:00Z".to_string(),
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

fn make_qso(
    qso_id: &str,
    my_call: &str,
    their_call: &str,
    completed_at: &str,
    dial_freq_hz: Option<i64>,
    band: Option<&str>,
) -> QsoRecord {
    QsoRecord {
        qso_id: qso_id.to_string(),
        radio_id: None,
        started_at_utc: "2026-11-23T12:00:00Z".to_string(),
        completed_at_utc: completed_at.to_string(),
        my_call: my_call.to_string(),
        my_grid: "FN33".to_string(),
        their_call: their_call.to_string(),
        their_grid: Some("PM95".to_string()),
        mode: "FT8".to_string(),
        dial_freq_hz,
        band: band.map(str::to_string),
        af_hz: Some(1420),
        rst_sent: Some("-10".to_string()),
        rst_rcvd: Some("-08".to_string()),
        completion_reason: "73_sent".to_string(),
        transcript_json: "[]".to_string(),
        qrz_status: None,
        qrz_logid: None,
        qrz_pushed_at_utc: None,
        qrz_error: None,
    }
}

async fn send_http_command(
    app: &Router,
    kind: &str,
    payload: Value,
    bearer_token: Option<&str>,
) -> (StatusCode, CommandAck, String) {
    let envelope = json!({
        "origin": "local_ui",
        "actor": "test-browser",
        "kind": kind,
        "payload": payload,
    });
    let mut builder = Request::builder()
        .method("POST")
        .uri("/api/v1/commands")
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(tok) = bearer_token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {tok}"));
    }
    let req = builder.body(Body::from(envelope.to_string())).unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let raw = String::from_utf8_lossy(&bytes).to_string();
    let ack: CommandAck = serde_json::from_slice(&bytes).unwrap();
    (status, ack, raw)
}

async fn get_json(app: &Router, uri: &str) -> (StatusCode, Value, String) {
    let res = app
        .clone()
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let raw = String::from_utf8_lossy(&bytes).to_string();
    let val: Value = serde_json::from_slice(&bytes).unwrap();
    (status, val, raw)
}

#[tokio::test]
async fn qrz_config_test_and_incremental_push_with_demo_isolation() {
    let (mock_url, mock_state, mock_handle) = spawn_mock_qrz().await;
    let (_dir, state) = test_state_with_qrz_url(mock_url, None);
    let app = build_router(Arc::clone(&state));

    // 1. Before configuration: status is unconfigured and qrz.push is rejected
    let (st_status, status_json, _) = get_json(&app, "/api/v1/qrz/status").await;
    assert_eq!(st_status, StatusCode::OK);
    assert_eq!(status_json["configured"], false);
    assert_eq!(status_json["key_source"], "none");
    assert!(status_json["key_hint"].is_null());

    let (push_st, push_ack, _) = send_http_command(&app, "qrz.push", json!({}), None).await;
    assert_eq!(push_st, StatusCode::BAD_REQUEST);
    assert_eq!(push_ack.status, CommandStatus::Rejected);
    assert_eq!(push_ack.error_code, Some(ErrorCode::QrzNotConfigured));

    // Configure station identity so User-Agent carries callsign
    let (st_cmd, _, _) = send_http_command(
        &app,
        "station.update_config",
        json!({ "callsign": "N1MPM", "grid": "FN33" }),
        None,
    )
    .await;
    assert_eq!(st_cmd, StatusCode::OK);

    // 2. Save QRZ API key and verify secret redaction across HTTP & SQLite audit log
    let secret_key = "1111-2222-3333-4444";
    let (cfg_st, cfg_ack, cfg_raw) = send_http_command(
        &app,
        "qrz.update_config",
        json!({ "api_key": secret_key }),
        None,
    )
    .await;
    assert_eq!(cfg_st, StatusCode::OK);
    assert_eq!(cfg_ack.status, CommandStatus::Ok);
    assert!(!cfg_raw.contains(secret_key));

    let (st_status2, status_json2, status_raw2) = get_json(&app, "/api/v1/qrz/status").await;
    assert_eq!(st_status2, StatusCode::OK);
    assert_eq!(status_json2["configured"], true);
    assert_eq!(status_json2["key_source"], "database");
    assert_eq!(status_json2["key_hint"], "••••-4444");
    assert!(!status_raw2.contains(secret_key));

    let (_, _, station_raw) = get_json(&app, "/api/v1/station").await;
    assert!(!station_raw.contains(secret_key));
    assert!(!station_raw.contains("qrz_api_key"));

    let audit_conn = Connection::open(state.store.db_path()).unwrap();
    let leaked_audits: i64 = audit_conn
        .query_row(
            "SELECT COUNT(*) FROM command_audit WHERE response_json LIKE ?1",
            [format!("%{secret_key}%")],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(leaked_audits, 0);

    // 3. Test connection via ACTION=STATUS
    let (test_st, test_ack, _) =
        send_http_command(&app, "qrz.test_connection", json!({}), None).await;
    assert_eq!(test_st, StatusCode::OK);
    assert_eq!(test_ack.status, CommandStatus::Ok);
    let test_res = test_ack.result.unwrap();
    assert_eq!(test_res["book_id"], "99");
    assert_eq!(test_res["callsign"], "N1MPM");
    assert_eq!(test_res["qso_count"], 42);

    let status_reqs = mock_state.take_requests();
    assert_eq!(status_reqs.len(), 1);
    assert_eq!(
        status_reqs[0].params.get("ACTION").map(String::as_str),
        Some("STATUS")
    );
    assert_eq!(
        status_reqs[0].params.get("KEY").map(String::as_str),
        Some(secret_key)
    );
    assert!(status_reqs[0]
        .user_agent
        .as_deref()
        .unwrap_or("")
        .contains("(N1MPM)"));

    // 4. Insert 2 real QSOs + 1 demo QSO; push sends only the 2 real QSOs
    state
        .store
        .insert_qso(&make_qso(
            "real-1",
            "N1MPM",
            "JA1ABC",
            "2026-11-23T12:02:00Z",
            Some(14_074_000),
            Some("20m"),
        ))
        .unwrap();
    state
        .store
        .insert_qso(&make_qso(
            "real-2",
            "N1MPM",
            "G4XYZ",
            "2026-11-23T12:04:00Z",
            Some(14_074_000),
            Some("20m"),
        ))
        .unwrap();
    state
        .store
        .insert_demo_qso(&make_qso(
            "demo-1",
            "QQ0DEMO",
            "QQ1XYZ",
            "2026-11-23T12:05:00Z",
            Some(14_074_000),
            Some("20m"),
        ))
        .unwrap();

    {
        let mut q = mock_state.insert_responses.lock().unwrap();
        q.push_back((StatusCode::OK, "RESULT=OK&LOGID=2001&COUNT=1".to_string()));
        q.push_back((StatusCode::OK, "RESULT=OK&LOGID=2002&COUNT=1".to_string()));
    }

    let (_, pre_push_status, _) = get_json(&app, "/api/v1/qrz/status").await;
    assert_eq!(pre_push_status["pending_count"], 2);
    assert_eq!(pre_push_status["synced_count"], 0);
    assert_eq!(pre_push_status["failed_count"], 0);

    let (push1_st, push1_ack, _) = send_http_command(&app, "qrz.push", json!({}), None).await;
    assert_eq!(push1_st, StatusCode::OK);
    assert_eq!(push1_ack.status, CommandStatus::Ok);
    let sum1 = push1_ack.result.unwrap();
    assert_eq!(sum1["total"], 2);
    assert_eq!(sum1["pushed"], 2);
    assert_eq!(sum1["duplicates"], 0);
    assert_eq!(sum1["failed"], 0);

    let reqs1 = mock_state.take_requests();
    assert_eq!(reqs1.len(), 2);
    for r in &reqs1 {
        assert_eq!(r.params.get("ACTION").map(String::as_str), Some("INSERT"));
        let adif = r.params.get("ADIF").unwrap();
        assert!(!adif.contains("<EOH>"));
        assert!(adif.contains("<EOR>"));
        assert!(!adif.contains("QQ"));
    }
    assert!(reqs1[0].params["ADIF"].contains("<CALL:6>JA1ABC "));
    assert!(reqs1[1].params["ADIF"].contains("<CALL:5>G4XYZ "));

    let (_, qso_list_json, _) = get_json(&app, "/api/v1/qsos?demo=false").await;
    let items = qso_list_json["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert!(items.iter().all(|q| q["qrz_status"] == "synced"));

    // 5. Second push with no new real QSOs sends 0 HTTP requests
    let (push2_st, push2_ack, _) = send_http_command(&app, "qrz.push", json!({}), None).await;
    assert_eq!(push2_st, StatusCode::OK);
    let sum2 = push2_ack.result.unwrap();
    assert_eq!(sum2["total"], 0);
    assert_eq!(sum2["pushed"], 0);
    assert!(mock_state.take_requests().is_empty());

    // 6. Log 1 new real QSO (hashed brackets + empty band) + 1 more demo QSO -> pushes only the 1 new QSO
    state
        .store
        .insert_qso(&make_qso(
            "real-3",
            "N1MPM",
            "<VK2DEF>",
            "2026-11-23T12:10:00Z",
            Some(7_074_000),
            Some(""),
        ))
        .unwrap();
    state
        .store
        .insert_demo_qso(&make_qso(
            "demo-2",
            "QQ0DEMO",
            "QQ2AAA",
            "2026-11-23T12:11:00Z",
            Some(14_074_000),
            Some("20m"),
        ))
        .unwrap();

    let (_, mid_status, _) = get_json(&app, "/api/v1/qrz/status").await;
    assert_eq!(mid_status["pending_count"], 1);
    assert_eq!(mid_status["synced_count"], 2);

    let (push3_st, push3_ack, _) = send_http_command(&app, "qrz.push", json!({}), None).await;
    assert_eq!(push3_st, StatusCode::OK);
    let sum3 = push3_ack.result.unwrap();
    assert_eq!(sum3["total"], 1);
    assert_eq!(sum3["pushed"], 1);

    let reqs3 = mock_state.take_requests();
    assert_eq!(reqs3.len(), 1);
    let adif3 = &reqs3[0].params["ADIF"];
    assert!(adif3.contains("<CALL:6>VK2DEF "));
    assert!(adif3.contains("<BAND:3>40m "));
    assert!(!adif3.contains("QQ"));

    mock_handle.abort();
}

#[tokio::test]
async fn qrz_duplicate_partial_failure_and_retry() {
    let (mock_url, mock_state, mock_handle) = spawn_mock_qrz().await;
    let (_dir, state) = test_state_with_qrz_url(mock_url, None);
    let app = build_router(Arc::clone(&state));

    let _ = send_http_command(
        &app,
        "qrz.update_config",
        json!({ "api_key": "AAAA-BBBB-CCCC-DDDD" }),
        None,
    )
    .await;

    state
        .store
        .insert_qso(&make_qso(
            "q1",
            "N1MPM",
            "K1AAA",
            "2026-11-23T13:01:00Z",
            Some(14_074_000),
            Some("20m"),
        ))
        .unwrap();
    state
        .store
        .insert_qso(&make_qso(
            "q2",
            "N1MPM",
            "W2BBB",
            "2026-11-23T13:02:00Z",
            Some(14_074_000),
            Some("20m"),
        ))
        .unwrap();
    state
        .store
        .insert_qso(&make_qso(
            "q3",
            "N1MPM",
            "DL3CCC",
            "2026-11-23T13:03:00Z",
            Some(14_074_000),
            Some("20m"),
        ))
        .unwrap();

    {
        let mut q = mock_state.insert_responses.lock().unwrap();
        q.push_back((StatusCode::OK, "RESULT=OK&LOGID=501".to_string()));
        q.push_back((
            StatusCode::OK,
            "RESULT=FAIL&REASON=Unable to add QSO to database: duplicate".to_string(),
        ));
        q.push_back((
            StatusCode::OK,
            "RESULT=FAIL&REASON=add_qso: outside date range".to_string(),
        ));
    }

    let (st1, ack1, _) = send_http_command(&app, "qrz.push", json!({}), None).await;
    assert_eq!(st1, StatusCode::OK);
    assert_eq!(ack1.status, CommandStatus::Ok);
    let sum1 = ack1.result.unwrap();
    assert_eq!(sum1["total"], 3);
    assert_eq!(sum1["pushed"], 1);
    assert_eq!(sum1["duplicates"], 1);
    assert_eq!(sum1["failed"], 1);
    let errs = sum1["errors"].as_array().unwrap();
    assert_eq!(errs.len(), 1);
    assert_eq!(errs[0]["their_call"], "DL3CCC");

    let (_, qrz_st1, _) = get_json(&app, "/api/v1/qrz/status").await;
    assert_eq!(qrz_st1["synced_count"], 2);
    assert_eq!(qrz_st1["failed_count"], 1);
    assert_eq!(qrz_st1["pending_count"], 0);

    // Retry pushes only the failed QSO (DL3CCC)
    let _ = mock_state.take_requests();
    mock_state
        .insert_responses
        .lock()
        .unwrap()
        .push_back((StatusCode::OK, "RESULT=OK&LOGID=503".to_string()));

    let (st2, ack2, _) = send_http_command(&app, "qrz.push", json!({}), None).await;
    assert_eq!(st2, StatusCode::OK);
    let sum2 = ack2.result.unwrap();
    assert_eq!(sum2["total"], 1);
    assert_eq!(sum2["pushed"], 1);
    assert_eq!(sum2["failed"], 0);

    let retry_reqs = mock_state.take_requests();
    assert_eq!(retry_reqs.len(), 1);
    assert!(retry_reqs[0].params["ADIF"].contains("<CALL:6>DL3CCC "));

    let (_, qrz_st2, _) = get_json(&app, "/api/v1/qrz/status").await;
    assert_eq!(qrz_st2["synced_count"], 3);
    assert_eq!(qrz_st2["failed_count"], 0);

    mock_handle.abort();
}

#[tokio::test]
async fn qrz_auth_failure_aborts_early_and_auth_token_enforced() {
    let (mock_url, mock_state, mock_handle) = spawn_mock_qrz().await;
    let (_dir, state) = test_state_with_qrz_url(mock_url, Some("shack-secret"));
    let app = build_router(Arc::clone(&state));

    // Unauthenticated mutating QRZ commands must return 401
    let (unauth_cfg_st, unauth_cfg_ack, _) = send_http_command(
        &app,
        "qrz.update_config",
        json!({ "api_key": "BAD-KEY-1234" }),
        None,
    )
    .await;
    assert_eq!(unauth_cfg_st, StatusCode::UNAUTHORIZED);
    assert_eq!(unauth_cfg_ack.error_code, Some(ErrorCode::AuthFailed));

    let (unauth_push_st, unauth_push_ack, _) =
        send_http_command(&app, "qrz.push", json!({}), None).await;
    assert_eq!(unauth_push_st, StatusCode::UNAUTHORIZED);
    assert_eq!(unauth_push_ack.error_code, Some(ErrorCode::AuthFailed));

    // Authenticated config succeeds
    let (auth_cfg_st, _, _) = send_http_command(
        &app,
        "qrz.update_config",
        json!({ "api_key": "BAD-KEY-1234" }),
        Some("shack-secret"),
    )
    .await;
    assert_eq!(auth_cfg_st, StatusCode::OK);

    // Insert 3 QSOs and configure mock to return AUTH error
    for idx in 1..=3 {
        state
            .store
            .insert_qso(&make_qso(
                &format!("qa-{idx}"),
                "N1MPM",
                &format!("W{idx}ABC"),
                &format!("2026-11-23T14:0{idx}:00Z"),
                Some(14_074_000),
                Some("20m"),
            ))
            .unwrap();
    }
    *mock_state.default_insert_response.lock().unwrap() = (
        StatusCode::OK,
        "RESULT=AUTH&REASON=invalid api key".to_string(),
    );

    let (push_st, push_ack, _) =
        send_http_command(&app, "qrz.push", json!({}), Some("shack-secret")).await;
    assert_eq!(push_st, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(push_ack.status, CommandStatus::Failed);
    assert_eq!(push_ack.error_code, Some(ErrorCode::QrzAuthFailed));

    // Batch aborted immediately on the first QSO; all 3 remain pending
    let reqs = mock_state.take_requests();
    assert_eq!(reqs.len(), 1);

    let (_, qrz_st, _) = get_json(&app, "/api/v1/qrz/status").await;
    assert_eq!(qrz_st["pending_count"], 3);
    assert_eq!(qrz_st["synced_count"], 0);
    assert_eq!(qrz_st["failed_count"], 0);

    mock_handle.abort();
}

#[tokio::test]
async fn qrz_concurrent_push_rejected() {
    let (mock_url, mock_state, mock_handle) = spawn_mock_qrz().await;
    let (_dir, state) = test_state_with_qrz_url(mock_url, None);
    let app = build_router(Arc::clone(&state));

    let _ = send_http_command(
        &app,
        "qrz.update_config",
        json!({ "api_key": "1111-2222-3333-4444" }),
        None,
    )
    .await;

    state
        .store
        .insert_qso(&make_qso(
            "conc-1",
            "N1MPM",
            "JA1ABC",
            "2026-11-23T15:00:00Z",
            Some(14_074_000),
            Some("20m"),
        ))
        .unwrap();

    mock_state.delay_ms.store(250, Ordering::Relaxed);

    let (res_a, res_b) = tokio::join!(
        send_http_command(&app, "qrz.push", json!({}), None),
        send_http_command(&app, "qrz.push", json!({}), None),
    );

    let statuses = [res_a.0, res_b.0];
    assert!(statuses.contains(&StatusCode::OK), "statuses: {statuses:?}");
    assert!(
        statuses.contains(&StatusCode::CONFLICT),
        "statuses: {statuses:?}"
    );
    let conflict_ack = if res_a.0 == StatusCode::CONFLICT {
        &res_a.1
    } else {
        &res_b.1
    };
    assert_eq!(conflict_ack.error_code, Some(ErrorCode::QrzSyncInProgress));

    mock_handle.abort();
}

#[tokio::test]
async fn qrz_http_401_and_403_with_kv_body_surfaces_qrz_reason() {
    let (mock_url, mock_state, mock_handle) = spawn_mock_qrz().await;
    let (_dir, state) = test_state_with_qrz_url(mock_url, None);
    let app = build_router(Arc::clone(&state));

    *mock_state.status_response.lock().unwrap() = (
        StatusCode::FORBIDDEN,
        "STATUS=FAIL&REASON=User does not have a valid QRZ XML subscription".to_string(),
    );

    let (st, ack, _) = send_http_command(
        &app,
        "qrz.test_connection",
        json!({ "api_key": "1111-2222-3333-4444" }),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(ack.error_code, Some(ErrorCode::QrzAuthFailed));
    assert!(ack
        .error_message
        .as_deref()
        .unwrap_or("")
        .contains("subscription"));

    *mock_state.status_response.lock().unwrap() = (
        StatusCode::UNAUTHORIZED,
        "STATUS=AUTH&RESULT=AUTH&REASON=invalid api key".to_string(),
    );

    let (st2, ack2, _) = send_http_command(
        &app,
        "qrz.test_connection",
        json!({ "api_key": "1111-2222-3333-4444" }),
        None,
    )
    .await;
    assert_eq!(st2, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(ack2.error_code, Some(ErrorCode::QrzAuthFailed));
    assert!(ack2
        .error_message
        .as_deref()
        .unwrap_or("")
        .contains("invalid api key"));

    mock_handle.abort();
}
