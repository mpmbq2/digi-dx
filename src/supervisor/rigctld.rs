use std::collections::{BTreeMap, HashMap};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::time::{sleep, timeout, Instant};
use tokio_util::sync::CancellationToken;

use crate::store::RadioProfile;

const DEFAULT_CAT_TIMEOUT: Duration = Duration::from_millis(2_000);
const ATU_TUNE_TIMEOUT: Duration = Duration::from_secs(15);
const EMERGENCY_PTT_TIMEOUT: Duration = Duration::from_millis(300);
const STARTUP_TIMEOUT: Duration = Duration::from_millis(5_000);
const SHUTDOWN_WAIT_TIMEOUT: Duration = Duration::from_millis(5_000);

#[derive(Debug, Error)]
pub enum RigctldError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("rigctld command timed out: {0}")]
    Timeout(String),
    #[error("loopback port 127.0.0.1:{0} is already in use")]
    PortBusy(u16),
    #[error("failed to spawn rigctld: {0}")]
    SpawnFailed(String),
    #[error("rigctld exited prematurely: {0}")]
    ExitedEarly(String),
    #[error("unexpected rigctld response: {0}")]
    ProtocolError(String),
    #[error("Hamlib error on '{cmd}': RPRT {code}")]
    HamlibError { cmd: String, code: i32 },
    #[error("serial port permission denied: {0}")]
    PermissionDenied(String),
    #[error("transceiver powered off or CAT unresponsive: {0}")]
    RadioPoweredOff(String),
}

pub const CURATED_LEVELS: &[&str] = &[
    "RFPOWER",
    "AF",
    "RF",
    "SQL",
    "MICGAIN",
    "PREAMP",
    "ATT",
    "AGC",
    "NR",
    "NB",
    "COMP",
    "KEYSPD",
    "STRENGTH",
    "SWR",
    "ALC",
    "RFPOWER_METER_WATTS",
];

pub const WRITABLE_LEVELS: &[&str] = &[
    "RFPOWER", "AF", "RF", "SQL", "MICGAIN", "PREAMP", "ATT", "AGC", "NR", "NB", "COMP", "KEYSPD",
];

pub const CURATED_FUNCS: &[&str] = &[
    "TUNER", "NB", "NR", "COMP", "VOX", "LOCK", "ANF", "MON", "RIT", "XIT",
];

