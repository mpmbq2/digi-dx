use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};
use tokio::time::{sleep_until, timeout, Instant};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::audio::dsp::FT8_SAMPLE_RATE;
use crate::domain::clock::UnixSecs;
use crate::modem::{
    DecodePassOptions, Ft8Decode, Ft8Decoder, ModemError, ModemMode, QsoDecodeContext,
};
use crate::preflight::resolve_executable;

pub const FTXR_MAGIC: [u8; 4] = *b"FTXR";
pub const FTXR_IPC_VERSION: u16 = 1;
pub const FLAG_HAS_BINARY: u16 = 0x0001;
pub const FLAG_BINARY_F32LE: u16 = 0x0002;

const MAX_JSON_BYTES: usize = 1024 * 1024;
const MAX_PAYLOAD_BYTES: usize = 64 * 1024 * 1024;
const MAX_TOTAL_FRAME_BYTES: usize = 64 * 1024 * 1024;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const CONTROL_OP_TIMEOUT: Duration = Duration::from_secs(5);
const ENCODE_TX_TIMEOUT: Duration = Duration::from_secs(5);
const CANCEL_DRAIN_TIMEOUT: Duration = Duration::from_millis(200);
const WORKER_TIMEOUT_MARGIN: Duration = Duration::from_millis(600);

pub const FTXR_FALLBACK_PATHS: &[&str] = &[
    "/opt/homebrew/opt/digi-dx/libexec/ftxr-modem",
    "/usr/local/opt/digi-dx/libexec/ftxr-modem",
    "/opt/homebrew/lib/digi-dx/ftxr-modem",
    "/usr/local/lib/digi-dx/ftxr-modem",
    "/usr/lib/digi-dx/ftxr-modem",
    "/opt/homebrew/bin/ftxr-modem",
    "/usr/local/bin/ftxr-modem",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FtxrBinaryInfo {
    pub path: PathBuf,
    pub version: String,
    pub ipc_protocol_version: u16,
}

#[derive(Debug, Deserialize)]
struct VersionProbeJson {
    #[serde(default)]
    name: Option<String>,
    version: String,
    ipc_protocol_version: u16,
}

fn find_ftxr_relative_to_exe(exe_path: &Path) -> Option<PathBuf> {
    let dir = exe_path.parent()?;
    let mut candidates = vec![dir.join("ftxr-modem"), dir.join("libexec/ftxr-modem")];
    if let Some(prefix_dir) = dir.parent() {
        candidates.push(prefix_dir.join("libexec/ftxr-modem"));
        candidates.push(prefix_dir.join("lib/digi-dx/ftxr-modem"));
    }
    for candidate in candidates {
        if let Some(found) = resolve_executable("ftxr-modem", Some(&candidate), &[]) {
            return Some(found);
        }
    }
    None
}

/// Locate the `ftxr-modem` executable using:
/// 1. Explicit override path (`DIGI_DX_FTXR_PATH`) if provided
/// 2. Co-bundled sidecar binary relative to the running `digi-dx` executable
///    (`ftxr-modem`, `libexec/ftxr-modem`, `../libexec/ftxr-modem`, `../lib/digi-dx/ftxr-modem`)
/// 3. Standard Homebrew/system directories and `PATH`
pub fn find_ftxr_candidate(override_path: Option<&Path>) -> Option<PathBuf> {
    if override_path.is_some() {
        return resolve_executable("ftxr-modem", override_path, &[]);
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(found) = find_ftxr_relative_to_exe(&exe) {
            return Some(found);
        }
    }

    resolve_executable("ftxr-modem", None, FTXR_FALLBACK_PATHS)
}

/// Verify that `bin_path` is a runnable `ftxr-modem` supporting IPC v1.
pub fn verify_ftxr_binary(bin_path: &Path) -> Result<FtxrBinaryInfo, String> {
    let out = StdCommand::new(bin_path)
        .args(["--version", "--json"])
        .output()
        .map_err(|e| format!("failed to launch {}: {e}", bin_path.display()))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!(
            "{} exited with {}: {}",
            bin_path.display(),
            out.status,
            stderr
        ));
    }

    let parsed: VersionProbeJson = serde_json::from_slice(&out.stdout).map_err(|e| {
        format!(
            "{} returned unexpected --version --json output: {e}",
            bin_path.display()
        )
    })?;

    if let Some(ref name) = parsed.name {
        if name != "ftxr-modem" {
            return Err(format!(
                "{} reported unexpected binary name '{name}'",
                bin_path.display()
            ));
        }
    }

    if parsed.ipc_protocol_version != FTXR_IPC_VERSION {
        return Err(format!(
            "{} supports IPC v{}, but Digi-Dx requires IPC v{}",
            bin_path.display(),
            parsed.ipc_protocol_version,
            FTXR_IPC_VERSION
        ));
    }

    Ok(FtxrBinaryInfo {
        path: bin_path.to_path_buf(),
        version: parsed.version,
        ipc_protocol_version: parsed.ipc_protocol_version,
    })
}

