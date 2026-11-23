use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::domain::bands::derive_band;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QsoRecord {
    pub qso_id: String,
    pub radio_id: Option<String>,
    pub started_at_utc: String,
    pub completed_at_utc: String,
    pub my_call: String,
    pub my_grid: String,
    pub their_call: String,
    pub their_grid: Option<String>,
    pub mode: String,
    pub dial_freq_hz: Option<i64>,
    pub band: Option<String>,
    pub af_hz: Option<i64>,
    pub rst_sent: Option<String>,
    pub rst_rcvd: Option<String>,
    pub completion_reason: String,
    pub transcript_json: String,
    #[serde(default)]
    pub qrz_status: Option<String>,
    #[serde(default)]
    pub qrz_logid: Option<String>,
    #[serde(default)]
    pub qrz_pushed_at_utc: Option<String>,
    #[serde(default)]
    pub qrz_error: Option<String>,
}

/// Format a single ADIF field using UTF-8 byte length (`value.len()`).
pub fn format_adif_field(name: &str, value: &str) -> String {
    format!("<{}:{}>{} ", name, value.len(), value)
}

fn clean_adif_callsign(raw: &str) -> String {
    raw.trim()
        .trim_matches(|c| c == '<' || c == '>')
        .trim()
        .to_string()
}

/// Format a single `QsoRecord` as an ADIF 3.1.4 record ending with `<EOR>\n`.
pub fn format_adif_record(rec: &QsoRecord, fallback_ts: DateTime<Utc>) -> String {
    let mut out = String::new();
    let started = DateTime::parse_from_rfc3339(&rec.started_at_utc)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or(fallback_ts);
    let completed = DateTime::parse_from_rfc3339(&rec.completed_at_utc)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or(started);

    let their_call = clean_adif_callsign(&rec.their_call);
    let my_call = clean_adif_callsign(&rec.my_call);

    out.push_str(&format_adif_field("CALL", &their_call));
    if let Some(grid) = &rec.their_grid {
        let trimmed = grid.trim();
        if !trimmed.is_empty() {
            out.push_str(&format_adif_field("GRIDSQUARE", trimmed));
        }
    }
    out.push_str(&format_adif_field("MODE", rec.mode.trim()));
    out.push_str(&format_adif_field(
        "QSO_DATE",
        &started.format("%Y%m%d").to_string(),
    ));
    out.push_str(&format_adif_field(
        "TIME_ON",
        &started.format("%H%M%S").to_string(),
    ));
    out.push_str(&format_adif_field(
        "QSO_DATE_OFF",
        &completed.format("%Y%m%d").to_string(),
    ));
    out.push_str(&format_adif_field(
        "TIME_OFF",
        &completed.format("%H%M%S").to_string(),
    ));
    if let Some(rst_s) = &rec.rst_sent {
        if !rst_s.is_empty() {
            out.push_str(&format_adif_field("RST_SENT", rst_s));
        }
    }
    if let Some(rst_r) = &rec.rst_rcvd {
        if !rst_r.is_empty() {
            out.push_str(&format_adif_field("RST_RCVD", rst_r));
        }
    }
    if let Some(freq_hz) = rec.dial_freq_hz {
        if freq_hz > 0 {
            let mhz = format!("{:.6}", (freq_hz as f64) / 1_000_000.0);
            out.push_str(&format_adif_field("FREQ", &mhz));
        }
    }
    let resolved_band = rec
        .band
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_string)
        .or_else(|| {
            rec.dial_freq_hz
                .and_then(|hz| u64::try_from(hz).ok())
                .and_then(derive_band)
                .map(str::to_string)
        });
    if let Some(band) = resolved_band {
        out.push_str(&format_adif_field("BAND", &band));
    }
    out.push_str(&format_adif_field("STATION_CALLSIGN", &my_call));
    out.push_str(&format_adif_field("OPERATOR", &my_call));
    out.push_str(&format_adif_field("MY_GRIDSQUARE", rec.my_grid.trim()));
    out.push_str("<EOR>\n");
    out
}

