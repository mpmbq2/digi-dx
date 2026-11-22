use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::command_bus::{CommandEnvelope, CommandStatus, ErrorCode, WsBroadcastEvent};
use crate::domain::adif::export_adif_3_1_4;
use crate::preflight::run_preflight;
use crate::server::AppState;
use crate::telemetry::TelemetryEnvelope;

pub async fn health(State(state): State<Arc<AppState>>) -> Json<Value> {
    let preflight = state
        .preflight
        .read()
        .expect("preflight lock poisoned")
        .clone();

    Json(json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "uptime_sec": state.started_at.elapsed().as_secs(),
        "active_radios": state.supervisor.active_ready_count(),
        "active_ptt": state.supervisor.any_ptt_active(),
        "preflight_status": preflight.overall_status,
        "active_ft8_decoder": preflight.active_ft8_decoder,
    }))
}

#[derive(Debug, Deserialize)]
pub struct PreflightQuery {
    #[serde(default)]
    pub refresh: bool,
}

pub async fn preflight(
    State(state): State<Arc<AppState>>,
    Query(q): Query<PreflightQuery>,
) -> impl IntoResponse {
    if q.refresh {
        let cfg = state.config.clone();
        if let Ok(report) = tokio::task::spawn_blocking(move || run_preflight(&cfg, false)).await {
            if let Ok(mut guard) = state.preflight.write() {
                *guard = report.clone();
            }
            if let Ok(station) = state.store.get_station_config() {
                let ev = TelemetryEnvelope::new(
                    station.station_id,
                    None,
                    "station.preflight",
                    false,
                    json!({
                        "overall_status": report.overall_status,
                        "active_ft8_decoder": report.active_ft8_decoder,
                        "checks": report.checks,
                    }),
                );
                let _ = state.store.enqueue_telemetry(&ev);
            }
            let _ = state.ws_tx.send(WsBroadcastEvent::PreflightAlert {
                severity: if report.has_fatal() {
                    "fatal".to_string()
                } else {
                    "info".to_string()
                },
                title: "Preflight Refreshed".to_string(),
                detail: format!(
                    "Status {:?} (decoder: {})",
                    report.overall_status, report.active_ft8_decoder
                ),
                occurred_at_utc: report.checked_at_utc.clone(),
            });
            return (StatusCode::OK, Json(json!(report))).into_response();
        }
    }

    let report = state
        .preflight
        .read()
        .expect("preflight lock poisoned")
        .clone();
    (StatusCode::OK, Json(json!(report))).into_response()
}

pub async fn station(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.store.get_station_config() {
        Ok(cfg) => (
            StatusCode::OK,
            Json(json!({
                "station_id": cfg.station_id,
                "callsign": cfg.callsign,
                "grid": cfg.grid,
                "updated_at_utc": cfg.updated_at_utc,
                "auth_required": state.bus.auth_required(),
            })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "INTERNAL_ERROR", "message": e.to_string() })),
        )
            .into_response(),
    }
}

pub use crate::audio::devices::AudioDeviceInfo as AudioDeviceSummary;

pub async fn devices_audio() -> impl IntoResponse {
    let res = tokio::task::spawn_blocking(crate::audio::devices::enumerate_audio_devices).await;
    match res {
        Ok(list) => (StatusCode::OK, Json(json!({ "devices": list }))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "INTERNAL_ERROR", "message": e.to_string() })),
        )
            .into_response(),
    }
}

pub async fn devices_usb(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.supervisor.list_usb_inventory() {
        Ok(devices) => (StatusCode::OK, Json(json!({ "devices": devices }))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "INTERNAL_ERROR", "message": e.to_string() })),
        )
            .into_response(),
    }
}

pub async fn hamlib_models(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    (
        StatusCode::OK,
        Json(json!({ "models": state.hamlib_models.as_ref() })),
    )
}

pub fn build_radio_summaries(state: &AppState) -> Result<Vec<Value>, String> {
    let profiles = state
        .store
        .list_radio_profiles()
        .map_err(|e| e.to_string())?;
    let leases = state.bus.leases().snapshot();
    let snapshots = state.supervisor.list_radio_snapshots();

    let list = profiles
        .into_iter()
        .map(|p| {
            let lease_holder = leases
                .iter()
                .find(|l| l.radio_id == p.radio_id)
                .map(|l| l.holder_actor.clone());
            let snap = snapshots.iter().find(|s| s.radio_id == p.radio_id);
            let lifecycle_state = snap
                .map(|s| s.lifecycle_state.as_str())
                .unwrap_or("CONFIGURED");
            let freq_hz = snap
                .and_then(|s| s.freq_hz)
                .or_else(|| p.last_dial_freq_hz.and_then(|f| u64::try_from(f).ok()));
            json!({
                "profile": p,
                "lifecycle_state": lifecycle_state,
                "freq_hz": freq_hz,
                "band": snap.and_then(|s| s.band.clone()),
                "mode": snap.and_then(|s| s.mode.clone()),
                "passband_hz": snap.and_then(|s| s.passband_hz),
                "ptt": snap.map(|s| s.ptt).unwrap_or(false),
                "bound_serial_path": snap.and_then(|s| s.bound_serial_path.clone()),
                "rigctld_pid": snap.and_then(|s| s.rigctld_pid),
                "last_error": snap.and_then(|s| s.last_error.clone()),
                "recovery_attempts": snap.map(|s| s.recovery_attempts).unwrap_or(0),
                "lease_holder": lease_holder,
            })
        })
        .collect();
    Ok(list)
}

