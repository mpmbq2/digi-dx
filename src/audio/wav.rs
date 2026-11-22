use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

use crate::audio::AudioError;

/// Write 16-bit signed PCM mono WAV file.
pub fn write_wav_16bit_mono(
    path: &Path,
    sample_rate: u32,
    samples: &[f32],
) -> Result<(), AudioError> {
    if sample_rate == 0 {
        return Err(AudioError::InvalidWav(
            "sample_rate must be non-zero".to_string(),
        ));
    }
    let data_bytes = u32::try_from(samples.len().saturating_mul(2))
        .map_err(|_| AudioError::InvalidWav("WAV payload exceeds 4 GiB RIFF limit".to_string()))?;
    let riff_size = data_bytes
        .checked_add(36)
        .ok_or_else(|| AudioError::InvalidWav("WAV size overflow".to_string()))?;
    let byte_rate = sample_rate
        .checked_mul(2)
        .ok_or_else(|| AudioError::InvalidWav("byte_rate overflow".to_string()))?;

    let file = File::create(path)?;
    let mut w = BufWriter::new(file);

    w.write_all(b"RIFF")?;
    w.write_all(&riff_size.to_le_bytes())?;
    w.write_all(b"WAVE")?;

    w.write_all(b"fmt ")?;
    w.write_all(&16_u32.to_le_bytes())?; // PCM fmt chunk size
    w.write_all(&1_u16.to_le_bytes())?; // PCM format = 1
    w.write_all(&1_u16.to_le_bytes())?; // Mono
    w.write_all(&sample_rate.to_le_bytes())?;
    w.write_all(&byte_rate.to_le_bytes())?;
    w.write_all(&2_u16.to_le_bytes())?; // Block align = 2 bytes
    w.write_all(&16_u16.to_le_bytes())?; // Bits per sample = 16

    w.write_all(b"data")?;
    w.write_all(&data_bytes.to_le_bytes())?;

    for &s in samples {
        let clamped = if s.is_finite() {
            s.clamp(-1.0, 1.0)
        } else {
            0.0
        };
        let q = (clamped * 32767.0).round() as i16;
        w.write_all(&q.to_le_bytes())?;
    }
    w.flush()?;
    Ok(())
}

/// Read a 16-bit PCM WAV file and return `(sample_rate, mono_f32_samples)`.
/// Stereo inputs are downmixed to mono; extra RIFF metadata chunks are skipped.
pub fn read_wav_mono_f32(path: &Path) -> Result<(u32, Vec<f32>), AudioError> {
    let file = File::open(path)?;
    let mut r = BufReader::new(file);

    let mut header = [0_u8; 12];
    r.read_exact(&mut header)
        .map_err(|e| AudioError::InvalidWav(format!("short RIFF header: {e}")))?;
    if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" {
        return Err(AudioError::InvalidWav(
            "missing RIFF/WAVE header".to_string(),
        ));
    }

    let mut fmt_channels: Option<u16> = None;
    let mut fmt_sample_rate: Option<u32> = None;
    let mut fmt_bits_per_sample: Option<u16> = None;
    let mut data_bytes: Option<Vec<u8>> = None;

    loop {
        let mut chunk_hdr = [0_u8; 8];
        match r.read_exact(&mut chunk_hdr) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(AudioError::Io(e)),
        }
        let chunk_id = &chunk_hdr[0..4];
        let chunk_len =
            u32::from_le_bytes([chunk_hdr[4], chunk_hdr[5], chunk_hdr[6], chunk_hdr[7]]) as usize;

        if chunk_id == b"fmt " {
            if chunk_len < 16 {
                return Err(AudioError::InvalidWav(
                    "fmt chunk smaller than 16 bytes".into(),
                ));
            }
            let mut fmt_buf = vec![0_u8; chunk_len];
            r.read_exact(&mut fmt_buf)?;
            let audio_format = u16::from_le_bytes([fmt_buf[0], fmt_buf[1]]);
            if audio_format != 1 {
                return Err(AudioError::InvalidWav(format!(
                    "unsupported WAV audio format {audio_format} (expected PCM = 1)"
                )));
            }
            let channels = u16::from_le_bytes([fmt_buf[2], fmt_buf[3]]);
            let sample_rate = u32::from_le_bytes([fmt_buf[4], fmt_buf[5], fmt_buf[6], fmt_buf[7]]);
            let bits = u16::from_le_bytes([fmt_buf[14], fmt_buf[15]]);
            if bits != 16 {
                return Err(AudioError::InvalidWav(format!(
                    "unsupported WAV bit depth {bits} (expected 16-bit PCM)"
                )));
            }
            if channels != 1 && channels != 2 {
                return Err(AudioError::InvalidWav(format!(
                    "unsupported WAV channel count {channels} (expected 1 or 2)"
                )));
            }
            fmt_channels = Some(channels);
            fmt_sample_rate = Some(sample_rate);
            fmt_bits_per_sample = Some(bits);
        } else if chunk_id == b"data" {
            let mut buf = vec![0_u8; chunk_len];
            r.read_exact(&mut buf)?;
            data_bytes = Some(buf);
        } else {
            r.seek(SeekFrom::Current(chunk_len as i64))?;
        }

        if chunk_len % 2 == 1 {
            let _ = r.seek(SeekFrom::Current(1));
        }

        if fmt_sample_rate.is_some() && data_bytes.is_some() {
            break;
        }
    }

    let sample_rate =
        fmt_sample_rate.ok_or_else(|| AudioError::InvalidWav("missing fmt chunk".into()))?;
    let channels =
        fmt_channels.ok_or_else(|| AudioError::InvalidWav("missing channel count".into()))?;
    let _bits =
        fmt_bits_per_sample.ok_or_else(|| AudioError::InvalidWav("missing bit depth".into()))?;
    let raw = data_bytes.ok_or_else(|| AudioError::InvalidWav("missing data chunk".into()))?;

    let frame_bytes = usize::from(channels) * 2;
    let num_frames = raw.len() / frame_bytes;
    let mut out = Vec::with_capacity(num_frames);

    for frame in raw.chunks_exact(frame_bytes) {
        if channels == 1 {
            let s = i16::from_le_bytes([frame[0], frame[1]]) as f32 / 32768.0;
            out.push(s);
        } else {
            let l = i16::from_le_bytes([frame[0], frame[1]]) as f32 / 32768.0;
            let r_ch = i16::from_le_bytes([frame[2], frame[3]]) as f32 / 32768.0;
            out.push((l + r_ch) * 0.5);
        }
    }

    Ok((sample_rate, out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn roundtrips_16bit_mono_wav() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("tone.wav");
        let input: Vec<f32> = (0..1200)
            .map(|i| (2.0 * std::f32::consts::PI * 1000.0 * (i as f32) / 12000.0).sin() * 0.75)
            .collect();

        write_wav_16bit_mono(&path, 12_000, &input).unwrap();
        let (rate, decoded) = read_wav_mono_f32(&path).unwrap();
        assert_eq!(rate, 12_000);
        assert_eq!(decoded.len(), input.len());
        let max_err = input
            .iter()
            .zip(decoded.iter())
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        assert!(
            max_err < 1e-4,
            "unexpected 16-bit quantization error: {max_err}"
        );
    }
}