pub const CURATED_VFO_OPS: &[&str] = &["TUNE"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgcLevelOption {
    pub value: i32,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RigCapabilities {
    pub model_id: i64,
    pub modes: Vec<String>,
    pub vfos: Vec<String>,
    pub preamp_db: Vec<i32>,
    pub att_db: Vec<i32>,
    pub agc_levels: Vec<AgcLevelOption>,
    pub get_levels: Vec<String>,
    pub set_levels: Vec<String>,
    pub get_funcs: Vec<String>,
    pub set_funcs: Vec<String>,
    #[serde(default)]
    pub vfo_ops: Vec<String>,
    pub max_rit_hz: Option<i32>,
    pub max_xit_hz: Option<i32>,
    pub has_split: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtendedResponse {
    pub values: HashMap<String, String>,
    pub raw_lines: Vec<String>,
    pub code: i32,
}

/// Persistent single-connection TCP client using Hamlib `+` extended response protocol.
pub struct RigctldClient {
    reader: BufReader<tokio::net::tcp::OwnedReadHalf>,
    writer: tokio::net::tcp::OwnedWriteHalf,
}

impl RigctldClient {
    pub async fn connect(port: u16) -> Result<Self, RigctldError> {
        let addr = format!("127.0.0.1:{port}");
        let stream = timeout(Duration::from_millis(1_000), TcpStream::connect(&addr))
            .await
            .map_err(|_| RigctldError::Timeout(format!("connect {addr}")))??;
        let _ = stream.set_nodelay(true);
        let (read_half, write_half) = stream.into_split();
        Ok(Self {
            reader: BufReader::new(read_half),
            writer: write_half,
        })
    }

    pub async fn send_extended(
        &mut self,
        cmd: &str,
        op_timeout: Duration,
    ) -> Result<ExtendedResponse, RigctldError> {
        let trimmed = cmd.trim();
        let prefixed = if trimmed.starts_with('+') {
            trimmed.to_string()
        } else {
            format!("+{trimmed}")
        };
        let wire = format!("{prefixed}\n");

        let fut = async {
            self.writer.write_all(wire.as_bytes()).await?;
            self.writer.flush().await?;

            let mut values = HashMap::new();
            let mut raw_lines = Vec::new();
            let mut line = String::new();
            loop {
                line.clear();
                let n = self.reader.read_line(&mut line).await?;
                if n == 0 {
                    return Err(RigctldError::ProtocolError(format!(
                        "EOF waiting for RPRT on '{prefixed}'"
                    )));
                }
                let s = line.trim();
                if let Some(code_str) = s.strip_prefix("RPRT ") {
                    let code = code_str.trim().parse::<i32>().map_err(|_| {
                        RigctldError::ProtocolError(format!("invalid RPRT code '{s}'"))
                    })?;
                    return Ok(ExtendedResponse {
                        values,
                        raw_lines,
                        code,
                    });
                }
                if let Some((k, v)) = s.split_once(':') {
                    let key = k.trim().to_string();
                    let val = v.trim().to_string();
                    if !val.is_empty() {
                        values.insert(key, val);
                    }
                } else if !s.is_empty() {
                    raw_lines.push(s.to_string());
                }
            }
        };

        let resp = timeout(op_timeout, fut)
            .await
            .map_err(|_| RigctldError::Timeout(prefixed.clone()))??;

        if resp.code != 0 {
            return Err(RigctldError::HamlibError {
                cmd: prefixed,
                code: resp.code,
            });
        }
        Ok(resp)
    }

    pub async fn get_freq(&mut self) -> Result<u64, RigctldError> {
        let resp = self.send_extended("+f", DEFAULT_CAT_TIMEOUT).await?;
        let raw = resp
            .values
            .get("Frequency")
            .ok_or_else(|| RigctldError::ProtocolError("missing Frequency field".to_string()))?;
        raw.parse::<f64>()
            .map(|f| f.round() as u64)
            .map_err(|_| RigctldError::ProtocolError(format!("invalid Frequency '{raw}'")))
    }

    pub async fn set_freq(&mut self, freq_hz: u64) -> Result<(), RigctldError> {
        self.send_extended(&format!("+F {freq_hz}"), DEFAULT_CAT_TIMEOUT)
            .await?;
        Ok(())
    }

    pub async fn get_mode(&mut self) -> Result<(String, u32), RigctldError> {
        let resp = self.send_extended("+m", DEFAULT_CAT_TIMEOUT).await?;
        let mode = resp
            .values
            .get("Mode")
            .cloned()
            .ok_or_else(|| RigctldError::ProtocolError("missing Mode field".to_string()))?;
        let passband = resp
            .values
            .get("Passband")
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(0);
        Ok((mode, passband))
    }

    pub async fn set_mode(&mut self, mode: &str, passband_hz: u32) -> Result<(), RigctldError> {
        let upper = mode.trim().to_ascii_uppercase();
        self.send_extended(&format!("+M {upper} {passband_hz}"), DEFAULT_CAT_TIMEOUT)
            .await?;
        Ok(())
    }

    /// Queries PTT state. Returns `Ok(None)` cleanly if rig returns `RPRT -11` (`RIG_ENAVAIL`).
    pub async fn get_ptt(&mut self) -> Result<Option<bool>, RigctldError> {
        match self.send_extended("+t", DEFAULT_CAT_TIMEOUT).await {
            Ok(resp) => {
                let ptt_val = resp
                    .values
                    .get("PTT")
                    .and_then(|v| v.parse::<i32>().ok())
                    .unwrap_or(0);
                Ok(Some(ptt_val != 0))
            }
            Err(RigctldError::HamlibError { code: -11, .. }) => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub async fn set_ptt(&mut self, ptt_value: u8) -> Result<(), RigctldError> {
        self.set_ptt_with_timeout(ptt_value, DEFAULT_CAT_TIMEOUT)
            .await
    }

    pub async fn set_ptt_with_timeout(
        &mut self,
        ptt_value: u8,
        op_timeout: Duration,
    ) -> Result<(), RigctldError> {
        self.send_extended(&format!("+T {ptt_value}"), op_timeout)
            .await?;
        Ok(())
    }

    /// Queries transceiver power status (`+\get_powerstat`).
    /// Returns `Ok(Some(true))` for ON/OPERATE (1/4), `Ok(Some(false))` for OFF/STANDBY (0/2 or `RPRT -20`),
    /// and `Ok(None)` when unsupported (`RPRT -4`/`-11`) or unknown.
    pub async fn get_powerstat(&mut self) -> Result<Option<bool>, RigctldError> {
        match self
            .send_extended("+\\get_powerstat", DEFAULT_CAT_TIMEOUT)
            .await
        {
            Ok(resp) => {
                let val = resp
                    .values
                    .get("Power Status")
                    .and_then(|s| s.parse::<i32>().ok());
                match val {
                    Some(0 | 2) => Ok(Some(false)),
                    Some(1 | 4) => Ok(Some(true)),
                    _ => Ok(None),
                }
            }
            Err(RigctldError::HamlibError { code: -4 | -11, .. }) => Ok(None),
            Err(RigctldError::HamlibError { code: -20, .. }) => Ok(Some(false)),
            Err(e) => Err(e),
        }
    }

    pub async fn get_vfo(&mut self) -> Result<Option<String>, RigctldError> {
        match self.send_extended("+v", DEFAULT_CAT_TIMEOUT).await {
            Ok(resp) => Ok(resp
                .values
                .get("VFO")
                .cloned()
                .or_else(|| resp.raw_lines.first().cloned())),
            Err(RigctldError::HamlibError { code: -4 | -11, .. }) => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub async fn set_vfo(&mut self, vfo: &str) -> Result<(), RigctldError> {
        let trimmed = vfo.trim();
        self.send_extended(&format!("+V {trimmed}"), DEFAULT_CAT_TIMEOUT)
            .await?;
        Ok(())
    }

    pub async fn get_split(&mut self) -> Result<Option<(bool, Option<String>)>, RigctldError> {
        match self.send_extended("+s", DEFAULT_CAT_TIMEOUT).await {
            Ok(resp) => {
                let split_on = resp
                    .values
                    .get("Split")
                    .and_then(|s| s.parse::<i32>().ok())
                    .is_some_and(|v| v != 0);
                let tx_vfo = resp.values.get("TX VFO").cloned();
                Ok(Some((split_on, tx_vfo)))
            }
            Err(RigctldError::HamlibError { code: -4 | -11, .. }) => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub async fn set_split(&mut self, enabled: bool, tx_vfo: &str) -> Result<(), RigctldError> {
        let flag = if enabled { 1 } else { 0 };
        let vfo = if tx_vfo.trim().is_empty() {
            "VFOB"
        } else {
            tx_vfo.trim()
        };
        self.send_extended(&format!("+S {flag} {vfo}"), DEFAULT_CAT_TIMEOUT)
            .await?;
        Ok(())
    }

    pub async fn get_rit(&mut self) -> Result<Option<i32>, RigctldError> {
        match self.send_extended("+j", DEFAULT_CAT_TIMEOUT).await {
            Ok(resp) => Ok(resp.values.get("RIT").and_then(|s| s.parse::<i32>().ok())),
            Err(RigctldError::HamlibError { code: -4 | -11, .. }) => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub async fn set_rit(&mut self, hz: i32) -> Result<(), RigctldError> {
        self.send_extended(&format!("+J {hz}"), DEFAULT_CAT_TIMEOUT)
            .await?;
        Ok(())
    }

    pub async fn get_xit(&mut self) -> Result<Option<i32>, RigctldError> {
        match self.send_extended("+z", DEFAULT_CAT_TIMEOUT).await {
            Ok(resp) => Ok(resp.values.get("XIT").and_then(|s| s.parse::<i32>().ok())),
            Err(RigctldError::HamlibError { code: -4 | -11, .. }) => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub async fn set_xit(&mut self, hz: i32) -> Result<(), RigctldError> {
        self.send_extended(&format!("+Z {hz}"), DEFAULT_CAT_TIMEOUT)
            .await?;
        Ok(())
    }

    pub async fn get_level(&mut self, name: &str) -> Result<Option<f64>, RigctldError> {
        let upper = name.trim().to_ascii_uppercase();
        match self
            .send_extended(&format!("+l {upper}"), DEFAULT_CAT_TIMEOUT)
            .await
        {
            Ok(resp) => {
                let val = resp
                    .raw_lines
                    .first()
                    .and_then(|s| s.parse::<f64>().ok())
                    .or_else(|| {
                        resp.values
                            .get("Level Value")
                            .and_then(|s| s.parse::<f64>().ok())
                    });
                Ok(val)
            }
            Err(RigctldError::HamlibError { code: -4 | -11, .. }) => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub async fn set_level(&mut self, name: &str, value: f64) -> Result<(), RigctldError> {
        let upper = name.trim().to_ascii_uppercase();
        let val_str = if matches!(upper.as_str(), "PREAMP" | "ATT" | "AGC" | "KEYSPD") {
            format!("{}", value.round() as i64)
        } else {
            format!("{value:.4}")
        };
        self.send_extended(&format!("+L {upper} {val_str}"), DEFAULT_CAT_TIMEOUT)
            .await?;
        Ok(())
    }

    pub async fn get_func(&mut self, name: &str) -> Result<Option<bool>, RigctldError> {
        let upper = name.trim().to_ascii_uppercase();
        match self
            .send_extended(&format!("+u {upper}"), DEFAULT_CAT_TIMEOUT)
            .await
        {
            Ok(resp) => {
                let raw = resp
                    .raw_lines
                    .first()
                    .map(String::as_str)
                    .or_else(|| resp.values.get("Func Status").map(String::as_str));
                Ok(raw.and_then(|s| s.parse::<i32>().ok()).map(|v| v != 0))
            }
            Err(RigctldError::HamlibError { code: -4 | -11, .. }) => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub async fn set_func(&mut self, name: &str, enabled: bool) -> Result<(), RigctldError> {
        let upper = name.trim().to_ascii_uppercase();
        let flag = if enabled { 1 } else { 0 };
        self.send_extended(&format!("+U {upper} {flag}"), DEFAULT_CAT_TIMEOUT)
            .await?;
        Ok(())
    }

    /// Executes a Hamlib VFO operation (`+G <OP>`, e.g. `+G TUNE` to trigger internal ATU).
    pub async fn vfo_op(&mut self, op: &str) -> Result<(), RigctldError> {
        let upper = op.trim().to_ascii_uppercase();
        let op_timeout = if upper == "TUNE" {
            ATU_TUNE_TIMEOUT
        } else {
            DEFAULT_CAT_TIMEOUT
        };
        self.send_extended(&format!("+G {upper}"), op_timeout)
            .await?;
        Ok(())
    }

    pub async fn power2mw(
        &mut self,
        level: f64,
        freq_hz: u64,
        mode: &str,
    ) -> Result<Option<u32>, RigctldError> {
        let norm_mode = if mode.trim().is_empty() {
            "USB"
        } else {
            mode.trim()
        };
        match self
            .send_extended(
                &format!("+\\power2mW {level:.4} {freq_hz} {norm_mode}"),
                DEFAULT_CAT_TIMEOUT,
            )
            .await
        {
            Ok(resp) => Ok(resp
                .values
                .get("Power mW")
                .and_then(|s| s.parse::<u32>().ok())),
            Err(RigctldError::HamlibError { code: -4 | -11, .. }) => Ok(None),
            Err(e) => Err(e),
        }
    }
}

pub fn is_cat_powered_off_error(err: &RigctldError, is_dummy: bool, rigctld_alive: bool) -> bool {
    match err {
        RigctldError::RadioPoweredOff(_) => true,
        RigctldError::HamlibError { code: -20, .. } => true,
        RigctldError::HamlibError { code: -5, .. } | RigctldError::Timeout(_) => {
            !is_dummy && rigctld_alive
        }
        _ => false,
    }
}

#[cfg(unix)]
pub fn check_serial_rw_access(dev_path: &str) -> Result<(), RigctldError> {
    let c_path = std::ffi::CString::new(dev_path).map_err(|_| {
        RigctldError::SpawnFailed(format!("invalid serial device path '{dev_path}'"))
    })?;
    // SAFETY: c_path is a valid NUL-terminated string; access(2) checks permissions without opening the tty.
    let rc = unsafe { libc::access(c_path.as_ptr(), libc::R_OK | libc::W_OK) };
    if rc != 0 {
        let err = std::io::Error::last_os_error();
        return Err(RigctldError::PermissionDenied(format!(
            "cannot access serial device '{dev_path}': {err} (ensure your user/session is in the dialout/uucp group; restart tmux/shell after group changes)"
        )));
    }
    Ok(())
}

pub fn normalize_civ_address(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.starts_with("0x") || trimmed.starts_with("0X") {
        return trimmed.to_string();
    }
    if trimmed.len() == 2 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
        return format!("0x{trimmed}");
    }
    trimmed.to_string()
}

pub fn build_rigctld_args(
    profile: &RadioProfile,
    serial_path: Option<&str>,
) -> Result<Vec<String>, RigctldError> {
    if profile.hamlib_model <= 0 {
        return Err(RigctldError::SpawnFailed(format!(
            "invalid hamlib_model {}",
            profile.hamlib_model
        )));
    }

    let mut args = vec![
        "-m".to_string(),
        profile.hamlib_model.to_string(),
        "-t".to_string(),
        profile.rigctld_port.to_string(),
        "-T".to_string(),
        "127.0.0.1".to_string(),
    ];

    let mut rig_opts = BTreeMap::<String, String>::new();
    if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&profile.rig_options_json) {
        for (k, v) in map {
            let val_str = match v {
                Value::String(s) => s,
                Value::Number(n) => n.to_string(),
                Value::Bool(b) => {
                    if b {
                        "1".to_string()
                    } else {
                        "0".to_string()
                    }
                }
                _ => continue,
            };
            rig_opts.insert(k, val_str);
        }
    }

    if profile.is_dummy || profile.hamlib_model == 1 {
        match profile.ptt_method.as_str() {
            "cat" | "cat_data" => {
                args.push("-P".to_string());
                args.push("RIG".to_string());
            }
            "vox" => {
                args.push("-P".to_string());
                args.push("NONE".to_string());
            }
            _ => {}
        }
    } else {
        let dev_path = serial_path
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                RigctldError::SpawnFailed("serial device path is required for non-dummy rig".into())
            })?;

        args.push("-r".to_string());
        args.push(dev_path.to_string());
        args.push("-s".to_string());
        args.push(profile.serial_baud_rate.to_string());

        if let Some(ref civ) = profile.civ_address {
            let trimmed = civ.trim();
            if !trimmed.is_empty() {
                args.push("-c".to_string());
                args.push(normalize_civ_address(trimmed));
            }
        }

        let ptt_flag = match profile.ptt_method.as_str() {
            "cat" | "cat_data" => Some("RIG"),
            "rts" => Some("RTS"),
            "dtr" => Some("DTR"),
            "vox" => Some("NONE"),
            _ => None,
        };
        if let Some(ptt) = ptt_flag {
            args.push("-P".to_string());
            args.push(ptt.to_string());
        }

        // Prevent Linux from holding serial RTS/DTR control lines HIGH by default on open,
        // which would continuously key transceivers configured for RTS/DTR SEND/CW/RTTY.
        let is_hw_handshake = rig_opts
            .get("serial_handshake")
            .is_some_and(|v| v.eq_ignore_ascii_case("hardware"));
        if !is_hw_handshake {
            match profile.ptt_method.as_str() {
                "cat" | "cat_data" | "vox" => {
                    rig_opts
                        .entry("rts_state".to_string())
                        .or_insert_with(|| "OFF".to_string());
                    rig_opts
                        .entry("dtr_state".to_string())
                        .or_insert_with(|| "OFF".to_string());
                }
                "rts" => {
                    rig_opts
                        .entry("dtr_state".to_string())
                        .or_insert_with(|| "OFF".to_string());
                }
                "dtr" => {
                    rig_opts
                        .entry("rts_state".to_string())
                        .or_insert_with(|| "OFF".to_string());
                }
                _ => {}
            }
        }
    }

    for (k, val_str) in rig_opts {
        args.push("-C".to_string());
        args.push(format!("{k}={val_str}"));
    }

    Ok(args)
}

pub struct RigctldProcess {
    child: Child,
    pid: u32,
    port: u16,
}

impl RigctldProcess {
    pub async fn spawn_and_connect(
        rigctld_bin: &str,
        profile: &RadioProfile,
        serial_path: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<(Self, RigctldClient), RigctldError> {
        let port = profile.rigctld_port;
        let addr = format!("127.0.0.1:{port}");
        if timeout(Duration::from_millis(150), TcpStream::connect(&addr))
            .await
            .is_ok_and(|res| res.is_ok())
        {
            return Err(RigctldError::PortBusy(port));
        }

        let args = build_rigctld_args(profile, serial_path)?;
        let is_dummy = profile.is_dummy || profile.hamlib_model == 1;
        if !is_dummy {
            if let Some(dev_path) = serial_path.map(str::trim).filter(|s| !s.is_empty()) {
                if !std::path::Path::new(dev_path).exists() {
                    return Err(RigctldError::SpawnFailed(format!(
                        "serial device path '{dev_path}' does not exist"
                    )));
                }
                #[cfg(unix)]
                check_serial_rw_access(dev_path)?;
            }
        }
        let mut cmd = Command::new(rigctld_bin);
        cmd.args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        #[cfg(unix)]
        {
            cmd.process_group(0);
        }

        let child = cmd
            .spawn()
            .map_err(|e| RigctldError::SpawnFailed(format!("{rigctld_bin}: {e}")))?;
        let pid = child.id().unwrap_or(0);
        let mut proc_handle = Self { child, pid, port };

        let deadline = Instant::now() + STARTUP_TIMEOUT;
        while Instant::now() < deadline {
            if cancel.is_cancelled() {
                proc_handle.shutdown_gracefully(None).await;
                return Err(RigctldError::ExitedEarly(
                    "cancelled during startup".to_string(),
                ));
            }

            if let Some(status) = proc_handle.child.try_wait()? {
                let stderr_msg = proc_handle.read_stderr_snippet().await;
                return Err(RigctldError::ExitedEarly(format!(
                    "exited with {status}{}",
                    if stderr_msg.is_empty() {
                        String::new()
                    } else {
                        format!(": {stderr_msg}")
                    }
                )));
            }

            if let Ok(mut client) = RigctldClient::connect(port).await {
                match client.get_powerstat().await {
                    Ok(Some(false)) => {
                        proc_handle.shutdown_gracefully(None).await;
                        return Err(RigctldError::RadioPoweredOff(
                            "transceiver reported power OFF / standby".to_string(),
                        ));
                    }
                    Ok(Some(true)) | Ok(None) => {}
                    Err(e) => {
                        let alive = proc_handle.is_alive();
                        if is_cat_powered_off_error(&e, is_dummy, alive) {
                            proc_handle.shutdown_gracefully(None).await;
                            return Err(RigctldError::RadioPoweredOff(format!(
                                "USB serial connected, CAT power probe unresponsive ({e})"
                            )));
                        }
                        proc_handle.shutdown_gracefully(Some(&mut client)).await;
                        return Err(e);
                    }
                }
                match client.get_freq().await {
                    Ok(_) => return Ok((proc_handle, client)),
                    Err(e) => {
                        let alive = proc_handle.is_alive();
                        if is_cat_powered_off_error(&e, is_dummy, alive) {
                            proc_handle.shutdown_gracefully(None).await;
                            return Err(RigctldError::RadioPoweredOff(format!(
                                "USB serial connected, transceiver did not respond to CAT ({e})"
                            )));
                        }
                        proc_handle.shutdown_gracefully(Some(&mut client)).await;
                        return Err(e);
                    }
                }
            }

            sleep(Duration::from_millis(50)).await;
        }

        if let Some(status) = proc_handle.child.try_wait()? {
            let stderr_msg = proc_handle.read_stderr_snippet().await;
            return Err(RigctldError::ExitedEarly(format!(
                "exited with {status}{}",
                if stderr_msg.is_empty() {
                    String::new()
                } else {
                    format!(": {stderr_msg}")
                }
            )));
        }

        proc_handle.shutdown_gracefully(None).await;
        if !is_dummy {
            return Err(RigctldError::RadioPoweredOff(format!(
                "USB serial port is openable, but transceiver did not answer CAT init within {}ms (likely powered off or wrong baud/CI-V)",
                STARTUP_TIMEOUT.as_millis()
            )));
        }
        Err(RigctldError::Timeout(format!(
            "rigctld failed to listen on 127.0.0.1:{port} within {}ms",
            STARTUP_TIMEOUT.as_millis()
        )))
    }

    async fn read_stderr_snippet(&mut self) -> String {
        use tokio::io::AsyncReadExt;
        let Some(mut stderr) = self.child.stderr.take() else {
            return String::new();
        };
        let mut buf = vec![0_u8; 512];
        match timeout(Duration::from_millis(200), stderr.read(&mut buf)).await {
            Ok(Ok(n)) if n > 0 => String::from_utf8_lossy(&buf[..n]).trim().to_string(),
            _ => String::new(),
        }
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn try_wait(&mut self) -> Result<Option<std::process::ExitStatus>, std::io::Error> {
        self.child.try_wait()
    }

    pub fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub async fn shutdown_gracefully(mut self, client: Option<&mut RigctldClient>) {
        if let Some(c) = client {
            let _ = c.set_ptt_with_timeout(0, EMERGENCY_PTT_TIMEOUT).await;
        }

        #[cfg(unix)]
        if self.pid > 0 {
            // SAFETY: pgid equals pid because process_group(0) was set before exec.
            unsafe {
                libc::kill(-(self.pid as libc::pid_t), libc::SIGTERM);
            }
        }
        #[cfg(not(unix))]
        {
            let _ = self.child.start_kill();
        }

        match timeout(SHUTDOWN_WAIT_TIMEOUT, self.child.wait()).await {
            Ok(_) => {}
            Err(_) => {
                #[cfg(unix)]
                if self.pid > 0 {
                    unsafe {
                        libc::kill(-(self.pid as libc::pid_t), libc::SIGKILL);
                    }
                }
                #[cfg(not(unix))]
                {
                    let _ = self.child.kill().await;
                }
                let _ = self.child.wait().await;
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HamlibModelEntry {
    pub id: i64,
    pub manufacturer: String,
    pub model: String,
    pub status: String,
}

pub fn load_rig_capabilities(rigctl_bin: &str, model_id: i64) -> Option<RigCapabilities> {
    if model_id <= 0 {
        return None;
    }
    let out = std::process::Command::new(rigctl_bin)
        .args(["-m", &model_id.to_string(), "-u"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(parse_rigctl_caps(
        model_id,
        &String::from_utf8_lossy(&out.stdout),
    ))
}

fn parse_curated_token_list(raw: &str, allowlist: &[&str]) -> Vec<String> {
    let mut found = Vec::new();
    for tok in raw.split_whitespace() {
        let name = tok.split('(').next().unwrap_or(tok).trim();
        let upper = name.to_ascii_uppercase();
        if allowlist.contains(&upper.as_str()) && !found.contains(&upper) {
            found.push(upper);
        }
    }
    found
}

fn parse_db_steps(raw: &str) -> Vec<i32> {
    let mut steps = Vec::new();
    for tok in raw.split_whitespace() {
        let cleaned = tok.trim_end_matches("dB").trim_end_matches("db");
        if let Ok(val) = cleaned.parse::<i32>() {
            if val > 0 && !steps.contains(&val) {
                steps.push(val);
            }
        }
    }
    if !steps.is_empty() {
        steps.insert(0, 0);
    }
    steps
}

fn parse_max_rit_xit_hz(raw: &str) -> Option<i32> {
    // Examples: "-9.990kHz/+9.990kHz", "-9999Hz/+9999Hz"
    let plus_part = raw.split('/').nth(1).unwrap_or(raw).trim();
    let lower = plus_part.to_ascii_lowercase();
    if let Some(num) = lower.strip_suffix("khz") {
        num.trim()
            .trim_start_matches('+')
            .parse::<f64>()
            .ok()
            .map(|k| (k * 1000.0).round() as i32)
            .filter(|&hz| hz > 0)
    } else if let Some(num) = lower.strip_suffix("hz") {
        num.trim()
            .trim_start_matches('+')
            .parse::<f64>()
            .ok()
            .map(|h| h.round() as i32)
            .filter(|&hz| hz > 0)
    } else {
        None
    }
}

pub fn parse_rigctl_caps(model_id: i64, stdout: &str) -> RigCapabilities {
    let mut modes = Vec::new();
    let mut vfos = Vec::new();
    let mut preamp_db = Vec::new();
    let mut att_db = Vec::new();
    let mut agc_levels = Vec::new();
    let mut get_levels = Vec::new();
    let mut set_levels = Vec::new();
    let mut get_funcs = Vec::new();
    let mut set_funcs = Vec::new();
    let mut vfo_ops = Vec::new();
    let mut max_rit_hz = None;
    let mut max_xit_hz = None;
    let mut targetable_vfo = false;

    for line in stdout.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("Mode list:") {
            for tok in rest.split_whitespace() {
                let m = tok.trim().to_ascii_uppercase();
                if !m.is_empty() && !modes.contains(&m) {
                    modes.push(m);
                }
            }
        } else if let Some(rest) = trimmed.strip_prefix("VFO list:") {
            if vfos.is_empty() {
                for tok in rest.split_whitespace() {
                    let v = tok.trim().to_string();
                    if !v.is_empty() && v != "currVFO" && !vfos.contains(&v) {
                        vfos.push(v);
                    }
                }
            }
        } else if let Some(rest) = trimmed.strip_prefix("Preamp:") {
            preamp_db = parse_db_steps(rest);
        } else if let Some(rest) = trimmed.strip_prefix("Attenuator:") {
            att_db = parse_db_steps(rest);
        } else if let Some(rest) = trimmed.strip_prefix("AGC levels:") {
            for tok in rest.split_whitespace() {
                if let Some((num_s, lbl)) = tok.split_once('=') {
                    if let Ok(value) = num_s.trim().parse::<i32>() {
                        agc_levels.push(AgcLevelOption {
                            value,
                            label: lbl.trim().to_string(),
                        });
                    }
                }
            }
        } else if let Some(rest) = trimmed.strip_prefix("Get level:") {
            get_levels = parse_curated_token_list(rest, CURATED_LEVELS);
        } else if let Some(rest) = trimmed.strip_prefix("Set level:") {
            set_levels = parse_curated_token_list(rest, WRITABLE_LEVELS);
        } else if let Some(rest) = trimmed.strip_prefix("Get functions:") {
            get_funcs = parse_curated_token_list(rest, CURATED_FUNCS);
        } else if let Some(rest) = trimmed.strip_prefix("Set functions:") {
            set_funcs = parse_curated_token_list(rest, CURATED_FUNCS);
        } else if let Some(rest) = trimmed.strip_prefix("VFO Ops:") {
            vfo_ops = parse_curated_token_list(rest, CURATED_VFO_OPS);
        } else if let Some(rest) = trimmed.strip_prefix("Max RIT:") {
            max_rit_hz = parse_max_rit_xit_hz(rest);
        } else if let Some(rest) = trimmed.strip_prefix("Max XIT:") {
            max_xit_hz = parse_max_rit_xit_hz(rest);
        } else if let Some(rest) = trimmed.strip_prefix("Has targetable VFO:") {
            targetable_vfo = rest.trim().eq_ignore_ascii_case("Y");
        }
    }

    let has_split = vfos.len() > 1 || targetable_vfo || stdout.contains("Can set Split");
    RigCapabilities {
        model_id,
        modes,
        vfos,
        preamp_db,
        att_db,
        agc_levels,
        get_levels,
        set_levels,
        get_funcs,
        set_funcs,
        vfo_ops,
        max_rit_hz,
        max_xit_hz,
        has_split,
    }
}

pub fn load_hamlib_models(rigctl_bin: &str) -> Vec<HamlibModelEntry> {
    if let Ok(out) = std::process::Command::new(rigctl_bin).arg("-l").output() {
        if out.status.success() {
            let parsed = parse_rigctl_list(&String::from_utf8_lossy(&out.stdout));
            if !parsed.is_empty() {
                return parsed;
            }
        }
    }
    fallback_hamlib_models()
}

pub fn parse_rigctl_list(stdout: &str) -> Vec<HamlibModelEntry> {
    let mut lines = stdout.lines();
    let mut mfg_col: Option<usize> = None;
    let mut model_col: Option<usize> = None;
    let mut ver_col: Option<usize> = None;

    for header in lines.by_ref() {
        if header.contains("Rig #") && header.contains("Mfg") && header.contains("Model") {
            mfg_col = header.find("Mfg");
            model_col = header.find("Model");
            ver_col = header.find("Version");
            break;
        }
    }

    let mut models = Vec::new();
    for line in lines {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let tokens: Vec<&str> = trimmed.split_whitespace().collect();
        if tokens.len() < 5 {
            continue;
        }
        let Ok(id) = tokens[0].parse::<i64>() else {
            continue;
        };
        let status = tokens[tokens.len() - 2].to_string();

        let (manufacturer, model) = match (mfg_col, model_col, ver_col) {
            (Some(mc), Some(mdc), Some(vc)) if line.len() >= vc => {
                let mfg = line[mc..mdc].trim().to_string();
                let mdl = line[mdc..vc].trim().to_string();
                (mfg, mdl)
            }
            _ => {
                let mfg = tokens[1].to_string();
                let mdl = tokens[2..tokens.len() - 3].join(" ");
                (mfg, mdl)
            }
        };

        if !manufacturer.is_empty() && !model.is_empty() {
            models.push(HamlibModelEntry {
                id,
                manufacturer,
                model,
                status,
            });
        }
    }
    models
}

fn fallback_hamlib_models() -> Vec<HamlibModelEntry> {
    vec![
        HamlibModelEntry {
            id: 1,
            manufacturer: "Hamlib".into(),
            model: "Dummy".into(),
            status: "Stable".into(),
        },
        HamlibModelEntry {
            id: 2016,
            manufacturer: "Kenwood".into(),
            model: "TS-570S".into(),
            status: "Stable".into(),
        },
        HamlibModelEntry {
            id: 2031,
            manufacturer: "Kenwood".into(),
            model: "TS-590S".into(),
            status: "Stable".into(),
        },
        HamlibModelEntry {
            id: 3073,
            manufacturer: "Icom".into(),
            model: "IC-7300".into(),
            status: "Stable".into(),
        },
        HamlibModelEntry {
            id: 3085,
            manufacturer: "Icom".into(),
            model: "IC-705".into(),
            status: "Stable".into(),
        },
        HamlibModelEntry {
            id: 1035,
            manufacturer: "Yaesu".into(),
            model: "FT-991".into(),
            status: "Stable".into(),
        },
        HamlibModelEntry {
            id: 1042,
            manufacturer: "Yaesu".into(),
            model: "FTDX-10".into(),
            status: "Stable".into(),
        },
        HamlibModelEntry {
            id: 2045,
            manufacturer: "Elecraft".into(),
            model: "KX3".into(),
            status: "Stable".into(),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_profile(is_dummy: bool) -> RadioProfile {
        RadioProfile {
            radio_id: "rad_test".to_string(),
            name: "Test Rig".to_string(),
            hamlib_model: if is_dummy { 1 } else { 3073 },
            is_dummy,
            serial_device_key: if is_dummy {
                None
            } else {
                Some("/dev/serial/by-id/usb-IC7300".to_string())
            },
            serial_baud_rate: 19200,
            civ_address: if is_dummy {
                None
            } else {
                Some("94".to_string())
            },
            ptt_method: "cat".to_string(),
            rig_options_json: r#"{"dtr_state":"OFF"}"#.to_string(),
            audio_device_uid: None,
            audio_device_name: None,
            audio_rx_channel: "mono".to_string(),
            audio_tx_gain_db: -6.0,
            rigctld_port: 4532,
            auto_connect: true,
            last_dial_freq_hz: None,
            created_at_utc: "2026-11-21T00:00:00Z".to_string(),
            updated_at_utc: "2026-11-21T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn builds_dummy_and_real_rigctld_args() {
        let dummy = build_rigctld_args(&sample_profile(true), None).unwrap();
        assert_eq!(
            dummy,
            vec![
                "-m",
                "1",
                "-t",
                "4532",
                "-T",
                "127.0.0.1",
                "-P",
                "RIG",
                "-C",
                "dtr_state=OFF"
            ]
        );

        let mut real_prof = sample_profile(false);
        real_prof.rig_options_json = "{}".to_string();
        let real = build_rigctld_args(&real_prof, Some("/dev/serial/by-id/usb-IC7300")).unwrap();
        assert_eq!(
            real,
            vec![
                "-m",
                "3073",
                "-t",
                "4532",
                "-T",
                "127.0.0.1",
                "-r",
                "/dev/serial/by-id/usb-IC7300",
                "-s",
                "19200",
                "-c",
                "0x94",
                "-P",
                "RIG",
                "-C",
                "dtr_state=OFF",
                "-C",
                "rts_state=OFF",
            ]
        );

        // RTS PTT defaults only dtr_state=OFF; DTR PTT defaults only rts_state=OFF
        let mut rts_prof = real_prof.clone();
        rts_prof.ptt_method = "rts".to_string();
        let rts_args = build_rigctld_args(&rts_prof, Some("/dev/serial/by-id/usb-IC7300")).unwrap();
        assert!(rts_args.contains(&"dtr_state=OFF".to_string()));
        assert!(!rts_args.contains(&"rts_state=OFF".to_string()));

        let mut dtr_prof = real_prof.clone();
        dtr_prof.ptt_method = "dtr".to_string();
        let dtr_args = build_rigctld_args(&dtr_prof, Some("/dev/serial/by-id/usb-IC7300")).unwrap();
        assert!(dtr_args.contains(&"rts_state=OFF".to_string()));
        assert!(!dtr_args.contains(&"dtr_state=OFF".to_string()));

        assert_eq!(normalize_civ_address("94"), "0x94");
        assert_eq!(normalize_civ_address("0xA4"), "0xA4");
        assert_eq!(normalize_civ_address("148"), "148");

        assert!(build_rigctld_args(&sample_profile(false), None).is_err());
    }

    #[test]
    fn parses_rigctl_list_table() {
        let sample = "\
 Rig #  Mfg                    Model                   Version         Status      Macro
     1  Hamlib                 Dummy                   20221128.0      Stable      RIG_MODEL_DUMMY
  1004  Yaesu                  MARK-V FT-1000MP        20230104.0      Stable      RIG_MODEL_FT1000MPMKV
  2016  Kenwood                TS-570S                 20230318.2      Stable      RIG_MODEL_TS570S
  3073  Icom                   IC-7300                 20230109.10     Stable      RIG_MODEL_IC7300
";
        let parsed = parse_rigctl_list(sample);
        assert_eq!(parsed.len(), 4);
        assert_eq!(parsed[0].id, 1);
        assert_eq!(parsed[1].model, "MARK-V FT-1000MP");
        assert_eq!(parsed[2].id, 2016);
        assert_eq!(parsed[3].manufacturer, "Icom");
    }

    #[test]
    fn classifies_powered_off_vs_fault_errors() {
        let pwr_err = RigctldError::RadioPoweredOff("off".into());
        assert!(is_cat_powered_off_error(&pwr_err, false, true));
        assert!(is_cat_powered_off_error(&pwr_err, true, false));

        let rprt_20 = RigctldError::HamlibError {
            cmd: "+f".into(),
            code: -20,
        };
        assert!(is_cat_powered_off_error(&rprt_20, false, true));
        assert!(is_cat_powered_off_error(&rprt_20, true, false));

        let rprt_5 = RigctldError::HamlibError {
            cmd: "+f".into(),
            code: -5,
        };
        assert!(is_cat_powered_off_error(&rprt_5, false, true));
        assert!(!is_cat_powered_off_error(&rprt_5, true, true));
        assert!(!is_cat_powered_off_error(&rprt_5, false, false));

        let timeout_err = RigctldError::Timeout("+f".into());
        assert!(is_cat_powered_off_error(&timeout_err, false, true));
        assert!(!is_cat_powered_off_error(&timeout_err, true, true));
        assert!(!is_cat_powered_off_error(&timeout_err, false, false));

        let io_err = RigctldError::HamlibError {
            cmd: "+f".into(),
            code: -6,
        };
        assert!(!is_cat_powered_off_error(&io_err, false, true));
        assert!(!is_cat_powered_off_error(
            &RigctldError::PermissionDenied("denied".into()),
            false,
            true
        ));
        assert!(!is_cat_powered_off_error(
            &RigctldError::PortBusy(4532),
            false,
            true
        ));
        assert!(!is_cat_powered_off_error(
            &RigctldError::ExitedEarly("crash".into()),
            false,
            false
        ));
    }

    #[cfg(unix)]
    #[test]
    fn checks_serial_rw_access_without_opening() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("mock_tty");
        std::fs::write(&file_path, b"").unwrap();
        std::fs::set_permissions(&file_path, std::fs::Permissions::from_mode(0o600)).unwrap();

        let path_str = file_path.to_str().unwrap();
        assert!(check_serial_rw_access(path_str).is_ok());

        // SAFETY: geteuid() is always safe to call.
        if unsafe { libc::geteuid() } != 0 {
            std::fs::set_permissions(&file_path, std::fs::Permissions::from_mode(0o000)).unwrap();
            let res = check_serial_rw_access(path_str);
            std::fs::set_permissions(&file_path, std::fs::Permissions::from_mode(0o600)).unwrap();
            assert!(matches!(res, Err(RigctldError::PermissionDenied(_))));
        }
    }

    #[test]
    fn parses_ts570_and_ic7300_rigctl_caps() {
        let ts570 = "\
Model name:\tTS-570S
Max RIT: -9.990kHz/+9.990kHz
Max XIT: -9.990kHz/+9.990kHz
Preamp: 12dB
Attenuator: 18dB
AGC levels: 2=FAST 3=SLOW
Get functions: FAGC NB COMP VOX TONE TSQL NR LOCK BC TUNER 
Set functions: FAGC NB COMP VOX TONE TSQL NR LOCK BC TUNER 
VFO Ops: UP DOWN 
Get level: PREAMP(10..20/10) ATT(12..12/0) AF(0..1/0.0039) RF(0..1/0.0039) RFPOWER(0.05..1/0.01) STRENGTH(0..60/0) 
Set level: PREAMP(10..20/10) ATT(12..12/0) AF(0..1/0.0039) RF(0..1/0.0039) RFPOWER(0.05..1/0.01) 
Mode list: AM CW USB LSB RTTY FM 
VFO list: VFOA VFOB 
";
        let caps = parse_rigctl_caps(2016, ts570);
        assert_eq!(caps.modes, vec!["AM", "CW", "USB", "LSB", "RTTY", "FM"]);
        assert_eq!(caps.vfos, vec!["VFOA", "VFOB"]);
        assert_eq!(caps.preamp_db, vec![0, 12]);
        assert_eq!(caps.att_db, vec![0, 18]);
        assert_eq!(caps.agc_levels.len(), 2);
        assert_eq!(caps.max_rit_hz, Some(9990));
        assert!(caps.set_funcs.contains(&"TUNER".to_string()));
        assert!(!caps.vfo_ops.contains(&"TUNE".to_string()));
        assert!(caps.set_levels.contains(&"RFPOWER".to_string()));
        assert!(caps.get_levels.contains(&"STRENGTH".to_string()));
        assert!(!caps.set_levels.contains(&"STRENGTH".to_string()));

        let ic7300 = "\
Model name:\tIC-7300
Preamp: 1dB 2dB
Attenuator: 20dB
Get functions: NB COMP TUNER 
Set functions: NB COMP TUNER 
VFO Ops: CPY XCHG FROM_VFO TO_VFO MCL TUNE 
Mode list: AM CW USB LSB RTTY FM CWR RTTYR PKTLSB PKTUSB FM-D AM-D 
VFO list: VFOA VFOB MEM 
";
        let ic_caps = parse_rigctl_caps(3073, ic7300);
        assert!(ic_caps.modes.contains(&"PKTUSB".to_string()));
        assert_eq!(ic_caps.preamp_db, vec![0, 1, 2]);
        assert!(ic_caps.vfo_ops.contains(&"TUNE".to_string()));
        assert!(ic_caps.get_funcs.contains(&"TUNER".to_string()));
        assert!(ic_caps.set_funcs.contains(&"TUNER".to_string()));
    }

    #[tokio::test]
    async fn dummy_rigctld_settings_round_trip() {
        let Ok(listener) = std::net::TcpListener::bind("127.0.0.1:0") else {
            return;
        };
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let mut prof = sample_profile(true);
        prof.rigctld_port = port;
        let cancel = CancellationToken::new();
        let Ok((proc_handle, mut client)) =
            RigctldProcess::spawn_and_connect("rigctld", &prof, None, &cancel).await
        else {
            return;
        };

        assert!(client.get_vfo().await.unwrap().is_some());
        client.set_vfo("VFOB").await.unwrap();
        assert_eq!(client.get_vfo().await.unwrap().as_deref(), Some("VFOB"));

        client.set_split(true, "VFOA").await.unwrap();
        assert_eq!(
            client.get_split().await.unwrap(),
            Some((true, Some("VFOA".to_string())))
        );

        client.set_level("RFPOWER", 0.5).await.unwrap();
        let pwr = client.get_level("RFPOWER").await.unwrap().unwrap();
        assert!((pwr - 0.5).abs() < 0.01);
        let mw = client.power2mw(0.5, 14_074_000, "USB").await.unwrap();
        assert_eq!(mw, Some(50_000));

        client.set_func("TUNER", true).await.unwrap();
        assert_eq!(client.get_func("TUNER").await.unwrap(), Some(true));
        client.vfo_op("TUNE").await.unwrap();

        proc_handle.shutdown_gracefully(Some(&mut client)).await;
    }
}