/// Resolve and verify an executable `ftxr-modem` binary.
pub fn resolve_ftxr_binary(override_path: Option<&Path>) -> Option<FtxrBinaryInfo> {
    let candidate = find_ftxr_candidate(override_path)?;
    verify_ftxr_binary(&candidate).ok()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawIpcFrame {
    pub version: u16,
    pub flags: u16,
    pub json: Vec<u8>,
    pub payload: Vec<u8>,
}

pub async fn write_frame_async<W: AsyncWrite + Unpin>(
    writer: &mut W,
    flags: u16,
    json: &[u8],
    payload: &[u8],
) -> io::Result<()> {
    if json.is_empty()
        || json.len() > MAX_JSON_BYTES
        || payload.len() > MAX_PAYLOAD_BYTES
        || json.len().saturating_add(payload.len()) > MAX_TOTAL_FRAME_BYTES
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "FTXR frame size out of bounds (json={}, payload={})",
                json.len(),
                payload.len()
            ),
        ));
    }
    let eff_flags = flags
        | if payload.is_empty() {
            0
        } else {
            FLAG_HAS_BINARY
        };
    let mut hdr = [0u8; 16];
    hdr[0..4].copy_from_slice(&FTXR_MAGIC);
    hdr[4..6].copy_from_slice(&FTXR_IPC_VERSION.to_le_bytes());
    hdr[6..8].copy_from_slice(&eff_flags.to_le_bytes());
    hdr[8..12].copy_from_slice(&(json.len() as u32).to_le_bytes());
    hdr[12..16].copy_from_slice(&(payload.len() as u32).to_le_bytes());

    writer.write_all(&hdr).await?;
    writer.write_all(json).await?;
    if !payload.is_empty() {
        writer.write_all(payload).await?;
    }
    writer.flush().await
}

pub async fn read_frame_async<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> io::Result<Option<RawIpcFrame>> {
    let mut hdr = [0u8; 16];
    let mut read = 0usize;
    while read < 16 {
        let n = reader.read(&mut hdr[read..]).await?;
        if n == 0 {
            if read == 0 {
                return Ok(None);
            }
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                format!("truncated FTXR header ({read}/16 bytes)"),
            ));
        }
        read += n;
    }

    if hdr[0..4] != FTXR_MAGIC {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid FTXR magic {:?}", &hdr[0..4]),
        ));
    }

    let version = u16::from_le_bytes([hdr[4], hdr[5]]);
    let flags = u16::from_le_bytes([hdr[6], hdr[7]]);
    let json_len = u32::from_le_bytes([hdr[8], hdr[9], hdr[10], hdr[11]]) as usize;
    let payload_len = u32::from_le_bytes([hdr[12], hdr[13], hdr[14], hdr[15]]) as usize;

    if json_len == 0 || json_len > MAX_JSON_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid FTXR json_len {json_len}"),
        ));
    }
    if payload_len > MAX_PAYLOAD_BYTES
        || json_len.saturating_add(payload_len) > MAX_TOTAL_FRAME_BYTES
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("oversized FTXR frame (json={json_len}, payload={payload_len})"),
        ));
    }

    let mut json = vec![0u8; json_len];
    reader.read_exact(&mut json).await?;

    let mut payload = vec![0u8; payload_len];
    if payload_len > 0 {
        reader.read_exact(&mut payload).await?;
    }

    Ok(Some(RawIpcFrame {
        version,
        flags,
        json,
        payload,
    }))
}

#[derive(Debug, Clone, Deserialize)]
struct WireDecode {
    snr_db: i8,
    dt_sec: f32,
    af_hz: f32,
    message: String,
    #[serde(default)]
    raw_metadata: Option<String>,
}

impl WireDecode {
    fn into_ft8_decode(self, slot_ts: UnixSecs) -> Option<Ft8Decode> {
        let normalized_msg = self
            .message
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if normalized_msg.is_empty() {
            return None;
        }
        let meta = self
            .raw_metadata
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty());
        Some(Ft8Decode {
            slot_ts,
            snr_db: self.snr_db.clamp(-50, 49),
            dt_sec: if self.dt_sec.is_finite() {
                self.dt_sec
            } else {
                0.0
            },
            af_hz: if self.af_hz.is_finite() {
                self.af_hz.round().clamp(0.0, 5000.0) as u16
            } else {
                1500
            },
            message: normalized_msg,
            raw_metadata: meta,
            decoder_backend: "ftxr".to_string(),
        })
    }
}

#[derive(Debug, Clone)]
enum DecodeCompletion {
    Completed,
    Cancelled,
    Timeout,
    Error(String),
}

struct PendingDecode {
    events_tx: mpsc::UnboundedSender<WireDecode>,
    done_tx: oneshot::Sender<DecodeCompletion>,
}

#[derive(Default)]
struct PendingDispatch {
    decodes: HashMap<String, PendingDecode>,
    encodes: HashMap<String, oneshot::Sender<Result<Vec<f32>, ModemError>>>,
    acks: HashMap<String, oneshot::Sender<Result<(), ModemError>>>,
}

impl PendingDispatch {
    fn fail_all(&mut self, reason: &str) {
        for (_, p) in self.decodes.drain() {
            let _ = p.done_tx.send(DecodeCompletion::Error(reason.to_string()));
        }
        for (_, tx) in self.encodes.drain() {
            let _ = tx.send(Err(ModemError::EncodeFailed(reason.to_string())));
        }
        for (_, tx) in self.acks.drain() {
            let _ = tx.send(Err(ModemError::DecodeFailed(reason.to_string())));
        }
    }
}

struct OutboundFrame {
    flags: u16,
    json: Vec<u8>,
    payload: Vec<u8>,
}

struct WorkerHandle {
    outbound_tx: mpsc::UnboundedSender<OutboundFrame>,
    pending: Arc<AsyncMutex<PendingDispatch>>,
    alive: Arc<AtomicBool>,
    child: Arc<AsyncMutex<Option<Child>>>,
    reader_task: tokio::task::JoinHandle<()>,
    writer_task: tokio::task::JoinHandle<()>,
    stderr_task: tokio::task::JoinHandle<()>,
}

