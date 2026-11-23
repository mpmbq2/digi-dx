use crate::domain::clock::UnixSecs;
use crate::modem::Ft8Decode;

pub const RECONCILE_AF_TOLERANCE_HZ: i32 = 15;

#[derive(Debug, Clone, PartialEq)]
pub enum ReconcileOutcome {
    New(Ft8Decode),
    Refined {
        previous: Ft8Decode,
        updated: Ft8Decode,
    },
    Duplicate,
}

#[derive(Debug, Clone)]
struct ReconciledSlotEntry {
    pass: u8,
    decode: Ft8Decode,
}

/// Confidence ranking for WSJT-X / `jt9` decode metadata:
/// - `2`: Verified full-CRC decode (`None`)
/// - `1`: High-confidence AP-assisted decode (`Some("a1")`, `Some("a2")`, etc.)
/// - `0`: Uncertain AP decode containing `?` (`Some("? a1")`, `Some("?")`)
fn confidence_rank(raw_metadata: Option<&str>) -> u8 {
    match raw_metadata.map(str::trim).filter(|s| !s.is_empty()) {
        None => 2,
        Some(m) if m.contains('?') => 0,
        Some(_) => 1,
    }
}

/// Reconciles multi-pass FT8 decodes within a single 15-second slot without duplicates or
/// confidence downgrades, retaining AP/uncertainty metadata for display.
#[derive(Debug, Clone)]
pub struct SlotDecodeReconciler {
    slot_ts: UnixSecs,
    entries: Vec<ReconciledSlotEntry>,
    telemetry_flushed: bool,
}

impl SlotDecodeReconciler {
    pub fn new(slot_ts: UnixSecs) -> Self {
        Self {
            slot_ts,
            entries: Vec::new(),
            telemetry_flushed: false,
        }
    }

    pub fn slot_ts(&self) -> UnixSecs {
        self.slot_ts
    }

    pub fn ingest(&mut self, pass: u8, incoming: Ft8Decode) -> ReconcileOutcome {
        let existing_idx = self.entries.iter().position(|entry| {
            entry.decode.slot_ts == incoming.slot_ts
                && entry.decode.message == incoming.message
                && (i32::from(entry.decode.af_hz) - i32::from(incoming.af_hz)).abs()
                    <= RECONCILE_AF_TOLERANCE_HZ
        });

        let Some(idx) = existing_idx else {
            self.entries.push(ReconciledSlotEntry {
                pass,
                decode: incoming.clone(),
            });
            return ReconcileOutcome::New(incoming);
        };

        let existing = &mut self.entries[idx];
        if pass < existing.pass {
            return ReconcileOutcome::Duplicate;
        }

        let old_rank = confidence_rank(existing.decode.raw_metadata.as_deref());
        let new_rank = confidence_rank(incoming.raw_metadata.as_deref());
        if new_rank < old_rank {
            return ReconcileOutcome::Duplicate;
        }

        let changed = existing.decode.snr_db != incoming.snr_db
            || existing.decode.af_hz != incoming.af_hz
            || (existing.decode.dt_sec - incoming.dt_sec).abs() >= 0.05
            || existing.decode.raw_metadata != incoming.raw_metadata
            || existing.decode.decoder_backend != incoming.decoder_backend;

        existing.pass = pass;
        if !changed {
            return ReconcileOutcome::Duplicate;
        }

        let previous = std::mem::replace(&mut existing.decode, incoming.clone());
        ReconcileOutcome::Refined {
            previous,
            updated: incoming,
        }
    }

