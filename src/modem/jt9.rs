use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use tempfile::Builder;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex};
use tokio::time::{sleep_until, timeout, Instant};
use tokio_util::sync::CancellationToken;
use tracing::warn;

use crate::audio::dsp::FT8_SAMPLE_RATE;
use crate::audio::wav::write_wav_16bit_mono;
use crate::domain::clock::UnixSecs;
use crate::domain::ft8::strip_decoder_metadata;
use crate::modem::{DecodePassOptions, Ft8Decode, Ft8Decoder, ModemError};

#[derive(Debug, Clone)]
pub struct Jt9SubprocessDecoder {
    pub jt9_bin: PathBuf,
    pub wisdom_dir: Option<PathBuf>,
    pub timeout: Duration,
    pub depth: u8,
    pub freq_min_hz: u16,
    pub freq_max_hz: u16,
    pub freq_center_hz: u16,
    pub freq_tol_hz: u16,
    /// Serializes `jt9` invocations sharing `wisdom_dir` (`jt9_wisdom.dat` / `timer.out`).
    run_lock: Arc<Mutex<()>>,
}

impl Jt9SubprocessDecoder {
    pub fn new(jt9_bin: PathBuf) -> Self {
        Self {
            jt9_bin,
            wisdom_dir: None,
            timeout: Duration::from_secs(4),
            depth: 3,
            freq_min_hz: 200,
            freq_max_hz: 3000,
            freq_center_hz: 1500,
            freq_tol_hz: 300,
            run_lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn with_data_dir(jt9_bin: PathBuf, data_dir: PathBuf) -> Self {
        let mut dec = Self::new(jt9_bin);
        dec.wisdom_dir = Some(data_dir);
        dec
    }

    fn resolve_data_dir_and_patience<'a>(
        &'a self,
        tmp_dir: &'a Path,
        generate_wisdom_if_missing: bool,
    ) -> (&'a Path, &'static str) {
        if let Some(ref dir) = self.wisdom_dir {
            if std::fs::create_dir_all(dir).is_ok()
                && (dir.join("jt9_wisdom.dat").is_file() || generate_wisdom_if_missing)
            {
                return (dir.as_path(), "1");
            }
        }
        (tmp_dir, "0")
    }

    /// Run `jt9` on `samples_12k` and stream each parsed decode line over `on_decode` immediately.
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

        let _run_guard = self.run_lock.lock().await;
        if cancel.is_cancelled() {
            return Ok(Vec::new());
        }

        let tmp = Builder::new()
            .prefix("digi-dx-jt9-")
            .tempdir()
            .map_err(|e| ModemError::DecodeFailed(format!("failed to create jt9 tempdir: {e}")))?;
        let wav_path = tmp.path().join(format_jt9_wav_name(slot_ts));

        let wav_path_clone = wav_path.clone();
        let pcm = samples_12k.to_vec();
        tokio::task::spawn_blocking(move || {
            write_wav_16bit_mono(&wav_path_clone, FT8_SAMPLE_RATE, &pcm)
        })
        .await
        .map_err(|e| ModemError::DecodeFailed(format!("jt9 WAV write task failed: {e}")))?
        .map_err(|e| ModemError::DecodeFailed(format!("failed to write jt9 WAV: {e}")))?;

        let (data_dir_arg, patience_arg) =
            self.resolve_data_dir_and_patience(tmp.path(), opts.generate_wisdom_if_missing);
        let depth = opts.depth.clamp(1, 3);

        let mut cmd = Command::new(&self.jt9_bin);
        cmd.arg("-8")
            .arg("-d")
            .arg(depth.to_string())
            .arg("-w")
            .arg(patience_arg)
            .arg("-L")
            .arg(self.freq_min_hz.to_string())
            .arg("-H")
            .arg(self.freq_max_hz.to_string())
            .arg("-F")
            .arg(self.freq_tol_hz.to_string())
            .arg("-f")
            .arg(self.freq_center_hz.to_string())
            .arg("-a")
            .arg(data_dir_arg)
            .arg("-t")
            .arg(tmp.path())
            .arg(&wav_path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        #[cfg(unix)]
        cmd.process_group(0);

        let mut child = cmd
            .spawn()
            .map_err(|e| ModemError::DecodeFailed(format!("failed to spawn jt9: {e}")))?;
        let pid = child.id();

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ModemError::DecodeFailed("jt9 stdout pipe unavailable".to_string()))?;
        let stderr = child.stderr.take();
        let stderr_task = tokio::spawn(async move {
            let mut buf = String::new();
            if let Some(mut s) = stderr {
                let _ = s.read_to_string(&mut buf).await;
            }
            buf
        });

        let deadline = Instant::now() + opts.timeout;
        let mut lines = BufReader::new(stdout).lines();
        let mut collected = Vec::new();
        let mut timed_out = false;
        let mut cancelled = false;
        let mut read_err: Option<String> = None;

        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    cancelled = true;
                    break;
                }
                _ = sleep_until(deadline) => {
                    timed_out = true;
                    break;
                }
                line_res = lines.next_line() => {
                    match line_res {
                        Ok(Some(line)) => {
                            if let Some(dec) = parse_jt9_line(slot_ts, &line) {
                                collected.push(dec.clone());
                                let _ = on_decode.send(dec);
                            }
                        }
                        Ok(None) => break,
                        Err(e) => {
                            read_err = Some(e.to_string());
                            break;
                        }
                    }
                }
            }
        }

        if cancelled {
            kill_process_group(pid);
            let _ = child.kill().await;
            let _ = child.wait().await;
            stderr_task.abort();
            return Ok(collected);
        }

        if timed_out {
            kill_process_group(pid);
            let _ = child.kill().await;
            let _ = child.wait().await;
            stderr_task.abort();
            if !collected.is_empty() {
                warn!(
                    timeout_ms = opts.timeout.as_millis() as u64,
                    depth,
                    streamed = collected.len(),
                    "jt9 timed out after streaming partial decodes; keeping received decodes"
                );
                return Ok(collected);
            }
            return Err(ModemError::DecoderTimeout(opts.timeout.as_millis() as u64));
        }

        if let Some(err_msg) = read_err {
            kill_process_group(pid);
            let _ = child.kill().await;
            let _ = child.wait().await;
            stderr_task.abort();
            return Err(ModemError::DecodeFailed(format!(
                "jt9 stdout read failed: {err_msg}"
            )));
        }

        let status = match timeout(Duration::from_millis(500), child.wait()).await {
            Ok(Ok(st)) => st,
            Ok(Err(e)) => {
                stderr_task.abort();
                return Err(ModemError::DecodeFailed(format!("jt9 wait failed: {e}")));
            }
            Err(_) => {
                kill_process_group(pid);
                let _ = child.kill().await;
                let _ = child.wait().await;
                stderr_task.abort();
                if !collected.is_empty() {
                    return Ok(collected);
                }
                return Err(ModemError::DecoderTimeout(opts.timeout.as_millis() as u64));
            }
        };

        let stderr_text = stderr_task.await.unwrap_or_default();
        if !status.success() && collected.is_empty() {
            return Err(ModemError::DecodeFailed(format!(
                "jt9 exited with {}: {}",
                status,
                stderr_text.trim()
            )));
        }

        Ok(collected)
    }
}