impl WorkerHandle {
    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire) && !self.outbound_tx.is_closed()
    }

    async fn spawn(bin_path: &Path, threads: Option<usize>) -> Result<Self, ModemError> {
        let mut cmd = Command::new(bin_path);
        cmd.arg("--worker")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(n) = threads {
            cmd.arg("--threads").arg(n.to_string());
        }

        let mut child = cmd.spawn().map_err(|e| {
            ModemError::DecodeFailed(format!(
                "failed to spawn ftxr-modem worker at {}: {e}",
                bin_path.display()
            ))
        })?;

        let mut stdin = child.stdin.take().ok_or_else(|| {
            ModemError::DecodeFailed("ftxr-modem worker stdin pipe unavailable".to_string())
        })?;
        let mut stdout = child.stdout.take().ok_or_else(|| {
            ModemError::DecodeFailed("ftxr-modem worker stdout pipe unavailable".to_string())
        })?;
        let stderr = child.stderr.take();

        let stderr_task = tokio::spawn(async move {
            if let Some(s) = stderr {
                let mut lines = BufReader::new(s).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        debug!(target: "ftxr_modem_worker", "{trimmed}");
                    }
                }
            }
        });

        let hello_json = serde_json::to_vec(&json!({
            "op": "hello",
            "id": "init-0",
            "protocol_version": FTXR_IPC_VERSION,
            "client": "digi-dx",
            "client_name": "digi-dx",
            "client_version": env!("CARGO_PKG_VERSION"),
            "threads": threads,
            "enable_telemetry_default": false,
        }))
        .expect("serialize hello");

        timeout(
            HANDSHAKE_TIMEOUT,
            write_frame_async(&mut stdin, 0, &hello_json, &[]),
        )
        .await
        .map_err(|_| ModemError::DecodeFailed("ftxr-modem handshake write timed out".to_string()))?
        .map_err(|e| ModemError::DecodeFailed(format!("ftxr-modem handshake write failed: {e}")))?;

        let ready_frame = timeout(HANDSHAKE_TIMEOUT, read_frame_async(&mut stdout))
            .await
            .map_err(|_| {
                ModemError::DecodeFailed("ftxr-modem worker handshake timed out".to_string())
            })?
            .map_err(|e| {
                ModemError::DecodeFailed(format!("ftxr-modem handshake read failed: {e}"))
            })?
            .ok_or_else(|| {
                ModemError::DecodeFailed(
                    "ftxr-modem worker closed stdout before ready handshake".to_string(),
                )
            })?;

        let ready_val: Value = serde_json::from_slice(&ready_frame.json).map_err(|e| {
            ModemError::DecodeFailed(format!("invalid JSON in ftxr-modem ready frame: {e}"))
        })?;

        match ready_val.get("op").and_then(Value::as_str) {
            Some("ready") => {
                let version = ready_val
                    .get("version")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let worker_threads = ready_val
                    .get("threads")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                info!(
                    bin = %bin_path.display(),
                    version,
                    threads = worker_threads,
                    "ftxr-modem persistent warm IPC worker ready"
                );
            }
            Some("error") => {
                let msg = ready_val
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown handshake error");
                let _ = child.kill().await;
                let _ = child.wait().await;
                stderr_task.abort();
                return Err(ModemError::DecodeFailed(format!(
                    "ftxr-modem rejected handshake: {msg}"
                )));
            }
            other => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                stderr_task.abort();
                return Err(ModemError::DecodeFailed(format!(
                    "unexpected first frame from ftxr-modem: {other:?}"
                )));
            }
        }

        let alive = Arc::new(AtomicBool::new(true));
        let pending = Arc::new(AsyncMutex::new(PendingDispatch::default()));
        let child_arc = Arc::new(AsyncMutex::new(Some(child)));
        let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<OutboundFrame>();

        let alive_w = Arc::clone(&alive);
        let pending_w = Arc::clone(&pending);
        let writer_task = tokio::spawn(async move {
            while let Some(frame) = outbound_rx.recv().await {
                if let Err(e) =
                    write_frame_async(&mut stdin, frame.flags, &frame.json, &frame.payload).await
                {
                    alive_w.store(false, Ordering::Release);
                    let mut guard = pending_w.lock().await;
                    guard.fail_all(&format!("ftxr-modem stdin write failed: {e}"));
                    break;
                }
            }
            let _ = stdin.shutdown().await;
        });

        let alive_r = Arc::clone(&alive);
        let pending_r = Arc::clone(&pending);
        let reader_task = tokio::spawn(async move {
            loop {
                let frame = match read_frame_async(&mut stdout).await {
                    Ok(Some(f)) => f,
                    Ok(None) => {
                        alive_r.store(false, Ordering::Release);
                        let mut guard = pending_r.lock().await;
                        guard.fail_all("ftxr-modem worker closed stdout");
                        break;
                    }
                    Err(e) => {
                        alive_r.store(false, Ordering::Release);
                        let mut guard = pending_r.lock().await;
                        guard.fail_all(&format!("ftxr-modem stdout frame error: {e}"));
                        break;
                    }
                };

                let val: Value = match serde_json::from_slice(&frame.json) {
                    Ok(v) => v,
                    Err(e) => {
                        warn!(error = %e, "ignoring malformed JSON frame from ftxr-modem");
                        continue;
                    }
                };

                let op = val.get("op").and_then(Value::as_str).unwrap_or("");
                match op {
                    "decode_event" => {
                        if let (Some(id), Some(dec_val)) =
                            (val.get("id").and_then(Value::as_str), val.get("decode"))
                        {
                            if let Ok(wire) = serde_json::from_value::<WireDecode>(dec_val.clone())
                            {
                                let guard = pending_r.lock().await;
                                if let Some(entry) = guard.decodes.get(id) {
                                    let _ = entry.events_tx.send(wire);
                                }
                            }
                        }
                    }
                    "decode_done" => {
                        if let Some(id) = val.get("id").and_then(Value::as_str) {
                            let status = val
                                .get("status")
                                .and_then(Value::as_str)
                                .unwrap_or("completed");
                            let completion = match status {
                                "completed" => DecodeCompletion::Completed,
                                "cancelled" => DecodeCompletion::Cancelled,
                                "timeout" => DecodeCompletion::Timeout,
                                other => DecodeCompletion::Error(format!(
                                    "unexpected decode_done status '{other}'"
                                )),
                            };
                            let mut guard = pending_r.lock().await;
                            if let Some(entry) = guard.decodes.remove(id) {
                                let _ = entry.done_tx.send(completion);
                            }
                        }
                    }
                    "encode_result" => {
                        if let Some(id) = val.get("id").and_then(Value::as_str) {
                            let format = val
                                .get("sample_format")
                                .and_then(Value::as_str)
                                .unwrap_or("f32le");
                            let decoded = decode_pcm_payload(&frame.payload, format);
                            let mut guard = pending_r.lock().await;
                            if let Some(tx) = guard.encodes.remove(id) {
                                let _ = tx.send(decoded);
                            }
                        }
                    }
                    "ok" | "pong" => {
                        if let Some(id) = val.get("id").and_then(Value::as_str) {
                            let mut guard = pending_r.lock().await;
                            if let Some(tx) = guard.acks.remove(id) {
                                let _ = tx.send(Ok(()));
                            }
                        }
                    }
                    "cancel_ack" => {}
                    "error" => {
                        let fatal = val.get("fatal").and_then(Value::as_bool).unwrap_or(false);
                        let code = val.get("code").and_then(Value::as_str).unwrap_or("error");
                        let message = val
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown worker error");
                        let detail = format!("ftxr-modem {code}: {message}");

                        if fatal {
                            alive_r.store(false, Ordering::Release);
                            let mut guard = pending_r.lock().await;
                            guard.fail_all(&detail);
                            break;
                        } else if let Some(id) = val.get("id").and_then(Value::as_str) {
                            let mut guard = pending_r.lock().await;
                            if let Some(entry) = guard.decodes.remove(id) {
                                let _ = entry.done_tx.send(DecodeCompletion::Error(detail.clone()));
                            }
                            if let Some(tx) = guard.encodes.remove(id) {
                                let _ = tx.send(Err(ModemError::EncodeFailed(detail.clone())));
                            }
                            if let Some(tx) = guard.acks.remove(id) {
                                let _ = tx.send(Err(ModemError::DecodeFailed(detail)));
                            }
                        } else {
                            warn!(detail = %detail, "non-fatal ftxr-modem worker error");
                        }
                    }
                    other => {
                        debug!(op = other, "unhandled ftxr-modem worker op");
                    }
                }
            }
        });

        Ok(Self {
            outbound_tx,
            pending,
            alive,
            child: child_arc,
            reader_task,
            writer_task,
            stderr_task,
        })
    }

    async fn send_frame(&self, frame: OutboundFrame) -> Result<(), ModemError> {
        if !self.is_alive() {
            return Err(ModemError::DecodeFailed(
                "ftxr-modem worker is not running".to_string(),
            ));
        }
        self.outbound_tx.send(frame).map_err(|_| {
            self.alive.store(false, Ordering::Release);
            ModemError::DecodeFailed("ftxr-modem worker channel closed".to_string())
        })
    }

    async fn shutdown(self) {
        self.alive.store(false, Ordering::Release);
        let bye = serde_json::to_vec(&json!({ "op": "shutdown", "id": "bye" })).unwrap_or_default();
        if !bye.is_empty() {
            let _ = self.outbound_tx.send(OutboundFrame {
                flags: 0,
                json: bye,
                payload: Vec::new(),
            });
        }
        drop(self.outbound_tx);

        if let Some(mut child) = self.child.lock().await.take() {
            if timeout(Duration::from_millis(500), child.wait())
                .await
                .is_err()
            {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
        }
        self.reader_task.abort();
        self.writer_task.abort();
        self.stderr_task.abort();
    }
}

