pub mod leases;
pub mod transport;

use std::sync::Arc;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use subtle::ConstantTimeEq;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::domain::ft8::{validate_station_callsign, validate_station_grid, validate_tx_message};
use crate::store::{
    now_utc_str, CreateRadioProfileInput, StateStore, StoreError, UpdateRadioProfileInput,
};
use crate::supervisor::DeviceSupervisor;
use crate::telemetry::TelemetryEnvelope;

use self::leases::{ControlLease, ControlLeaseManager, LeaseError};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandOrigin {
    LocalUi,
    Cli,
    GcpBridge,
}

impl CommandOrigin {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LocalUi => "local_ui",
            Self::Cli => "cli",
            Self::GcpBridge => "gcp_bridge",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandStatus {
    Ok,
    Rejected,
    Failed,
}

impl CommandStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Rejected => "rejected",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    ValidationFailed,
    AuthFailed,
    LeaseRequired,
    LeaseHeld,
    RadioNotFound,
    RadioNotReady,
    SessionAlreadyActive,
    NoActiveSession,
    ConfigRequired,
    DemoConfigForbidden,
    AudioDeviceUnavailable,
    CatUnavailable,
    CatCommandFailed,
    PortUnavailable,
    DecoderFailed,
    PttWatchdogAbort,
    InternalError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandEnvelope {
    #[serde(default = "default_uuid_v7")]
    pub command_id: String,
    #[serde(default)]
    pub idempotency_key: Option<String>,
    pub origin: CommandOrigin,
    pub actor: String,
    #[serde(default)]
    pub radio_id: Option<String>,
    pub kind: String,
    #[serde(default = "now_utc_str")]
    pub issued_at_utc: String,
    #[serde(default = "default_empty_obj")]
    pub payload: Value,
}

fn default_uuid_v7() -> String {
    Uuid::now_v7().to_string()
}

fn default_empty_obj() -> Value {
    json!({})
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandAck {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub command_id: String,
    pub status: CommandStatus,
    pub error_code: Option<ErrorCode>,
    pub error_message: Option<String>,
    pub result: Option<Value>,
    pub completed_at_utc: String,
}

impl CommandAck {
    pub fn ok(command_id: impl Into<String>, result: Value) -> Self {
        Self {
            msg_type: "command_ack".to_string(),
            command_id: command_id.into(),
            status: CommandStatus::Ok,
            error_code: None,
            error_message: None,
            result: Some(result),
            completed_at_utc: now_utc_str(),
        }
    }

    pub fn err(
        command_id: impl Into<String>,
        status: CommandStatus,
        code: ErrorCode,
        message: impl Into<String>,
    ) -> Self {
        Self {
            msg_type: "command_ack".to_string(),
            command_id: command_id.into(),
            status,
            error_code: Some(code),
            error_message: Some(message.into()),
            result: None,
            completed_at_utc: now_utc_str(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsBroadcastEvent {
    ControlLease {
        radio_id: String,
        held: bool,
        holder_actor: Option<String>,
        expires_at_utc: Option<String>,
    },
    PreflightAlert {
        severity: String,
        title: String,
        detail: String,
        occurred_at_utc: String,
    },
    StationUpdated {
        station_id: String,
        callsign: Option<String>,
        grid: Option<String>,
        updated_at_utc: String,
    },
    RadioState {
        radio_id: String,
        lifecycle_state: String,
        freq_hz: Option<u64>,
        band: Option<String>,
        mode: Option<String>,
        passband_hz: Option<u32>,
        ptt: bool,
        bound_serial_path: Option<String>,
        rigctld_port: Option<u16>,
        rigctld_pid: Option<u32>,
        last_error: Option<String>,
        recovery_attempts: Option<u32>,
        detail: Option<String>,
    },
    UsbDevicesChanged {
        devices: Value,
    },
}

pub struct CommandBus {
    store: StateStore,
    leases: Arc<ControlLeaseManager>,
    supervisor: Arc<DeviceSupervisor>,
    auth_token: Option<String>,
    ws_tx: broadcast::Sender<WsBroadcastEvent>,
}

impl CommandBus {
    pub fn new(
        store: StateStore,
        leases: Arc<ControlLeaseManager>,
        supervisor: Arc<DeviceSupervisor>,
        auth_token: Option<String>,
        ws_tx: broadcast::Sender<WsBroadcastEvent>,
    ) -> Self {
        Self {
            store,
            leases,
            supervisor,
            auth_token,
            ws_tx,
        }
    }

    pub fn auth_required(&self) -> bool {
        self.auth_token.is_some()
    }

    pub fn verify_token(&self, presented_token: Option<&str>) -> bool {
        let Some(expected) = &self.auth_token else {
            return true;
        };
        let Some(actual) = presented_token else {
            return false;
        };
        bool::from(expected.as_bytes().ct_eq(actual.as_bytes()))
    }

    pub fn leases(&self) -> &Arc<ControlLeaseManager> {
        &self.leases
    }

    pub async fn dispatch(
        &self,
        envelope: CommandEnvelope,
        presented_token: Option<&str>,
    ) -> CommandAck {
        let created_at = now_utc_str();

        // Stage 2a: Token authentication check (must happen before returning any cached ack).
        if !self.verify_token(presented_token) {
            return self.finalize_and_audit(
                &envelope,
                &created_at,
                CommandAck::err(
                    envelope.command_id.clone(),
                    CommandStatus::Rejected,
                    ErrorCode::AuthFailed,
                    "Invalid or missing bearer token",
                ),
                false,
            );
        }

        // Stage 1a: Basic envelope validation.
        if envelope.actor.trim().is_empty() {
            return self.finalize_and_audit(
                &envelope,
                &created_at,
                CommandAck::err(
                    envelope.command_id.clone(),
                    CommandStatus::Rejected,
                    ErrorCode::ValidationFailed,
                    "actor must not be empty",
                ),
                false,
            );
        }

        // Stage 1b: Idempotency cache lookup.
        if let Some(idem_key) = envelope
            .idempotency_key
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            match self.store.lookup_command_by_idempotency(idem_key) {
                Ok(Some(cached_json)) => {
                    if let Ok(mut cached_ack) = serde_json::from_str::<CommandAck>(&cached_json) {
                        cached_ack.command_id = envelope.command_id;
                        return cached_ack;
                    }
                }
                Ok(None) => {}
                Err(e) => {
                    return CommandAck::err(
                        envelope.command_id,
                        CommandStatus::Failed,
                        ErrorCode::InternalError,
                        format!("idempotency lookup failed: {e}"),
                    );
                }
            }
        }

        // Stage 1c: Command-specific input validation.
        if let Err((code, msg)) = validate_command(&envelope) {
            return self.finalize_and_audit(
                &envelope,
                &created_at,
                CommandAck::err(
                    envelope.command_id.clone(),
                    CommandStatus::Rejected,
                    code,
                    msg,
                ),
                true,
            );
        }

        // Stage 2b: Per-radio control lease check (tx.halt_emergency explicitly exempt).
        if requires_lease(&envelope.kind) {
            let radio_id = match resolve_radio_id(&envelope) {
                Some(r) => r,
                None => {
                    return self.finalize_and_audit(
                        &envelope,
                        &created_at,
                        CommandAck::err(
                            envelope.command_id.clone(),
                            CommandStatus::Rejected,
                            ErrorCode::ValidationFailed,
                            "radio_id is required for this command",
                        ),
                        true,
                    );
                }
            };

            if let Err(err) = self.leases.verify_holder(&radio_id, &envelope.actor) {
                let (code, msg) = map_lease_error(err);
                return self.finalize_and_audit(
                    &envelope,
                    &created_at,
                    CommandAck::err(
                        envelope.command_id.clone(),
                        CommandStatus::Rejected,
                        code,
                        msg,
                    ),
                    true,
                );
            }
        }

        // Stage 3: Execute command.
        let ack = self.execute_command(&envelope).await;

        // Stage 4: Persist audit & return ack (skip high-frequency successful heartbeats).
        let record_audit =
            !(envelope.kind == "control.heartbeat" && ack.status == CommandStatus::Ok);
        self.finalize_and_audit(&envelope, &created_at, ack, record_audit)
    }

    async fn execute_command(&self, envelope: &CommandEnvelope) -> CommandAck {
        match envelope.kind.as_str() {
            "station.update_config" => self.exec_station_update(envelope),
            "radio.create_profile" => self.exec_radio_create(envelope).await,
            "radio.update_profile" => self.exec_radio_update(envelope).await,
            "radio.delete_profile" => self.exec_radio_delete(envelope).await,
            "radio.restart" => self.exec_radio_restart(envelope).await,
            "radio.stop" => self.exec_radio_stop(envelope).await,
            "radio.test_cat" => self.exec_radio_test_cat(envelope).await,
            "radio.test_ptt" => self.exec_radio_test_ptt(envelope).await,
            "radio.set_freq" => self.exec_radio_set_freq(envelope).await,
            "radio.set_mode" => self.exec_radio_set_mode(envelope).await,
            "control.claim_lease" => self.exec_claim_lease(envelope),
            "control.release_lease" => self.exec_release_lease(envelope),
            "control.heartbeat" => self.exec_heartbeat(envelope),
            "tx.halt_emergency" => self.exec_halt_emergency(envelope).await,
            "session.start" | "session.stop" => {
                let radio_id = resolve_radio_id(envelope).unwrap_or_default();
                match self.store.get_radio_profile(&radio_id) {
                    Ok(Some(_)) => CommandAck::err(
                        envelope.command_id.clone(),
                        CommandStatus::Failed,
                        ErrorCode::RadioNotReady,
                        "Modem/audio session engine activates in Milestone M3",
                    ),
                    Ok(None) => CommandAck::err(
                        envelope.command_id.clone(),
                        CommandStatus::Rejected,
                        ErrorCode::RadioNotFound,
                        format!("Unknown radio_id '{radio_id}'"),
                    ),
                    Err(e) => CommandAck::err(
                        envelope.command_id.clone(),
                        CommandStatus::Failed,
                        ErrorCode::InternalError,
                        e.to_string(),
                    ),
                }
            }
            "tx.arm" | "tx.cancel" | "qso.call_cq" | "qso.reply" | "qso.action"
            | "qso.survey_af" | "qso.set_af" | "qso.set_tx_enabled" => CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Failed,
                ErrorCode::NoActiveSession,
                "Modem/QSO session engine activates in Milestone M3/M4",
            ),
            other => CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                format!("Unsupported command kind '{other}'"),
            ),
        }
    }

    fn exec_station_update(&self, envelope: &CommandEnvelope) -> CommandAck {
        let call_raw = envelope
            .payload
            .get("callsign")
            .and_then(Value::as_str)
            .unwrap_or("");
        let grid_raw = envelope
            .payload
            .get("grid")
            .and_then(Value::as_str)
            .unwrap_or("");

        let call = match validate_station_callsign(call_raw) {
            Ok(c) => c,
            Err(e) => {
                return CommandAck::err(
                    envelope.command_id.clone(),
                    CommandStatus::Rejected,
                    ErrorCode::ValidationFailed,
                    e,
                );
            }
        };
        let grid = match validate_station_grid(grid_raw) {
            Ok(g) => g,
            Err(e) => {
                return CommandAck::err(
                    envelope.command_id.clone(),
                    CommandStatus::Rejected,
                    ErrorCode::ValidationFailed,
                    e,
                );
            }
        };

        match self.store.update_station_config(&call, &grid) {
            Ok(cfg) => {
                let _ = self.ws_tx.send(WsBroadcastEvent::StationUpdated {
                    station_id: cfg.station_id.clone(),
                    callsign: cfg.callsign.clone(),
                    grid: cfg.grid.clone(),
                    updated_at_utc: cfg.updated_at_utc.clone(),
                });
                CommandAck::ok(
                    envelope.command_id.clone(),
                    serde_json::to_value(cfg).unwrap_or(Value::Null),
                )
            }
            Err(e) => CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Failed,
                ErrorCode::InternalError,
                e.to_string(),
            ),
        }
    }

    async fn exec_radio_create(&self, envelope: &CommandEnvelope) -> CommandAck {
        let input: CreateRadioProfileInput = match serde_json::from_value(envelope.payload.clone())
        {
            Ok(i) => i,
            Err(e) => {
                return CommandAck::err(
                    envelope.command_id.clone(),
                    CommandStatus::Rejected,
                    ErrorCode::ValidationFailed,
                    format!("Invalid radio profile payload: {e}"),
                );
            }
        };

        match self.store.create_radio_profile(&input) {
            Ok(profile) => {
                self.supervisor.on_profile_created(profile.clone()).await;
                let snap = self.supervisor.get_radio_snapshot(&profile.radio_id);
                CommandAck::ok(
                    envelope.command_id.clone(),
                    json!({
                        "profile": profile,
                        "snapshot": snap,
                    }),
                )
            }
            Err(StoreError::PortUnavailable) => CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Failed,
                ErrorCode::PortUnavailable,
                "All rigctld ports 4532..=4599 are allocated",
            ),
            Err(e) => CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Failed,
                ErrorCode::InternalError,
                e.to_string(),
            ),
        }
    }