pub fn export_adif_3_1_4(records: &[QsoRecord], created_at: DateTime<Utc>) -> String {
    let mut out = String::new();
    out.push_str("Digi-Dx v2 ADIF Export\n");
    out.push_str(&format_adif_field("ADIF_VER", "3.1.4"));
    out.push_str(&format_adif_field("PROGRAMID", "digi-dx"));
    out.push_str(&format_adif_field(
        "PROGRAMVERSION",
        env!("CARGO_PKG_VERSION"),
    ));
    out.push_str(&format_adif_field(
        "CREATED_TIMESTAMP",
        &created_at.format("%Y%m%d %H%M%S").to_string(),
    ));
    out.push_str("<EOH>\n");

    for rec in records {
        out.push_str(&format_adif_record(rec, created_at));
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn adif_uses_utf8_byte_length() {
        // 'é' is 2 bytes in UTF-8, 1 char
        assert_eq!(format_adif_field("NAME", "José"), "<NAME:5>José ");
    }

    #[test]
    fn exports_valid_adif_3_1_4_record() {
        let ts = Utc.with_ymd_and_hms(2026, 11, 21, 22, 15, 0).unwrap();
        let rec = QsoRecord {
            qso_id: "019a2f4b-0000-7000-8000-000000000001".to_string(),
            radio_id: Some("rad_1".to_string()),
            started_at_utc: "2026-11-21T22:10:00Z".to_string(),
            completed_at_utc: "2026-11-21T22:12:30Z".to_string(),
            my_call: "N1MPM".to_string(),
            my_grid: "FN33".to_string(),
            their_call: "JA1ABC".to_string(),
            their_grid: Some("PM95".to_string()),
            mode: "FT8".to_string(),
            dial_freq_hz: Some(14_074_000),
            band: Some("20m".to_string()),
            af_hz: Some(1420),
            rst_sent: Some("-11".to_string()),
            rst_rcvd: Some("-08".to_string()),
            completion_reason: "73_sent".to_string(),
            transcript_json: "[]".to_string(),
            qrz_status: None,
            qrz_logid: None,
            qrz_pushed_at_utc: None,
            qrz_error: None,
        };

        let adi = export_adif_3_1_4(&[rec], ts);
        assert!(adi.contains("<ADIF_VER:5>3.1.4 "));
        assert!(adi.contains("<PROGRAMID:7>digi-dx "));
        assert!(adi.contains("<EOH>"));
        assert!(adi.contains("<CALL:6>JA1ABC "));
        assert!(adi.contains("<GRIDSQUARE:4>PM95 "));
        assert!(adi.contains("<FREQ:9>14.074000 "));
        assert!(adi.contains("<BAND:3>20m "));
        assert!(adi.contains("<STATION_CALLSIGN:5>N1MPM "));
        assert!(adi.contains("<MY_GRIDSQUARE:4>FN33 "));
        assert!(adi.contains("<EOR>"));
    }

    #[test]
    fn single_record_strips_hashed_call_brackets_and_falls_back_on_empty_band() {
        let ts = Utc.with_ymd_and_hms(2026, 11, 21, 22, 15, 0).unwrap();
        let rec = QsoRecord {
            qso_id: "019a2f4b-0000-7000-8000-000000000002".to_string(),
            radio_id: None,
            started_at_utc: "2026-11-21T22:10:00Z".to_string(),
            completed_at_utc: "2026-11-21T22:12:30Z".to_string(),
            my_call: "<N1MPM>".to_string(),
            my_grid: "FN33".to_string(),
            their_call: "<JA1ABC>".to_string(),
            their_grid: None,
            mode: "FT8".to_string(),
            dial_freq_hz: Some(7_074_000),
            band: Some("".to_string()),
            af_hz: Some(1200),
            rst_sent: Some("-10".to_string()),
            rst_rcvd: Some("-05".to_string()),
            completion_reason: "73_sent".to_string(),
            transcript_json: "[]".to_string(),
            qrz_status: None,
            qrz_logid: None,
            qrz_pushed_at_utc: None,
            qrz_error: None,
        };

        let single = format_adif_record(&rec, ts);
        assert!(!single.contains("<EOH>"));
        assert!(single.contains("<CALL:6>JA1ABC "));
        assert!(single.contains("<STATION_CALLSIGN:5>N1MPM "));
        assert!(single.contains("<OPERATOR:5>N1MPM "));
        assert!(single.contains("<BAND:3>40m "));
        assert!(single.ends_with("<EOR>\n"));
    }
}