fn decode_pcm_payload(bytes: &[u8], sample_format: &str) -> Result<Vec<f32>, ModemError> {
    match sample_format {
        "f32le" => {
            if !bytes.len().is_multiple_of(4) {
                return Err(ModemError::EncodeFailed(format!(
                    "ftxr-modem returned unaligned f32le payload ({} bytes)",
                    bytes.len()
                )));
            }
            let mut out = Vec::with_capacity(bytes.len() / 4);
            for &chunk in bytes.as_chunks::<4>().0 {
                out.push(f32::from_le_bytes(chunk));
            }
            Ok(out)
        }
        "i16le" => {
            if !bytes.len().is_multiple_of(2) {
                return Err(ModemError::EncodeFailed(format!(
                    "ftxr-modem returned unaligned i16le payload ({} bytes)",
                    bytes.len()
                )));
            }
            let mut out = Vec::with_capacity(bytes.len() / 2);
            for &chunk in bytes.as_chunks::<2>().0 {
                let s = i16::from_le_bytes(chunk);
                out.push(f32::from(s) / 32768.0);
            }
            Ok(out)
        }
        other => Err(ModemError::EncodeFailed(format!(
            "unsupported ftxr-modem sample_format '{other}'"
        ))),
    }
}

fn encode_f32le_payload(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 4);
    for &s in samples {
        let finite = if s.is_finite() { s } else { 0.0 };
        bytes.extend_from_slice(&finite.to_le_bytes());
    }
    bytes
}