    async fn exec_radio_update(&self, envelope: &CommandEnvelope) -> CommandAck {
        let mut payload = envelope.payload.clone();
        if let Some(obj) = payload.as_object_mut() {
            if !obj.contains_key("radio_id") {
                if let Some(rid) = &envelope.radio_id {
                    obj.insert("radio_id".to_string(), Value::String(rid.clone()));
                }
            }
        }
        let input: UpdateRadioProfileInput = match serde_json::from_value(payload) {
            Ok(i) => i,
            Err(e) => {
                return CommandAck::err(
                    envelope.command_id.clone(),
                    CommandStatus::Rejected,
                    ErrorCode::ValidationFailed,
                    format!("Invalid radio update payload: {e}"),
                );
            }
        };

        match self.store.update_radio_profile(&input) {
            Ok(profile) => {
                self.supervisor.on_profile_updated(profile.clone()).await;
                CommandAck::ok(
                    envelope.command_id.clone(),
                    serde_json::to_value(profile).unwrap_or(Value::Null),
                )
            }
            Err(StoreError::NotFound(id)) => CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::RadioNotFound,
                format!("Radio profile '{id}' not found"),
            ),
            Err(e) => CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Failed,
                ErrorCode::InternalError,
                e.to_string(),
            ),
        }
    }

    async fn exec_radio_delete(&self, envelope: &CommandEnvelope) -> CommandAck {
        let Some(radio_id) = resolve_radio_id(envelope) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "radio_id is required",
            );
        };
        self.supervisor.on_profile_deleted(&radio_id).await;
        match self.store.delete_radio_profile(&radio_id) {
            Ok(true) => {
                self.leases.force_clear(&radio_id);
                CommandAck::ok(envelope.command_id.clone(), json!({ "deleted": radio_id }))
            }
            Ok(false) => CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::RadioNotFound,
                format!("Radio profile '{radio_id}' not found"),
            ),
            Err(e) => CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Failed,
                ErrorCode::InternalError,
                e.to_string(),
            ),
        }
    }

    async fn exec_radio_restart(&self, envelope: &CommandEnvelope) -> CommandAck {
        let Some(radio_id) = resolve_radio_id(envelope) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "radio_id is required",
            );
        };
        match self.supervisor.restart_radio(&radio_id).await {
            Ok(res) => CommandAck::ok(envelope.command_id.clone(), res),
            Err((code, msg)) => CommandAck::err(
                envelope.command_id.clone(),
                status_for_error(code),
                code,
                msg,
            ),
        }
    }

    async fn exec_radio_stop(&self, envelope: &CommandEnvelope) -> CommandAck {
        let Some(radio_id) = resolve_radio_id(envelope) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "radio_id is required",
            );
        };
        match self.supervisor.stop_radio(&radio_id).await {
            Ok(res) => CommandAck::ok(envelope.command_id.clone(), res),
            Err((code, msg)) => CommandAck::err(
                envelope.command_id.clone(),
                status_for_error(code),
                code,
                msg,
            ),
        }
    }

    async fn exec_radio_test_cat(&self, envelope: &CommandEnvelope) -> CommandAck {
        let Some(radio_id) = resolve_radio_id(envelope) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "radio_id is required",
            );
        };
        match self.supervisor.test_cat(&radio_id).await {
            Ok(res) => CommandAck::ok(envelope.command_id.clone(), res),
            Err((code, msg)) => CommandAck::err(
                envelope.command_id.clone(),
                status_for_error(code),
                code,
                msg,
            ),
        }
    }

    async fn exec_radio_test_ptt(&self, envelope: &CommandEnvelope) -> CommandAck {
        let Some(radio_id) = resolve_radio_id(envelope) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "radio_id is required",
            );
        };
        let dur = envelope
            .payload
            .get("duration_ms")
            .and_then(Value::as_u64)
            .unwrap_or(200);
        match self.supervisor.test_ptt(&radio_id, dur).await {
            Ok(res) => CommandAck::ok(envelope.command_id.clone(), res),
            Err((code, msg)) => CommandAck::err(
                envelope.command_id.clone(),
                status_for_error(code),
                code,
                msg,
            ),
        }
    }

    async fn exec_radio_set_freq(&self, envelope: &CommandEnvelope) -> CommandAck {
        let Some(radio_id) = resolve_radio_id(envelope) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "radio_id is required",
            );
        };
        let Some(freq_hz) = envelope.payload.get("freq_hz").and_then(Value::as_u64) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "freq_hz integer is required",
            );
        };
        match self.supervisor.set_freq(&radio_id, freq_hz).await {
            Ok(res) => CommandAck::ok(envelope.command_id.clone(), res),
            Err((code, msg)) => CommandAck::err(
                envelope.command_id.clone(),
                status_for_error(code),
                code,
                msg,
            ),
        }
    }

    async fn exec_radio_set_mode(&self, envelope: &CommandEnvelope) -> CommandAck {
        let Some(radio_id) = resolve_radio_id(envelope) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "radio_id is required",
            );
        };
        let mode = envelope
            .payload
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_uppercase();
        let passband_hz = envelope
            .payload
            .get("passband_hz")
            .and_then(Value::as_u64)
            .unwrap_or(2400) as u32;
        match self
            .supervisor
            .set_mode(&radio_id, &mode, passband_hz)
            .await
        {
            Ok(res) => CommandAck::ok(envelope.command_id.clone(), res),
            Err((code, msg)) => CommandAck::err(
                envelope.command_id.clone(),
                status_for_error(code),
                code,
                msg,
            ),
        }
    }

    fn exec_claim_lease(&self, envelope: &CommandEnvelope) -> CommandAck {
        let Some(radio_id) = resolve_radio_id(envelope) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "radio_id is required",
            );
        };
        let force = envelope
            .payload
            .get("force")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        match self.leases.claim(&radio_id, &envelope.actor, force) {
            Ok(lease) => {
                self.broadcast_lease(&lease);
                CommandAck::ok(
                    envelope.command_id.clone(),
                    json!({
                        "lease_id": lease.lease_id,
                        "radio_id": lease.radio_id,
                        "holder_actor": lease.holder_actor,
                        "ttl_ms": self::leases::LEASE_TTL_MS,
                        "expires_at_utc": lease.expires_at_utc,
                    }),
                )
            }
            Err(e) => {
                let (code, msg) = map_lease_error(e);
                CommandAck::err(
                    envelope.command_id.clone(),
                    CommandStatus::Rejected,
                    code,
                    msg,
                )
            }
        }
    }

    fn exec_release_lease(&self, envelope: &CommandEnvelope) -> CommandAck {
        let Some(radio_id) = resolve_radio_id(envelope) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "radio_id is required",
            );
        };

        match self.leases.release(&radio_id, &envelope.actor) {
            Ok(()) => {
                let _ = self.ws_tx.send(WsBroadcastEvent::ControlLease {
                    radio_id: radio_id.clone(),
                    held: false,
                    holder_actor: None,
                    expires_at_utc: None,
                });
                CommandAck::ok(envelope.command_id.clone(), json!({ "released": radio_id }))
            }
            Err(e) => {
                let (code, msg) = map_lease_error(e);
                CommandAck::err(
                    envelope.command_id.clone(),
                    CommandStatus::Rejected,
                    code,
                    msg,
                )
            }
        }
    }

    fn exec_heartbeat(&self, envelope: &CommandEnvelope) -> CommandAck {
        let Some(radio_id) = resolve_radio_id(envelope) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "radio_id is required",
            );
        };
        let Some(lease_id) = envelope
            .payload
            .get("lease_id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "lease_id is required for control.heartbeat",
            );
        };

        match self.leases.heartbeat(&radio_id, &envelope.actor, lease_id) {
            Ok(lease) => CommandAck::ok(
                envelope.command_id.clone(),
                json!({
                    "kind": "control.heartbeat",
                    "radio_id": lease.radio_id,
                    "lease_id": lease.lease_id,
                    "expires_at_utc": lease.expires_at_utc,
                }),
            ),
            Err(e) => {
                let (code, msg) = map_lease_error(e);
                CommandAck::err(
                    envelope.command_id.clone(),
                    CommandStatus::Rejected,
                    code,
                    msg,
                )
            }
        }
    }

    async fn exec_halt_emergency(&self, envelope: &CommandEnvelope) -> CommandAck {
        let radio_id = resolve_radio_id(envelope);
        self.supervisor.emergency_halt(radio_id.as_deref()).await;
        if let Some(ref rid) = radio_id {
            self.leases.force_clear(rid);
            let _ = self.ws_tx.send(WsBroadcastEvent::ControlLease {
                radio_id: rid.clone(),
                held: false,
                holder_actor: None,
                expires_at_utc: None,
            });
        }

        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        if let Ok(station) = self.store.get_station_config() {
            let ev = TelemetryEnvelope::new(
                station.station_id,
                radio_id.clone(),
                "watchdog.abort",
                false,
                json!({
                    "reason": "tx.halt_emergency",
                    "actor": envelope.actor,
                    "origin": envelope.origin.as_str(),
                }),
            );
            let _ = self.store.enqueue_telemetry(&ev);
        }

        let _ = self.ws_tx.send(WsBroadcastEvent::PreflightAlert {
            severity: "warn".to_string(),
            title: "Emergency Halt TX".to_string(),
            detail: format!(
                "Emergency TX halt issued by {} ({}) for radio {:?}",
                envelope.actor,
                envelope.origin.as_str(),
                radio_id
            ),
            occurred_at_utc: now,
        });

        CommandAck::ok(
            envelope.command_id.clone(),
            json!({
                "halted": true,
                "radio_id": radio_id,
            }),
        )
    }

    fn broadcast_lease(&self, lease: &ControlLease) {
        let _ = self.ws_tx.send(WsBroadcastEvent::ControlLease {
            radio_id: lease.radio_id.clone(),
            held: true,
            holder_actor: Some(lease.holder_actor.clone()),
            expires_at_utc: Some(lease.expires_at_utc.clone()),
        });
    }

    fn finalize_and_audit(
        &self,
        envelope: &CommandEnvelope,
        created_at: &str,
        ack: CommandAck,
        record_audit: bool,
    ) -> CommandAck {
        if record_audit {
            let idem = envelope
                .idempotency_key
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let err_code_str = ack
                .error_code
                .and_then(|c| serde_json::to_value(c).ok())
                .and_then(|v| v.as_str().map(str::to_string));
            let resp_json = serde_json::to_string(&ack).unwrap_or_else(|_| "{}".to_string());
            let _ = self.store.insert_command_audit(
                &envelope.command_id,
                idem,
                envelope.origin.as_str(),
                &envelope.actor,
                envelope.radio_id.as_deref(),
                &envelope.kind,
                ack.status.as_str(),
                err_code_str.as_deref(),
                &resp_json,
                created_at,
                &ack.completed_at_utc,
            );
        }
        ack
    }
}

