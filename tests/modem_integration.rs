use std::path::Path;
use std::time::{Duration, Instant};

use digi_dx::audio::dsp::{
    resample_48k_to_12k, DSP_SAMPLE_RATE, FT8_SAMPLE_RATE, FT8_SLOT_SAMPLES_12K,
};
use digi_dx::audio::wav::read_wav_mono_f32;
use digi_dx::domain::clock::UnixSecs;
use digi_dx::modem::ft8_lib::{Ft8LibEmbeddedDecoder, Ft8LibTxModulator};
use digi_dx::modem::jt9::{parse_jt9_stdout, Jt9SubprocessDecoder};
use digi_dx::modem::{DecodePassOptions, Ft8Decode, Ft8Decoder, HybridFt8Decoder};
use digi_dx::qso::reconciler::{ReconcileOutcome, SlotDecodeReconciler};
use tempfile::tempdir;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn offline_wav_fixture_decodes_with_both_jt9_and_ft8_lib() {
    let wav_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("191111_110200.wav");
    let (sample_rate, samples_12k) = read_wav_mono_f32(&wav_path).unwrap();
    assert_eq!(sample_rate, FT8_SAMPLE_RATE);

    let slot_ts = UnixSecs(1_573_470_120);
    let expected = [
        ("CQ TA6CQ KN70", 678..=688),
        ("CQ LZ1JZ KN22", 1026..=1036),
        ("CQ R7IW LN35", 1287..=1297),
        ("CQ DX R6WA LN32", 2092..=2102),
    ];

    let embedded = Ft8LibEmbeddedDecoder;
    let emb_decodes = embedded.decode_slot(slot_ts, &samples_12k).await.unwrap();
    for (msg, af_range) in &expected {
        let hit = emb_decodes
            .iter()
            .find(|d| d.message == *msg)
            .unwrap_or_else(|| panic!("ft8_lib missed expected message '{msg}': {emb_decodes:?}"));
        assert_eq!(hit.decoder_backend, "ft8_lib_fallback");
        assert!(
            af_range.contains(&hit.af_hz),
            "ft8_lib AF {} out of {:?} for '{}'",
            hit.af_hz,
            af_range,
            msg
        );
    }

    if let Some(jt9_bin) = HybridFt8Decoder::resolve_jt9_path(None) {
        let jt9 = Jt9SubprocessDecoder::new(jt9_bin);
        let jt9_decodes = jt9.decode_slot(slot_ts, &samples_12k).await.unwrap();
        for (msg, af_range) in &expected {
            let hit = jt9_decodes
                .iter()
                .find(|d| d.message == *msg)
                .unwrap_or_else(|| panic!("jt9 missed expected message '{msg}': {jt9_decodes:?}"));
            assert_eq!(hit.decoder_backend, "jt9");
            assert!(
                af_range.contains(&hit.af_hz),
                "jt9 AF {} out of {:?} for '{}'",
                hit.af_hz,
                af_range,
                msg
            );
        }
    }

    // Verify jt9 metadata suffix stripping contract
    let parsed = parse_jt9_stdout(
        slot_ts,
        "110200   6  0.9 1234 ~  GJ0KYZ RK9AX MO05                       ? a1\n<DecodeFinished> 0 1 0\n",
    );
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].message, "GJ0KYZ RK9AX MO05");
    assert_eq!(parsed[0].raw_metadata.as_deref(), Some("? a1"));
}

