pub mod leases;
pub mod transport;

use std::sync::Arc;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use subtle::ConstantTimeEq;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::domain::adif::QsoRecord;
use crate::domain::clock::{SlotClockSpec, SlotParity};
use crate::domain::ft8::{validate_station_callsign, validate_station_grid, validate_tx_message};
use crate::modem::{DecoderBackendChoice, DecoderOption, TxIntent};
use crate::qrz::{QrzClientError, QrzPushError, QrzStatusSnapshot, QrzSyncService};
use crate::qso::sequencer::{ActiveQso, CqState, QsoAction, SequencerMode};
use crate::qso::SessionManager;
use crate::store::{
    now_utc_str, ChannelRosterEntry, CreateRadioProfileInput, StateStore, StoreError,
    UpdateRadioProfileInput,
};
use crate::supervisor::radio_worker::RadioLiveSettings;
use crate::supervisor::rigctld::{RigCapabilities, CURATED_FUNCS, WRITABLE_LEVELS};
use crate::supervisor::DeviceSupervisor;
use crate::telemetry::TelemetryEnvelope;
use crate::watchdog::{PttWatchdog, WatchdogAbortReason};

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
    QrzNotConfigured,
    QrzAuthFailed,
    QrzSyncInProgress,
    QrzRequestFailed,
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
        #[serde(skip_serializing_if = "Option::is_none")]
        capabilities: Option<Box<RigCapabilities>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        settings: Option<Box<RadioLiveSettings>>,
        detail: Option<String>,
    },
    RosterUpdate {
        radio_id: String,
        is_demo: bool,
        channel_key: String,
        band: Option<String>,
        dial_freq_hz: Option<i64>,
        entries: Vec<ChannelRosterEntry>,
    },
    UsbDevicesChanged {
        devices: Value,
    },
    WatchdogAbort {
        radio_id: String,
        reason: String,
        elapsed_ms: u64,
        occurred_at_utc: String,
    },
    SlotClockUpdated {
        radio_id: Option<String>,
        active: bool,
        is_demo: bool,
        decoder_backend: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        digital_mode: Option<String>,
        slot_clock: SlotClockSpec,
    },
    Decode {
        radio_id: String,
        ts_sec: i64,
        slot: String,
        snr_db: i8,
        dt_sec: f32,
        af_hz: u16,
        mode: String,
        message: String,
        decoder_backend: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        decoder_metadata: Option<String>,
    },
    TxState {
        radio_id: String,
        state: String,
        af_hz: Option<u16>,
        slot: Option<String>,
        message: Option<String>,
        ptt_elapsed_ms: u64,
    },
    Waterfall {
        radio_id: String,
        min_hz: f32,
        max_hz: f32,
        bin_hz: f32,
        bins_db: Vec<f32>,
        rms_db: f32,
        peak_db: f32,
        clipped: bool,
        even_occupied_hz: Vec<u16>,
        odd_occupied_hz: Vec<u16>,
    },
    QsoUpdate {
        radio_id: Option<String>,
        active: bool,
        is_demo: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        digital_mode: Option<String>,
        my_call: Option<String>,
        my_grid: Option<String>,
        tx_enabled: bool,
        tx_af_hz: u16,
        tx_af_occupied: bool,
        survey_active: bool,
        #[serde(default)]
        sequencer_mode: SequencerMode,
        #[serde(default)]
        armed_qso_id: Option<String>,
        #[serde(default)]
        cq: Option<CqState>,
        active_qsos: Vec<ActiveQso>,
        completed_qso: Option<Box<QsoRecord>>,
    },
    QrzSyncUpdate {
        status: Box<QrzStatusSnapshot>,
    },
    DecoderConfigUpdated {
        active_decoder: String,
        available_decoders: Vec<DecoderOption>,
    },
}

pub struct CommandBus {
    store: StateStore,
    leases: Arc<ControlLeaseManager>,
    supervisor: Arc<DeviceSupervisor>,
    watchdog: Arc<PttWatchdog>,
    sessions: Arc<SessionManager>,
    qrz: Arc<QrzSyncService>,
    auth_token: Option<String>,
    ws_tx: broadcast::Sender<WsBroadcastEvent>,
}

