use std::f64::consts::PI;
use std::ffi::{c_char, c_float, c_int, CStr, CString};
use std::sync::Mutex;

use async_trait::async_trait;

use crate::audio::dsp::FT8_SAMPLE_RATE;
use crate::domain::clock::UnixSecs;
use crate::domain::ft8::{strip_decoder_metadata, validate_tx_message};
use crate::modem::{Ft8Decode, Ft8Decoder, ModemError};

const FT8_NUM_TONES: usize = 79;
const FT8_SYMBOL_PERIOD_SEC: f64 = 0.160;
const FT8_SLOT_SEC: f64 = 15.0;
const FT8_SYMBOL_BT: f64 = 2.0;
const GFSK_CONST_K: f64 = 5.336_446;
const MAX_DECODES_PER_SLOT: usize = 128;

#[repr(C)]
#[derive(Clone, Copy)]
struct DigidxFt8DecodeC {
    freq_hz: c_float,
    time_sec: c_float,
    snr_db: c_float,
    text: [c_char; 40],
}

impl Default for DigidxFt8DecodeC {
    fn default() -> Self {
        Self {
            freq_hz: 0.0,
            time_sec: 0.0,
            snr_db: 0.0,
            text: [0; 40],
        }
    }
}

extern "C" {
    fn digidx_erff(x: c_float) -> c_float;
    fn digidx_ft8_encode_tones(message: *const c_char, out_tones: *mut u8) -> c_int;
    fn digidx_ft8_decode_slot(
        samples: *const c_float,
        num_samples: c_int,
        sample_rate: c_int,
        f_min: c_float,
        f_max: c_float,
        out_decodes: *mut DigidxFt8DecodeC,
        max_decodes: c_int,
    ) -> c_int;
}

/// Serializes calls into `digidx_ft8_decode_slot` because `digidx_bridge.c` holds a static callsign hashtable.
static FT8_LIB_DECODE_LOCK: Mutex<()> = Mutex::new(());

pub struct Ft8LibTxModulator;

impl Ft8LibTxModulator {
    pub fn encode_tones(message: &str) -> Result<[u8; FT8_NUM_TONES], ModemError> {
        let normalized = validate_tx_message(message).map_err(ModemError::InvalidMessage)?;
        let c_msg = CString::new(normalized)
            .map_err(|e| ModemError::InvalidMessage(format!("interior NUL byte: {e}")))?;
        let mut tones = [0_u8; FT8_NUM_TONES];
        let rc = unsafe { digidx_ft8_encode_tones(c_msg.as_ptr(), tones.as_mut_ptr()) };
        if rc != 0 {
            return Err(ModemError::EncodeFailed(format!(
                "ft8_lib encode error code {rc} for '{message}'"
            )));
        }
        Ok(tones)
    }