#[derive(Debug, Serialize)]
struct WireContextPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    my_call: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dx_call: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dx_grid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rx_freq_hz: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tx_freq_hz: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    qso_progress: Option<u8>,
    enable_ap: bool,
}

impl From<&QsoDecodeContext> for WireContextPayload {
    fn from(ctx: &QsoDecodeContext) -> Self {
        Self {
            my_call: ctx.my_call.clone(),
            dx_call: ctx.dx_call.clone(),
            dx_grid: ctx.dx_grid.clone(),
            rx_freq_hz: ctx.rx_freq_hz,
            tx_freq_hz: ctx.tx_freq_hz,
            qso_progress: ctx.qso_progress,
            enable_ap: ctx.enable_ap,
        }
    }
}

struct FtxrWorkerInner {
    bin_path: PathBuf,
    threads: Option<usize>,
    freq_min_hz: f32,
    freq_max_hz: f32,
    freq_tol_hz: f32,
    worker: AsyncMutex<Option<Arc<WorkerHandle>>>,
    /// Serializes RX decode passes cleanly while allowing `encode_tx` to execute concurrently.
    rx_lock: AsyncMutex<()>,
    next_id: AtomicU64,
}

/// Persistent warm stdio IPC v1 client for the standalone GPLv3 `ftxr-modem --worker` process.
#[derive(Clone)]
pub struct FtxrWorkerDecoder {
    inner: Arc<FtxrWorkerInner>,
}

impl std::fmt::Debug for FtxrWorkerDecoder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FtxrWorkerDecoder")
            .field("bin_path", &self.inner.bin_path)
            .field("threads", &self.inner.threads)
            .field("freq_min_hz", &self.inner.freq_min_hz)
            .field("freq_max_hz", &self.inner.freq_max_hz)
            .finish()
    }
}

impl FtxrWorkerDecoder {
    pub fn new(bin_path: PathBuf) -> Self {
        Self {
            inner: Arc::new(FtxrWorkerInner {
                bin_path,
                threads: None,
                freq_min_hz: 200.0,
                freq_max_hz: 3000.0,
                freq_tol_hz: 20.0,
                worker: AsyncMutex::new(None),
                rx_lock: AsyncMutex::new(()),
                next_id: AtomicU64::new(1),
            }),
        }
    }

    pub fn bin_path(&self) -> &Path {
        &self.inner.bin_path
    }

    fn next_op_id(&self, prefix: &str) -> String {
        let seq = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        format!("{prefix}-{seq}")
    }

    async fn get_or_spawn_worker(&self) -> Result<Arc<WorkerHandle>, ModemError> {
        let mut guard = self.inner.worker.lock().await;
        if let Some(ref existing) = *guard {
            if existing.is_alive() {
                return Ok(Arc::clone(existing));
            }
            if let Some(dead) = guard.take() {
                if let Ok(owned) = Arc::try_unwrap(dead) {
                    owned.shutdown().await;
                }
            }
        }
        let spawned =
            Arc::new(WorkerHandle::spawn(&self.inner.bin_path, self.inner.threads).await?);
        *guard = Some(Arc::clone(&spawned));
        Ok(spawned)
    }

    async fn invalidate_worker(&self, failed: &Arc<WorkerHandle>) {
        failed.alive.store(false, Ordering::Release);
        let mut guard = self.inner.worker.lock().await;
        let matches = guard.as_ref().is_some_and(|w| Arc::ptr_eq(w, failed));
        if matches {
            if let Some(old) = guard.take() {
                if let Ok(owned) = Arc::try_unwrap(old) {
                    owned.shutdown().await;
                }
            }
        }
    }

    /// Eagerly spawn and pre-warm FFT plans in the persistent `ftxr-modem --worker`.
    pub async fn warm_up(&self) -> Result<(), ModemError> {
        let _ = self.get_or_spawn_worker().await?;
        Ok(())
    }

    /// Clear `ftxr-modem`'s persistent session callsign hash table (e.g., on session start or QSY).
    pub async fn reset_session(&self) -> Result<(), ModemError> {
        let worker = {
            let guard = self.inner.worker.lock().await;
            match guard.as_ref() {
                Some(w) if w.is_alive() => Arc::clone(w),
                _ => return Ok(()),
            }
        };
        let id = self.next_op_id("rst");
        let (ack_tx, ack_rx) = oneshot::channel();
        {
            let mut pending = worker.pending.lock().await;
            pending.acks.insert(id.clone(), ack_tx);
        }
        let json = serde_json::to_vec(&json!({
            "op": "session_reset",
            "id": id,
        }))
        .expect("serialize session_reset");
        if let Err(e) = worker
            .send_frame(OutboundFrame {
                flags: 0,
                json,
                payload: Vec::new(),
            })
            .await
        {
            worker.pending.lock().await.acks.remove(&id);
            self.invalidate_worker(&worker).await;
            return Err(e);
        }
        match timeout(CONTROL_OP_TIMEOUT, ack_rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => {
                self.invalidate_worker(&worker).await;
                Err(ModemError::DecodeFailed(
                    "ftxr-modem worker dropped session_reset response".to_string(),
                ))
            }
            Err(_) => {
                worker.pending.lock().await.acks.remove(&id);
                self.invalidate_worker(&worker).await;
                Err(ModemError::DecodeFailed(
                    "ftxr-modem session_reset timed out".to_string(),
                ))
            }
        }
    }