#[tokio::test]
async fn loopback_encode_resample_decode_recovers_message_and_af_within_5hz() {
    let slot_ts = UnixSecs(1_795_212_900);
    let slot_48k =
        Ft8LibTxModulator::modulate_slot_pcm("CQ N1MPM FN33", 1420.0, DSP_SAMPLE_RATE, 0.5)
            .unwrap();
    let slot_12k = resample_48k_to_12k(&slot_48k).unwrap();
    assert_eq!(slot_12k.len(), FT8_SLOT_SAMPLES_12K);

    let embedded = Ft8LibEmbeddedDecoder;
    let emb_decodes = embedded.decode_slot(slot_ts, &slot_12k).await.unwrap();
    let emb_hit = emb_decodes
        .iter()
        .find(|d| d.message == "CQ N1MPM FN33")
        .expect("ft8_lib failed loopback decode for CQ N1MPM FN33");
    assert!(
        (1415..=1425).contains(&emb_hit.af_hz),
        "ft8_lib loopback AF {} not within ±5 Hz of 1420",
        emb_hit.af_hz
    );

    if let Some(jt9_bin) = HybridFt8Decoder::resolve_jt9_path(None) {
        let jt9 = Jt9SubprocessDecoder::new(jt9_bin);
        let jt9_decodes = jt9.decode_slot(slot_ts, &slot_12k).await.unwrap();
        let jt9_hit = jt9_decodes
            .iter()
            .find(|d| d.message == "CQ N1MPM FN33")
            .expect("jt9 failed loopback decode for CQ N1MPM FN33");
        assert!(
            (1415..=1425).contains(&jt9_hit.af_hz),
            "jt9 loopback AF {} not within ±5 Hz of 1420",
            jt9_hit.af_hz
        );
    }
}

#[tokio::test]
async fn hybrid_decoder_falls_back_to_ft8_lib_when_jt9_missing() {
    let wav_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("191111_110200.wav");
    let (_, samples_12k) = read_wav_mono_f32(&wav_path).unwrap();

    let hybrid = HybridFt8Decoder::new(Some(Path::new("/nonexistent/digi-dx/jt9")));
    assert_eq!(hybrid.active_backend_name(), "ft8_lib_fallback");
    assert_eq!(hybrid.backend_name(), "ft8_lib_fallback");

    let decodes = hybrid
        .decode_slot(UnixSecs(1_573_470_120), &samples_12k)
        .await
        .unwrap();
    assert!(decodes.iter().any(|d| d.message == "CQ DX R6WA LN32"));
}

#[tokio::test]
async fn loopback_73_and_14s_padded_slot_decode_with_ft8_lib_and_jt9() {
    let slot_ts = UnixSecs(1_795_212_930);
    let slot_48k =
        Ft8LibTxModulator::modulate_slot_pcm("K1ABC N1MPM 73", 1500.0, DSP_SAMPLE_RATE, 0.4)
            .unwrap();
    let mut slot_12k = resample_48k_to_12k(&slot_48k).unwrap();
    let samples_14s = 14 * FT8_SAMPLE_RATE as usize;
    slot_12k.truncate(samples_14s);
    slot_12k.resize(FT8_SLOT_SAMPLES_12K, 0.0);

    let embedded = Ft8LibEmbeddedDecoder;
    let emb_decodes = embedded.decode_slot(slot_ts, &slot_12k).await.unwrap();
    let emb_hit = emb_decodes
        .iter()
        .find(|d| d.message == "K1ABC N1MPM 73")
        .unwrap_or_else(|| panic!("ft8_lib failed loopback decode for 73: {emb_decodes:?}"));
    assert!(
        (1495..=1505).contains(&emb_hit.af_hz),
        "ft8_lib loopback 73 AF {} not within ±5 Hz of 1500",
        emb_hit.af_hz
    );

    let wav_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("191111_110200.wav");
    let (_, mut wav_12k) = read_wav_mono_f32(&wav_path).unwrap();
    wav_12k.truncate(samples_14s);
    wav_12k.resize(FT8_SLOT_SAMPLES_12K, 0.0);
    let fixture_slot_ts = UnixSecs(1_573_470_120);
    let wav_emb = embedded
        .decode_slot(fixture_slot_ts, &wav_12k)
        .await
        .unwrap();
    for expected_msg in [
        "CQ TA6CQ KN70",
        "CQ LZ1JZ KN22",
        "CQ R7IW LN35",
        "CQ DX R6WA LN32",
    ] {
        assert!(
            wav_emb.iter().any(|d| d.message == expected_msg),
            "ft8_lib missed 14s-padded fixture message '{expected_msg}': {wav_emb:?}"
        );
    }

    if let Some(jt9_bin) = HybridFt8Decoder::resolve_jt9_path(None) {
        let jt9 = Jt9SubprocessDecoder::new(jt9_bin);
        let jt9_decodes = jt9.decode_slot(slot_ts, &slot_12k).await.unwrap();
        let jt9_hit = jt9_decodes
            .iter()
            .find(|d| d.message == "K1ABC N1MPM 73")
            .unwrap_or_else(|| panic!("jt9 failed loopback decode for 73: {jt9_decodes:?}"));
        assert!(
            (1495..=1505).contains(&jt9_hit.af_hz),
            "jt9 loopback 73 AF {} not within ±5 Hz of 1500",
            jt9_hit.af_hz
        );

        let wav_jt9 = jt9.decode_slot(fixture_slot_ts, &wav_12k).await.unwrap();
        for expected_msg in [
            "CQ TA6CQ KN70",
            "CQ LZ1JZ KN22",
            "CQ R7IW LN35",
            "CQ DX R6WA LN32",
        ] {
            assert!(
                wav_jt9.iter().any(|d| d.message == expected_msg),
                "jt9 missed 14s-padded fixture message '{expected_msg}': {wav_jt9:?}"
            );
        }
    }
}

