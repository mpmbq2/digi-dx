use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::domain::adif::QsoRecord;
use crate::telemetry::TelemetryEnvelope;

const INITIAL_MIGRATION_SQL: &str = include_str!("migrations/001_initial_schema.sql");
const ROSTER_MIGRATION_SQL: &str = include_str!("migrations/002_channel_roster.sql");
const ROSTER_ROLE_MIGRATION_SQL: &str = include_str!("migrations/003_channel_roster_role.sql");
const QRZ_SYNC_MIGRATION_SQL: &str = include_str!("migrations/004_qrz_sync.sql");
pub const CHANNEL_ROSTER_WINDOW_MS: i64 = 300_000;

pub fn channel_key_for_freq(mode: &str, dial_freq_hz: Option<i64>) -> String {
    let norm_mode = mode.trim().to_ascii_uppercase();
    let mode_label = if norm_mode.is_empty() {
        "FT8"
    } else {
        norm_mode.as_str()
    };
    match dial_freq_hz {
        Some(hz) if hz > 0 => {
            let rounded = ((hz + 500) / 1_000) * 1_000;
            format!("{mode_label}:{rounded}")
        }
        _ => format!("{mode_label}:unknown"),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChannelRosterEntry {
    pub is_demo: bool,
    pub channel_key: String,
    pub callsign: String,
    pub mode: String,
    pub dial_freq_hz: Option<i64>,
    pub band: Option<String>,
    pub grid: Option<String>,
    pub last_snr_db: i8,
    pub last_dt_sec: f32,
    pub last_af_hz: u16,
    pub last_slot: String,
    pub last_message: String,
    pub is_cq: bool,
    pub directed_cq: Option<String>,
    pub calling_me: bool,
    pub station_role: Option<String>,
    pub first_seen_ts_sec: i64,
    pub last_seen_ts_sec: i64,
    pub last_seen_wall_ms: i64,
    pub decode_count: i64,
}

#[derive(Debug, Clone)]
pub struct UpsertChannelRosterInput {
    pub is_demo: bool,
    pub channel_key: String,
    pub callsign: String,
    pub mode: String,
    pub dial_freq_hz: Option<i64>,
    pub band: Option<String>,
    pub grid: Option<String>,
    pub last_snr_db: i8,
    pub last_dt_sec: f32,
    pub last_af_hz: u16,
    pub last_slot: String,
    pub last_message: String,
    pub is_cq: bool,
    pub directed_cq: Option<String>,
    pub calling_me: bool,
    pub station_role: Option<String>,
    pub seen_ts_sec: i64,
    pub increment_decode_count: bool,
}

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("database I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("mutex poisoned")]
    LockPoisoned,
    #[error("no available rigctld ports in range 4532..=4599")]
    PortUnavailable,
    #[error("radio profile not found: {0}")]
    NotFound(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StationConfig {
    pub station_id: String,
    pub callsign: Option<String>,
    pub grid: Option<String>,
    pub updated_at_utc: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsbDeviceRecord {
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
    pub first_seen_utc: String,
    pub last_seen_utc: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RadioProfile {
    pub radio_id: String,
    pub name: String,
    pub hamlib_model: i64,
    pub is_dummy: bool,
    pub serial_device_key: Option<String>,
    pub serial_baud_rate: i64,
    pub civ_address: Option<String>,
    pub ptt_method: String,
    pub rig_options_json: String,
    pub audio_device_uid: Option<String>,
    pub audio_device_name: Option<String>,
    pub audio_rx_channel: String,
    pub audio_tx_gain_db: f64,
    pub rigctld_port: u16,
    pub auto_connect: bool,
    pub last_dial_freq_hz: Option<i64>,
    pub created_at_utc: String,
    pub updated_at_utc: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateRadioProfileInput {
    pub name: String,
    pub hamlib_model: i64,
    #[serde(default)]
    pub is_dummy: bool,
    pub serial_device_key: Option<String>,
    #[serde(default = "default_baud")]
    pub serial_baud_rate: i64,
    pub civ_address: Option<String>,
    #[serde(default = "default_ptt_method")]
    pub ptt_method: String,
    #[serde(default = "default_rig_options")]
    pub rig_options_json: String,
    pub audio_device_uid: Option<String>,
    pub audio_device_name: Option<String>,
    #[serde(default = "default_rx_channel")]
    pub audio_rx_channel: String,
    #[serde(default = "default_tx_gain")]
    pub audio_tx_gain_db: f64,
    #[serde(default)]
    pub rigctld_port: Option<u16>,
    #[serde(default = "default_true")]
    pub auto_connect: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateRadioProfileInput {
    pub radio_id: String,
    pub name: Option<String>,
    pub hamlib_model: Option<i64>,
    pub is_dummy: Option<bool>,
    pub serial_device_key: Option<String>,
    pub serial_baud_rate: Option<i64>,
    pub civ_address: Option<String>,
    pub ptt_method: Option<String>,
    pub rig_options_json: Option<String>,
    pub audio_device_uid: Option<String>,
    pub audio_device_name: Option<String>,
    pub audio_rx_channel: Option<String>,
    pub audio_tx_gain_db: Option<f64>,
    pub auto_connect: Option<bool>,
}

fn default_baud() -> i64 {
    9600
}
fn default_ptt_method() -> String {
    "cat".to_string()
}
fn default_rig_options() -> String {
    "{}".to_string()
}
fn default_rx_channel() -> String {
    "mono".to_string()
}
fn default_tx_gain() -> f64 {
    -6.0
}
fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutboxRow {
    pub event_id: String,
    pub schema_version: i64,
    pub station_id: String,
    pub radio_id: Option<String>,
    pub event_type: String,
    pub is_demo: bool,
    pub occurred_at_utc: String,
    pub payload_json: String,
    pub status: String,
    pub attempts: i64,
    pub next_attempt_at_utc: String,
    pub leased_until_utc: Option<String>,
    pub last_error: Option<String>,
    pub created_at_utc: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutboxStats {
    pub pending_count: i64,
    pub sent_count: i64,
    pub dead_letter_count: i64,
    pub sink_name: String,
    pub oldest_pending_utc: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct QrzQsoCounts {
    pub pending: i64,
    pub synced: i64,
    pub failed: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QrzPushErrorItem {
    pub qso_id: String,
    pub their_call: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QrzPushSummary {
    pub total: usize,
    pub pushed: usize,
    pub duplicates: usize,
    pub failed: usize,
    pub skipped_demo: usize,
    pub aborted_reason: Option<String>,
    pub errors: Vec<QrzPushErrorItem>,
    pub pushed_at_utc: String,
}

#[derive(Clone)]
pub struct StateStore {
    conn: Arc<Mutex<Connection>>,
    db_path: PathBuf,
}

impl StateStore {
    pub fn open(db_path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let path = db_path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }

        let mut conn = Connection::open(&path)?;
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 5000;
            ",
        )?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = fs::metadata(&path) {
                let mut perms = meta.permissions();
                perms.set_mode(0o600);
                let _ = fs::set_permissions(&path, perms);
            }
        }

        Self::apply_migrations(&mut conn)?;
        Self::ensure_station_singleton(&conn)?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            db_path: path,
        })
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    fn apply_migrations(conn: &mut Connection) -> Result<(), StoreError> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at_utc TEXT NOT NULL
            );",
        )?;

        let applied: Option<i64> = conn
            .query_row(
                "SELECT version FROM schema_migrations WHERE version = 1",
                [],
                |row| row.get(0),
            )
            .optional()?;

        if applied.is_none() {
            let tx = conn.transaction()?;
            tx.execute_batch(INITIAL_MIGRATION_SQL)?;
            tx.execute(
                "INSERT INTO schema_migrations (version, name, applied_at_utc) VALUES (?1, ?2, ?3)",
                params![1_i64, "001_initial_schema", now_utc_str()],
            )?;
            tx.commit()?;
        }

        let roster_applied: Option<i64> = conn
            .query_row(
                "SELECT version FROM schema_migrations WHERE version = 2",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if roster_applied.is_none() {
            let tx = conn.transaction()?;
            tx.execute_batch(ROSTER_MIGRATION_SQL)?;
            tx.execute(
                "INSERT INTO schema_migrations (version, name, applied_at_utc) VALUES (?1, ?2, ?3)",
                params![2_i64, "002_channel_roster", now_utc_str()],
            )?;
            tx.commit()?;
        }

        let role_applied: Option<i64> = conn
            .query_row(
                "SELECT version FROM schema_migrations WHERE version = 3",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if role_applied.is_none() {
            let tx = conn.transaction()?;
            tx.execute_batch(ROSTER_ROLE_MIGRATION_SQL)?;
            tx.execute(
                "INSERT INTO schema_migrations (version, name, applied_at_utc) VALUES (?1, ?2, ?3)",
                params![3_i64, "003_channel_roster_role", now_utc_str()],
            )?;
            tx.commit()?;
        }

        let qrz_applied: Option<i64> = conn
            .query_row(
                "SELECT version FROM schema_migrations WHERE version = 4",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if qrz_applied.is_none() {
            let tx = conn.transaction()?;
            tx.execute_batch(QRZ_SYNC_MIGRATION_SQL)?;
            tx.execute(
                "INSERT INTO schema_migrations (version, name, applied_at_utc) VALUES (?1, ?2, ?3)",
                params![4_i64, "004_qrz_sync", now_utc_str()],
            )?;
            tx.commit()?;
        }
        Ok(())
    }

    fn ensure_station_singleton(conn: &Connection) -> Result<(), StoreError> {
        let exists: Option<i64> = conn
            .query_row("SELECT id FROM station_config WHERE id = 1", [], |row| {
                row.get(0)
            })
            .optional()?;

        if exists.is_none() {
            conn.execute(
                "INSERT INTO station_config (id, station_id, callsign, grid, updated_at_utc)
                 VALUES (1, ?1, NULL, NULL, ?2)",
                params![Uuid::new_v4().to_string(), now_utc_str()],
            )?;
        }
        Ok(())
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, StoreError> {
        self.conn.lock().map_err(|_| StoreError::LockPoisoned)
    }

    pub fn quick_check(&self) -> Result<String, StoreError> {
        let conn = self.lock()?;
        let res: String = conn.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
        Ok(res)
    }

    pub fn journal_mode(&self) -> Result<String, StoreError> {
        let conn = self.lock()?;
        let mode: String = conn.query_row("PRAGMA journal_mode", [], |row| row.get(0))?;
        Ok(mode)
    }

    pub fn get_station_config(&self) -> Result<StationConfig, StoreError> {
        let conn = self.lock()?;
        let cfg = conn.query_row(
            "SELECT station_id, callsign, grid, updated_at_utc FROM station_config WHERE id = 1",
            [],
            |row| {
                Ok(StationConfig {
                    station_id: row.get(0)?,
                    callsign: row.get(1)?,
                    grid: row.get(2)?,
                    updated_at_utc: row.get(3)?,
                })
            },
        )?;
        Ok(cfg)
    }

    pub fn update_station_config(
        &self,
        callsign: &str,
        grid: &str,
    ) -> Result<StationConfig, StoreError> {
        let conn = self.lock()?;
        let updated_at = now_utc_str();
        conn.execute(
            "UPDATE station_config SET callsign = ?1, grid = ?2, updated_at_utc = ?3 WHERE id = 1",
            params![callsign, grid, updated_at],
        )?;
        let cfg = conn.query_row(
            "SELECT station_id, callsign, grid, updated_at_utc FROM station_config WHERE id = 1",
            [],
            |row| {
                Ok(StationConfig {
                    station_id: row.get(0)?,
                    callsign: row.get(1)?,
                    grid: row.get(2)?,
                    updated_at_utc: row.get(3)?,
                })
            },
        )?;
        Ok(cfg)
    }

    pub fn list_usb_devices(&self) -> Result<Vec<UsbDeviceRecord>, StoreError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT device_key, os_path, real_tty_path, usb_vid, usb_pid, usb_serial,
                    usb_interface, usb_topology_path, manufacturer, product, is_connected,
                    first_seen_utc, last_seen_utc
             FROM usb_devices
             ORDER BY is_connected DESC, device_key ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(UsbDeviceRecord {
                device_key: row.get(0)?,
                os_path: row.get(1)?,
                real_tty_path: row.get(2)?,
                usb_vid: row.get(3)?,
                usb_pid: row.get(4)?,
                usb_serial: row.get(5)?,
                usb_interface: row.get(6)?,
                usb_topology_path: row.get(7)?,
                manufacturer: row.get(8)?,
                product: row.get(9)?,
                is_connected: row.get::<_, i64>(10)? != 0,
                first_seen_utc: row.get(11)?,
                last_seen_utc: row.get(12)?,
            })
        })?;
        let mut out = Vec::new();
        for item in rows {
            out.push(item?);
        }
        Ok(out)
    }

    pub fn upsert_usb_device(&self, dev: &UsbDeviceRecord) -> Result<(), StoreError> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO usb_devices (
                device_key, os_path, real_tty_path, usb_vid, usb_pid, usb_serial,
                usb_interface, usb_topology_path, manufacturer, product, is_connected,
                first_seen_utc, last_seen_utc
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(device_key) DO UPDATE SET
                os_path = excluded.os_path,
                real_tty_path = excluded.real_tty_path,
                usb_vid = excluded.usb_vid,
                usb_pid = excluded.usb_pid,
                usb_serial = excluded.usb_serial,
                usb_interface = excluded.usb_interface,
                usb_topology_path = excluded.usb_topology_path,
                manufacturer = excluded.manufacturer,
                product = excluded.product,
                is_connected = excluded.is_connected,
                last_seen_utc = excluded.last_seen_utc",
            params![
                dev.device_key,
                dev.os_path,
                dev.real_tty_path,
                dev.usb_vid,
                dev.usb_pid,
                dev.usb_serial,
                dev.usb_interface,
                dev.usb_topology_path,
                dev.manufacturer,
                dev.product,
                if dev.is_connected { 1_i64 } else { 0_i64 },
                dev.first_seen_utc,
                dev.last_seen_utc,
            ],
        )?;
        Ok(())
    }

    pub fn list_radio_profiles(&self) -> Result<Vec<RadioProfile>, StoreError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT radio_id, name, hamlib_model, is_dummy, serial_device_key,
                    serial_baud_rate, civ_address, ptt_method, rig_options_json,
                    audio_device_uid, audio_device_name, audio_rx_channel, audio_tx_gain_db,
                    rigctld_port, auto_connect, last_dial_freq_hz, created_at_utc, updated_at_utc
             FROM radio_profiles
             ORDER BY created_at_utc ASC",
        )?;
        let rows = stmt.query_map([], map_radio_profile)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn get_radio_profile(&self, radio_id: &str) -> Result<Option<RadioProfile>, StoreError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT radio_id, name, hamlib_model, is_dummy, serial_device_key,
                    serial_baud_rate, civ_address, ptt_method, rig_options_json,
                    audio_device_uid, audio_device_name, audio_rx_channel, audio_tx_gain_db,
                    rigctld_port, auto_connect, last_dial_freq_hz, created_at_utc, updated_at_utc
             FROM radio_profiles WHERE radio_id = ?1",
        )?;
        stmt.query_row(params![radio_id], map_radio_profile)
            .optional()
            .map_err(StoreError::from)
    }

    pub fn create_radio_profile(
        &self,
        input: &CreateRadioProfileInput,
    ) -> Result<RadioProfile, StoreError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;

        let mut used_ports = Vec::new();
        {
            let mut stmt = tx.prepare("SELECT rigctld_port FROM radio_profiles")?;
            let rows = stmt.query_map([], |row| row.get::<_, u16>(0))?;
            for p in rows {
                used_ports.push(p?);
            }
        }
        let port = match input.rigctld_port {
            Some(requested) => {
                if !(4532..=4599).contains(&requested) || used_ports.contains(&requested) {
                    return Err(StoreError::PortUnavailable);
                }
                requested
            }
            None => (4532_u16..=4599)
                .find(|p| {
                    !used_ports.contains(p)
                        && std::net::TcpListener::bind(("127.0.0.1", *p)).is_ok()
                })
                .ok_or(StoreError::PortUnavailable)?,
        };

        let id_raw = Uuid::new_v4().simple().to_string();
        let radio_id = format!("rad_{}", &id_raw[..10]);
        let now = now_utc_str();

        if let Some(ref dev_key) = input.serial_device_key {
            let exists: Option<String> = tx
                .query_row(
                    "SELECT device_key FROM usb_devices WHERE device_key = ?1",
                    params![dev_key],
                    |row| row.get(0),
                )
                .optional()?;
            if exists.is_none() {
                tx.execute(
                    "INSERT INTO usb_devices (
                        device_key, os_path, real_tty_path, usb_vid, usb_pid, usb_serial,
                        usb_interface, usb_topology_path, manufacturer, product, is_connected,
                        first_seen_utc, last_seen_utc
                     ) VALUES (?1, ?1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, ?2, ?2)",
                    params![dev_key, now],
                )?;
            }
        }

        tx.execute(
            "INSERT INTO radio_profiles (
                radio_id, name, hamlib_model, is_dummy, serial_device_key,
                serial_baud_rate, civ_address, ptt_method, rig_options_json,
                audio_device_uid, audio_device_name, audio_rx_channel, audio_tx_gain_db,
                rigctld_port, auto_connect, last_dial_freq_hz, created_at_utc, updated_at_utc
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, NULL, ?16, ?16)",
            params![
                radio_id,
                input.name,
                input.hamlib_model,
                if input.is_dummy { 1_i64 } else { 0_i64 },
                input.serial_device_key,
                input.serial_baud_rate,
                input.civ_address,
                input.ptt_method,
                input.rig_options_json,
                input.audio_device_uid,
                input.audio_device_name,
                input.audio_rx_channel,
                input.audio_tx_gain_db,
                port as i64,
                if input.auto_connect { 1_i64 } else { 0_i64 },
                now,
            ],
        )?;
        tx.commit()?;
        drop(conn);

        self.get_radio_profile(&radio_id)?
            .ok_or_else(|| StoreError::NotFound(radio_id))
    }

    pub fn update_radio_profile(
        &self,
        input: &UpdateRadioProfileInput,
    ) -> Result<RadioProfile, StoreError> {
        let existing = self
            .get_radio_profile(&input.radio_id)?
            .ok_or_else(|| StoreError::NotFound(input.radio_id.clone()))?;

        let next_serial_key = match input.serial_device_key.as_deref() {
            Some(s) if s.trim().is_empty() => None,
            Some(s) => Some(s.trim().to_string()),
            None => existing.serial_device_key.clone(),
        };
        let next_civ = match input.civ_address.as_deref() {
            Some(s) if s.trim().is_empty() => None,
            Some(s) => Some(s.trim().to_string()),
            None => existing.civ_address.clone(),
        };
        let next_audio_uid = match input.audio_device_uid.as_deref() {
            Some(s) if s.trim().is_empty() => None,
            Some(s) => Some(s.trim().to_string()),
            None => existing.audio_device_uid.clone(),
        };
        let next_audio_name = match input.audio_device_name.as_deref() {
            Some(s) if s.trim().is_empty() => None,
            Some(s) => Some(s.trim().to_string()),
            None => existing.audio_device_name.clone(),
        };

        let now = now_utc_str();
        let conn = self.lock()?;
        conn.execute(
            "UPDATE radio_profiles SET
                name = ?2,
                hamlib_model = ?3,
                is_dummy = ?4,
                serial_device_key = ?5,
                serial_baud_rate = ?6,
                civ_address = ?7,
                ptt_method = ?8,
                rig_options_json = ?9,
                audio_device_uid = ?10,
                audio_device_name = ?11,
                audio_rx_channel = ?12,
                audio_tx_gain_db = ?13,
                auto_connect = ?14,
                updated_at_utc = ?15
             WHERE radio_id = ?1",
            params![
                input.radio_id,
                input.name.as_deref().unwrap_or(&existing.name),
                input.hamlib_model.unwrap_or(existing.hamlib_model),
                if input.is_dummy.unwrap_or(existing.is_dummy) {
                    1_i64
                } else {
                    0_i64
                },
                next_serial_key,
                input.serial_baud_rate.unwrap_or(existing.serial_baud_rate),
                next_civ,
                input.ptt_method.as_deref().unwrap_or(&existing.ptt_method),
                input
                    .rig_options_json
                    .as_deref()
                    .unwrap_or(&existing.rig_options_json),
                next_audio_uid,
                next_audio_name,
                input
                    .audio_rx_channel
                    .as_deref()
                    .unwrap_or(&existing.audio_rx_channel),
                input.audio_tx_gain_db.unwrap_or(existing.audio_tx_gain_db),
                if input.auto_connect.unwrap_or(existing.auto_connect) {
                    1_i64
                } else {
                    0_i64
                },
                now,
            ],
        )?;
        drop(conn);

        self.get_radio_profile(&input.radio_id)?
            .ok_or_else(|| StoreError::NotFound(input.radio_id.clone()))
    }

    pub fn delete_radio_profile(&self, radio_id: &str) -> Result<bool, StoreError> {
        let conn = self.lock()?;
        let affected = conn.execute(
            "DELETE FROM radio_profiles WHERE radio_id = ?1",
            params![radio_id],
        )?;
        Ok(affected > 0)
    }

    pub fn update_radio_last_freq(&self, radio_id: &str, freq_hz: i64) -> Result<(), StoreError> {
        let conn = self.lock()?;
        conn.execute(
            "UPDATE radio_profiles SET last_dial_freq_hz = ?2, updated_at_utc = ?3 WHERE radio_id = ?1",
            params![radio_id, freq_hz, now_utc_str()],
        )?;
        Ok(())
    }

    pub fn mark_usb_devices_disconnected_except(
        &self,
        connected_keys: &[String],
    ) -> Result<usize, StoreError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        let mut changed = 0_usize;
        let existing_connected: Vec<String> = {
            let mut stmt =
                tx.prepare("SELECT device_key FROM usb_devices WHERE is_connected = 1")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for key in existing_connected {
            if !connected_keys.iter().any(|k| k == &key) {
                changed += tx.execute(
                    "UPDATE usb_devices SET is_connected = 0 WHERE device_key = ?1",
                    params![key],
                )?;
            }
        }
        tx.commit()?;
        Ok(changed)
    }

    pub fn get_usb_device(&self, device_key: &str) -> Result<Option<UsbDeviceRecord>, StoreError> {
        let conn = self.lock()?;
        conn.query_row(
            "SELECT device_key, os_path, real_tty_path, usb_vid, usb_pid, usb_serial,
                    usb_interface, usb_topology_path, manufacturer, product, is_connected,
                    first_seen_utc, last_seen_utc
             FROM usb_devices WHERE device_key = ?1",
            params![device_key],
            |row| {
                Ok(UsbDeviceRecord {
                    device_key: row.get(0)?,
                    os_path: row.get(1)?,
                    real_tty_path: row.get(2)?,
                    usb_vid: row.get(3)?,
                    usb_pid: row.get(4)?,
                    usb_serial: row.get(5)?,
                    usb_interface: row.get(6)?,
                    usb_topology_path: row.get(7)?,
                    manufacturer: row.get(8)?,
                    product: row.get(9)?,
                    is_connected: row.get::<_, i64>(10)? != 0,
                    first_seen_utc: row.get(11)?,
                    last_seen_utc: row.get(12)?,
                })
            },
        )
        .optional()
        .map_err(StoreError::from)
    }

    pub fn insert_qso(&self, rec: &QsoRecord) -> Result<(), StoreError> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO qso_log (
                qso_id, radio_id, started_at_utc, completed_at_utc, my_call, my_grid,
                their_call, their_grid, mode, dial_freq_hz, band, af_hz,
                rst_sent, rst_rcvd, completion_reason, transcript_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                rec.qso_id,
                rec.radio_id,
                rec.started_at_utc,
                rec.completed_at_utc,
                rec.my_call,
                rec.my_grid,
                rec.their_call,
                rec.their_grid,
                rec.mode,
                rec.dial_freq_hz,
                rec.band,
                rec.af_hz,
                rec.rst_sent,
                rec.rst_rcvd,
                rec.completion_reason,
                rec.transcript_json,
            ],
        )?;
        Ok(())
    }

    pub fn insert_demo_qso(&self, rec: &QsoRecord) -> Result<(), StoreError> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO demo_qso_log (
                qso_id, started_at_utc, completed_at_utc, my_call, my_grid,
                their_call, their_grid, mode, dial_freq_hz, band,
                rst_sent, rst_rcvd, completion_reason, transcript_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                rec.qso_id,
                rec.started_at_utc,
                rec.completed_at_utc,
                rec.my_call,
                rec.my_grid,
                rec.their_call,
                rec.their_grid,
                rec.mode,
                rec.dial_freq_hz,
                rec.band,
                rec.rst_sent,
                rec.rst_rcvd,
                rec.completion_reason,
                rec.transcript_json,
            ],
        )?;
        Ok(())
    }

    pub fn list_qsos(
        &self,
        limit: u32,
        offset: u32,
        band: Option<&str>,
        demo: bool,
    ) -> Result<Vec<QsoRecord>, StoreError> {
        let conn = self.lock()?;
        let clamped_limit = limit.min(1000) as i64;
        let offset_i64 = offset as i64;

        let sql = if demo {
            if band.is_some() {
                "SELECT qso_id, NULL as radio_id, started_at_utc, completed_at_utc, my_call, my_grid,
                        their_call, their_grid, mode, dial_freq_hz, band, NULL as af_hz,
                        rst_sent, rst_rcvd, completion_reason, transcript_json,
                        NULL as qrz_status, NULL as qrz_logid, NULL as qrz_pushed_at_utc, NULL as qrz_error
                 FROM demo_qso_log
                 WHERE band = ?1
                 ORDER BY completed_at_utc DESC
                 LIMIT ?2 OFFSET ?3"
            } else {
                "SELECT qso_id, NULL as radio_id, started_at_utc, completed_at_utc, my_call, my_grid,
                        their_call, their_grid, mode, dial_freq_hz, band, NULL as af_hz,
                        rst_sent, rst_rcvd, completion_reason, transcript_json,
                        NULL as qrz_status, NULL as qrz_logid, NULL as qrz_pushed_at_utc, NULL as qrz_error
                 FROM demo_qso_log
                 ORDER BY completed_at_utc DESC
                 LIMIT ?1 OFFSET ?2"
            }
        } else if band.is_some() {
            "SELECT qso_id, radio_id, started_at_utc, completed_at_utc, my_call, my_grid,
                    their_call, their_grid, mode, dial_freq_hz, band, af_hz,
                    rst_sent, rst_rcvd, completion_reason, transcript_json,
                    qrz_status, qrz_logid, qrz_pushed_at_utc, qrz_error
             FROM qso_log
             WHERE band = ?1
             ORDER BY completed_at_utc DESC
             LIMIT ?2 OFFSET ?3"
        } else {
            "SELECT qso_id, radio_id, started_at_utc, completed_at_utc, my_call, my_grid,
                    their_call, their_grid, mode, dial_freq_hz, band, af_hz,
                    rst_sent, rst_rcvd, completion_reason, transcript_json,
                    qrz_status, qrz_logid, qrz_pushed_at_utc, qrz_error
             FROM qso_log
             ORDER BY completed_at_utc DESC
             LIMIT ?1 OFFSET ?2"
        };

        let mut stmt = conn.prepare(sql)?;
        let rows = if let Some(b) = band {
            stmt.query_map(params![b, clamped_limit, offset_i64], map_qso_record)?
        } else {
            stmt.query_map(params![clamped_limit, offset_i64], map_qso_record)?
        };

        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Reads strictly from `qso_log` (never `demo_qso_log`).
    pub fn list_real_qsos_for_adif(&self) -> Result<Vec<QsoRecord>, StoreError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT qso_id, radio_id, started_at_utc, completed_at_utc, my_call, my_grid,
                    their_call, their_grid, mode, dial_freq_hz, band, af_hz,
                    rst_sent, rst_rcvd, completion_reason, transcript_json,
                    qrz_status, qrz_logid, qrz_pushed_at_utc, qrz_error
             FROM qso_log
             ORDER BY completed_at_utc ASC",
        )?;
        let rows = stmt.query_map([], map_qso_record)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Return all distinct normalized `their_call` callsigns from the real or demo logbook.
    pub fn list_worked_callsigns(&self, demo: bool) -> Result<Vec<String>, StoreError> {
        let conn = self.lock()?;
        let sql = if demo {
            "SELECT DISTINCT UPPER(TRIM(their_call)) FROM demo_qso_log WHERE TRIM(their_call) != ''"
        } else {
            "SELECT DISTINCT UPPER(TRIM(their_call)) FROM qso_log WHERE TRIM(their_call) != ''"
        };
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in rows {
            let clean = r?
                .trim()
                .trim_matches(|c| c == '<' || c == '>')
                .to_ascii_uppercase();
            if !clean.is_empty() {
                out.push(clean);
            }
        }
        out.sort();
        out.dedup();
        Ok(out)
    }

    pub fn get_qrz_api_key(&self) -> Result<Option<String>, StoreError> {
        let conn = self.lock()?;
        let raw: Option<String> = conn
            .query_row(
                "SELECT qrz_api_key FROM station_config WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        Ok(raw.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
    }

    pub fn set_qrz_api_key(&self, api_key: Option<&str>) -> Result<(), StoreError> {
        let cleaned = api_key.map(str::trim).filter(|s| !s.is_empty());
        let conn = self.lock()?;
        conn.execute(
            "UPDATE station_config SET qrz_api_key = ?1, updated_at_utc = ?2 WHERE id = 1",
            params![cleaned, now_utc_str()],
        )?;
        Ok(())
    }

    /// Reads strictly from `qso_log` (never `demo_qso_log`).
    pub fn list_unpushed_real_qsos(&self) -> Result<Vec<QsoRecord>, StoreError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT qso_id, radio_id, started_at_utc, completed_at_utc, my_call, my_grid,
                    their_call, their_grid, mode, dial_freq_hz, band, af_hz,
                    rst_sent, rst_rcvd, completion_reason, transcript_json,
                    qrz_status, qrz_logid, qrz_pushed_at_utc, qrz_error
             FROM qso_log
             WHERE qrz_status IN ('pending', 'failed')
             ORDER BY completed_at_utc ASC",
        )?;
        let rows = stmt.query_map([], map_qso_record)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn count_qrz_qso_states(&self) -> Result<QrzQsoCounts, StoreError> {
        let conn = self.lock()?;
        let (pending, synced, failed): (i64, i64, i64) = conn.query_row(
            "SELECT
                COALESCE(SUM(CASE WHEN qrz_status = 'pending' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN qrz_status = 'synced' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN qrz_status = 'failed' THEN 1 ELSE 0 END), 0)
             FROM qso_log",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        Ok(QrzQsoCounts {
            pending,
            synced,
            failed,
        })
    }

    pub fn mark_qso_qrz_synced(
        &self,
        qso_id: &str,
        logid: Option<&str>,
        pushed_at_utc: &str,
    ) -> Result<(), StoreError> {
        let conn = self.lock()?;
        conn.execute(
            "UPDATE qso_log
             SET qrz_status = 'synced',
                 qrz_logid = COALESCE(?2, qrz_logid),
                 qrz_pushed_at_utc = ?3,
                 qrz_error = NULL
             WHERE qso_id = ?1",
            params![qso_id, logid, pushed_at_utc],
        )?;
        Ok(())
    }

    pub fn mark_qso_qrz_failed(&self, qso_id: &str, error: &str) -> Result<(), StoreError> {
        let conn = self.lock()?;
        conn.execute(
            "UPDATE qso_log
             SET qrz_status = 'failed',
                 qrz_error = ?2
             WHERE qso_id = ?1",
            params![qso_id, error],
        )?;
        Ok(())
    }

    pub fn record_qrz_push_result(
        &self,
        pushed_at_utc: &str,
        summary: &QrzPushSummary,
    ) -> Result<(), StoreError> {
        let summary_json = serde_json::to_string(summary).unwrap_or_else(|_| "{}".to_string());
        let conn = self.lock()?;
        conn.execute(
            "UPDATE station_config
             SET qrz_last_push_at_utc = ?1,
                 qrz_last_push_summary_json = ?2
             WHERE id = 1",
            params![pushed_at_utc, summary_json],
        )?;
        Ok(())
    }

    pub fn get_qrz_last_push(
        &self,
    ) -> Result<(Option<String>, Option<QrzPushSummary>), StoreError> {
        let conn = self.lock()?;
        let row: Option<(Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT qrz_last_push_at_utc, qrz_last_push_summary_json
                 FROM station_config
                 WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((ts, raw_json)) = row else {
            return Ok((None, None));
        };
        let summary = raw_json
            .as_deref()
            .and_then(|s| serde_json::from_str::<QrzPushSummary>(s).ok());
        Ok((ts, summary))
    }

    pub fn enqueue_telemetry(&self, env: &TelemetryEnvelope) -> Result<(), StoreError> {
        let conn = self.lock()?;
        let payload_json = serde_json::to_string(&env.payload).unwrap_or_else(|_| "{}".to_string());
        let now = now_utc_str();
        conn.execute(
            "INSERT INTO telemetry_outbox (
                event_id, schema_version, station_id, radio_id, event_type, is_demo,
                occurred_at_utc, payload_json, status, attempts, next_attempt_at_utc,
                leased_until_utc, last_error, created_at_utc
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', 0, ?9, NULL, NULL, ?9)",
            params![
                env.event_id,
                env.schema_version as i64,
                env.station_id,
                env.radio_id,
                env.event_type,
                if env.is_demo { 1_i64 } else { 0_i64 },
                env.occurred_at_utc,
                payload_json,
                now,
            ],
        )?;
        Ok(())
    }

    pub fn claim_pending_outbox(
        &self,
        limit: usize,
        lease_secs: i64,
        now: DateTime<Utc>,
    ) -> Result<Vec<OutboxRow>, StoreError> {
        let mut conn = self.lock()?;
        let now_str = format_utc(now);
        let lease_until = format_utc(now + Duration::seconds(lease_secs));
        let tx = conn.transaction()?;

        let mut rows = Vec::new();
        {
            let mut stmt = tx.prepare(
                "SELECT event_id, schema_version, station_id, radio_id, event_type, is_demo,
                        occurred_at_utc, payload_json, status, attempts, next_attempt_at_utc,
                        leased_until_utc, last_error, created_at_utc
                 FROM telemetry_outbox
                 WHERE status = 'pending'
                   AND next_attempt_at_utc <= ?1
                   AND (leased_until_utc IS NULL OR leased_until_utc <= ?1)
                 ORDER BY created_at_utc ASC
                 LIMIT ?2",
            )?;
            let iter = stmt.query_map(params![now_str, limit as i64], map_outbox_row)?;
            for r in iter {
                rows.push(r?);
            }
        }

        for row in &rows {
            tx.execute(
                "UPDATE telemetry_outbox SET leased_until_utc = ?2 WHERE event_id = ?1",
                params![row.event_id, lease_until],
            )?;
        }
        tx.commit()?;
        Ok(rows)
    }

    pub fn mark_outbox_sent(&self, event_ids: &[String]) -> Result<(), StoreError> {
        if event_ids.is_empty() {
            return Ok(());
        }
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        for id in event_ids {
            tx.execute(
                "UPDATE telemetry_outbox
                 SET status = 'sent', leased_until_utc = NULL, last_error = NULL
                 WHERE event_id = ?1",
                params![id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn mark_outbox_retry(
        &self,
        event_id: &str,
        attempts: i64,
        next_attempt_at: DateTime<Utc>,
        dead_letter: bool,
        last_error: &str,
    ) -> Result<(), StoreError> {
        let conn = self.lock()?;
        let status = if dead_letter {
            "dead_letter"
        } else {
            "pending"
        };
        conn.execute(
            "UPDATE telemetry_outbox
             SET status = ?2,
                 attempts = ?3,
                 next_attempt_at_utc = ?4,
                 leased_until_utc = NULL,
                 last_error = ?5
             WHERE event_id = ?1",
            params![
                event_id,
                status,
                attempts,
                format_utc(next_attempt_at),
                last_error
            ],
        )?;
        Ok(())
    }

    pub fn enforce_outbox_retention(
        &self,
        max_rows: usize,
        retention_days: i64,
        now: DateTime<Utc>,
    ) -> Result<usize, StoreError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        let cutoff = format_utc(now - Duration::days(retention_days));
        let mut deleted = 0_usize;

        deleted += tx.execute(
            "DELETE FROM telemetry_outbox WHERE status = 'sent' AND created_at_utc < ?1",
            params![cutoff],
        )?;

        let total: i64 = tx.query_row("SELECT COUNT(*) FROM telemetry_outbox", [], |r| r.get(0))?;
        let mut excess = (total as usize).saturating_sub(max_rows);

        if excess > 0 {
            let d = tx.execute(
                "DELETE FROM telemetry_outbox
                 WHERE event_id IN (
                     SELECT event_id FROM telemetry_outbox
                     WHERE status = 'sent'
                     ORDER BY created_at_utc ASC
                     LIMIT ?1
                 )",
                params![excess as i64],
            )?;
            deleted += d;
            excess = excess.saturating_sub(d);
        }

        if excess > 0 {
            let d = tx.execute(
                "DELETE FROM telemetry_outbox
                 WHERE event_id IN (
                     SELECT event_id FROM telemetry_outbox
                     WHERE event_type = 'ft8.decode'
                     ORDER BY created_at_utc ASC
                     LIMIT ?1
                 )",
                params![excess as i64],
            )?;
            deleted += d;
            excess = excess.saturating_sub(d);
        }

        if excess > 0 {
            let d = tx.execute(
                "DELETE FROM telemetry_outbox
                 WHERE event_id IN (
                     SELECT event_id FROM telemetry_outbox
                     WHERE event_type NOT IN ('qso.completed', 'watchdog.abort')
                     ORDER BY created_at_utc ASC
                     LIMIT ?1
                 )",
                params![excess as i64],
            )?;
            deleted += d;
        }

        tx.commit()?;
        Ok(deleted)
    }

    pub fn outbox_stats(&self, sink_name: &str) -> Result<OutboxStats, StoreError> {
        let conn = self.lock()?;
        let pending_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM telemetry_outbox WHERE status = 'pending'",
            [],
            |r| r.get(0),
        )?;
        let sent_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM telemetry_outbox WHERE status = 'sent'",
            [],
            |r| r.get(0),
        )?;
        let dead_letter_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM telemetry_outbox WHERE status = 'dead_letter'",
            [],
            |r| r.get(0),
        )?;
        let oldest_pending_utc: Option<String> = conn
            .query_row(
                "SELECT MIN(occurred_at_utc) FROM telemetry_outbox WHERE status = 'pending'",
                [],
                |r| r.get(0),
            )
            .optional()?
            .flatten();

        Ok(OutboxStats {
            pending_count,
            sent_count,
            dead_letter_count,
            sink_name: sink_name.to_string(),
            oldest_pending_utc,
        })
    }

    pub fn list_outbox_rows(&self, limit: usize) -> Result<Vec<OutboxRow>, StoreError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT event_id, schema_version, station_id, radio_id, event_type, is_demo,
                    occurred_at_utc, payload_json, status, attempts, next_attempt_at_utc,
                    leased_until_utc, last_error, created_at_utc
             FROM telemetry_outbox
             ORDER BY created_at_utc DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], map_outbox_row)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn lookup_command_by_idempotency(&self, key: &str) -> Result<Option<String>, StoreError> {
        let conn = self.lock()?;
        conn.query_row(
            "SELECT response_json FROM command_audit WHERE idempotency_key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(StoreError::from)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn insert_command_audit(
        &self,
        command_id: &str,
        idempotency_key: Option<&str>,
        origin: &str,
        actor: &str,
        radio_id: Option<&str>,
        command_kind: &str,
        status: &str,
        error_code: Option<&str>,
        response_json: &str,
        created_at_utc: &str,
        completed_at_utc: &str,
    ) -> Result<(), StoreError> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO command_audit (
                command_id, idempotency_key, origin, actor, radio_id, command_kind,
                status, error_code, response_json, created_at_utc, completed_at_utc
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                command_id,
                idempotency_key,
                origin,
                actor,
                radio_id,
                command_kind,
                status,
                error_code,
                response_json,
                created_at_utc,
                completed_at_utc,
            ],
        )?;
        Ok(())
    }

    pub fn count_command_audits(&self) -> Result<i64, StoreError> {
        let conn = self.lock()?;
        let cnt: i64 = conn.query_row("SELECT COUNT(*) FROM command_audit", [], |r| r.get(0))?;
        Ok(cnt)
    }

    pub fn upsert_channel_roster_entry(
        &self,
        input: &UpsertChannelRosterInput,
        now_wall_ms: i64,
    ) -> Result<(), StoreError> {
        let conn = self.lock()?;
        let cutoff = now_wall_ms - CHANNEL_ROSTER_WINDOW_MS;
        let count_delta = if input.increment_decode_count {
            1_i64
        } else {
            0_i64
        };
        conn.execute(
            "INSERT INTO channel_roster (
                is_demo, channel_key, callsign, mode, dial_freq_hz, band, grid,
                last_snr_db, last_dt_sec, last_af_hz, last_slot, last_message,
                is_cq, directed_cq, calling_me, station_role, first_seen_ts_sec, last_seen_ts_sec,
                last_seen_wall_ms, decode_count
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, 1)
             ON CONFLICT(is_demo, channel_key, callsign) DO UPDATE SET
                mode = excluded.mode,
                dial_freq_hz = COALESCE(excluded.dial_freq_hz, channel_roster.dial_freq_hz),
                band = COALESCE(excluded.band, channel_roster.band),
                grid = COALESCE(excluded.grid, channel_roster.grid),
                last_snr_db = excluded.last_snr_db,
                last_dt_sec = excluded.last_dt_sec,
                last_af_hz = excluded.last_af_hz,
                last_slot = excluded.last_slot,
                last_message = excluded.last_message,
                is_cq = excluded.is_cq,
                directed_cq = excluded.directed_cq,
                calling_me = excluded.calling_me,
                station_role = excluded.station_role,
                last_seen_ts_sec = excluded.last_seen_ts_sec,
                last_seen_wall_ms = CASE
                    WHEN ?20 > 0 THEN excluded.last_seen_wall_ms
                    ELSE channel_roster.last_seen_wall_ms
                END,
                decode_count = channel_roster.decode_count + ?20",
            params![
                if input.is_demo { 1_i64 } else { 0_i64 },
                input.channel_key,
                input.callsign,
                input.mode,
                input.dial_freq_hz,
                input.band,
                input.grid,
                i64::from(input.last_snr_db),
                f64::from(input.last_dt_sec),
                i64::from(input.last_af_hz),
                input.last_slot,
                input.last_message,
                if input.is_cq { 1_i64 } else { 0_i64 },
                input.directed_cq,
                if input.calling_me { 1_i64 } else { 0_i64 },
                input.station_role,
                input.seen_ts_sec,
                input.seen_ts_sec,
                now_wall_ms,
                count_delta,
            ],
        )?;
        conn.execute(
            "DELETE FROM channel_roster WHERE last_seen_wall_ms < ?1",
            params![cutoff],
        )?;
        Ok(())
    }

    pub fn prune_expired_channel_roster(&self, now_wall_ms: i64) -> Result<usize, StoreError> {
        let conn = self.lock()?;
        let cutoff = now_wall_ms - CHANNEL_ROSTER_WINDOW_MS;
        let deleted = conn.execute(
            "DELETE FROM channel_roster WHERE last_seen_wall_ms < ?1",
            params![cutoff],
        )?;
        Ok(deleted)
    }

    pub fn list_channel_roster(
        &self,
        is_demo: bool,
        channel_key: &str,
        now_wall_ms: i64,
    ) -> Result<Vec<ChannelRosterEntry>, StoreError> {
        let conn = self.lock()?;
        let cutoff = now_wall_ms - CHANNEL_ROSTER_WINDOW_MS;
        conn.execute(
            "DELETE FROM channel_roster WHERE last_seen_wall_ms < ?1",
            params![cutoff],
        )?;
        let mut stmt = conn.prepare(
            "SELECT is_demo, channel_key, callsign, mode, dial_freq_hz, band, grid,
                    last_snr_db, last_dt_sec, last_af_hz, last_slot, last_message,
                    is_cq, directed_cq, calling_me, station_role, first_seen_ts_sec,
                    last_seen_ts_sec, last_seen_wall_ms, decode_count
             FROM channel_roster
             WHERE is_demo = ?1 AND channel_key = ?2 AND last_seen_wall_ms >= ?3
             ORDER BY last_seen_wall_ms DESC, callsign ASC",
        )?;
        let rows = stmt.query_map(
            params![if is_demo { 1_i64 } else { 0_i64 }, channel_key, cutoff],
            |row| {
                let last_message: String = row.get(11)?;
                let stored_role: Option<String> = row.get(15)?;
                let station_role = stored_role.or_else(|| {
                    let parsed = crate::domain::ft8::parse_ft8_message(&last_message);
                    crate::domain::ft8::infer_station_role(&parsed).map(|r| r.as_str().to_string())
                });
                Ok(ChannelRosterEntry {
                    is_demo: row.get::<_, i64>(0)? != 0,
                    channel_key: row.get(1)?,
                    callsign: row.get(2)?,
                    mode: row.get(3)?,
                    dial_freq_hz: row.get(4)?,
                    band: row.get(5)?,
                    grid: row.get(6)?,
                    last_snr_db: row.get::<_, i64>(7)?.clamp(-128, 127) as i8,
                    last_dt_sec: row.get::<_, f64>(8)? as f32,
                    last_af_hz: row.get::<_, i64>(9)?.clamp(0, u16::MAX as i64) as u16,
                    last_slot: row.get(10)?,
                    last_message,
                    is_cq: row.get::<_, i64>(12)? != 0,
                    directed_cq: row.get(13)?,
                    calling_me: row.get::<_, i64>(14)? != 0,
                    station_role,
                    first_seen_ts_sec: row.get(16)?,
                    last_seen_ts_sec: row.get(17)?,
                    last_seen_wall_ms: row.get(18)?,
                    decode_count: row.get(19)?,
                })
            },
        )?;
        let mut out = Vec::new();
        for item in rows {
            out.push(item?);
        }
        Ok(out)
    }
}