    /// Gracefully shut down the persistent `ftxr-modem --worker` subprocess if running.
    pub async fn shutdown(&self) {
        let worker_opt = self.inner.worker.lock().await.take();
        if let Some(worker) = worker_opt {
            worker.alive.store(false, Ordering::Release);
            if let Ok(owned) = Arc::try_unwrap(worker) {
                owned.shutdown().await;
            }
        }
    }

    /// Encode and GFSK-modulate an FT8 or FT4 TX waveform via `ftxr-modem`'s isolated `TXTHR` thread.
    pub async fn encode_tx(
        &self,
        mode: ModemMode,
        message: &str,
        af_hz: f32,
        sample_rate: u32,
        start_delay_ms: Option<u32>,
        offset_ms: u64,
    ) -> Result<Vec<f32>, ModemError> {
        let mut last_err = None;
        for attempt in 0..2 {
            let worker = self.get_or_spawn_worker().await.map_err(|e| {
                ModemError::EncodeFailed(format!("ftxr-modem worker unavailable: {e}"))
            })?;
            match self
                .encode_tx_once(
                    &worker,
                    mode,
                    message,
                    af_hz,
                    sample_rate,
                    start_delay_ms,
                    offset_ms,
                )
                .await
            {
                Ok(pcm) => return Ok(pcm),
                Err(e) => {
                    let retryable = attempt == 0 && !worker.is_alive();
                    if retryable {
                        warn!(error = %e, "ftxr-modem worker exited during encode_tx; respawning once");
                        self.invalidate_worker(&worker).await;
                        last_err = Some(e);
                        continue;
                    }
                    return Err(e);
                }
            }
        }
        Err(last_err.unwrap_or_else(|| ModemError::EncodeFailed("encode_tx failed".to_string())))
    }

    #[allow(clippy::too_many_arguments)]
    async fn encode_tx_once(
        &self,
        worker: &Arc<WorkerHandle>,
        mode: ModemMode,
        message: &str,
        af_hz: f32,
        sample_rate: u32,
        start_delay_ms: Option<u32>,
        offset_ms: u64,
    ) -> Result<Vec<f32>, ModemError> {
        let id = self.next_op_id("tx");
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = worker.pending.lock().await;
            pending.encodes.insert(id.clone(), tx);
        }

        let mut req = json!({
            "op": "encode_tx",
            "id": id,
            "mode": mode.as_str(),
            "message": message,
            "af_hz": af_hz,
            "sample_rate": sample_rate,
            "sample_format": "f32le",
            "offset_ms": offset_ms,
            "pad_to_slot": false,
            "amplitude": 1.0,
        });
        if let Some(delay) = start_delay_ms {
            req["start_delay_ms"] = json!(delay);
        }
        let json_bytes = serde_json::to_vec(&req).expect("serialize encode_tx");

        if let Err(e) = worker
            .send_frame(OutboundFrame {
                flags: 0,
                json: json_bytes,
                payload: Vec::new(),
            })
            .await
        {
            worker.pending.lock().await.encodes.remove(&id);
            self.invalidate_worker(worker).await;
            return Err(ModemError::EncodeFailed(e.to_string()));
        }