    /// Synthesize continuous-phase 12.64-second FT8 GFSK PCM at `sample_rate` and base `af_hz`.
    pub fn synthesize_gfsk(
        tones: &[u8; FT8_NUM_TONES],
        af_hz: f32,
        sample_rate: u32,
    ) -> Result<Vec<f32>, ModemError> {
        if !(200.0..=3000.0).contains(&af_hz) {
            return Err(ModemError::EncodeFailed(format!(
                "af_hz {af_hz} outside FT8 passband 200..=3000 Hz"
            )));
        }
        if sample_rate < 8_000 {
            return Err(ModemError::EncodeFailed(format!(
                "sample_rate {sample_rate} too low (minimum 8000 Hz)"
            )));
        }

        let n_spsym = (0.5 + (sample_rate as f64) * FT8_SYMBOL_PERIOD_SEC) as usize;
        let n_wave = FT8_NUM_TONES * n_spsym;
        let n_pulse = 3 * n_spsym;

        let mut pulse = vec![0.0_f64; n_pulse];
        for (i, p) in pulse.iter_mut().enumerate() {
            let t = (i as f64) / (n_spsym as f64) - 1.5;
            let arg1 = (GFSK_CONST_K * FT8_SYMBOL_BT * (t + 0.5)) as c_float;
            let arg2 = (GFSK_CONST_K * FT8_SYMBOL_BT * (t - 0.5)) as c_float;
            let erf1 = unsafe { digidx_erff(arg1) } as f64;
            let erf2 = unsafe { digidx_erff(arg2) } as f64;
            *p = (erf1 - erf2) * 0.5;
        }

        let dphi_peak = 2.0 * PI / (n_spsym as f64);
        let base_dphi = 2.0 * PI * (af_hz as f64) / (sample_rate as f64);
        let mut dphi = vec![base_dphi; n_wave + 2 * n_spsym];

        for (i, &tone) in tones.iter().enumerate() {
            let ib = i * n_spsym;
            let t_val = tone as f64;
            for j in 0..n_pulse {
                dphi[j + ib] += dphi_peak * t_val * pulse[j];
            }
        }

        let first_tone = tones[0] as f64;
        let last_tone = tones[FT8_NUM_TONES - 1] as f64;
        for j in 0..(2 * n_spsym) {
            dphi[j] += dphi_peak * pulse[j + n_spsym] * first_tone;
            dphi[j + n_wave] += dphi_peak * pulse[j] * last_tone;
        }

        let mut signal = vec![0.0_f32; n_wave];
        let mut phi = 0.0_f64;
        for (k, out) in signal.iter_mut().enumerate() {
            *out = phi.sin() as f32;
            phi = (phi + dphi[k + n_spsym]).rem_euclid(2.0 * PI);
        }

        let n_ramp = (n_spsym / 8).max(1);
        for i in 0..n_ramp {
            let env = (1.0 - (2.0 * PI * (i as f64) / (2.0 * (n_ramp as f64))).cos()) * 0.5;
            let e = env as f32;
            signal[i] *= e;
            signal[n_wave - 1 - i] *= e;
        }

        Ok(signal)
    }

    /// Generate the active 12.64-second FT8 GFSK PCM for `message`.
    pub fn modulate_pcm(
        message: &str,
        af_hz: f32,
        sample_rate: u32,
    ) -> Result<Vec<f32>, ModemError> {
        let tones = Self::encode_tones(message)?;
        Self::synthesize_gfsk(&tones, af_hz, sample_rate)
    }

    /// Generate FT8 GFSK PCM starting `offset_ms` into the slot so late TX and mid-slot
    /// hot-swaps remain UTC-symbol-aligned and finish at t = 12.64 s with a smooth fade-in.
    pub fn modulate_pcm_from_offset(
        message: &str,
        af_hz: f32,
        sample_rate: u32,
        offset_ms: u64,
    ) -> Result<Vec<f32>, ModemError> {
        let mut signal = Self::modulate_pcm(message, af_hz, sample_rate)?;
        if offset_ms == 0 {
            return Ok(signal);
        }
        let skip_samples = ((offset_ms as f64) * (sample_rate as f64) / 1000.0).round() as usize;
        if skip_samples >= signal.len() {
            return Ok(Vec::new());
        }
        let mut tail = signal.split_off(skip_samples);
        let n_spsym = (0.5 + (sample_rate as f64) * FT8_SYMBOL_PERIOD_SEC) as usize;
        let n_ramp = (n_spsym / 8).max(1).min(tail.len());
        for (i, s) in tail.iter_mut().take(n_ramp).enumerate() {
            let env = (1.0 - (2.0 * PI * (i as f64) / (2.0 * (n_ramp as f64))).cos()) * 0.5;
            *s *= env as f32;
        }
        Ok(tail)
    }

