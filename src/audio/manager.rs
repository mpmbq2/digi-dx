use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc as std_mpsc, Arc, Mutex};

use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use tokio::sync::mpsc;

use crate::audio::devices::{
    enumerate_audio_devices, lock_audio_open, match_audio_device, resolve_cpal_input_device,
    resolve_cpal_output_device, AudioDeviceInfo, AudioMatchOutcome,
};
use crate::audio::dsp::{
    apply_gain_db, extract_channel, resample_mono, StreamingResampler, WaterfallAnalyzer,
    WaterfallFrame, DSP_SAMPLE_RATE, FT8_SAMPLE_RATE, FT8_SLOT_SAMPLES_12K,
};
use crate::audio::AudioError;

pub type FaultCallback = Arc<dyn Fn(String) + Send + Sync>;

pub struct AudioCaptureHandle {
    stop_tx: Option<std_mpsc::Sender<()>>,
    join: Option<std::thread::JoinHandle<()>>,
    slot_buffer: Arc<Mutex<Vec<f32>>>,
}

impl AudioCaptureHandle {
    pub fn start(
        device_name: &str,
        rx_channel: &str,
        wf_tx: Option<mpsc::Sender<WaterfallFrame>>,
        on_fault: FaultCallback,
    ) -> Result<Self, AudioError> {
        let target = device_name.to_string();
        let rx_ch = rx_channel.to_string();
        let slot_buffer = Arc::new(Mutex::new(Vec::with_capacity(FT8_SLOT_SAMPLES_12K)));
        let slot_buf_worker = Arc::clone(&slot_buffer);

        let (ready_tx, ready_rx) = std_mpsc::sync_channel::<Result<(), AudioError>>(1);
        let (stop_tx, stop_rx) = std_mpsc::channel::<()>();

        let join = std::thread::Builder::new()
            .name("digidx-audio-rx".to_string())
            .spawn(move || {
                run_capture_thread(
                    target,
                    rx_ch,
                    slot_buf_worker,
                    wf_tx,
                    on_fault,
                    ready_tx,
                    stop_rx,
                );
            })
            .map_err(|e| AudioError::StreamError(format!("failed to spawn RX thread: {e}")))?;

        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                stop_tx: Some(stop_tx),
                join: Some(join),
                slot_buffer,
            }),
            Ok(Err(e)) => {
                let _ = join.join();
                Err(e)
            }
            Err(_) => {
                let _ = join.join();
                Err(AudioError::StreamError(
                    "RX audio thread exited during startup".to_string(),
                ))
            }
        }
    }

    pub fn drain_slot_samples(&self) -> Vec<f32> {
        let mut guard = self.slot_buffer.lock().expect("slot buffer lock poisoned");
        std::mem::take(&mut *guard)
    }

    /// Clone all samples currently buffered for the active slot without removing them.
    pub fn snapshot_slot_samples(&self) -> Vec<f32> {
        let guard = self.slot_buffer.lock().expect("slot buffer lock poisoned");
        guard.clone()
    }

    /// Prepend `count` zero samples so a live session started mid-slot preserves FT8 DT alignment.
    pub fn seed_leading_silence(&self, count: usize) {
        if count == 0 {
            return;
        }
        let mut guard = self.slot_buffer.lock().expect("slot buffer lock poisoned");
        let capped = count.min(FT8_SLOT_SAMPLES_12K);
        let mut padded = Vec::with_capacity(capped + guard.len());
        padded.resize(capped, 0.0);
        padded.extend_from_slice(&guard);
        *guard = padded;
    }

    /// Advance the capture buffer to a newly opened slot boundary, retaining only the newest
    /// `keep_tail_samples` captured after the boundary instant.
    pub fn reset_for_new_slot(&self, keep_tail_samples: usize) {
        let mut guard = self.slot_buffer.lock().expect("slot buffer lock poisoned");
        if keep_tail_samples == 0 {
            guard.clear();
        } else if guard.len() > keep_tail_samples {
            let drop_count = guard.len() - keep_tail_samples;
            guard.drain(..drop_count);
        }
    }

    pub fn discard_oldest_samples(&self, count: usize) {
        let mut guard = self.slot_buffer.lock().expect("slot buffer lock poisoned");
        let n = count.min(guard.len());
        guard.drain(..n);
    }

    pub fn buffered_len(&self) -> usize {
        self.slot_buffer
            .lock()
            .expect("slot buffer lock poisoned")
            .len()
    }

    #[cfg(test)]
    pub(crate) fn from_slot_buffer_for_test(slot_buffer: Arc<Mutex<Vec<f32>>>) -> Self {
        Self {
            stop_tx: None,
            join: None,
            slot_buffer,
        }
    }

    pub fn stop(&mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

impl Drop for AudioCaptureHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

struct PlaybackBuffer {
    pcm: Vec<f32>,
    cursor: usize,
}

pub struct AudioPlaybackHandle {
    abort_flag: Arc<AtomicBool>,
    finished_flag: Arc<AtomicBool>,
    buffer: Arc<Mutex<PlaybackBuffer>>,
    out_rate: u32,
    tx_gain_db: f64,
    stop_tx: Mutex<Option<std_mpsc::Sender<()>>>,
    join: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl AudioPlaybackHandle {
    pub fn start(
        device_name: &str,
        samples_48k: Vec<f32>,
        tx_gain_db: f64,
        on_fault: FaultCallback,
    ) -> Result<Self, AudioError> {
        let target = device_name.to_string();
        let abort_flag = Arc::new(AtomicBool::new(false));
        let finished_flag = Arc::new(AtomicBool::new(false));
        let buffer = Arc::new(Mutex::new(PlaybackBuffer {
            pcm: Vec::new(),
            cursor: 0,
        }));
        let abort_worker = Arc::clone(&abort_flag);
        let finished_worker = Arc::clone(&finished_flag);
        let buffer_worker = Arc::clone(&buffer);

        let (ready_tx, ready_rx) = std_mpsc::sync_channel::<Result<u32, AudioError>>(1);
        let (stop_tx, stop_rx) = std_mpsc::channel::<()>();

        let join = std::thread::Builder::new()
            .name("digidx-audio-tx".to_string())
            .spawn(move || {
                run_playback_thread(
                    target,
                    samples_48k,
                    tx_gain_db,
                    buffer_worker,
                    abort_worker,
                    finished_worker,
                    on_fault,
                    ready_tx,
                    stop_rx,
                );
            })
            .map_err(|e| AudioError::StreamError(format!("failed to spawn TX thread: {e}")))?;

        match ready_rx.recv() {
            Ok(Ok(out_rate)) => Ok(Self {
                abort_flag,
                finished_flag,
                buffer,
                out_rate,
                tx_gain_db,
                stop_tx: Mutex::new(Some(stop_tx)),
                join: Mutex::new(Some(join)),
            }),
            Ok(Err(e)) => {
                let _ = join.join();
                Err(e)
            }
            Err(_) => {
                let _ = join.join();
                Err(AudioError::StreamError(
                    "TX audio thread exited during startup".to_string(),
                ))
            }
        }
    }

    /// Hot-swap the active TX playback buffer in place without dropping PTT or reopening audio.
    pub fn replace_samples(&self, samples_48k: Vec<f32>) -> Result<(), AudioError> {
        let mut pcm = resample_mono(&samples_48k, DSP_SAMPLE_RATE, self.out_rate)?;
        apply_gain_db(&mut pcm, self.tx_gain_db);

        let mut guard = self.buffer.lock().expect("tx playback buffer poisoned");
        let prev_sample = guard
            .pcm
            .get(guard.cursor.saturating_sub(1))
            .copied()
            .unwrap_or(0.0);
        if prev_sample.abs() > 1e-4 && !pcm.is_empty() {
            let decay_len = ((self.out_rate as usize) / 500).max(1).min(pcm.len());
            for (i, s) in pcm.iter_mut().take(decay_len).enumerate() {
                let t = 1.0 - (i as f32) / (decay_len as f32);
                *s = (*s + prev_sample * t).clamp(-0.98, 0.98);
            }
        }
        guard.pcm = pcm;
        guard.cursor = 0;
        self.finished_flag.store(false, Ordering::SeqCst);
        Ok(())
    }

    pub fn abort_handle(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.abort_flag)
    }

    pub fn is_finished(&self) -> bool {
        self.finished_flag.load(Ordering::SeqCst)
    }

    pub fn abort(&self) {
        self.abort_flag.store(true, Ordering::SeqCst);
    }

    pub fn stop(&self) {
        self.abort();
        if let Some(tx) = self.stop_tx.lock().expect("tx stop_tx poisoned").take() {
            let _ = tx.send(());
        }
        if let Some(j) = self.join.lock().expect("tx join poisoned").take() {
            let _ = j.join();
        }
    }

    #[cfg(test)]
    pub(crate) fn from_buffer_for_test(
        pcm: Vec<f32>,
        cursor: usize,
        out_rate: u32,
        tx_gain_db: f64,
    ) -> Self {
        Self {
            abort_flag: Arc::new(AtomicBool::new(false)),
            finished_flag: Arc::new(AtomicBool::new(cursor >= pcm.len())),
            buffer: Arc::new(Mutex::new(PlaybackBuffer { pcm, cursor })),
            out_rate,
            tx_gain_db,
            stop_tx: Mutex::new(None),
            join: Mutex::new(None),
        }
    }
}

impl Drop for AudioPlaybackHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

pub struct AudioManager;

impl AudioManager {
    pub fn enumerate_devices() -> Vec<AudioDeviceInfo> {
        enumerate_audio_devices()
    }

    pub fn match_device(
        saved_uid: Option<&str>,
        saved_name: Option<&str>,
        available: &[AudioDeviceInfo],
    ) -> AudioMatchOutcome {
        match_audio_device(saved_uid, saved_name, available)
    }

    pub fn start_capture(
        device_name: &str,
        rx_channel: &str,
        wf_tx: Option<mpsc::Sender<WaterfallFrame>>,
        on_fault: FaultCallback,
    ) -> Result<AudioCaptureHandle, AudioError> {
        AudioCaptureHandle::start(device_name, rx_channel, wf_tx, on_fault)
    }

    pub fn start_playback(
        device_name: &str,
        samples_48k: Vec<f32>,
        tx_gain_db: f64,
        on_fault: FaultCallback,
    ) -> Result<AudioPlaybackHandle, AudioError> {
        AudioPlaybackHandle::start(device_name, samples_48k, tx_gain_db, on_fault)
    }
}

fn select_input_config(dev: &cpal::Device) -> Result<(StreamConfig, SampleFormat), AudioError> {
    if let Ok(ranges) = dev.supported_input_configs() {
        for range in ranges {
            if range.min_sample_rate().0 <= DSP_SAMPLE_RATE
                && range.max_sample_rate().0 >= DSP_SAMPLE_RATE
                && matches!(
                    range.sample_format(),
                    SampleFormat::F32 | SampleFormat::I16 | SampleFormat::U16
                )
            {
                let fmt = range.sample_format();
                let cfg = range.with_sample_rate(cpal::SampleRate(DSP_SAMPLE_RATE));
                return Ok((cfg.into(), fmt));
            }
        }
    }

    let def = dev
        .default_input_config()
        .map_err(|e| AudioError::UnsupportedConfig(e.to_string()))?;
    let fmt = def.sample_format();
    Ok((def.into(), fmt))
}

fn select_output_config(dev: &cpal::Device) -> Result<(StreamConfig, SampleFormat), AudioError> {
    if let Ok(ranges) = dev.supported_output_configs() {
        for range in ranges {
            if range.min_sample_rate().0 <= DSP_SAMPLE_RATE
                && range.max_sample_rate().0 >= DSP_SAMPLE_RATE
                && matches!(
                    range.sample_format(),
                    SampleFormat::F32 | SampleFormat::I16 | SampleFormat::U16
                )
            {
                let fmt = range.sample_format();
                let cfg = range.with_sample_rate(cpal::SampleRate(DSP_SAMPLE_RATE));
                return Ok((cfg.into(), fmt));
            }
        }
    }

    let def = dev
        .default_output_config()
        .map_err(|e| AudioError::UnsupportedConfig(e.to_string()))?;
    let fmt = def.sample_format();
    Ok((def.into(), fmt))
}

fn run_capture_thread(
    device_name: String,
    rx_channel: String,
    slot_buffer: Arc<Mutex<Vec<f32>>>,
    wf_tx: Option<mpsc::Sender<WaterfallFrame>>,
    on_fault: FaultCallback,
    ready_tx: std_mpsc::SyncSender<Result<(), AudioError>>,
    stop_rx: std_mpsc::Receiver<()>,
) {
    let stream = {
        let _open_guard = lock_audio_open();
        let Some(dev) = resolve_cpal_input_device(&device_name) else {
            let _ = ready_tx.send(Err(AudioError::DeviceNotFound(device_name)));
            return;
        };

        let (config, fmt) = match select_input_config(&dev) {
            Ok(c) => c,
            Err(e) => {
                let _ = ready_tx.send(Err(e));
                return;
            }
        };

        let sample_rate = config.sample_rate.0;
        let channels = config.channels as usize;
        let resampler = match StreamingResampler::new(sample_rate, FT8_SAMPLE_RATE) {
            Ok(r) => Arc::new(Mutex::new(r)),
            Err(e) => {
                let _ = ready_tx.send(Err(e));
                return;
            }
        };
        let analyzer = Arc::new(Mutex::new(WaterfallAnalyzer::new(sample_rate)));

        let handle_samples = move |mono_in: Vec<f32>| {
            if mono_in.is_empty() {
                return;
            }
            if let Some(ref tx) = wf_tx {
                if let Ok(mut wf) = analyzer.lock() {
                    for frame in wf.push_samples(&mono_in) {
                        let _ = tx.try_send(frame);
                    }
                }
            }
            if let Ok(mut res) = resampler.lock() {
                if let Ok(pcm_12k) = res.push(&mono_in) {
                    if !pcm_12k.is_empty() {
                        if let Ok(mut buf) = slot_buffer.lock() {
                            buf.extend_from_slice(&pcm_12k);
                            let cap = FT8_SLOT_SAMPLES_12K * 2;
                            if buf.len() > cap {
                                let excess = buf.len() - cap;
                                buf.drain(..excess);
                            }
                        }
                    }
                }
            }
        };

        let fault_cb = Arc::clone(&on_fault);
        let err_fn = move |err: cpal::StreamError| {
            fault_cb(format!("RX audio stream error: {err}"));
        };

        let stream_res = match fmt {
            SampleFormat::F32 => {
                let ch = rx_channel.clone();
                dev.build_input_stream(
                    &config,
                    move |data: &[f32], _| {
                        handle_samples(extract_channel(data, channels, &ch));
                    },
                    err_fn,
                    None,
                )
            }
            SampleFormat::I16 => {
                let ch = rx_channel.clone();
                dev.build_input_stream(
                    &config,
                    move |data: &[i16], _| {
                        let f: Vec<f32> = data.iter().map(|&s| (s as f32) / 32768.0).collect();
                        handle_samples(extract_channel(&f, channels, &ch));
                    },
                    err_fn,
                    None,
                )
            }
            SampleFormat::U16 => {
                let ch = rx_channel.clone();
                dev.build_input_stream(
                    &config,
                    move |data: &[u16], _| {
                        let f: Vec<f32> = data
                            .iter()
                            .map(|&s| ((s as f32) - 32768.0) / 32768.0)
                            .collect();
                        handle_samples(extract_channel(&f, channels, &ch));
                    },
                    err_fn,
                    None,
                )
            }
            other => {
                let _ = ready_tx.send(Err(AudioError::UnsupportedConfig(format!(
                    "unsupported RX sample format: {other:?}"
                ))));
                return;
            }
        };

        let stream = match stream_res {
            Ok(s) => s,
            Err(e) => {
                let _ = ready_tx.send(Err(AudioError::StreamError(e.to_string())));
                return;
            }
        };
        // Drop cpal::Device so ALSA releases the unused playback PCM handle while RX runs.
        #[allow(clippy::drop_non_drop)]
        drop(dev);
        stream
    };

    if let Err(e) = stream.play() {
        let _ = ready_tx.send(Err(AudioError::StreamError(e.to_string())));
        return;
    }

    let _ = ready_tx.send(Ok(()));
    let _ = stop_rx.recv();
    drop(stream);
}

#[allow(clippy::too_many_arguments)]
fn run_playback_thread(
    device_name: String,
    samples_48k: Vec<f32>,
    tx_gain_db: f64,
    buffer: Arc<Mutex<PlaybackBuffer>>,
    abort_flag: Arc<AtomicBool>,
    finished_flag: Arc<AtomicBool>,
    on_fault: FaultCallback,
    ready_tx: std_mpsc::SyncSender<Result<u32, AudioError>>,
    stop_rx: std_mpsc::Receiver<()>,
) {
    let (stream, out_rate) = {
        let _open_guard = lock_audio_open();
        let Some(dev) = resolve_cpal_output_device(&device_name) else {
            let _ = ready_tx.send(Err(AudioError::DeviceNotFound(device_name)));
            return;
        };

        let (config, fmt) = match select_output_config(&dev) {
            Ok(c) => c,
            Err(e) => {
                let _ = ready_tx.send(Err(e));
                return;
            }
        };

        let out_rate = config.sample_rate.0;
        let channels = config.channels as usize;
        let mut pcm = match resample_mono(&samples_48k, DSP_SAMPLE_RATE, out_rate) {
            Ok(v) => v,
            Err(e) => {
                let _ = ready_tx.send(Err(e));
                return;
            }
        };
        apply_gain_db(&mut pcm, tx_gain_db);

        {
            let mut guard = buffer.lock().expect("tx playback buffer poisoned");
            guard.pcm = pcm;
            guard.cursor = 0;
        }
        let err_fn = move |err: cpal::StreamError| {
            on_fault(format!("TX audio stream error: {err}"));
        };

        let stream_res = match fmt {
            SampleFormat::F32 => {
                let buf = Arc::clone(&buffer);
                let ab = Arc::clone(&abort_flag);
                let fin = Arc::clone(&finished_flag);
                dev.build_output_stream(
                    &config,
                    move |data: &mut [f32], _| {
                        let mut guard = buf.lock().expect("tx playback buffer poisoned");
                        for frame in data.chunks_mut(channels) {
                            let val =
                                if ab.load(Ordering::SeqCst) || guard.cursor >= guard.pcm.len() {
                                    fin.store(true, Ordering::SeqCst);
                                    0.0
                                } else {
                                    let s = guard.pcm[guard.cursor];
                                    guard.cursor += 1;
                                    if guard.cursor >= guard.pcm.len() {
                                        fin.store(true, Ordering::SeqCst);
                                    }
                                    s
                                };
                            frame.fill(val);
                        }
                    },
                    err_fn,
                    None,
                )
            }
            SampleFormat::I16 => {
                let buf = Arc::clone(&buffer);
                let ab = Arc::clone(&abort_flag);
                let fin = Arc::clone(&finished_flag);
                dev.build_output_stream(
                    &config,
                    move |data: &mut [i16], _| {
                        let mut guard = buf.lock().expect("tx playback buffer poisoned");
                        for frame in data.chunks_mut(channels) {
                            let val =
                                if ab.load(Ordering::SeqCst) || guard.cursor >= guard.pcm.len() {
                                    fin.store(true, Ordering::SeqCst);
                                    0_i16
                                } else {
                                    let s = (guard.pcm[guard.cursor].clamp(-1.0, 1.0) * 32767.0)
                                        .round() as i16;
                                    guard.cursor += 1;
                                    if guard.cursor >= guard.pcm.len() {
                                        fin.store(true, Ordering::SeqCst);
                                    }
                                    s
                                };
                            frame.fill(val);
                        }
                    },
                    err_fn,
                    None,
                )
            }
            SampleFormat::U16 => {
                let buf = Arc::clone(&buffer);
                let ab = Arc::clone(&abort_flag);
                let fin = Arc::clone(&finished_flag);
                dev.build_output_stream(
                    &config,
                    move |data: &mut [u16], _| {
                        let mut guard = buf.lock().expect("tx playback buffer poisoned");
                        for frame in data.chunks_mut(channels) {
                            let val =
                                if ab.load(Ordering::SeqCst) || guard.cursor >= guard.pcm.len() {
                                    fin.store(true, Ordering::SeqCst);
                                    32768_u16
                                } else {
                                    let s = ((guard.pcm[guard.cursor].clamp(-1.0, 1.0) * 32767.0)
                                        + 32768.0)
                                        .round() as u16;
                                    guard.cursor += 1;
                                    if guard.cursor >= guard.pcm.len() {
                                        fin.store(true, Ordering::SeqCst);
                                    }
                                    s
                                };
                            frame.fill(val);
                        }
                    },
                    err_fn,
                    None,
                )
            }
            other => {
                let _ = ready_tx.send(Err(AudioError::UnsupportedConfig(format!(
                    "unsupported TX sample format: {other:?}"
                ))));
                return;
            }
        };

        let stream = match stream_res {
            Ok(s) => s,
            Err(e) => {
                let _ = ready_tx.send(Err(AudioError::StreamError(e.to_string())));
                return;
            }
        };
        // Drop cpal::Device so unused capture handle is released immediately.
        #[allow(clippy::drop_non_drop)]
        drop(dev);
        (stream, out_rate)
    };

    if let Err(e) = stream.play() {
        let _ = ready_tx.send(Err(AudioError::StreamError(e.to_string())));
        return;
    }

    let _ = ready_tx.send(Ok(out_rate));
    let _ = stop_rx.recv();
    drop(stream);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_seed_and_reset_preserve_slot_alignment() {
        let buf = Arc::new(Mutex::new(vec![1.0_f32, 2.0, 3.0, 4.0]));
        let handle = AudioCaptureHandle::from_slot_buffer_for_test(buf);

        // Non-destructive snapshot leaves samples intact across multiple passes.
        assert_eq!(handle.snapshot_slot_samples(), vec![1.0, 2.0, 3.0, 4.0]);
        assert_eq!(handle.snapshot_slot_samples(), vec![1.0, 2.0, 3.0, 4.0]);
        assert_eq!(handle.buffered_len(), 4);

        // Leading silence seeding prepends zeros and caps at FT8_SLOT_SAMPLES_12K.
        handle.seed_leading_silence(3);
        assert_eq!(
            handle.snapshot_slot_samples(),
            vec![0.0, 0.0, 0.0, 1.0, 2.0, 3.0, 4.0]
        );

        // Boundary reset retains only the newest `keep_tail_samples`.
        handle.reset_for_new_slot(2);
        assert_eq!(handle.snapshot_slot_samples(), vec![3.0, 4.0]);

        // Zero tail clears completely.
        handle.reset_for_new_slot(0);
        assert!(handle.snapshot_slot_samples().is_empty());

        // Seeding over FT8_SLOT_SAMPLES_12K is capped safely.
        handle.seed_leading_silence(FT8_SLOT_SAMPLES_12K + 500);
        assert_eq!(handle.buffered_len(), FT8_SLOT_SAMPLES_12K);
    }

    #[test]
    fn playback_replace_samples_resets_cursor_and_blends_transition() {
        let handle =
            AudioPlaybackHandle::from_buffer_for_test(vec![0.8_f32; 100], 100, 48_000, 0.0);
        assert!(handle.is_finished());

        handle.replace_samples(vec![0.0_f32; 480]).unwrap();
        assert!(!handle.is_finished());

        let guard = handle.buffer.lock().unwrap();
        assert_eq!(guard.cursor, 0);
        assert_eq!(guard.pcm.len(), 480);
        // Leading sample smoothly blends down from previous 0.8 instead of jumping abruptly.
        assert!((guard.pcm[0] - 0.8).abs() < 1e-4);
        assert!(guard.pcm[96].abs() < 1e-4);
    }
}
