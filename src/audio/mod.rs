pub mod devices;
pub mod dsp;
pub mod manager;
pub mod wav;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum AudioError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("WAV format error: {0}")]
    InvalidWav(String),
    #[error("audio device not found: {0}")]
    DeviceNotFound(String),
    #[error("unsupported audio configuration: {0}")]
    UnsupportedConfig(String),
    #[error("audio stream error: {0}")]
    StreamError(String),
    #[error("resampler error: {0}")]
    ResampleError(String),
}