    /// Generate a full 15.0-second slot PCM buffer with leading and trailing silence.
    pub fn modulate_slot_pcm(
        message: &str,
        af_hz: f32,
        sample_rate: u32,
        lead_silence_sec: f32,
    ) -> Result<Vec<f32>, ModemError> {
        let wave = Self::modulate_pcm(message, af_hz, sample_rate)?;
        let total_samples = (FT8_SLOT_SEC * (sample_rate as f64)).round() as usize;
        let lead_samples =
            ((lead_silence_sec.max(0.0) as f64) * (sample_rate as f64)).round() as usize;

        let mut slot = vec![0.0_f32; total_samples];
        if lead_samples < total_samples {
            let copy_len = wave.len().min(total_samples - lead_samples);
            slot[lead_samples..lead_samples + copy_len].copy_from_slice(&wave[..copy_len]);
        }
        Ok(slot)
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct Ft8LibEmbeddedDecoder;

impl Ft8LibEmbeddedDecoder {
    pub fn decode_slot_sync(
        &self,
        slot_ts: UnixSecs,
        samples_12k: &[f32],
    ) -> Result<Vec<Ft8Decode>, ModemError> {
        if samples_12k.is_empty() {
            return Ok(Vec::new());
        }

        let _guard = FT8_LIB_DECODE_LOCK
            .lock()
            .expect("ft8_lib decode lock poisoned");
        let mut raw = vec![DigidxFt8DecodeC::default(); MAX_DECODES_PER_SLOT];
        let count = unsafe {
            digidx_ft8_decode_slot(
                samples_12k.as_ptr(),
                samples_12k.len() as c_int,
                FT8_SAMPLE_RATE as c_int,
                200.0,
                3000.0,
                raw.as_mut_ptr(),
                MAX_DECODES_PER_SLOT as c_int,
            )
        };
        if count < 0 {
            return Err(ModemError::DecodeFailed(format!(
                "ft8_lib returned error status {count}"
            )));
        }

        let mut out = Vec::with_capacity(count as usize);
        for item in raw.iter().take(count as usize) {
            let text_raw = unsafe { CStr::from_ptr(item.text.as_ptr()) }
                .to_string_lossy()
                .into_owned();
            let (clean, meta) = strip_decoder_metadata(&text_raw);
            if clean.is_empty() {
                continue;
            }
            out.push(Ft8Decode {
                slot_ts,
                snr_db: item.snr_db.round().clamp(-50.0, 49.0) as i8,
                dt_sec: item.time_sec,
                af_hz: item.freq_hz.round().clamp(0.0, 5000.0) as u16,
                message: clean.to_string(),
                raw_metadata: meta.map(str::to_string),
                decoder_backend: "ft8_lib_fallback".to_string(),
            });
        }
        Ok(out)
    }
}

#[async_trait]
impl Ft8Decoder for Ft8LibEmbeddedDecoder {
    fn backend_name(&self) -> &'static str {
        "ft8_lib_fallback"
    }

    async fn decode_slot(
        &self,
        slot_ts: UnixSecs,
        samples_12k: &[f32],
    ) -> Result<Vec<Ft8Decode>, ModemError> {
        let pcm = samples_12k.to_vec();
        let decoder = *self;
        tokio::task::spawn_blocking(move || decoder.decode_slot_sync(slot_ts, &pcm))
            .await
            .map_err(|e| ModemError::DecodeFailed(format!("ft8_lib blocking task failed: {e}")))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offset_modulation_truncates_leading_samples_with_smooth_fade_in() {
        let full = Ft8LibTxModulator::modulate_pcm("CQ N1MPM FN33", 1500.0, 48_000).unwrap();
        assert_eq!(full.len(), 606_720);

        let zero_off =
            Ft8LibTxModulator::modulate_pcm_from_offset("CQ N1MPM FN33", 1500.0, 48_000, 0)
                .unwrap();
        assert_eq!(zero_off.len(), full.len());

        let late_5s =
            Ft8LibTxModulator::modulate_pcm_from_offset("CQ N1MPM FN33", 1500.0, 48_000, 5_000)
                .unwrap();
        assert_eq!(late_5s.len(), 606_720 - 240_000);
        assert!(late_5s[0].abs() < 1e-6);

        let past_end =
            Ft8LibTxModulator::modulate_pcm_from_offset("CQ N1MPM FN33", 1500.0, 48_000, 15_000)
                .unwrap();
        assert!(past_end.is_empty());
    }
}
