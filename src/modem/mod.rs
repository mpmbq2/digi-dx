pub mod ft8_lib;
pub mod jt9;
pub mod simulator;

use std::path::{Path, PathBuf};
use std::process::Command;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;
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

    pub fn new(jt9_override: Option<&Path>) -> Self {
        let primary = Self::resolve_jt9_path(jt9_override).map(Jt9SubprocessDecoder::new);
        Self {
            primary,
            fallback: Ft8LibEmbeddedDecoder,
        }
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
