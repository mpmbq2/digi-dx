use std::path::Path;

use digi_dx::audio::dsp::{
    resample_48k_to_12k, DSP_SAMPLE_RATE, FT8_SAMPLE_RATE, FT8_SLOT_SAMPLES_12K,
};
use digi_dx::audio::wav::read_wav_mono_f32;
use digi_dx::domain::clock::UnixSecs;
use digi_dx::modem::ft8_lib::{Ft8LibEmbeddedDecoder, Ft8LibTxModulator};
use digi_dx::modem::jt9::{parse_jt9_stdout, Jt9SubprocessDecoder};
use digi_dx::modem::{Ft8Decoder, HybridFt8Decoder};

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