    /// Return the deduplicated final decodes for this slot once (idempotent).
    pub fn take_final_for_telemetry(&mut self) -> Vec<Ft8Decode> {
        if self.telemetry_flushed {
            return Vec::new();
        }
        self.telemetry_flushed = true;
        self.entries.iter().map(|e| e.decode.clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(snr: i8, dt: f32, af: u16, msg: &str, meta: Option<&str>) -> Ft8Decode {
        Ft8Decode {
            slot_ts: UnixSecs(1_795_212_900),
            snr_db: snr,
            dt_sec: dt,
            af_hz: af,
            message: msg.to_string(),
            raw_metadata: meta.map(str::to_string),
            decoder_backend: "jt9".to_string(),
        }
    }

    #[test]
    fn reconciles_new_duplicate_refined_and_distinct_af() {
        let mut rec = SlotDecodeReconciler::new(UnixSecs(1_795_212_900));

        let d1 = mk(-14, 0.6, 1030, "CQ LZ1JZ KN22", Some("? a1"));
        assert_eq!(rec.ingest(1, d1.clone()), ReconcileOutcome::New(d1.clone()));

        // Identical repeat on same pass is Duplicate
        assert_eq!(rec.ingest(1, d1), ReconcileOutcome::Duplicate);

        // Pass 2 refines SNR, AF within +-15 Hz, and upgrades metadata ? a1 -> a1
        let d2 = mk(-12, 0.6, 1032, "CQ LZ1JZ KN22", Some("a1"));
        assert_eq!(
            rec.ingest(2, d2.clone()),
            ReconcileOutcome::Refined {
                previous: mk(-14, 0.6, 1030, "CQ LZ1JZ KN22", Some("? a1")),
                updated: d2.clone(),
            }
        );

        // Pass 3 verifies CRC with identical SNR/AF/DT -> metadata-only upgrade emits Refined
        let d3 = mk(-12, 0.6, 1032, "CQ LZ1JZ KN22", None);
        assert_eq!(
            rec.ingest(3, d3.clone()),
            ReconcileOutcome::Refined {
                previous: d2,
                updated: d3.clone(),
            }
        );

        // Same message >15 Hz away is treated as a separate station/signal
        let d_other_af = mk(-10, 0.4, 1055, "CQ LZ1JZ KN22", None);
        assert_eq!(
            rec.ingest(3, d_other_af.clone()),
            ReconcileOutcome::New(d_other_af)
        );

        let final_set = rec.take_final_for_telemetry();
        assert_eq!(final_set.len(), 2);
        assert_eq!(final_set[0], d3);
        assert!(rec.take_final_for_telemetry().is_empty());
    }

    #[test]
    fn blocks_confidence_downgrades_and_pass_regressions() {
        let mut rec = SlotDecodeReconciler::new(UnixSecs(1_795_212_900));

        // Pass 1 yields AP a1
        let ap = mk(-10, 0.5, 1420, "CQ K1ABC FN42", Some("a1"));
        assert_eq!(rec.ingest(1, ap.clone()), ReconcileOutcome::New(ap.clone()));

        // Pass 2 yields lower-confidence ? a1 -> blocked
        let uncertain = mk(-9, 0.5, 1420, "CQ K1ABC FN42", Some("? a1"));
        assert_eq!(
            rec.ingest(2, uncertain.clone()),
            ReconcileOutcome::Duplicate
        );

        // Pass 2 yields verified None -> accepted
        let verified = mk(-10, 0.5, 1420, "CQ K1ABC FN42", None);
        assert!(matches!(
            rec.ingest(2, verified.clone()),
            ReconcileOutcome::Refined { .. }
        ));

        // Pass 3 yields a1 or ? a1 -> blocked (never downgrade verified decode)
        assert_eq!(rec.ingest(3, ap), ReconcileOutcome::Duplicate);
        assert_eq!(rec.ingest(3, uncertain), ReconcileOutcome::Duplicate);

        // Pass regression (pass 1 after pass 2) -> blocked
        assert_eq!(
            rec.ingest(1, mk(-8, 0.5, 1420, "CQ K1ABC FN42", None)),
            ReconcileOutcome::Duplicate
        );

        let final_set = rec.take_final_for_telemetry();
        assert_eq!(final_set, vec![verified]);
    }
}