fn kill_process_group(pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(p) = pid {
        // SAFETY: child was spawned in its own process group (`process_group(0)`).
        unsafe {
            libc::kill(-(p as libc::pid_t), libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    let _ = pid;
}

/// Format temporary WAV filename strictly as UTC `YYMMDD_HHMMSS.wav` to satisfy `jt9`.
pub fn format_jt9_wav_name(slot_ts: UnixSecs) -> String {
    let dt = DateTime::<Utc>::from_timestamp(slot_ts.0, 0).unwrap_or(DateTime::<Utc>::UNIX_EPOCH);
    dt.format("%y%m%d_%H%M%S.wav").to_string()
}

pub fn parse_jt9_line(slot_ts: UnixSecs, line: &str) -> Option<Ft8Decode> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('<') {
        return None;
    }
    let tokens: Vec<&str> = trimmed.split_whitespace().collect();
    if tokens.len() < 5 {
        return None;
    }
    let snr_f = tokens[1].parse::<f32>().ok()?;
    let dt_sec = tokens[2].parse::<f32>().ok()?;
    let af_f = tokens[3].parse::<f32>().ok()?;

    let (_, after_marker) = trimmed.split_once('~')?;
    let (clean, meta) = strip_decoder_metadata(after_marker);
    let normalized_msg = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized_msg.is_empty() {
        return None;
    }

    Some(Ft8Decode {
        slot_ts,
        snr_db: snr_f.round().clamp(-50.0, 49.0) as i8,
        dt_sec,
        af_hz: af_f.round().clamp(0.0, 5000.0) as u16,
        message: normalized_msg,
        raw_metadata: meta.map(str::to_string),
        decoder_backend: "jt9".to_string(),
    })
}

pub fn parse_jt9_stdout(slot_ts: UnixSecs, stdout: &str) -> Vec<Ft8Decode> {
    stdout
        .lines()
        .filter_map(|line| parse_jt9_line(slot_ts, line))
        .collect()
}

#[async_trait]
impl Ft8Decoder for Jt9SubprocessDecoder {
    fn backend_name(&self) -> &'static str {
        "jt9"
    }

    async fn decode_slot(
        &self,
        slot_ts: UnixSecs,
        samples_12k: &[f32],
    ) -> Result<Vec<Ft8Decode>, ModemError> {
        let (tx, _rx) = mpsc::unbounded_channel();
        let opts = DecodePassOptions {
            depth: self.depth,
            timeout: self.timeout,
            generate_wisdom_if_missing: true,
            fallback_on_empty_timeout: true,
        };
        self.decode_slot_streaming(slot_ts, samples_12k, opts, tx, CancellationToken::new())
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_yymmdd_hhmmss_wav_name() {
        // 2019-11-11 11:01:15 UTC = 1573470075
        let name = format_jt9_wav_name(UnixSecs(1_573_470_075));
        assert_eq!(name, "191111_110115.wav");
    }

    #[test]
    fn parses_jt9_stdout_and_strips_metadata_suffix() {
        let sample = "\
110115   9  0.9 1234 ~  GJ0KYZ RK9AX MO05                       
110115 -22  0.3 1993 ~  CQ PY7XC HI21                       ? a1
<DecodeFinished>   0   2        0
";
        let decodes = parse_jt9_stdout(UnixSecs(1_573_470_075), sample);
        assert_eq!(decodes.len(), 2);

        assert_eq!(decodes[0].message, "GJ0KYZ RK9AX MO05");
        assert_eq!(decodes[0].raw_metadata, None);
        assert_eq!(decodes[0].af_hz, 1234);
        assert_eq!(decodes[0].snr_db, 9);
        assert_eq!(decodes[0].decoder_backend, "jt9");

        assert_eq!(decodes[1].message, "CQ PY7XC HI21");
        assert_eq!(decodes[1].raw_metadata.as_deref(), Some("? a1"));
        assert_eq!(decodes[1].af_hz, 1993);
        assert_eq!(decodes[1].snr_db, -22);

        let bare_ap = "110200 -14  0.6 1030 ~  CQ LZ1JZ KN22                         a1\n";
        let ap_decodes = parse_jt9_stdout(UnixSecs(1_573_470_120), bare_ap);
        assert_eq!(ap_decodes.len(), 1);
        assert_eq!(ap_decodes[0].message, "CQ LZ1JZ KN22");
        assert_eq!(ap_decodes[0].raw_metadata.as_deref(), Some("a1"));
    }
}