impl CommandBus {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        store: StateStore,
        leases: Arc<ControlLeaseManager>,
        supervisor: Arc<DeviceSupervisor>,
        watchdog: Arc<PttWatchdog>,
        sessions: Arc<SessionManager>,
        qrz: Arc<QrzSyncService>,
        auth_token: Option<String>,
        ws_tx: broadcast::Sender<WsBroadcastEvent>,
    ) -> Self {
        Self {
            store,
            leases,
            supervisor,
            watchdog,
            sessions,
            qrz,
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
            "station.update_config" => self.exec_station_update(envelope).await,
            "radio.create_profile" => self.exec_radio_create(envelope).await,
            "radio.update_profile" => self.exec_radio_update(envelope).await,
            "radio.delete_profile" => self.exec_radio_delete(envelope).await,
            "radio.restart" => self.exec_radio_restart(envelope).await,
            "radio.stop" => self.exec_radio_stop(envelope).await,
            "radio.test_cat" => self.exec_radio_test_cat(envelope).await,
            "radio.test_ptt" => self.exec_radio_test_ptt(envelope).await,
            "radio.set_freq" => self.exec_radio_set_freq(envelope).await,
            "radio.set_mode" => self.exec_radio_set_mode(envelope).await,
            "radio.set_vfo" => self.exec_radio_set_vfo(envelope).await,
            "radio.set_split" => self.exec_radio_set_split(envelope).await,
            "radio.set_rit" => self.exec_radio_set_rit(envelope).await,
            "radio.set_xit" => self.exec_radio_set_xit(envelope).await,
            "radio.set_level" => self.exec_radio_set_level(envelope).await,
            "radio.set_func" => self.exec_radio_set_func(envelope).await,
            "radio.atu_tune" => self.exec_radio_atu_tune(envelope).await,
            "radio.refresh_settings" => self.exec_radio_refresh_settings(envelope).await,
            "control.claim_lease" => self.exec_claim_lease(envelope),
            "control.release_lease" => self.exec_release_lease(envelope).await,
            "control.heartbeat" => self.exec_heartbeat(envelope).await,
            "tx.halt_emergency" => self.exec_halt_emergency(envelope).await,
            "session.start" => self.exec_session_start(envelope).await,
            "session.stop" => self.exec_session_stop(envelope).await,
            "session.set_mode" => self.exec_session_set_mode(envelope).await,
            "session.set_decoder" => self.exec_session_set_decoder(envelope).await,
            "tx.tune" => self.exec_tx_tune(envelope).await,
            "tx.arm" => self.exec_tx_arm(envelope).await,
            "tx.cancel" => self.exec_tx_cancel(envelope).await,
            "qso.call_cq" => self.exec_qso_call_cq(envelope).await,
            "qso.stop_cq" => self.exec_qso_stop_cq(envelope).await,
            "qso.set_sequencer_mode" => self.exec_qso_set_sequencer_mode(envelope).await,
            "qso.reply" => self.exec_qso_reply(envelope).await,
            "qso.action" => self.exec_qso_action(envelope).await,
            "qso.survey_af" => self.exec_qso_survey_af(envelope).await,
            "qso.set_af" => self.exec_qso_set_af(envelope).await,
            "qso.set_tx_enabled" => self.exec_qso_set_tx_enabled(envelope).await,
            "qrz.update_config" => self.exec_qrz_update_config(envelope).await,
            "qrz.test_connection" => self.exec_qrz_test_connection(envelope).await,
            "qrz.push" => self.exec_qrz_push(envelope).await,
            other => CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                format!("Unsupported command kind '{other}'"),
            ),
        }
    }

    async fn exec_station_update(&self, envelope: &CommandEnvelope) -> CommandAck {
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
                self.sessions
                    .update_live_station_identity(&call, &grid)
                    .await;
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

    async fn exec_qrz_update_config(&self, envelope: &CommandEnvelope) -> CommandAck {
        let api_key = match envelope.payload.get("api_key") {
            Some(Value::String(s)) => Some(s.as_str()),
            Some(Value::Null) | None => None,
            _ => {
                return CommandAck::err(
                    envelope.command_id.clone(),
                    CommandStatus::Rejected,
                    ErrorCode::ValidationFailed,
                    "api_key must be a string or null",
                );
            }
        };

        match self.qrz.update_api_key(api_key) {
            Ok(status) => CommandAck::ok(
                envelope.command_id.clone(),
                serde_json::to_value(status).unwrap_or(Value::Null),
            ),
            Err(e) => CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Failed,
                ErrorCode::InternalError,
                e.to_string(),
            ),
        }
    }

    async fn exec_qrz_test_connection(&self, envelope: &CommandEnvelope) -> CommandAck {
        let override_key = envelope.payload.get("api_key").and_then(Value::as_str);

        match self.qrz.test_connection(override_key).await {
            Ok(account) => CommandAck::ok(
                envelope.command_id.clone(),
                serde_json::to_value(account).unwrap_or(Value::Null),
            ),
            Err(QrzClientError::Auth(msg)) => CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Failed,
                ErrorCode::QrzAuthFailed,
                msg,
            ),
            Err(
                QrzClientError::Rejected(msg)
                | QrzClientError::Transport(msg)
                | QrzClientError::InvalidResponse(msg),
            ) => CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Failed,
                ErrorCode::QrzRequestFailed,
                msg,
            ),
        }
    }

    async fn exec_qrz_push(&self, envelope: &CommandEnvelope) -> CommandAck {
        match self.qrz.push_pending().await {
            Ok(summary) => CommandAck::ok(
                envelope.command_id.clone(),
                serde_json::to_value(summary).unwrap_or(Value::Null),
            ),
            Err(QrzPushError::NotConfigured) => CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::QrzNotConfigured,
                "QRZ API key is not configured",
            ),
            Err(QrzPushError::AlreadyInProgress) => CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::QrzSyncInProgress,
                "A QRZ logbook push is already in progress",
            ),
            Err(QrzPushError::AuthFailed { reason, summary }) => CommandAck {
                msg_type: "command_ack".to_string(),
                command_id: envelope.command_id.clone(),
                status: CommandStatus::Failed,
                error_code: Some(ErrorCode::QrzAuthFailed),
                error_message: Some(reason),
                result: Some(serde_json::to_value(summary).unwrap_or(Value::Null)),
                completed_at_utc: now_utc_str(),
            },
            Err(QrzPushError::TransportFailed { reason, summary }) => CommandAck {
                msg_type: "command_ack".to_string(),
                command_id: envelope.command_id.clone(),
                status: CommandStatus::Failed,
                error_code: Some(ErrorCode::QrzRequestFailed),
                error_message: Some(reason),
                result: Some(serde_json::to_value(summary).unwrap_or(Value::Null)),
                completed_at_utc: now_utc_str(),
            },
            Err(QrzPushError::Store(e)) => CommandAck::err(
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

    async fn exec_radio_set_vfo(&self, envelope: &CommandEnvelope) -> CommandAck {
        let Some(radio_id) = resolve_radio_id(envelope) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "radio_id is required",
            );
        };
        let vfo = envelope
            .payload
            .get("vfo")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        match self.supervisor.set_vfo(&radio_id, vfo).await {
            Ok(res) => CommandAck::ok(envelope.command_id.clone(), res),
            Err((code, msg)) => CommandAck::err(
                envelope.command_id.clone(),
                status_for_error(code),
                code,
                msg,
            ),
        }
    }

    async fn exec_radio_set_split(&self, envelope: &CommandEnvelope) -> CommandAck {
        let Some(radio_id) = resolve_radio_id(envelope) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "radio_id is required",
            );
        };
        let enabled = envelope
            .payload
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let tx_vfo = envelope
            .payload
            .get("tx_vfo")
            .and_then(Value::as_str)
            .unwrap_or("VFOB");
        match self.supervisor.set_split(&radio_id, enabled, tx_vfo).await {
            Ok(res) => CommandAck::ok(envelope.command_id.clone(), res),
            Err((code, msg)) => CommandAck::err(
                envelope.command_id.clone(),
                status_for_error(code),
                code,
                msg,
            ),
        }
    }

    async fn exec_radio_set_rit(&self, envelope: &CommandEnvelope) -> CommandAck {
        let Some(radio_id) = resolve_radio_id(envelope) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "radio_id is required",
            );
        };
        let offset_hz = envelope
            .payload
            .get("offset_hz")
            .and_then(Value::as_i64)
            .unwrap_or(0) as i32;
        match self.supervisor.set_rit(&radio_id, offset_hz).await {
            Ok(res) => CommandAck::ok(envelope.command_id.clone(), res),
            Err((code, msg)) => CommandAck::err(
                envelope.command_id.clone(),
                status_for_error(code),
                code,
                msg,
            ),
        }
    }

    async fn exec_radio_set_xit(&self, envelope: &CommandEnvelope) -> CommandAck {
        let Some(radio_id) = resolve_radio_id(envelope) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "radio_id is required",
            );
        };
        let offset_hz = envelope
            .payload
            .get("offset_hz")
            .and_then(Value::as_i64)
            .unwrap_or(0) as i32;
        match self.supervisor.set_xit(&radio_id, offset_hz).await {
            Ok(res) => CommandAck::ok(envelope.command_id.clone(), res),
            Err((code, msg)) => CommandAck::err(
                envelope.command_id.clone(),
                status_for_error(code),
                code,
                msg,
            ),
        }
    }

    async fn exec_radio_set_level(&self, envelope: &CommandEnvelope) -> CommandAck {
        let Some(radio_id) = resolve_radio_id(envelope) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "radio_id is required",
            );
        };
        let name = envelope
            .payload
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("");
        let value = envelope
            .payload
            .get("value")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        match self.supervisor.set_level(&radio_id, name, value).await {
            Ok(res) => CommandAck::ok(envelope.command_id.clone(), res),
            Err((code, msg)) => CommandAck::err(
                envelope.command_id.clone(),
                status_for_error(code),
                code,
                msg,
            ),
        }
    }

    async fn exec_radio_set_func(&self, envelope: &CommandEnvelope) -> CommandAck {
        let Some(radio_id) = resolve_radio_id(envelope) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "radio_id is required",
            );
        };
        let name = envelope
            .payload
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("");
        let enabled = envelope
            .payload
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if name.eq_ignore_ascii_case("TUNER") {
            let sess = self.sessions.snapshot();
            if sess.active
                && sess.radio_id.as_deref() == Some(radio_id.as_str())
                && sess.tx_state == "transmitting"
            {
                return CommandAck::err(
                    envelope.command_id.clone(),
                    CommandStatus::Rejected,
                    ErrorCode::CatCommandFailed,
                    "Cannot change ATU bypass state while transmitting — halt TX first",
                );
            }
        }
        match self.supervisor.set_func(&radio_id, name, enabled).await {
            Ok(res) => CommandAck::ok(envelope.command_id.clone(), res),
            Err((code, msg)) => CommandAck::err(
                envelope.command_id.clone(),
                status_for_error(code),
                code,
                msg,
            ),
        }
    }

    async fn exec_radio_atu_tune(&self, envelope: &CommandEnvelope) -> CommandAck {
        let Some(radio_id) = resolve_radio_id(envelope) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "radio_id is required",
            );
        };
        let sess = self.sessions.snapshot();
        if sess.active
            && sess.radio_id.as_deref() == Some(radio_id.as_str())
            && sess.tx_state == "transmitting"
        {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::CatCommandFailed,
                "Cannot start ATU tune while transmitting — halt TX first",
            );
        }
        match self.supervisor.atu_tune(&radio_id).await {
            Ok(res) => CommandAck::ok(envelope.command_id.clone(), res),
            Err((code, msg)) => CommandAck::err(
                envelope.command_id.clone(),
                status_for_error(code),
                code,
                msg,
            ),
        }
    }

    async fn exec_radio_refresh_settings(&self, envelope: &CommandEnvelope) -> CommandAck {
        let Some(radio_id) = resolve_radio_id(envelope) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "radio_id is required",
            );
        };
        match self.supervisor.refresh_settings(&radio_id).await {
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

    async fn exec_release_lease(&self, envelope: &CommandEnvelope) -> CommandAck {
        let Some(radio_id) = resolve_radio_id(envelope) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "radio_id is required",
            );
        };

        self.sessions.stop_tune(Some(&radio_id)).await;
        self.sessions.abort_active_tx(&radio_id).await;
        self.watchdog
            .trigger_abort(&radio_id, WatchdogAbortReason::LeaseReleased)
            .await;

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

    async fn exec_heartbeat(&self, envelope: &CommandEnvelope) -> CommandAck {
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
            Ok(lease) => {
                self.watchdog
                    .pet_heartbeat(&radio_id, &envelope.actor)
                    .await;
                CommandAck::ok(
                    envelope.command_id.clone(),
                    json!({
                        "kind": "control.heartbeat",
                        "radio_id": lease.radio_id,
                        "lease_id": lease.lease_id,
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

    async fn exec_halt_emergency(&self, envelope: &CommandEnvelope) -> CommandAck {
        let radio_id = resolve_radio_id(envelope);
        self.sessions.emergency_halt(radio_id.as_deref()).await;
        let aborted_via_wd = match radio_id {
            Some(ref rid) => {
                self.watchdog
                    .trigger_abort(rid, WatchdogAbortReason::EmergencyHalt)
                    .await
            }
            None => false,
        };
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
        if !aborted_via_wd {
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

    async fn exec_session_start(&self, envelope: &CommandEnvelope) -> CommandAck {
        let Some(radio_id) = resolve_radio_id(envelope) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "radio_id is required",
            );
        };
        let demo = envelope
            .payload
            .get("demo")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let scale = envelope.payload.get("scale").and_then(Value::as_f64);
        let mode = envelope.payload.get("mode").and_then(Value::as_str);
        let decoder = envelope
            .payload
            .get("decoder_backend")
            .and_then(Value::as_str);
        match self
            .sessions
            .start_session_with_options(&radio_id, &envelope.actor, demo, scale, mode, decoder)
            .await
        {
            Ok(v) => CommandAck::ok(envelope.command_id.clone(), v),
            Err((code, msg)) => CommandAck::err(
                envelope.command_id.clone(),
                status_for_error(code),
                code,
                msg,
            ),
        }
    }

    async fn exec_session_stop(&self, envelope: &CommandEnvelope) -> CommandAck {
        let radio_id = resolve_radio_id(envelope);
        match self.sessions.stop_session(radio_id.as_deref()).await {
            Ok(v) => CommandAck::ok(envelope.command_id.clone(), v),
            Err((code, msg)) => CommandAck::err(
                envelope.command_id.clone(),
                status_for_error(code),
                code,
                msg,
            ),
        }
    }

    async fn exec_session_set_mode(&self, envelope: &CommandEnvelope) -> CommandAck {
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
            .unwrap_or("");
        match self.sessions.set_session_mode(&radio_id, mode).await {
            Ok(v) => CommandAck::ok(envelope.command_id.clone(), v),
            Err((code, msg)) => CommandAck::err(
                envelope.command_id.clone(),
                status_for_error(code),
                code,
                msg,
            ),
        }
    }

    async fn exec_session_set_decoder(&self, envelope: &CommandEnvelope) -> CommandAck {
        let decoder = envelope
            .payload
            .get("decoder_backend")
            .and_then(Value::as_str)
            .unwrap_or("");
        match self.sessions.set_decoder_backend(decoder).await {
            Ok(v) => CommandAck::ok(envelope.command_id.clone(), v),
            Err((code, msg)) => CommandAck::err(
                envelope.command_id.clone(),
                status_for_error(code),
                code,
                msg,
            ),
        }
    }

    async fn exec_tx_tune(&self, envelope: &CommandEnvelope) -> CommandAck {
        let Some(radio_id) = resolve_radio_id(envelope) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "radio_id is required",
            );
        };
        let enabled = envelope
            .payload
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let af_hz = envelope
            .payload
            .get("af_hz")
            .and_then(Value::as_u64)
            .map(|n| n as u16);
        match self
            .sessions
            .set_tune(&radio_id, &envelope.actor, enabled, af_hz)
            .await
        {
            Ok(v) => CommandAck::ok(envelope.command_id.clone(), v),
            Err((code, msg)) => CommandAck::err(
                envelope.command_id.clone(),
                status_for_error(code),
                code,
                msg,
            ),
        }
    }

    async fn exec_tx_arm(&self, envelope: &CommandEnvelope) -> CommandAck {
        let Some(radio_id) = resolve_radio_id(envelope) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "radio_id is required",
            );
        };
        let af_hz = envelope
            .payload
            .get("af_hz")
            .and_then(Value::as_u64)
            .unwrap_or(1500) as u16;
        let slot = match envelope
            .payload
            .get("slot")
            .and_then(Value::as_str)
            .unwrap_or("")
        {
            "even" => SlotParity::Even,
            _ => SlotParity::Odd,
        };
        let raw_msg = envelope
            .payload
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("");
        let message = match validate_tx_message(raw_msg) {
            Ok(m) => m,
            Err(e) => {
                return CommandAck::err(
                    envelope.command_id.clone(),
                    CommandStatus::Rejected,
                    ErrorCode::ValidationFailed,
                    e,
                );
            }
        };
        match self
            .sessions
            .arm_tx(
                &radio_id,
                TxIntent {
                    af_hz,
                    slot,
                    message,
                },
            )
            .await
        {
            Ok(v) => CommandAck::ok(envelope.command_id.clone(), v),
            Err((code, msg)) => CommandAck::err(
                envelope.command_id.clone(),
                status_for_error(code),
                code,
                msg,
            ),
        }
    }

    async fn exec_tx_cancel(&self, envelope: &CommandEnvelope) -> CommandAck {
        let Some(radio_id) = resolve_radio_id(envelope) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "radio_id is required",
            );
        };
        match self.sessions.cancel_tx(&radio_id).await {
            Ok(v) => CommandAck::ok(envelope.command_id.clone(), v),
            Err((code, msg)) => CommandAck::err(
                envelope.command_id.clone(),
                status_for_error(code),
                code,
                msg,
            ),
        }
    }

    async fn exec_qso_call_cq(&self, envelope: &CommandEnvelope) -> CommandAck {
        let Some(radio_id) = resolve_radio_id(envelope) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "radio_id is required",
            );
        };
        let slot = match envelope.payload.get("slot").and_then(Value::as_str) {
            Some("even") => Some(SlotParity::Even),
            Some("odd") => Some(SlotParity::Odd),
            _ => None,
        };
        let directed = envelope
            .payload
            .get("directed")
            .and_then(Value::as_str)
            .map(str::to_string);
        match self.sessions.call_cq(&radio_id, slot, directed).await {
            Ok(v) => CommandAck::ok(envelope.command_id.clone(), v),
            Err((code, msg)) => CommandAck::err(
                envelope.command_id.clone(),
                status_for_error(code),
                code,
                msg,
            ),
        }
    }

    async fn exec_qso_stop_cq(&self, envelope: &CommandEnvelope) -> CommandAck {
        let Some(radio_id) = resolve_radio_id(envelope) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "radio_id is required",
            );
        };
        match self.sessions.stop_cq(&radio_id).await {
            Ok(v) => CommandAck::ok(envelope.command_id.clone(), v),
            Err((code, msg)) => CommandAck::err(
                envelope.command_id.clone(),
                status_for_error(code),
                code,
                msg,
            ),
        }
    }

    async fn exec_qso_set_sequencer_mode(&self, envelope: &CommandEnvelope) -> CommandAck {
        let Some(radio_id) = resolve_radio_id(envelope) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "radio_id is required",
            );
        };
        let raw_mode = envelope
            .payload
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("");
        let Ok(mode) = SequencerMode::parse(raw_mode) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                format!("Invalid sequencer mode '{raw_mode}'"),
            );
        };
        match self.sessions.set_sequencer_mode(&radio_id, mode).await {
            Ok(v) => CommandAck::ok(envelope.command_id.clone(), v),
            Err((code, msg)) => CommandAck::err(
                envelope.command_id.clone(),
                status_for_error(code),
                code,
                msg,
            ),
        }
    }

    async fn exec_qso_reply(&self, envelope: &CommandEnvelope) -> CommandAck {
        let Some(radio_id) = resolve_radio_id(envelope) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "radio_id is required",
            );
        };
        let callsign = envelope
            .payload
            .get("callsign")
            .and_then(Value::as_str)
            .unwrap_or("");
        let their_grid = envelope
            .payload
            .get("their_grid")
            .and_then(Value::as_str)
            .map(str::to_string);
        let rx_slot = match envelope
            .payload
            .get("rx_slot")
            .and_then(Value::as_str)
            .unwrap_or("even")
        {
            "odd" => SlotParity::Odd,
            _ => SlotParity::Even,
        };
        let snr_db = envelope
            .payload
            .get("snr_db")
            .and_then(Value::as_i64)
            .map(|n| n.clamp(-50, 49) as i8);
        let rx_message = envelope
            .payload
            .get("rx_message")
            .and_then(Value::as_str)
            .map(str::to_string);
        let rx_af_hz = envelope
            .payload
            .get("rx_af_hz")
            .and_then(Value::as_u64)
            .map(|n| n.clamp(200, 3000) as u16);
        let rx_ts_sec = envelope.payload.get("rx_ts_sec").and_then(Value::as_i64);
        match self
            .sessions
            .reply_qso(
                &radio_id, callsign, their_grid, rx_slot, snr_db, rx_message, rx_af_hz, rx_ts_sec,
            )
            .await
        {
            Ok(v) => CommandAck::ok(envelope.command_id.clone(), v),
            Err((code, msg)) => CommandAck::err(
                envelope.command_id.clone(),
                status_for_error(code),
                code,
                msg,
            ),
        }
    }

    async fn exec_qso_action(&self, envelope: &CommandEnvelope) -> CommandAck {
        let Some(radio_id) = resolve_radio_id(envelope) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "radio_id is required",
            );
        };
        let qso_id = envelope
            .payload
            .get("qso_id")
            .and_then(Value::as_str)
            .unwrap_or("");
        let action_str = envelope
            .payload
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("");
        let Ok(action) = QsoAction::parse(action_str) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                format!("Invalid qso.action '{action_str}'"),
            );
        };
        match self.sessions.qso_action(&radio_id, qso_id, action).await {
            Ok(v) => CommandAck::ok(envelope.command_id.clone(), v),
            Err((code, msg)) => CommandAck::err(
                envelope.command_id.clone(),
                status_for_error(code),
                code,
                msg,
            ),
        }
    }

    async fn exec_qso_survey_af(&self, envelope: &CommandEnvelope) -> CommandAck {
        let Some(radio_id) = resolve_radio_id(envelope) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "radio_id is required",
            );
        };
        match self.sessions.survey_af(&radio_id).await {
            Ok(v) => CommandAck::ok(envelope.command_id.clone(), v),
            Err((code, msg)) => CommandAck::err(
                envelope.command_id.clone(),
                status_for_error(code),
                code,
                msg,
            ),
        }
    }

    async fn exec_qso_set_af(&self, envelope: &CommandEnvelope) -> CommandAck {
        let Some(radio_id) = resolve_radio_id(envelope) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "radio_id is required",
            );
        };
        let af_hz = envelope
            .payload
            .get("af_hz")
            .and_then(Value::as_u64)
            .unwrap_or(1500) as u16;
        match self.sessions.set_af(&radio_id, af_hz).await {
            Ok(v) => CommandAck::ok(envelope.command_id.clone(), v),
            Err((code, msg)) => CommandAck::err(
                envelope.command_id.clone(),
                status_for_error(code),
                code,
                msg,
            ),
        }
    }

    async fn exec_qso_set_tx_enabled(&self, envelope: &CommandEnvelope) -> CommandAck {
        let Some(radio_id) = resolve_radio_id(envelope) else {
            return CommandAck::err(
                envelope.command_id.clone(),
                CommandStatus::Rejected,
                ErrorCode::ValidationFailed,
                "radio_id is required",
            );
        };
        let enabled = envelope
            .payload
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        match self.sessions.set_tx_enabled(&radio_id, enabled).await {
            Ok(v) => CommandAck::ok(envelope.command_id.clone(), v),
            Err((code, msg)) => CommandAck::err(
                envelope.command_id.clone(),
                status_for_error(code),
                code,
                msg,
            ),
        }
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
            | "radio.set_vfo"
            | "radio.set_split"
            | "radio.set_rit"
            | "radio.set_xit"
            | "radio.set_level"
            | "radio.set_func"
            | "radio.atu_tune"
            | "control.release_lease"
            | "control.heartbeat"
            | "session.start"
            | "session.stop"
            | "session.set_mode"
            | "tx.tune"
            | "tx.arm"
            | "tx.cancel"
            | "qso.call_cq"
            | "qso.stop_cq"
            | "qso.set_sequencer_mode"
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
                "USB", "LSB", "PKTUSB", "PKTLSB", "PKTFM", "PKTAM", "CW", "CWR", "FM", "FM-D",
                "AM", "AM-D", "WFM", "RTTY", "RTTYR", "DATA",
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
        "radio.set_vfo" => {
            let vfo = envelope
                .payload
                .get("vfo")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if vfo.is_empty() || vfo.len() > 16 {
                return Err((
                    ErrorCode::ValidationFailed,
                    "vfo string is required".to_string(),
                ));
            }
            Ok(())
        }
        "radio.set_split" => {
            if envelope
                .payload
                .get("enabled")
                .and_then(Value::as_bool)
                .is_none()
            {
                return Err((
                    ErrorCode::ValidationFailed,
                    "enabled boolean is required for radio.set_split".to_string(),
                ));
            }
            Ok(())
        }
        "radio.set_rit" | "radio.set_xit" => {
            let off = envelope
                .payload
                .get("offset_hz")
                .and_then(Value::as_i64)
                .ok_or((
                    ErrorCode::ValidationFailed,
                    "offset_hz integer is required".to_string(),
                ))?;
            if !(-20_000..=20_000).contains(&off) {
                return Err((
                    ErrorCode::ValidationFailed,
                    "offset_hz must be between -20000 and 20000".to_string(),
                ));
            }
            Ok(())
        }
        "radio.set_level" => {
            let name = envelope
                .payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_ascii_uppercase();
            if !WRITABLE_LEVELS.contains(&name.as_str()) {
                return Err((
                    ErrorCode::ValidationFailed,
                    format!("unsupported or read-only level '{name}'"),
                ));
            }
            let val = envelope
                .payload
                .get("value")
                .and_then(Value::as_f64)
                .ok_or((
                    ErrorCode::ValidationFailed,
                    "numeric level value is required".to_string(),
                ))?;
            if !val.is_finite() {
                return Err((
                    ErrorCode::ValidationFailed,
                    "level value must be finite".to_string(),
                ));
            }
            Ok(())
        }
        "radio.set_func" => {
            let name = envelope
                .payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_ascii_uppercase();
            if !CURATED_FUNCS.contains(&name.as_str()) {
                return Err((
                    ErrorCode::ValidationFailed,
                    format!("unsupported function '{name}'"),
                ));
            }
            if envelope
                .payload
                .get("enabled")
                .and_then(Value::as_bool)
                .is_none()
            {
                return Err((
                    ErrorCode::ValidationFailed,
                    "enabled boolean is required for radio.set_func".to_string(),
                ));
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
        "session.start" => {
            if let Some(scale) = envelope.payload.get("scale").and_then(Value::as_f64) {
                if !scale.is_finite() || scale <= 0.0 || scale > 100.0 {
                    return Err((
                        ErrorCode::ValidationFailed,
                        "scale must be a finite value between 0 and 100".to_string(),
                    ));
                }
            }
            if let Some(mode_val) = envelope.payload.get("mode") {
                let Some(mode_str) = mode_val.as_str() else {
                    return Err((
                        ErrorCode::ValidationFailed,
                        "mode must be 'FT8' or 'FT4'".to_string(),
                    ));
                };
                let up = mode_str.trim().to_ascii_uppercase();
                if up != "FT8" && up != "FT4" {
                    return Err((
                        ErrorCode::ValidationFailed,
                        format!("unsupported mode '{mode_str}' (expected FT8 or FT4)"),
                    ));
                }
            }
            if let Some(dec_val) = envelope.payload.get("decoder_backend") {
                let Some(dec_str) = dec_val.as_str() else {
                    return Err((
                        ErrorCode::ValidationFailed,
                        "decoder_backend must be a string".to_string(),
                    ));
                };
                if DecoderBackendChoice::parse(dec_str).is_none() {
                    return Err((
                        ErrorCode::ValidationFailed,
                        format!(
                            "unsupported decoder_backend '{dec_str}' (expected ftxr, jt9, ft8_lib_fallback, or auto)"
                        ),
                    ));
                }
            }
            Ok(())
        }
        "session.set_mode" => {
            let mode = envelope
                .payload
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_ascii_uppercase();
            if mode != "FT8" && mode != "FT4" {
                return Err((
                    ErrorCode::ValidationFailed,
                    "mode must be 'FT8' or 'FT4'".to_string(),
                ));
            }
            Ok(())
        }
        "session.set_decoder" => {
            let dec = envelope
                .payload
                .get("decoder_backend")
                .and_then(Value::as_str)
                .unwrap_or("");
            if DecoderBackendChoice::parse(dec).is_none() {
                return Err((
                    ErrorCode::ValidationFailed,
                    "decoder_backend must be 'ftxr', 'jt9', 'ft8_lib_fallback', or 'auto'"
                        .to_string(),
                ));
            }
            Ok(())
        }
        "tx.tune" => {
            if envelope
                .payload
                .get("enabled")
                .and_then(Value::as_bool)
                .is_none()
            {
                return Err((
                    ErrorCode::ValidationFailed,
                    "enabled boolean is required for tx.tune".to_string(),
                ));
            }
            if let Some(af_val) = envelope.payload.get("af_hz") {
                let Some(af) = af_val.as_i64() else {
                    return Err((
                        ErrorCode::ValidationFailed,
                        "af_hz must be an integer between 200 and 3000".to_string(),
                    ));
                };
                if !(200..=3000).contains(&af) {
                    return Err((
                        ErrorCode::ValidationFailed,
                        format!("af_hz {af} outside valid range 200..=3000"),
                    ));
                }
            }
            Ok(())
        }
        "qso.call_cq" => {
            if let Some(slot) = envelope.payload.get("slot").and_then(Value::as_str) {
                if slot != "even" && slot != "odd" {
                    return Err((
                        ErrorCode::ValidationFailed,
                        "slot must be 'even' or 'odd'".to_string(),
                    ));
                }
            }
            Ok(())
        }
        "qso.stop_cq" => Ok(()),
        "qso.set_sequencer_mode" => {
            let mode_str = envelope
                .payload
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or("");
            SequencerMode::parse(mode_str).map_err(|e| (ErrorCode::ValidationFailed, e))?;
            Ok(())
        }
        "qso.reply" => {
            let call = envelope
                .payload
                .get("callsign")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if call.is_empty() {
                return Err((
                    ErrorCode::ValidationFailed,
                    "callsign is required for qso.reply".to_string(),
                ));
            }
            let rx_slot = envelope
                .payload
                .get("rx_slot")
                .and_then(Value::as_str)
                .unwrap_or("even");
            if rx_slot != "even" && rx_slot != "odd" {
                return Err((
                    ErrorCode::ValidationFailed,
                    "rx_slot must be 'even' or 'odd'".to_string(),
                ));
            }
            Ok(())
        }
        "qso.action" => {
            let qid = envelope
                .payload
                .get("qso_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if qid.is_empty() {
                return Err((
                    ErrorCode::ValidationFailed,
                    "qso_id is required for qso.action".to_string(),
                ));
            }
            let act = envelope
                .payload
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("");
            QsoAction::parse(act).map_err(|e| (ErrorCode::ValidationFailed, e))?;
            Ok(())
        }
        "qso.set_tx_enabled" => {
            if envelope
                .payload
                .get("enabled")
                .and_then(Value::as_bool)
                .is_none()
            {
                return Err((
                    ErrorCode::ValidationFailed,
                    "enabled boolean is required".to_string(),
                ));
            }
            Ok(())
        }
        "qrz.update_config" | "qrz.test_connection" => {
            if let Some(val) = envelope.payload.get("api_key") {
                match val {
                    Value::Null => {}
                    Value::String(s) => {
                        let trimmed = s.trim();
                        if trimmed.len() > 128 || s.chars().any(|c| c.is_control()) {
                            return Err((
                                ErrorCode::ValidationFailed,
                                "api_key must be at most 128 printable characters".to_string(),
                            ));
                        }
                    }
                    _ => {
                        return Err((
                            ErrorCode::ValidationFailed,
                            "api_key must be a string or null".to_string(),
                        ));
                    }
                }
            }
            Ok(())
        }
        "qrz.push" => {
            if !envelope.payload.is_object() && !envelope.payload.is_null() {
                return Err((
                    ErrorCode::ValidationFailed,
                    "qrz.push payload must be an object".to_string(),
                ));
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
        | ErrorCode::RadioNotFound
        | ErrorCode::QrzNotConfigured
        | ErrorCode::QrzSyncInProgress => CommandStatus::Rejected,
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