#[tokio::test]
async fn streaming_jt9_emits_decodes_before_exit_and_reconciles_three_passes() {
    let Some(jt9_bin) = HybridFt8Decoder::resolve_jt9_path(None) else {
        return;
    };

    let wav_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("191111_110200.wav");
    let (_, raw_12k) = read_wav_mono_f32(&wav_path).unwrap();
    let slot_ts = UnixSecs(1_573_470_120);

    let wisdom_tmp = tempdir().unwrap();
    let jt9 = Jt9SubprocessDecoder::with_data_dir(jt9_bin, wisdom_tmp.path().to_path_buf());
    let mut reconciler = SlotDecodeReconciler::new(slot_ts);

    let pad_to_slot = |secs: f64| -> Vec<f32> {
        let take = ((secs * FT8_SAMPLE_RATE as f64).round() as usize).min(raw_12k.len());
        let mut buf = raw_12k[..take].to_vec();
        buf.resize(FT8_SLOT_SAMPLES_12K, 0.0);
        buf
    };

    // Pass 1 (11.8s, -d 1, cold wisdom uses -w 0 estimate without stalling or writing wisdom)
    let (tx1, mut rx1) = mpsc::unbounded_channel::<Ft8Decode>();
    let p1 = jt9
        .decode_slot_streaming(
            slot_ts,
            &pad_to_slot(11.8),
            DecodePassOptions {
                depth: 1,
                timeout: Duration::from_millis(2_000),
                generate_wisdom_if_missing: false,
                fallback_on_empty_timeout: false,
            },
            tx1,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(!wisdom_tmp.path().join("jt9_wisdom.dat").exists());
    let mut pass1_new = 0_usize;
    while let Ok(dec) = rx1.try_recv() {
        if matches!(reconciler.ingest(1, dec), ReconcileOutcome::New(_)) {
            pass1_new += 1;
        }
    }
    assert!(
        pass1_new >= 4 && p1.len() >= 4,
        "expected Pass 1 at 11.8s to decode most fixture signals (got {pass1_new})"
    );

    // Pass 2 (13.5s, -d 2)
    let (tx2, mut rx2) = mpsc::unbounded_channel::<Ft8Decode>();
    let _p2 = jt9
        .decode_slot_streaming(
            slot_ts,
            &pad_to_slot(13.5),
            DecodePassOptions {
                depth: 2,
                timeout: Duration::from_millis(2_000),
                generate_wisdom_if_missing: false,
                fallback_on_empty_timeout: false,
            },
            tx2,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    while let Ok(dec) = rx2.try_recv() {
        reconciler.ingest(2, dec);
    }

    // Pass 3 (14.8s, -d 3): generates persistent wisdom and streams lines before exit
    let (tx3, mut rx3) = mpsc::unbounded_channel::<Ft8Decode>();
    let cancel3 = CancellationToken::new();
    let jt9_p3 = jt9.clone();
    let pcm3 = pad_to_slot(14.8);
    let started = Instant::now();
    let p3_handle = tokio::spawn(async move {
        let res = jt9_p3
            .decode_slot_streaming(
                slot_ts,
                &pcm3,
                DecodePassOptions {
                    depth: 3,
                    timeout: Duration::from_millis(4_000),
                    generate_wisdom_if_missing: true,
                    fallback_on_empty_timeout: true,
                },
                tx3,
                cancel3,
            )
            .await;
        (res, Instant::now())
    });

    let mut first_stream_at: Option<Instant> = None;
    while let Some(dec) = rx3.recv().await {
        if first_stream_at.is_none() {
            first_stream_at = Some(Instant::now());
        }
        reconciler.ingest(3, dec);
    }
    let (p3_res, finished_at) = p3_handle.await.unwrap();
    let p3_decodes = p3_res.unwrap();
    assert!(!p3_decodes.is_empty());
    let first_at = first_stream_at.expect("expected streamed decodes from Pass 3");
    assert!(
        first_at < finished_at,
        "expected first decode ({:?}) to stream before Pass 3 exit ({:?})",
        first_at.duration_since(started),
        finished_at.duration_since(started)
    );
    assert!(
        wisdom_tmp.path().join("jt9_wisdom.dat").is_file(),
        "Pass 3 should persist jt9_wisdom.dat into wisdom_dir"
    );

    let final_decodes = reconciler.take_final_for_telemetry();
    assert!(
        final_decodes.len() == 5,
        "expected 5 deduplicated decodes across 3 passes: {final_decodes:?}"
    );
    for expected_msg in [
        "CQ TA6CQ KN70",
        "CQ LZ1JZ KN22",
        "CQ R7IW LN35",
        "CQ DX R6WA LN32",
        "OH3NIV ZS6S RR73",
    ] {
        assert!(
            final_decodes.iter().any(|d| d.message == expected_msg),
            "missing reconciled message '{expected_msg}': {final_decodes:?}"
        );
    }
}

#[tokio::test]
async fn late_start_5s_offset_tx_waveform_decodes_with_jt9_and_ft8_lib() {
    let slot_ts = UnixSecs(1_795_212_960);
    let total_48k = 15 * (DSP_SAMPLE_RATE as usize);

    // Embedded ft8_lib fallback requires more Costas symbols than jt9; verify offset-sliced grid alignment at 1.0 s.
    let tail_1s_48k = Ft8LibTxModulator::modulate_pcm_from_offset(
        "K1ABC N1MPM RR73",
        1500.0,
        DSP_SAMPLE_RATE,
        1_000,
    )
    .unwrap();
    let start_1s_48k = DSP_SAMPLE_RATE as usize;
    let mut slot_1s_48k = vec![0.0_f32; total_48k];
    let copy_1s = tail_1s_48k.len().min(total_48k - start_1s_48k);
    slot_1s_48k[start_1s_48k..start_1s_48k + copy_1s].copy_from_slice(&tail_1s_48k[..copy_1s]);
    let slot_1s_12k = resample_48k_to_12k(&slot_1s_48k).unwrap();
    let embedded = Ft8LibEmbeddedDecoder;
    let emb = embedded.decode_slot(slot_ts, &slot_1s_12k).await.unwrap();
    let emb_hit = emb
        .iter()
        .find(|d| d.message == "K1ABC N1MPM RR73")
        .unwrap_or_else(|| panic!("ft8_lib missed 1s late-start TX: {emb:?}"));
    assert!((1495..=1505).contains(&emb_hit.af_hz));

    // Primary jt9 decoder decodes all the way out to 5.0 s+ late start.
    let tail_48k = Ft8LibTxModulator::modulate_pcm_from_offset(
        "K1ABC N1MPM RR73",
        1500.0,
        DSP_SAMPLE_RATE,
        5_000,
    )
    .unwrap();
    let start_48k = 5 * (DSP_SAMPLE_RATE as usize);
    let mut slot_48k = vec![0.0_f32; total_48k];
    let copy_len = tail_48k.len().min(total_48k - start_48k);
    slot_48k[start_48k..start_48k + copy_len].copy_from_slice(&tail_48k[..copy_len]);
    let slot_12k = resample_48k_to_12k(&slot_48k).unwrap();
    assert_eq!(slot_12k.len(), FT8_SLOT_SAMPLES_12K);

    if let Some(jt9_bin) = HybridFt8Decoder::resolve_jt9_path(None) {
        let jt9 = Jt9SubprocessDecoder::new(jt9_bin);
        let jt9_decodes = jt9.decode_slot(slot_ts, &slot_12k).await.unwrap();
        let hit = jt9_decodes
            .iter()
            .find(|d| d.message == "K1ABC N1MPM RR73")
            .unwrap_or_else(|| panic!("jt9 missed 5s late-start TX: {jt9_decodes:?}"));
        assert!((1495..=1505).contains(&hit.af_hz));
        assert!(
            (hit.dt_sec + 0.5).abs() <= 0.25,
            "expected UTC-aligned dt_sec near -0.5 (got {})",
            hit.dt_sec
        );
    }
}

#[tokio::test]
async fn mid_slot_hotswap_tx_waveform_decodes_replacement_message_in_jt9() {
    let slot_ts = UnixSecs(1_795_212_990);
    let stale_48k =
        Ft8LibTxModulator::modulate_pcm("K1ABC N1MPM -08", 1500.0, DSP_SAMPLE_RATE).unwrap();
    let replacement_48k = Ft8LibTxModulator::modulate_pcm_from_offset(
        "K1ABC N1MPM RR73",
        1500.0,
        DSP_SAMPLE_RATE,
        1_000,
    )
    .unwrap();

    let total_48k = 15 * (DSP_SAMPLE_RATE as usize);
    let swap_at_48k = DSP_SAMPLE_RATE as usize;
    let mut slot_48k = vec![0.0_f32; total_48k];
    slot_48k[..swap_at_48k].copy_from_slice(&stale_48k[..swap_at_48k]);
    let copy_len = replacement_48k.len().min(total_48k - swap_at_48k);
    slot_48k[swap_at_48k..swap_at_48k + copy_len].copy_from_slice(&replacement_48k[..copy_len]);
    let slot_12k = resample_48k_to_12k(&slot_48k).unwrap();

    if let Some(jt9_bin) = HybridFt8Decoder::resolve_jt9_path(None) {
        let jt9 = Jt9SubprocessDecoder::new(jt9_bin);
        let jt9_decodes = jt9.decode_slot(slot_ts, &slot_12k).await.unwrap();
        assert!(
            jt9_decodes
                .iter()
                .any(|d| d.message == "K1ABC N1MPM RR73" && (1495..=1505).contains(&d.af_hz)),
            "jt9 missed hot-swapped replacement message: {jt9_decodes:?}"
        );
        assert!(
            !jt9_decodes.iter().any(|d| d.message == "K1ABC N1MPM -08"),
            "jt9 unexpectedly decoded cancelled stale prefix: {jt9_decodes:?}"
        );
    }
}
