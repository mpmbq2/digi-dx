use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use tempfile::Builder;
use tokio::process::Command;

use crate::audio::dsp::FT8_SAMPLE_RATE;
use crate::audio::wav::write_wav_16bit_mono;
use crate::domain::clock::UnixSecs;
use crate::domain::ft8::strip_decoder_metadata;
use crate::modem::{Ft8Decode, Ft8Decoder, ModemError};

#[derive(Debug, Clone)]
pub struct Jt9SubprocessDecoder {
    pub jt9_bin: PathBuf,
    pub timeout: Duration,
    pub depth: u8,
    pub freq_center_hz: u16,
    pub freq_tol_hz: u16,
}

impl Jt9SubprocessDecoder {
    pub fn new(jt9_bin: PathBuf) -> Self {
        Self {
            jt9_bin,
            timeout: Duration::from_secs(4),
            depth: 3,
            freq_center_hz: 1500,
            freq_tol_hz: 300,
        }
    }
}

/// Format temporary WAV filename strictly as UTC `YYMMDD_HHMMSS.wav` to satisfy `jt9`.
pub fn format_jt9_wav_name(slot_ts: UnixSecs) -> String {
    let dt = DateTime::<Utc>::from_timestamp(slot_ts.0, 0).unwrap_or(DateTime::<Utc>::UNIX_EPOCH);
    dt.format("%y%m%d_%H%M%S.wav").to_string()
}

pub fn parse_jt9_stdout(slot_ts: UnixSecs, stdout: &str) -> Vec<Ft8Decode> {
    let mut decodes = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('<') {
            continue;
        }
        let tokens: Vec<&str> = trimmed.split_whitespace().collect();
        if tokens.len() < 5 {
            continue;
        }
        let Ok(snr_f) = tokens[1].parse::<f32>() else {
            continue;
        };
        let Ok(dt_sec) = tokens[2].parse::<f32>() else {
            continue;
        };
        let Ok(af_f) = tokens[3].parse::<f32>() else {
            continue;
        };

        let after_marker = if let Some((_, rhs)) = trimmed.split_once('~') {
            rhs
        } else {
            continue;
        };
        let (clean, meta) = strip_decoder_metadata(after_marker);
        let normalized_msg = clean.split_whitespace().collect::<Vec<_>>().join(" ");
        if normalized_msg.is_empty() {
            continue;
        }

        decodes.push(Ft8Decode {
            slot_ts,
            snr_db: snr_f.round().clamp(-50.0, 49.0) as i8,
            dt_sec,
            af_hz: af_f.round().clamp(0.0, 5000.0) as u16,
            message: normalized_msg,
            raw_metadata: meta.map(str::to_string),
            decoder_backend: "jt9".to_string(),
        });
    }
    decodes
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
        if samples_12k.is_empty() {
            return Ok(Vec::new());
        }

        let tmp = Builder::new()
            .prefix("digi-dx-jt9-")
            .tempdir()
            .map_err(|e| ModemError::DecodeFailed(format!("failed to create jt9 tempdir: {e}")))?;
        let wav_path = tmp.path().join(format_jt9_wav_name(slot_ts));

        write_wav_16bit_mono(&wav_path, FT8_SAMPLE_RATE, samples_12k)
            .map_err(|e| ModemError::DecodeFailed(format!("failed to write jt9 WAV: {e}")))?;

        let mut cmd = Command::new(&self.jt9_bin);
        cmd.arg("-8")
            .arg("-d")
            .arg(self.depth.to_string())
            .arg("-F")
            .arg(self.freq_tol_hz.to_string())
            .arg("-f")
            .arg(self.freq_center_hz.to_string())
            .arg("-a")
            .arg(tmp.path())
            .arg("-t")
            .arg(tmp.path())
            .arg(&wav_path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        #[cfg(unix)]
        cmd.process_group(0);

        let child = cmd
            .spawn()
            .map_err(|e| ModemError::DecodeFailed(format!("failed to spawn jt9: {e}")))?;
        let pid = child.id();

        let output = match tokio::time::timeout(self.timeout, child.wait_with_output()).await {
            Ok(Ok(out)) => out,
            Ok(Err(e)) => {
                return Err(ModemError::DecodeFailed(format!("jt9 wait failed: {e}")));
            }
            Err(_) => {
                #[cfg(unix)]
                if let Some(p) = pid {
                    // SAFETY: child was spawned in its own process group (`process_group(0)`).
                    unsafe {
                        libc::kill(-(p as libc::pid_t), libc::SIGKILL);
                    }
                }
                return Err(ModemError::DecoderTimeout(self.timeout.as_millis() as u64));
            }
        };

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(ModemError::DecodeFailed(format!(
                "jt9 exited with {}: {stderr}",
                output.status
            )));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(parse_jt9_stdout(slot_ts, &stdout))
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
    }
}