        match timeout(ENCODE_TX_TIMEOUT, rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => {
                self.invalidate_worker(worker).await;
                Err(ModemError::EncodeFailed(
                    "ftxr-modem worker disconnected during encode_tx".to_string(),
                ))
            }
            Err(_) => {
                worker.pending.lock().await.encodes.remove(&id);
                self.invalidate_worker(worker).await;
                Err(ModemError::EncodeFailed(
                    "ftxr-modem encode_tx timed out".to_string(),
                ))
            }
        }
    }

    /// Decode a 12 kHz mono slot via the persistent `ftxr-modem --worker`, streaming each
    /// `decode_event` over `on_decode` as soon as it arrives.
    pub async fn decode_slot_streaming(
        &self,
        slot_ts: UnixSecs,
        samples_12k: &[f32],
        opts: DecodePassOptions,
        on_decode: mpsc::UnboundedSender<Ft8Decode>,
        cancel: CancellationToken,
    ) -> Result<Vec<Ft8Decode>, ModemError> {
        if samples_12k.is_empty() || cancel.is_cancelled() {
            return Ok(Vec::new());
        }

        let _rx_guard = self.inner.rx_lock.lock().await;
        if cancel.is_cancelled() {
            return Ok(Vec::new());
        }

        let payload = encode_f32le_payload(samples_12k);
        for attempt in 0..2 {
            let worker = self.get_or_spawn_worker().await?;
            let (res, streamed_any) = self
                .decode_slot_once(&worker, slot_ts, &payload, &opts, &on_decode, &cancel)
                .await;
            match res {
                Ok(decodes) => return Ok(decodes),
                Err(e)
                    if attempt == 0
                        && !streamed_any
                        && !cancel.is_cancelled()
                        && !worker.is_alive() =>
                {
                    warn!(
                        error = %e,
                        "ftxr-modem worker exited during decode_slot; respawning once"
                    );
                    self.invalidate_worker(&worker).await;
                    continue;
                }
                Err(e) => return Err(e),
            }
        }

        Ok(Vec::new())
    }

    async fn decode_slot_once(
        &self,
        worker: &Arc<WorkerHandle>,
        slot_ts: UnixSecs,
        payload: &[u8],
        opts: &DecodePassOptions,
        on_decode: &mpsc::UnboundedSender<Ft8Decode>,
        cancel: &CancellationToken,
    ) -> (Result<Vec<Ft8Decode>, ModemError>, bool) {
        let id = self.next_op_id("dec");
        let slot_id = format!("{}_d{}", slot_ts.0, opts.depth);
        let (events_tx, mut events_rx) = mpsc::unbounded_channel::<WireDecode>();
        let (done_tx, mut done_rx) = oneshot::channel::<DecodeCompletion>();

        {
            let mut pending = worker.pending.lock().await;
            pending
                .decodes
                .insert(id.clone(), PendingDecode { events_tx, done_tx });
        }

        let timeout_ms = opts.timeout.as_millis().max(1) as u64;
        let rx_freq_hz = opts
            .qso_context
            .as_ref()
            .and_then(|c| c.rx_freq_hz)
            .unwrap_or(1500.0);

        let mut req = json!({
            "op": "decode_slot",
            "id": id,
            "slot_id": slot_id,
            "mode": opts.mode.as_str(),
            "depth": opts.depth.clamp(1, 3),
            "freq_min_hz": self.inner.freq_min_hz,
            "freq_max_hz": self.inner.freq_max_hz,
            "rx_freq_hz": rx_freq_hz,
            "freq_tol_hz": self.inner.freq_tol_hz,
            "sample_rate": FT8_SAMPLE_RATE,
            "sample_format": "f32le",
            "early_pass": opts.early_pass,
            "qso_first": true,
            "enable_telemetry": false,
            "timeout_ms": timeout_ms,
        });
        if let Some(ref ctx) = opts.qso_context {
            req["qso_override"] =
                serde_json::to_value(WireContextPayload::from(ctx)).unwrap_or(Value::Null);
        }

        let json_bytes = serde_json::to_vec(&req).expect("serialize decode_slot");
        if let Err(e) = worker
            .send_frame(OutboundFrame {
                flags: FLAG_HAS_BINARY | FLAG_BINARY_F32LE,
                json: json_bytes,
                payload: payload.to_vec(),
            })
            .await
        {
            worker.pending.lock().await.decodes.remove(&id);
            self.invalidate_worker(worker).await;
            return (Err(e), false);
        }

        let hard_deadline = Instant::now() + opts.timeout + WORKER_TIMEOUT_MARGIN;
        let mut collected = Vec::new();
        let mut completion: Option<DecodeCompletion> = None;
        let mut cancelled_locally = false;
        let mut hard_timed_out = false;
        let mut events_open = true;

        loop {
            tokio::select! {
                biased;
                maybe_ev = events_rx.recv(), if events_open => {
                    match maybe_ev {
                        Some(wire) => {
                            if let Some(dec) = wire.into_ft8_decode(slot_ts) {
                                collected.push(dec.clone());
                                let _ = on_decode.send(dec);
                            }
                        }
                        None => {
                            events_open = false;
                        }
                    }
                }
                done_res = &mut done_rx => {
                    completion = Some(match done_res {
                        Ok(c) => c,
                        Err(_) => DecodeCompletion::Error("ftxr-modem worker exited mid-decode".to_string()),
                    });
                    break;
                }
                _ = cancel.cancelled() => {
                    cancelled_locally = true;
                    break;
                }
                _ = sleep_until(hard_deadline) => {
                    hard_timed_out = true;
                    break;
                }
            }
        }

        // Drain any decode_events already queued before decode_done arrived.
        while let Ok(wire) = events_rx.try_recv() {
            if let Some(dec) = wire.into_ft8_decode(slot_ts) {
                collected.push(dec.clone());
                let _ = on_decode.send(dec);
            }
        }

        if cancelled_locally {
            let cancel_json = serde_json::to_vec(&json!({
                "op": "cancel",
                "id": self.next_op_id("can"),
                "target_id": id,
            }))
            .expect("serialize cancel");
            let _ = worker
                .send_frame(OutboundFrame {
                    flags: 0,
                    json: cancel_json,
                    payload: Vec::new(),
                })
                .await;
            let _ = timeout(CANCEL_DRAIN_TIMEOUT, &mut done_rx).await;
            worker.pending.lock().await.decodes.remove(&id);
            let streamed_any = !collected.is_empty();
            return (Ok(collected), streamed_any);
        }

        if hard_timed_out {
            worker.pending.lock().await.decodes.remove(&id);
            self.invalidate_worker(worker).await;
            if !collected.is_empty() {
                warn!(
                    timeout_ms,
                    depth = opts.depth,
                    streamed = collected.len(),
                    "ftxr-modem hard-timed out after streaming partial decodes; keeping received decodes"
                );
                return (Ok(collected), true);
            }
            return (Err(ModemError::DecoderTimeout(timeout_ms)), false);
        }

        let streamed_any = !collected.is_empty();
        match completion.unwrap_or(DecodeCompletion::Completed) {
            DecodeCompletion::Completed | DecodeCompletion::Cancelled => {
                (Ok(collected), streamed_any)
            }
            DecodeCompletion::Timeout => {
                if !collected.is_empty() {
                    warn!(
                        timeout_ms,
                        depth = opts.depth,
                        streamed = collected.len(),
                        "ftxr-modem timed out after streaming partial decodes; keeping received decodes"
                    );
                    (Ok(collected), true)
                } else {
                    (Err(ModemError::DecoderTimeout(timeout_ms)), false)
                }
            }
            DecodeCompletion::Error(msg) => (Err(ModemError::DecodeFailed(msg)), streamed_any),
        }
    }
}