fn map_radio_profile(row: &rusqlite::Row<'_>) -> rusqlite::Result<RadioProfile> {
    Ok(RadioProfile {
        radio_id: row.get(0)?,
        name: row.get(1)?,
        hamlib_model: row.get(2)?,
        is_dummy: row.get::<_, i64>(3)? != 0,
        serial_device_key: row.get(4)?,
        serial_baud_rate: row.get(5)?,
        civ_address: row.get(6)?,
        ptt_method: row.get(7)?,
        rig_options_json: row.get(8)?,
        audio_device_uid: row.get(9)?,
        audio_device_name: row.get(10)?,
        audio_rx_channel: row.get(11)?,
        audio_tx_gain_db: row.get(12)?,
        rigctld_port: row.get::<_, i64>(13)? as u16,
        auto_connect: row.get::<_, i64>(14)? != 0,
        last_dial_freq_hz: row.get(15)?,
        created_at_utc: row.get(16)?,
        updated_at_utc: row.get(17)?,
    })
}

fn map_qso_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<QsoRecord> {
    Ok(QsoRecord {
        qso_id: row.get(0)?,
        radio_id: row.get(1)?,
        started_at_utc: row.get(2)?,
        completed_at_utc: row.get(3)?,
        my_call: row.get(4)?,
        my_grid: row.get(5)?,
        their_call: row.get(6)?,
        their_grid: row.get(7)?,
        mode: row.get(8)?,
        dial_freq_hz: row.get(9)?,
        band: row.get(10)?,
        af_hz: row.get(11)?,
        rst_sent: row.get(12)?,
        rst_rcvd: row.get(13)?,
        completion_reason: row.get(14)?,
        transcript_json: row.get(15)?,
        qrz_status: row.get(16)?,
        qrz_logid: row.get(17)?,
        qrz_pushed_at_utc: row.get(18)?,
        qrz_error: row.get(19)?,
    })
}

