use std::f32::consts::PI;
use std::sync::Arc;

use rubato::{FftFixedIn, Resampler};
use rustfft::{num_complex::Complex, Fft, FftPlanner};
use serde::{Deserialize, Serialize};

use crate::audio::AudioError;

pub const DSP_SAMPLE_RATE: u32 = 48_000;
pub const FT8_SAMPLE_RATE: u32 = 12_000;
pub const FT8_SLOT_SAMPLES_12K: usize = 180_000;
pub const WATERFALL_MIN_HZ: f32 = 200.0;
pub const WATERFALL_MAX_HZ: f32 = 3000.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaterfallFrame {
    pub min_hz: f32,
    pub max_hz: f32,
    pub bin_hz: f32,
    pub bins_db: Vec<f32>,
    pub rms_db: f32,
    pub peak_db: f32,
    pub clipped: bool,
}

/// Resample a complete mono f32 buffer from `in_rate` to `out_rate`, compensating for filter delay.
pub fn resample_mono(samples: &[f32], in_rate: u32, out_rate: u32) -> Result<Vec<f32>, AudioError> {
    if in_rate == 0 || out_rate == 0 {
        return Err(AudioError::ResampleError(
            "sample rates must be non-zero".to_string(),
        ));
    }
    if in_rate == out_rate {
        return Ok(samples.to_vec());
    }
    if samples.is_empty() {
        return Ok(Vec::new());
    }

    let chunk_size_in = 1024;
    let mut resampler =
        FftFixedIn::<f32>::new(in_rate as usize, out_rate as usize, chunk_size_in, 2, 1)
            .map_err(|e| AudioError::ResampleError(e.to_string()))?;

    let delay = resampler.output_delay();
    let expected_len = ((samples.len() as u64 * out_rate as u64) / in_rate as u64) as usize;
    let pad_in =
        ((delay as f64) * (in_rate as f64) / (out_rate as f64)).ceil() as usize + chunk_size_in * 2;

    let mut padded = Vec::with_capacity(samples.len() + pad_in);
    padded.extend_from_slice(samples);
    padded.resize(samples.len() + pad_in, 0.0);

    let mut raw_out = Vec::with_capacity(expected_len + delay + 2048);
    let mut pos = 0_usize;
    while pos < padded.len() {
        let needed = resampler.input_frames_next();
        if pos + needed > padded.len() {
            break;
        }
        let chunk = [&padded[pos..pos + needed]];
        let out_chunk = resampler
            .process(&chunk, None)
            .map_err(|e| AudioError::ResampleError(e.to_string()))?;
        raw_out.extend_from_slice(&out_chunk[0]);
        pos += needed;
    }

    if raw_out.len() <= delay {
        return Ok(vec![0.0; expected_len]);
    }
    let trimmed = &raw_out[delay..];
    let take_len = expected_len.min(trimmed.len());
    let mut out = Vec::with_capacity(expected_len);
    out.extend_from_slice(&trimmed[..take_len]);
    if out.len() < expected_len {
        out.resize(expected_len, 0.0);
    }
    Ok(out)
}

pub fn resample_48k_to_12k(samples_48k: &[f32]) -> Result<Vec<f32>, AudioError> {
    resample_mono(samples_48k, DSP_SAMPLE_RATE, FT8_SAMPLE_RATE)
}

pub fn resample_12k_to_48k(samples_12k: &[f32]) -> Result<Vec<f32>, AudioError> {
    resample_mono(samples_12k, FT8_SAMPLE_RATE, DSP_SAMPLE_RATE)
}

/// Incremental streaming resampler for live audio callbacks.
pub struct StreamingResampler {
    in_rate: u32,
    out_rate: u32,
    resampler: Option<FftFixedIn<f32>>,
    staging: Vec<f32>,
}

impl StreamingResampler {
    pub fn new(in_rate: u32, out_rate: u32) -> Result<Self, AudioError> {
        if in_rate == 0 || out_rate == 0 {
            return Err(AudioError::ResampleError(
                "sample rates must be non-zero".to_string(),
            ));
        }
        let resampler = if in_rate == out_rate {
            None
        } else {
            Some(
                FftFixedIn::<f32>::new(in_rate as usize, out_rate as usize, 1024, 2, 1)
                    .map_err(|e| AudioError::ResampleError(e.to_string()))?,
            )
        };
        Ok(Self {
            in_rate,
            out_rate,
            resampler,
            staging: Vec::with_capacity(4096),
        })
    }

    pub fn push(&mut self, input: &[f32]) -> Result<Vec<f32>, AudioError> {
        if self.in_rate == self.out_rate {
            return Ok(input.to_vec());
        }
        let Some(ref mut resampler) = self.resampler else {
            return Ok(input.to_vec());
        };
        self.staging.extend_from_slice(input);
        let mut out = Vec::new();
        loop {
            let needed = resampler.input_frames_next();
            if self.staging.len() < needed {
                break;
            }
            let chunk: Vec<f32> = self.staging.drain(..needed).collect();
            let res = resampler
                .process(&[chunk.as_slice()], None)
                .map_err(|e| AudioError::ResampleError(e.to_string()))?;
            out.extend_from_slice(&res[0]);
        }
        Ok(out)
    }
}

/// Real-time Hann-windowed FFT spectrum/waterfall analyzer over `200..=3000 Hz`.
pub struct WaterfallAnalyzer {
    sample_rate: u32,
    fft_size: usize,
    window: Vec<f32>,
    fft: Arc<dyn Fft<f32>>,
    buffer: Vec<f32>,
    min_bin: usize,
    max_bin: usize,
}