fn resolve_radio_id(envelope: &CommandEnvelope) -> Option<String> {
    envelope
        .radio_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            envelope
                .payload
                .get("radio_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
}

fn requires_lease(kind: &str) -> bool {
    matches!(
        kind,
        "radio.test_ptt"
            | "radio.set_freq"
            | "radio.set_mode"
            | "control.release_lease"
            | "control.heartbeat"
            | "session.start"
            | "session.stop"
            | "tx.arm"
            | "tx.cancel"
            | "qso.call_cq"
            | "qso.reply"
            | "qso.action"
            | "qso.survey_af"
            | "qso.set_af"
            | "qso.set_tx_enabled"
    )
}

fn validate_command(envelope: &CommandEnvelope) -> Result<(), (ErrorCode, String)> {
    match envelope.kind.as_str() {
        "station.update_config" => {
            let call = envelope
                .payload
                .get("callsign")
                .and_then(Value::as_str)
                .ok_or((
                    ErrorCode::ValidationFailed,
                    "callsign is required".to_string(),
                ))?;
            let grid = envelope
                .payload
                .get("grid")
                .and_then(Value::as_str)
                .ok_or((ErrorCode::ValidationFailed, "grid is required".to_string()))?;
            validate_station_callsign(call).map_err(|e| (ErrorCode::ValidationFailed, e))?;
            validate_station_grid(grid).map_err(|e| (ErrorCode::ValidationFailed, e))?;
            Ok(())
        }
        "tx.arm" => {
            let af = envelope
                .payload
                .get("af_hz")
                .and_then(Value::as_i64)
                .ok_or((
                    ErrorCode::ValidationFailed,
                    "af_hz integer is required".to_string(),
                ))?;
            if !(200..=3000).contains(&af) {
                return Err((
                    ErrorCode::ValidationFailed,
                    format!("af_hz {af} outside valid FT8 range 200..=3000"),
                ));
            }
            let slot = envelope
                .payload
                .get("slot")
                .and_then(Value::as_str)
                .unwrap_or("");
            if slot != "even" && slot != "odd" {
                return Err((
                    ErrorCode::ValidationFailed,
                    "slot must be 'even' or 'odd'".to_string(),
                ));
            }
            let msg = envelope
                .payload
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("");
            validate_tx_message(msg).map_err(|e| (ErrorCode::ValidationFailed, e))?;
            Ok(())
        }
        "qso.set_af" => {
            let af = envelope
                .payload
                .get("af_hz")
                .and_then(Value::as_i64)
                .ok_or((
                    ErrorCode::ValidationFailed,
                    "af_hz integer is required".to_string(),
                ))?;
            if !(200..=3000).contains(&af) {
                return Err((
                    ErrorCode::ValidationFailed,
                    format!("af_hz {af} outside valid FT8 range 200..=3000"),
                ));
            }
            Ok(())
        }
        "radio.test_ptt" => {
            let dur = envelope
                .payload
                .get("duration_ms")
                .and_then(Value::as_i64)
                .unwrap_or(200);
            if !(1..=500).contains(&dur) {
                return Err((
                    ErrorCode::ValidationFailed,
                    "radio.test_ptt duration_ms must be between 1 and 500 ms".to_string(),
                ));
            }
            Ok(())
        }
        "radio.set_freq" => {
            let freq = envelope
                .payload
                .get("freq_hz")
                .and_then(Value::as_u64)
                .ok_or((
                    ErrorCode::ValidationFailed,
                    "freq_hz positive integer is required".to_string(),
                ))?;
            if !(100_000..=2_000_000_000).contains(&freq) {
                return Err((
                    ErrorCode::ValidationFailed,
                    format!("freq_hz {freq} outside supported range 100kHz..2GHz"),
                ));
            }
            Ok(())
        }
        "radio.set_mode" => {
            let mode = envelope
                .payload
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_ascii_uppercase();
            let valid_modes = [
                "USB", "LSB", "PKTUSB", "PKTLSB", "CW", "CWR", "FM", "AM", "RTTY", "RTTYR", "DATA",
            ];
            if !valid_modes.contains(&mode.as_str()) {
                return Err((
                    ErrorCode::ValidationFailed,
                    format!("unsupported mode '{mode}'"),
                ));
            }
            if let Some(pb) = envelope.payload.get("passband_hz").and_then(Value::as_i64) {
                if !(0..=50_000).contains(&pb) {
                    return Err((
                        ErrorCode::ValidationFailed,
                        "passband_hz must be between 0 and 50000".to_string(),
                    ));
                }
            }
            Ok(())
        }
        "radio.create_profile" => {
            let name = envelope
                .payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if name.is_empty() {
                return Err((
                    ErrorCode::ValidationFailed,
                    "radio profile name is required".to_string(),
                ));
            }
            let model = envelope
                .payload
                .get("hamlib_model")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            if model <= 0 {
                return Err((
                    ErrorCode::ValidationFailed,
                    "hamlib_model must be a positive integer".to_string(),
                ));
            }
            if let Some(baud) = envelope
                .payload
                .get("serial_baud_rate")
                .and_then(Value::as_i64)
            {
                if baud <= 0 {
                    return Err((
                        ErrorCode::ValidationFailed,
                        "serial_baud_rate must be positive".to_string(),
                    ));
                }
            }
            if let Some(ptt) = envelope.payload.get("ptt_method").and_then(Value::as_str) {
                if !matches!(ptt, "cat" | "cat_data" | "rts" | "dtr" | "vox") {
                    return Err((
                        ErrorCode::ValidationFailed,
                        format!("invalid ptt_method '{ptt}'"),
                    ));
                }
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn status_for_error(code: ErrorCode) -> CommandStatus {
    match code {
        ErrorCode::ValidationFailed
        | ErrorCode::AuthFailed
        | ErrorCode::LeaseRequired
        | ErrorCode::LeaseHeld
        | ErrorCode::RadioNotFound => CommandStatus::Rejected,
        _ => CommandStatus::Failed,
    }
}

fn map_lease_error(err: LeaseError) -> (ErrorCode, String) {
    match err {
        LeaseError::Required => (
            ErrorCode::LeaseRequired,
            "Active per-radio control lease is required (call control.claim_lease)".to_string(),
        ),
        LeaseError::HeldByOther { holder_actor } => (
            ErrorCode::LeaseHeld,
            format!("Radio control lease is currently held by '{holder_actor}'"),
        ),
        LeaseError::InvalidLeaseId => (
            ErrorCode::LeaseRequired,
            "Provided lease_id does not match the active lease".to_string(),
        ),
    }
}
