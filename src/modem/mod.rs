pub mod ft8_lib;
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

use crate::domain::clock::{SlotParity, UnixSecs};
use crate::preflight::resolve_executable;

use self::ft8_lib::Ft8LibEmbeddedDecoder;
use self::jt9::Jt9SubprocessDecoder;

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
    #[error("jt9 decoder timed out after {0} ms")]
    DecoderTimeout(u64),
}

#[derive(Debug, Clone, Copy)]
pub struct DecodePassOptions {
    pub depth: u8,
    pub timeout: Duration,
    /// When true and no persistent `jt9_wisdom.dat` exists yet, run `-w 1` against the persistent
    /// `-a` dir to generate and cache measured FFTW plans. When false and no wisdom exists yet,
    /// use `-w 0` (`FFTW_ESTIMATE`) against the throwaway tempdir to avoid a ~1s cold stall.
    pub generate_wisdom_if_missing: bool,
    /// Allow fallback to embedded `ft8_lib` if `jt9` times out with zero streamed decodes.
    pub fallback_on_empty_timeout: bool,
}

impl Default for DecodePassOptions {
    fn default() -> Self {
        Self {
            depth: 3,
            timeout: Duration::from_secs(4),
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

/// Primary (`jt9`) + zero-dependency (`ft8_lib`) fallback FT8 decoder coordinator.
#[derive(Debug, Clone)]
pub struct HybridFt8Decoder {
    primary: Option<Jt9SubprocessDecoder>,
    fallback: Ft8LibEmbeddedDecoder,
}

impl HybridFt8Decoder {
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

    pub fn with_data_dir(jt9_override: Option<&Path>, jt9_data_dir: Option<PathBuf>) -> Self {
        let primary = Self::resolve_jt9_path(jt9_override).map(|bin| match jt9_data_dir {
            Some(dir) => Jt9SubprocessDecoder::with_data_dir(bin, dir),
            None => Jt9SubprocessDecoder::new(bin),
        });
        Self {
            primary,
            fallback: Ft8LibEmbeddedDecoder,
        }
    }

    pub fn new(jt9_override: Option<&Path>) -> Self {
        Self::with_data_dir(jt9_override, None)
    }

    pub fn active_backend_name(&self) -> &'static str {
        if self.primary.is_some() {
            "jt9"
        } else {
            "ft8_lib_fallback"
        }
    }

    pub fn jt9_decoder(&self) -> Option<&Jt9SubprocessDecoder> {
        self.primary.as_ref()
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

        if let Some(ref jt9) = self.primary {
            match jt9
                .decode_slot_streaming(
                    slot_ts,
                    samples_12k,
                    opts,
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
                        "primary jt9 decoder failed; falling back to embedded ft8_lib"
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
        if let Some(ref jt9) = self.primary {
            match jt9.decode_slot(slot_ts, samples_12k).await {
                Ok(decodes) => return Ok(decodes),
                Err(err) => {
                    warn!(error = %err, "primary jt9 decoder failed; falling back to embedded ft8_lib");
                }
            }
        }
        self.fallback.decode_slot(slot_ts, samples_12k).await
    }
}