#[async_trait]
impl Ft8Decoder for FtxrWorkerDecoder {
    fn backend_name(&self) -> &'static str {
        "ftxr"
    }

    async fn decode_slot(
        &self,
        slot_ts: UnixSecs,
        samples_12k: &[f32],
    ) -> Result<Vec<Ft8Decode>, ModemError> {
        let (tx, _rx) = mpsc::unbounded_channel();
        self.decode_slot_streaming(
            slot_ts,
            samples_12k,
            DecodePassOptions::default(),
            tx,
            CancellationToken::new(),
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[tokio::test]
    async fn binary_ipc_framing_roundtrips_and_rejects_corrupt_headers() {
        let mut wire = Vec::new();
        let json = br#"{"op":"ping","id":"p1"}"#;
        let payload = vec![0x01, 0x02, 0x03, 0x04];
        write_frame_async(&mut wire, FLAG_BINARY_F32LE, json, &payload)
            .await
            .unwrap();

        let mut cur = Cursor::new(wire.clone());
        let parsed = read_frame_async(&mut cur).await.unwrap().expect("frame");
        assert_eq!(parsed.version, FTXR_IPC_VERSION);
        assert_eq!(parsed.flags, FLAG_HAS_BINARY | FLAG_BINARY_F32LE);
        assert_eq!(parsed.json, json);
        assert_eq!(parsed.payload, payload);
        assert!(read_frame_async(&mut cur).await.unwrap().is_none());

        let mut bad_magic = wire.clone();
        bad_magic[0] = b'X';
        assert!(read_frame_async(&mut Cursor::new(bad_magic)).await.is_err());

        let truncated = &wire[..7];
        assert!(read_frame_async(&mut Cursor::new(truncated)).await.is_err());
    }

    #[test]
    fn converts_wire_decode_with_ap_metadata_and_bounds() {
        let wire = WireDecode {
            snr_db: -18,
            dt_sec: 0.4,
            af_hz: 1502.6,
            message: "  CQ   LZ1JZ  KN22 ".to_string(),
            raw_metadata: Some(" ? a1 ".to_string()),
        };
        let dec = wire.into_ft8_decode(UnixSecs(1_573_470_120)).unwrap();
        assert_eq!(dec.snr_db, -18);
        assert!((dec.dt_sec - 0.4).abs() < 1e-6);
        assert_eq!(dec.af_hz, 1503);
        assert_eq!(dec.message, "CQ LZ1JZ KN22");
        assert_eq!(dec.raw_metadata.as_deref(), Some("? a1"));
        assert_eq!(dec.decoder_backend, "ftxr");
    }

    #[test]
    fn decode_pcm_payload_roundtrips_f32le_and_i16le() {
        let samples = vec![0.0_f32, 0.5, -0.5, 0.25];
        let raw = encode_f32le_payload(&samples);
        let back = decode_pcm_payload(&raw, "f32le").unwrap();
        assert_eq!(back, samples);

        let i16_raw: Vec<u8> = [0_i16, 16384_i16, -16384_i16]
            .into_iter()
            .flat_map(i16::to_le_bytes)
            .collect();
        let i16_back = decode_pcm_payload(&i16_raw, "i16le").unwrap();
        assert!((i16_back[0] - 0.0).abs() < 1e-6);
        assert!((i16_back[1] - 0.5).abs() < 1e-4);
        assert!((i16_back[2] + 0.5).abs() < 1e-4);
    }

    #[cfg(unix)]
    #[test]
    fn finds_co_bundled_sidecar_layouts_relative_to_executable() {
        use std::os::unix::fs::PermissionsExt;

        let make_exec = |path: &Path| {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "#!/bin/sh\nexit 0\n").unwrap();
            let mut perms = std::fs::metadata(path).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(path, perms).unwrap();
        };

        // 1. Extracted tarball layout: <dir>/digi-dx + <dir>/libexec/ftxr-modem
        let root_tar = tempfile::tempdir().unwrap();
        let exe_tar = root_tar.path().join("digi-dx");
        let libexec_tar = root_tar.path().join("libexec/ftxr-modem");
        make_exec(&exe_tar);
        make_exec(&libexec_tar);
        assert_eq!(find_ftxr_relative_to_exe(&exe_tar), Some(libexec_tar));

        // 2. Homebrew layout: <prefix>/bin/digi-dx + <prefix>/libexec/ftxr-modem
        let root_brew = tempfile::tempdir().unwrap();
        let exe_brew = root_brew.path().join("bin/digi-dx");
        let libexec_brew = root_brew.path().join("libexec/ftxr-modem");
        make_exec(&exe_brew);
        make_exec(&libexec_brew);
        assert_eq!(find_ftxr_relative_to_exe(&exe_brew), Some(libexec_brew));

        // 3. System installer layout: <prefix>/bin/digi-dx + <prefix>/lib/digi-dx/ftxr-modem
        let root_sys = tempfile::tempdir().unwrap();
        let exe_sys = root_sys.path().join("bin/digi-dx");
        let lib_sys = root_sys.path().join("lib/digi-dx/ftxr-modem");
        make_exec(&exe_sys);
        make_exec(&lib_sys);
        assert_eq!(find_ftxr_relative_to_exe(&exe_sys), Some(lib_sys));
    }
}
