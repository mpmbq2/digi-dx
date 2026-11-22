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
}

/// Format a single ADIF field using UTF-8 byte length (`value.len()`).
pub fn format_adif_field(name: &str, value: &str) -> String {
    format!("<{}:{}>{} ", name, value.len(), value)
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
        let started = DateTime::parse_from_rfc3339(&rec.started_at_utc)
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or(created_at);
        let completed = DateTime::parse_from_rfc3339(&rec.completed_at_utc)
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or(started);

        out.push_str(&format_adif_field("CALL", &rec.their_call));
        if let Some(grid) = &rec.their_grid {
            if !grid.is_empty() {
                out.push_str(&format_adif_field("GRIDSQUARE", grid));
            }
        }
        out.push_str(&format_adif_field("MODE", &rec.mode));
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
                if rec.band.is_none() {
                    if let Some(b) = derive_band(freq_hz as u64) {
                        out.push_str(&format_adif_field("BAND", b));
                    }
                }
            }
        }
        if let Some(band) = &rec.band {
            if !band.is_empty() {
                out.push_str(&format_adif_field("BAND", band));
            }
        }
        out.push_str(&format_adif_field("STATION_CALLSIGN", &rec.my_call));
        out.push_str(&format_adif_field("OPERATOR", &rec.my_call));
        out.push_str(&format_adif_field("MY_GRIDSQUARE", &rec.my_grid));
        out.push_str("<EOR>\n");
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
}