pub async fn radios(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match build_radio_summaries(&state) {
        Ok(list) => (StatusCode::OK, Json(json!({ "radios": list }))).into_response(),
        Err(msg) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "INTERNAL_ERROR", "message": msg })),
        )
            .into_response(),
    }
}

pub async fn radio_detail(
    State(state): State<Arc<AppState>>,
    Path(radio_id): Path<String>,
) -> impl IntoResponse {
    match state.store.get_radio_profile(&radio_id) {
        Ok(Some(profile)) => {
            let leases = state.bus.leases().snapshot();
            let lease = leases.into_iter().find(|l| l.radio_id == radio_id);
            let snap = state.supervisor.get_radio_snapshot(&radio_id);
            let lifecycle_state = snap
                .as_ref()
                .map(|s| s.lifecycle_state.as_str())
                .unwrap_or("CONFIGURED");
            let session = state.sessions.snapshot();
            let for_this = session.radio_id.as_deref() == Some(radio_id.as_str());
            (
                StatusCode::OK,
                Json(json!({
                    "profile": profile,
                    "lifecycle_state": lifecycle_state,
                    "snapshot": snap,
                    "lease": lease,
                    "session": if for_this { json!(session) } else { json!(null) },
                    "active_qsos": if for_this { json!(session.active_qsos) } else { json!([]) },
                    "recent_decodes": if for_this { json!(session.recent_decodes) } else { json!([]) },
                })),
            )
                .into_response()
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({
                "error": "RADIO_NOT_FOUND",
                "message": format!("Radio '{radio_id}' not found")
            })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "INTERNAL_ERROR", "message": e.to_string() })),
        )
            .into_response(),
    }
}

pub async fn dispatch_command(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(envelope): Json<CommandEnvelope>,
) -> impl IntoResponse {
    let token = extract_bearer_token(&headers);
    let ack = state.bus.dispatch(envelope, token.as_deref()).await;

    let status = match ack.status {
        CommandStatus::Ok => StatusCode::OK,
        CommandStatus::Rejected | CommandStatus::Failed => match ack.error_code {
            Some(ErrorCode::AuthFailed) => StatusCode::UNAUTHORIZED,
            Some(ErrorCode::ValidationFailed) => StatusCode::BAD_REQUEST,
            Some(ErrorCode::LeaseRequired | ErrorCode::LeaseHeld) => StatusCode::CONFLICT,
            Some(ErrorCode::RadioNotFound) => StatusCode::NOT_FOUND,
            Some(ErrorCode::InternalError) => StatusCode::INTERNAL_SERVER_ERROR,
            _ => StatusCode::UNPROCESSABLE_ENTITY,
        },
    };

    (status, Json(ack))
}

fn extract_bearer_token(headers: &HeaderMap) -> Option<String> {
    let val = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let rest = val
        .strip_prefix("Bearer ")
        .or_else(|| val.strip_prefix("bearer "))?;
    Some(rest.trim().to_string())
}

#[derive(Debug, Deserialize)]
pub struct QsoListQuery {
    #[serde(default = "default_qso_limit")]
    pub limit: u32,
    #[serde(default)]
    pub offset: u32,
    pub band: Option<String>,
    #[serde(default)]
    pub demo: bool,
}

fn default_qso_limit() -> u32 {
    100
}

pub async fn qsos(
    State(state): State<Arc<AppState>>,
    Query(q): Query<QsoListQuery>,
) -> impl IntoResponse {
    match state
        .store
        .list_qsos(q.limit, q.offset, q.band.as_deref(), q.demo)
    {
        Ok(items) => (
            StatusCode::OK,
            Json(json!({
                "demo": q.demo,
                "count": items.len(),
                "items": items,
            })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "INTERNAL_ERROR", "message": e.to_string() })),
        )
            .into_response(),
    }
}

pub async fn qsos_export_adi(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.store.list_real_qsos_for_adif() {
        Ok(records) => {
            let adif = export_adif_3_1_4(&records, Utc::now());
            (
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
                    (
                        header::CONTENT_DISPOSITION,
                        "attachment; filename=\"digi-dx.adi\"",
                    ),
                ],
                adif,
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "INTERNAL_ERROR", "message": e.to_string() })),
        )
            .into_response(),
    }
}

pub async fn outbox_stats(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.store.outbox_stats(&state.sink_name) {
        Ok(stats) => (StatusCode::OK, Json(json!(stats))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "INTERNAL_ERROR", "message": e.to_string() })),
        )
            .into_response(),
    }
}
