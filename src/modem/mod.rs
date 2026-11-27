pub mod ft8_lib;
pub mod ftxr;
pub mod jt9;
pub mod simulator;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::warn;

use crate::audio::dsp::{FT4_SLOT_SAMPLES_12K, FT8_SLOT_SAMPLES_12K};
use crate::domain::clock::{SlotParity, UnixSecs};
use crate::preflight::resolve_executable;

use self::ft8_lib::{Ft8LibEmbeddedDecoder, Ft8LibTxModulator};
use self::ftxr::{resolve_ftxr_binary, FtxrWorkerDecoder};
use self::jt9::Jt9SubprocessDecoder;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModemMode {
    #[default]
    Ft8,
    Ft4,
}

impl ModemMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ft8 => "ft8",
            Self::Ft4 => "ft4",
        }
    }

    pub fn from_mode_str(raw: &str) -> Self {
        if raw.trim().eq_ignore_ascii_case("FT4") {
            Self::Ft4
        } else {
            Self::Ft8
        }
    }

    pub const fn slot_samples_12k(self) -> usize {
        match self {
            Self::Ft8 => FT8_SLOT_SAMPLES_12K,
            Self::Ft4 => FT4_SLOT_SAMPLES_12K,
        }
    }

    /// Nominal TX start delay (ms) used when generating live TX waveforms.
    /// FT8 uses 0 ms to preserve existing Digi-Dx UTC-aligned live TX timing;
    /// FT4 uses the standard 300 ms WSJT-X nominal TX delay.
    pub const fn live_tx_start_delay_ms(self) -> u32 {
        match self {
            Self::Ft8 => 0,
            Self::Ft4 => 300,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct QsoDecodeContext {
    pub my_call: Option<String>,
    pub dx_call: Option<String>,
    pub dx_grid: Option<String>,
    pub rx_freq_hz: Option<f32>,
    pub tx_freq_hz: Option<f32>,
    pub qso_progress: Option<u8>,
    pub enable_ap: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Ft8Decode {
    pub slot_ts: UnixSecs,
    pub snr_db: i8,
    pub dt_sec: f32,
    pub af_hz: u16,
    pub message: String,
    pub raw_metadata: Option<String>,
    pub decoder_backend: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TxIntent {
    pub af_hz: u16,
    pub slot: SlotParity,
    pub message: String,
}

#[derive(Debug, Error)]
pub enum ModemError {
    #[error("invalid FT8 message: {0}")]
    InvalidMessage(String),
    #[error("FT8 encode failed: {0}")]
    EncodeFailed(String),
    #[error("FT8 decode failed: {0}")]
    DecodeFailed(String),
    #[error("decoder timed out after {0} ms")]
    DecoderTimeout(u64),
}

#[derive(Debug, Clone)]
pub struct DecodePassOptions {
    pub mode: ModemMode,
    pub depth: u8,
    pub timeout: Duration,
    /// True during early partial passes (e.g. 11.8s / 13.5s) to bound pass depth for low latency.
    pub early_pass: bool,
    /// Optional live QSO context for A Priori (`a1`–`a6`) hypotheses and QSO-frequency prioritization.
    pub qso_context: Option<QsoDecodeContext>,
    /// When true and no persistent `jt9_wisdom.dat` exists yet, run `-w 1` against the persistent
    /// `-a` dir to generate and cache measured FFTW plans. When false and no wisdom exists yet,
    /// use `-w 0` (`FFTW_ESTIMATE`) against the throwaway tempdir to avoid a ~1s cold stall.
    pub generate_wisdom_if_missing: bool,
    /// Allow fallback to secondary/embedded decoders if the primary backend times out with zero streamed decodes.
    pub fallback_on_empty_timeout: bool,
}

impl Default for DecodePassOptions {
    fn default() -> Self {
        Self {
            mode: ModemMode::Ft8,
            depth: 3,
            timeout: Duration::from_secs(4),
            early_pass: false,
            qso_context: None,
            generate_wisdom_if_missing: true,
            fallback_on_empty_timeout: true,
        }
    }
}

#[async_trait]
pub trait Ft8Decoder: Send + Sync {
    fn backend_name(&self) -> &'static str;
    async fn decode_slot(
        &self,
        slot_ts: UnixSecs,
        samples_12k: &[f32],
    ) -> Result<Vec<Ft8Decode>, ModemError>;
}

/// Primary (`ftxr-modem`), secondary legacy (`jt9`), and zero-dependency (`ft8_lib`) fallback
/// FT8/FT4 decoder and modulator coordinator.
#[derive(Debug, Clone)]
pub struct HybridFt8Decoder {
    ftxr: Option<FtxrWorkerDecoder>,
    jt9: Option<Jt9SubprocessDecoder>,
    fallback: Ft8LibEmbeddedDecoder,
}

impl HybridFt8Decoder {
    pub fn resolve_ftxr_path(override_path: Option<&Path>) -> Option<PathBuf> {
        resolve_ftxr_binary(override_path).map(|info| info.path)
    }

    pub fn resolve_jt9_path(override_path: Option<&Path>) -> Option<PathBuf> {
        let fallback_paths = [
            "/usr/local/lib/digi-dx/jt9",
            "/Applications/wsjtx.app/Contents/MacOS/jt9",
        ];
        let candidate = resolve_executable("jt9", override_path, &fallback_paths)?;
        let ok = Command::new(&candidate)
            .arg("-h")
            .output()
            .is_ok_and(|o| o.status.success());
        if ok {
            Some(candidate)
        } else {
            None
        }
    }

    pub fn with_backends(
        ftxr_override: Option<&Path>,
        jt9_override: Option<&Path>,
        jt9_data_dir: Option<PathBuf>,
    ) -> Self {
        let ftxr = Self::resolve_ftxr_path(ftxr_override).map(FtxrWorkerDecoder::new);
        let jt9 = Self::resolve_jt9_path(jt9_override).map(|bin| match jt9_data_dir {
            Some(dir) => Jt9SubprocessDecoder::with_data_dir(bin, dir),
            None => Jt9SubprocessDecoder::new(bin),
        });
        Self {
            ftxr,
            jt9,
            fallback: Ft8LibEmbeddedDecoder,
        }
    }

    pub fn with_data_dir(jt9_override: Option<&Path>, jt9_data_dir: Option<PathBuf>) -> Self {
        Self::with_backends(None, jt9_override, jt9_data_dir)
    }

    pub fn new(jt9_override: Option<&Path>) -> Self {
        Self::with_backends(None, jt9_override, None)
    }

    pub fn active_backend_name(&self) -> &'static str {
        if self.ftxr.is_some() {
            "ftxr"
        } else if self.jt9.is_some() {
            "jt9"
        } else {
            "ft8_lib_fallback"
        }
    }

    pub fn ftxr_decoder(&self) -> Option<&FtxrWorkerDecoder> {
        self.ftxr.as_ref()
    }

    pub fn jt9_decoder(&self) -> Option<&Jt9SubprocessDecoder> {
        self.jt9.as_ref()
    }

    pub async fn warm_up(&self) {
        if let Some(ref ftxr) = self.ftxr {
            if let Err(e) = ftxr.warm_up().await {
                warn!(error = %e, "failed to pre-warm ftxr-modem worker");
            }
        }
    }

    pub async fn reset_session(&self) {
        if let Some(ref ftxr) = self.ftxr {
            if let Err(e) = ftxr.reset_session().await {
                warn!(error = %e, "failed to reset ftxr-modem session state");
            }
        }
    }

    pub async fn shutdown(&self) {
        if let Some(ref ftxr) = self.ftxr {
            ftxr.shutdown().await;
        }
    }

    /// Modulate an FT8 or FT4 TX waveform starting `offset_ms` into the slot.
    /// Uses `ftxr-modem`'s isolated TX thread when available, falling back to `ft8_lib` for FT8.
    pub async fn modulate_tx_from_offset(
        &self,
        mode: ModemMode,
        message: &str,
        af_hz: f32,
        sample_rate: u32,
        offset_ms: u64,
    ) -> Result<Vec<f32>, ModemError> {
        if let Some(ref ftxr) = self.ftxr {
            match ftxr
                .encode_tx(
                    mode,
                    message,
                    af_hz,
                    sample_rate,
                    Some(mode.live_tx_start_delay_ms()),
                    offset_ms,
                )
                .await
            {
                Ok(pcm) => return Ok(pcm),
                Err(err) if mode == ModemMode::Ft8 => {
                    warn!(
                        error = %err,
                        "ftxr-modem FT8 encode_tx failed; falling back to embedded ft8_lib modulator"
                    );
                }
                Err(err) => return Err(err),
            }
        }

        match mode {
            ModemMode::Ft8 => {
                let msg = message.to_string();
                tokio::task::spawn_blocking(move || {
                    Ft8LibTxModulator::modulate_pcm_from_offset(&msg, af_hz, sample_rate, offset_ms)
                })
                .await
                .map_err(|e| {
                    ModemError::EncodeFailed(format!("ft8_lib modulate task error: {e}"))
                })?
            }
            ModemMode::Ft4 => Err(ModemError::EncodeFailed(
                "FT4 TX modulation requires ftxr-modem (not installed)".to_string(),
            )),
        }
    }

    /// Decode a slot while streaming each parsed line over `on_decode` as soon as emitted.
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

        if let Some(ref ftxr) = self.ftxr {
            match ftxr
                .decode_slot_streaming(
                    slot_ts,
                    samples_12k,
                    opts.clone(),
                    on_decode.clone(),
                    cancel.clone(),
                )
                .await
            {
                Ok(decodes) => return Ok(decodes),
                Err(ModemError::DecoderTimeout(ms)) if !opts.fallback_on_empty_timeout => {
                    warn!(
                        timeout_ms = ms,
                        depth = opts.depth,
                        mode = opts.mode.as_str(),
                        "ftxr-modem intermediate pass timed out; skipping fallback"
                    );
                    return Ok(Vec::new());
                }
                Err(err) => {
                    if opts.mode == ModemMode::Ft4 {
                        return Err(err);
                    }
                    warn!(
                        error = %err,
                        "primary ftxr-modem decoder failed; falling back"
                    );
                }
            }
        }

        if opts.mode == ModemMode::Ft4 {
            return Err(ModemError::DecodeFailed(
                "FT4 decoding requires ftxr-modem (not installed)".to_string(),
            ));
        }

        if let Some(ref jt9) = self.jt9 {
            match jt9
                .decode_slot_streaming(
                    slot_ts,
                    samples_12k,
                    opts.clone(),
                    on_decode.clone(),
                    cancel.clone(),
                )
                .await
            {
                Ok(decodes) => return Ok(decodes),
                Err(ModemError::DecoderTimeout(ms)) if !opts.fallback_on_empty_timeout => {
                    warn!(
                        timeout_ms = ms,
                        depth = opts.depth,
                        "jt9 intermediate pass timed out; skipping ft8_lib fallback"
                    );
                    return Ok(Vec::new());
                }
                Err(err) => {
                    warn!(
                        error = %err,
                        "jt9 decoder failed; falling back to embedded ft8_lib"
                    );
                }
            }
        }

        if cancel.is_cancelled() {
            return Ok(Vec::new());
        }

        let decodes = self.fallback.decode_slot(slot_ts, samples_12k).await?;
        for dec in &decodes {
            let _ = on_decode.send(dec.clone());
        }
        Ok(decodes)
    }
}

#[async_trait]
impl Ft8Decoder for HybridFt8Decoder {
    fn backend_name(&self) -> &'static str {
        self.active_backend_name()
    }

    async fn decode_slot(
        &self,
        slot_ts: UnixSecs,
        samples_12k: &[f32],
    ) -> Result<Vec<Ft8Decode>, ModemError> {
        if let Some(ref ftxr) = self.ftxr {
            match ftxr.decode_slot(slot_ts, samples_12k).await {
                Ok(decodes) => return Ok(decodes),
                Err(err) => {
                    warn!(error = %err, "primary ftxr-modem decoder failed; falling back");
                }
            }
        }
        if let Some(ref jt9) = self.jt9 {
            match jt9.decode_slot(slot_ts, samples_12k).await {
                Ok(decodes) => return Ok(decodes),
                Err(err) => {
                    warn!(error = %err, "jt9 decoder failed; falling back to embedded ft8_lib");
                }
            }
        }
        self.fallback.decode_slot(slot_ts, samples_12k).await
    }
}