fn map_outbox_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<OutboxRow> {
    Ok(OutboxRow {
        event_id: row.get(0)?,
        schema_version: row.get(1)?,
        station_id: row.get(2)?,
        radio_id: row.get(3)?,
        event_type: row.get(4)?,
        is_demo: row.get::<_, i64>(5)? != 0,
        occurred_at_utc: row.get(6)?,
        payload_json: row.get(7)?,
        status: row.get(8)?,
        attempts: row.get(9)?,
        next_attempt_at_utc: row.get(10)?,
        leased_until_utc: row.get(11)?,
        last_error: row.get(12)?,
        created_at_utc: row.get(13)?,
    })
}

pub fn format_utc(dt: DateTime<Utc>) -> String {
    dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn now_utc_str() -> String {
    format_utc(Utc::now())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn opens_wal_applies_all_8_tables_and_quick_checks() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("digi-dx.db");
        let store = StateStore::open(&db_path).unwrap();

        assert_eq!(store.journal_mode().unwrap().to_ascii_lowercase(), "wal");
        assert_eq!(store.quick_check().unwrap(), "ok");

        let station = store.get_station_config().unwrap();
        assert!(!station.station_id.is_empty());
        assert!(station.callsign.is_none());

        // Re-opening preserves station_id and migrations idempotently
        let store2 = StateStore::open(&db_path).unwrap();
        let station2 = store2.get_station_config().unwrap();
        assert_eq!(station.station_id, station2.station_id);
    }

    #[test]
    fn isolates_real_qsos_from_demo_qsos() {
        let dir = tempdir().unwrap();
        let store = StateStore::open(dir.path().join("digi-dx.db")).unwrap();

        let demo = QsoRecord {
            qso_id: Uuid::now_v7().to_string(),
            radio_id: None,
            started_at_utc: "2026-11-21T22:00:00Z".to_string(),
            completed_at_utc: "2026-11-21T22:01:30Z".to_string(),
            my_call: "QQ0DEMO".to_string(),
            my_grid: "FN33".to_string(),
            their_call: "QQ1XYZ".to_string(),
            their_grid: Some("PM95".to_string()),
            mode: "FT8".to_string(),
            dial_freq_hz: Some(14_074_000),
            band: Some("20m".to_string()),
            af_hz: Some(1400),
            rst_sent: Some("-10".to_string()),
            rst_rcvd: Some("-05".to_string()),
            completion_reason: "73_sent".to_string(),
            transcript_json: "[]".to_string(),
            qrz_status: None,
            qrz_logid: None,
            qrz_pushed_at_utc: None,
            qrz_error: None,
        };
        store.insert_demo_qso(&demo).unwrap();

        assert!(store.list_real_qsos_for_adif().unwrap().is_empty());
        assert_eq!(store.list_qsos(50, 0, None, true).unwrap().len(), 1);
        assert!(store.list_qsos(50, 0, None, false).unwrap().is_empty());

        let real = QsoRecord {
            qso_id: Uuid::now_v7().to_string(),
            my_call: "N1MPM".to_string(),
            their_call: "JA1ABC".to_string(),
            ..demo
        };
        store.insert_qso(&real).unwrap();
        let adif_rows = store.list_real_qsos_for_adif().unwrap();
        assert_eq!(adif_rows.len(), 1);
        assert_eq!(adif_rows[0].their_call, "JA1ABC");

        let real_bracket = QsoRecord {
            qso_id: Uuid::now_v7().to_string(),
            my_call: "N1MPM".to_string(),
            their_call: "<ja1abc>".to_string(),
            ..real
        };
        store.insert_qso(&real_bracket).unwrap();

        assert_eq!(
            store.list_worked_callsigns(false).unwrap(),
            vec!["JA1ABC".to_string()]
        );
        assert_eq!(
            store.list_worked_callsigns(true).unwrap(),
            vec!["QQ1XYZ".to_string()]
        );
    }

    #[test]
    fn outbox_retention_preserves_qso_completed_and_watchdog_abort() {
        let dir = tempdir().unwrap();
        let store = StateStore::open(dir.path().join("digi-dx.db")).unwrap();
        let station_id = store.get_station_config().unwrap().station_id;

        for idx in 0..5 {
            let env = TelemetryEnvelope {
                event_id: Uuid::now_v7().to_string(),
                schema_version: 1,
                station_id: station_id.clone(),
                radio_id: None,
                event_type: if idx == 0 {
                    "qso.completed".to_string()
                } else if idx == 1 {
                    "watchdog.abort".to_string()
                } else {
                    "ft8.decode".to_string()
                },
                occurred_at_utc: now_utc_str(),
                is_demo: false,
                payload: json!({ "idx": idx }),
            };
            store.enqueue_telemetry(&env).unwrap();
        }

        let future = Utc.with_ymd_and_hms(2027, 1, 1, 0, 0, 0).unwrap();
        store.enforce_outbox_retention(2, 14, future).unwrap();
        let remaining = store.list_outbox_rows(10).unwrap();
        assert_eq!(remaining.len(), 2);
        let types: Vec<&str> = remaining.iter().map(|r| r.event_type.as_str()).collect();
        assert!(types.contains(&"qso.completed"));
        assert!(types.contains(&"watchdog.abort"));
    }

    #[test]
    fn channel_roster_preserves_grid_prunes_after_5m_and_isolates_channels_and_demo() {
        let dir = tempdir().unwrap();
        let store = StateStore::open(dir.path().join("digi-dx.db")).unwrap();

        let ch_20m = channel_key_for_freq("FT8", Some(14_074_000));
        let ch_40m = channel_key_for_freq("FT8", Some(7_074_000));
        assert_eq!(ch_20m, "FT8:14074000");
        assert_eq!(ch_40m, "FT8:7074000");

        let t0 = 1_700_000_000_000_i64;
        store
            .upsert_channel_roster_entry(
                &UpsertChannelRosterInput {
                    is_demo: false,
                    channel_key: ch_20m.clone(),
                    callsign: "JA1ABC".into(),
                    mode: "FT8".into(),
                    dial_freq_hz: Some(14_074_000),
                    band: Some("20m".into()),
                    grid: Some("PM95".into()),
                    last_snr_db: -10,
                    last_dt_sec: 0.1,
                    last_af_hz: 1420,
                    last_slot: "even".into(),
                    last_message: "CQ JA1ABC PM95".into(),
                    is_cq: true,
                    directed_cq: None,
                    calling_me: false,
                    station_role: Some("caller".into()),
                    seen_ts_sec: 1_700_000_000,
                    increment_decode_count: true,
                },
                t0,
            )
            .unwrap();

        // Refined multi-pass update (increment_decode_count: false) must refresh SNR/AF without inflating count
        store
            .upsert_channel_roster_entry(
                &UpsertChannelRosterInput {
                    is_demo: false,
                    channel_key: ch_20m.clone(),
                    callsign: "JA1ABC".into(),
                    mode: "FT8".into(),
                    dial_freq_hz: Some(14_074_000),
                    band: Some("20m".into()),
                    grid: Some("PM95".into()),
                    last_snr_db: -9,
                    last_dt_sec: 0.1,
                    last_af_hz: 1422,
                    last_slot: "even".into(),
                    last_message: "CQ JA1ABC PM95".into(),
                    is_cq: true,
                    directed_cq: None,
                    calling_me: false,
                    station_role: Some("caller".into()),
                    seen_ts_sec: 1_700_000_000,
                    increment_decode_count: false,
                },
                t0 + 1_700,
            )
            .unwrap();

        let after_refine = store
            .list_channel_roster(false, &ch_20m, t0 + 1_700)
            .unwrap();
        assert_eq!(after_refine[0].decode_count, 1);
        assert_eq!(after_refine[0].last_snr_db, -9);
        assert_eq!(after_refine[0].last_af_hz, 1422);

        // Follow-up message where station acts as Hunter must preserve PM95 and switch station_role
        store
            .upsert_channel_roster_entry(
                &UpsertChannelRosterInput {
                    is_demo: false,
                    channel_key: ch_20m.clone(),
                    callsign: "JA1ABC".into(),
                    mode: "FT8".into(),
                    dial_freq_hz: Some(14_074_000),
                    band: Some("20m".into()),
                    grid: None,
                    last_snr_db: -8,
                    last_dt_sec: 0.2,
                    last_af_hz: 1420,
                    last_slot: "even".into(),
                    last_message: "K1XYZ JA1ABC R-08".into(),
                    is_cq: false,
                    directed_cq: None,
                    calling_me: false,
                    station_role: Some("hunter".into()),
                    seen_ts_sec: 1_700_000_030,
                    increment_decode_count: true,
                },
                t0 + 30_000,
            )
            .unwrap();

        // Demo entry on same frequency is isolated from real channel roster
        store
            .upsert_channel_roster_entry(
                &UpsertChannelRosterInput {
                    is_demo: true,
                    channel_key: ch_20m.clone(),
                    callsign: "QQ1AAA".into(),
                    mode: "FT8".into(),
                    dial_freq_hz: Some(14_074_000),
                    band: Some("20m".into()),
                    grid: Some("EM10".into()),
                    last_snr_db: -5,
                    last_dt_sec: 0.1,
                    last_af_hz: 740,
                    last_slot: "odd".into(),
                    last_message: "CQ QQ1AAA EM10".into(),
                    is_cq: true,
                    directed_cq: None,
                    calling_me: false,
                    station_role: Some("caller".into()),
                    seen_ts_sec: 1_700_000_030,
                    increment_decode_count: true,
                },
                t0 + 30_000,
            )
            .unwrap();

        let real_20m = store
            .list_channel_roster(false, &ch_20m, t0 + 60_000)
            .unwrap();
        assert_eq!(real_20m.len(), 1);
        assert_eq!(real_20m[0].callsign, "JA1ABC");
        assert_eq!(real_20m[0].grid.as_deref(), Some("PM95"));
        assert_eq!(real_20m[0].station_role.as_deref(), Some("hunter"));
        assert_eq!(real_20m[0].decode_count, 2);

        assert!(store
            .list_channel_roster(false, &ch_40m, t0 + 60_000)
            .unwrap()
            .is_empty());

        let demo_20m = store
            .list_channel_roster(true, &ch_20m, t0 + 60_000)
            .unwrap();
        assert_eq!(demo_20m.len(), 1);
        assert_eq!(demo_20m[0].callsign, "QQ1AAA");

        // After 5m01s from t0+30_000, both entries prune out
        let expired = store
            .list_channel_roster(false, &ch_20m, t0 + 30_000 + CHANNEL_ROSTER_WINDOW_MS + 1)
            .unwrap();
        assert!(expired.is_empty());
    }

    #[test]
    fn qrz_sync_store_tracks_states_isolates_demo_and_redacts_station_config() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("digi-dx.db");
        let store = StateStore::open(&db_path).unwrap();

        // Key set & get without leaking through StationConfig JSON
        assert_eq!(store.get_qrz_api_key().unwrap(), None);
        store
            .set_qrz_api_key(Some("  ABCD-1234-EFGH-5678  "))
            .unwrap();
        assert_eq!(
            store.get_qrz_api_key().unwrap().as_deref(),
            Some("ABCD-1234-EFGH-5678")
        );
        let station_json = serde_json::to_string(&store.get_station_config().unwrap()).unwrap();
        assert!(!station_json.contains("ABCD-1234-EFGH-5678"));
        assert!(!station_json.contains("qrz_api_key"));

        // Re-opening runs migration 004 idempotently
        let store2 = StateStore::open(&db_path).unwrap();
        assert_eq!(
            store2.get_qrz_api_key().unwrap().as_deref(),
            Some("ABCD-1234-EFGH-5678")
        );

        let demo = QsoRecord {
            qso_id: Uuid::now_v7().to_string(),
            radio_id: None,
            started_at_utc: "2026-11-21T22:00:00Z".to_string(),
            completed_at_utc: "2026-11-21T22:01:30Z".to_string(),
            my_call: "QQ0DEMO".to_string(),
            my_grid: "FN33".to_string(),
            their_call: "QQ1XYZ".to_string(),
            their_grid: Some("PM95".to_string()),
            mode: "FT8".to_string(),
            dial_freq_hz: Some(14_074_000),
            band: Some("20m".to_string()),
            af_hz: Some(1400),
            rst_sent: Some("-10".to_string()),
            rst_rcvd: Some("-05".to_string()),
            completion_reason: "73_sent".to_string(),
            transcript_json: "[]".to_string(),
            qrz_status: None,
            qrz_logid: None,
            qrz_pushed_at_utc: None,
            qrz_error: None,
        };
        store2.insert_demo_qso(&demo).unwrap();

        let real1 = QsoRecord {
            qso_id: "qso-real-1".to_string(),
            my_call: "N1MPM".to_string(),
            their_call: "JA1ABC".to_string(),
            completed_at_utc: "2026-11-21T22:02:00Z".to_string(),
            ..demo.clone()
        };
        let real2 = QsoRecord {
            qso_id: "qso-real-2".to_string(),
            my_call: "N1MPM".to_string(),
            their_call: "DL2XYZ".to_string(),
            completed_at_utc: "2026-11-21T22:05:00Z".to_string(),
            ..demo
        };
        store2.insert_qso(&real1).unwrap();
        store2.insert_qso(&real2).unwrap();

        let unpushed = store2.list_unpushed_real_qsos().unwrap();
        assert_eq!(unpushed.len(), 2);
        assert_eq!(unpushed[0].qso_id, "qso-real-1");
        assert_eq!(unpushed[1].qso_id, "qso-real-2");
        assert_eq!(unpushed[0].qrz_status.as_deref(), Some("pending"));

        store2
            .mark_qso_qrz_synced("qso-real-1", Some("987654"), "2026-11-21T22:06:00Z")
            .unwrap();
        store2
            .mark_qso_qrz_failed("qso-real-2", "outside date range")
            .unwrap();

        let counts = store2.count_qrz_qso_states().unwrap();
        assert_eq!(
            counts,
            QrzQsoCounts {
                pending: 0,
                synced: 1,
                failed: 1,
            }
        );

        let retry_list = store2.list_unpushed_real_qsos().unwrap();
        assert_eq!(retry_list.len(), 1);
        assert_eq!(retry_list[0].qso_id, "qso-real-2");
        assert_eq!(retry_list[0].qrz_status.as_deref(), Some("failed"));
        assert_eq!(
            retry_list[0].qrz_error.as_deref(),
            Some("outside date range")
        );

        let summary = QrzPushSummary {
            total: 2,
            pushed: 1,
            duplicates: 0,
            failed: 1,
            skipped_demo: 0,
            aborted_reason: None,
            errors: vec![QrzPushErrorItem {
                qso_id: "qso-real-2".to_string(),
                their_call: "DL2XYZ".to_string(),
                reason: "outside date range".to_string(),
            }],
            pushed_at_utc: "2026-11-21T22:06:05Z".to_string(),
        };
        store2
            .record_qrz_push_result("2026-11-21T22:06:05Z", &summary)
            .unwrap();
        let (ts, loaded) = store2.get_qrz_last_push().unwrap();
        assert_eq!(ts.as_deref(), Some("2026-11-21T22:06:05Z"));
        assert_eq!(loaded, Some(summary));

        store2.set_qrz_api_key(Some("   ")).unwrap();
        assert_eq!(store2.get_qrz_api_key().unwrap(), None);
    }
}