impl WaterfallAnalyzer {
    pub fn new(sample_rate: u32) -> Self {
        let fft_size = if sample_rate >= 32_000 { 4096 } else { 1024 };
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(fft_size);
        let window: Vec<f32> = (0..fft_size)
            .map(|i| 0.5 * (1.0 - (2.0 * PI * (i as f32) / (fft_size as f32)).cos()))
            .collect();

        let bin_hz = (sample_rate as f32) / (fft_size as f32);
        let min_bin = (WATERFALL_MIN_HZ / bin_hz).floor().max(1.0) as usize;
        let max_bin = ((WATERFALL_MAX_HZ / bin_hz).ceil() as usize).min(fft_size / 2);

        Self {
            sample_rate,
            fft_size,
            window,
            fft,
            buffer: Vec::with_capacity(fft_size * 2),
            min_bin,
            max_bin,
        }
    }

    pub fn push_samples(&mut self, samples: &[f32]) -> Vec<WaterfallFrame> {
        let mut frames = Vec::new();
        self.buffer.extend_from_slice(samples);
        while self.buffer.len() >= self.fft_size {
            let chunk: Vec<f32> = self.buffer.drain(..self.fft_size).collect();
            frames.push(self.compute_frame(&chunk));
        }
        frames
    }

    pub fn compute_frame(&self, chunk: &[f32]) -> WaterfallFrame {
        let mut sum_sq = 0.0_f32;
        let mut peak = 0.0_f32;
        let mut clipped = false;
        let mut spectrum = Vec::with_capacity(self.fft_size);

        let win_sum: f32 = self.fft_size as f32 * 0.5;
        for (i, &w) in self.window.iter().enumerate().take(self.fft_size) {
            let s = chunk.get(i).copied().unwrap_or(0.0);
            let abs_s = s.abs();
            if abs_s >= 0.99 {
                clipped = true;
            }
            if abs_s > peak {
                peak = abs_s;
            }
            sum_sq += s * s;
            spectrum.push(Complex::new(s * w, 0.0));
        }

        self.fft.process(&mut spectrum);

        let bin_hz = (self.sample_rate as f32) / (self.fft_size as f32);
        let mut bins_db = Vec::with_capacity(self.max_bin.saturating_sub(self.min_bin) + 1);
        for bin in spectrum.iter().take(self.max_bin + 1).skip(self.min_bin) {
            let mag = (bin.norm() * 2.0 / win_sum).max(1e-6);
            bins_db.push(20.0 * mag.log10());
        }

        let rms = (sum_sq / self.fft_size as f32).sqrt().max(1e-6);
        WaterfallFrame {
            min_hz: (self.min_bin as f32) * bin_hz,
            max_hz: (self.max_bin as f32) * bin_hz,
            bin_hz,
            bins_db,
            rms_db: 20.0 * rms.log10(),
            peak_db: 20.0 * peak.max(1e-6).log10(),
            clipped,
        }
    }
}

pub fn extract_channel(interleaved: &[f32], channels: usize, rx_channel: &str) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    let ch_mode = rx_channel.trim().to_ascii_lowercase();
    let mut out = Vec::with_capacity(interleaved.len() / channels);
    for frame in interleaved.chunks_exact(channels) {
        let sample = match ch_mode.as_str() {
            "left" => frame[0],
            "right" => frame[1.min(channels - 1)],
            _ => frame.iter().copied().sum::<f32>() / (channels as f32),
        };
        out.push(sample);
    }
    out
}

pub fn apply_gain_db(samples: &mut [f32], gain_db: f64) {
    let linear = 10.0_f64.powf(gain_db / 20.0) as f32;
    for s in samples.iter_mut() {
        *s = (*s * linear).clamp(-0.98, 0.98);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resamples_48k_to_12k_and_back_preserving_1420hz_peak() {
        let len_48k = 48_000_usize;
        let tone_48k: Vec<f32> = (0..len_48k)
            .map(|i| (2.0 * PI * 1420.0 * (i as f32) / 48_000.0).sin() * 0.8)
            .collect();

        let down_12k = resample_48k_to_12k(&tone_48k).unwrap();
        assert_eq!(down_12k.len(), 12_000);

        let mut wf = WaterfallAnalyzer::new(12_000);
        let frames = wf.push_samples(&down_12k[1024..2048]);
        assert_eq!(frames.len(), 1);
        let (max_idx, _) = frames[0]
            .bins_db
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .unwrap();
        let peak_hz = frames[0].min_hz + (max_idx as f32) * frames[0].bin_hz;
        assert!(
            (peak_hz - 1420.0).abs() <= 15.0,
            "12k resampled peak at {peak_hz} Hz (expected ~1420 Hz)"
        );

        let up_48k = resample_12k_to_48k(&down_12k).unwrap();
        assert_eq!(up_48k.len(), 48_000);
    }

    #[test]
    fn extracts_channels_and_detects_clipping() {
        let interleaved = vec![0.1_f32, 0.5, 0.2, 0.6];
        assert_eq!(extract_channel(&interleaved, 2, "left"), vec![0.1, 0.2]);
        assert_eq!(extract_channel(&interleaved, 2, "right"), vec![0.5, 0.6]);
        let mono = extract_channel(&interleaved, 2, "mono");
        assert!((mono[0] - 0.3).abs() < 1e-6);

        let wf = WaterfallAnalyzer::new(48_000);
        let mut loud = vec![0.0_f32; 4096];
        loud[100] = 0.995;
        let frame = wf.compute_frame(&loud);
        assert!(frame.clipped);
    }
}
