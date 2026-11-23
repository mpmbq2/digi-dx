use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignalReport {
    pub is_roger: bool,
    pub snr_db: i8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Ft8Payload {
    Grid(String),
    Report { is_roger: bool, snr_db: i8 },
    Terminal(String),
    Unknown(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ParsedFt8Message {
    Cq {
        directed: Option<String>,
        callsign: String,
        grid: Option<String>,
        metadata: Option<String>,
    },
    Directed {
        to: String,
        from: String,
        payload: Option<Ft8Payload>,
        metadata: Option<String>,
    },
    Raw {
        text: String,
        metadata: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StationRole {
    Caller,
    Hunter,
}

impl StationRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Caller => "caller",
            Self::Hunter => "hunter",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "caller" => Some(Self::Caller),
            "hunter" => Some(Self::Hunter),
            _ => None,
        }
    }
}

/// Infer whether the transmitting station (`from`) is acting as a Caller (running CQ)
/// or a Hunter (replying to CQ) based on the standard 6-step FT8 QSO sequence:
///   1. CQ A GRID      -> Caller
///   2. A B GRID       -> Hunter
///   3. B A -10        -> Caller (non-roger report)
///   4. A B R-08       -> Hunter (roger report)
///   5. B A RR73 / RRR -> Caller
///   6. A B 73         -> Hunter
pub fn infer_station_role(parsed: &ParsedFt8Message) -> Option<StationRole> {
    match parsed {
        ParsedFt8Message::Cq { .. } => Some(StationRole::Caller),
        ParsedFt8Message::Directed { payload, .. } => match payload {
            Some(Ft8Payload::Grid(_)) => Some(StationRole::Hunter),
            Some(Ft8Payload::Report {
                is_roger: false, ..
            }) => Some(StationRole::Caller),
            Some(Ft8Payload::Report { is_roger: true, .. }) => Some(StationRole::Hunter),
            Some(Ft8Payload::Terminal(t)) if t == "RR73" || t == "RRR" => Some(StationRole::Caller),
            Some(Ft8Payload::Terminal(t)) if t == "73" => Some(StationRole::Hunter),
            _ => None,
        },
        ParsedFt8Message::Raw { .. } => None,
    }
}

/// Strip trailing WSJT-X / jt9 decoder-pass metadata starting at `?` (e.g. `? a1`).
pub fn strip_decoder_metadata(raw: &str) -> (&str, Option<&str>) {
    let trimmed = raw.trim();
    if let Some(idx) = trimmed.find('?') {
        let msg = trimmed[..idx].trim_end();
        let meta = trimmed[idx..].trim();
        let meta_opt = if meta.is_empty() { None } else { Some(meta) };
        (msg, meta_opt)
    } else {
        (trimmed, None)
    }
}

pub fn is_terminal_payload(token: &str) -> bool {
    matches!(
        token.trim().to_ascii_uppercase().as_str(),
        "RRR" | "RR73" | "73"
    )
}

/// Matches 4- or 6-character Maidenhead grid locators: `[A-R]{2}[0-9]{2}([A-X]{2})?`.
/// Note: Callers parsing FT8 payloads must check `is_terminal_payload()` before `is_maidenhead_grid()`
/// because `"RR73"` matches the 4-character grid pattern.
pub fn is_maidenhead_grid(token: &str) -> bool {
    let bytes = token.as_bytes();
    if bytes.len() != 4 && bytes.len() != 6 {
        return false;
    }
    let a0 = bytes[0].to_ascii_uppercase();
    let a1 = bytes[1].to_ascii_uppercase();
    let d0 = bytes[2];
    let d1 = bytes[3];

    if !(b'A'..=b'R').contains(&a0)
        || !(b'A'..=b'R').contains(&a1)
        || !d0.is_ascii_digit()
        || !d1.is_ascii_digit()
    {
        return false;
    }

    if bytes.len() == 6 {
        let s0 = bytes[4].to_ascii_uppercase();
        let s1 = bytes[5].to_ascii_uppercase();
        return (b'A'..=b'X').contains(&s0) && (b'A'..=b'X').contains(&s1);
    }

    true
}

pub fn parse_signal_report(token: &str) -> Option<SignalReport> {
    let upper = token.trim().to_ascii_uppercase();
    let (is_roger, num_part) = if let Some(rest) = upper.strip_prefix('R') {
        (true, rest)
    } else {
        (false, upper.as_str())
    };

    if num_part.len() != 3 {
        return None;
    }
    let sign = num_part.as_bytes()[0];
    if sign != b'+' && sign != b'-' {
        return None;
    }
    if !num_part.as_bytes()[1].is_ascii_digit() || !num_part.as_bytes()[2].is_ascii_digit() {
        return None;
    }

    let snr: i8 = num_part.parse().ok()?;
    if !(-50..=49).contains(&snr) {
        return None;
    }
    Some(SignalReport {
        is_roger,
        snr_db: snr,
    })
}

pub fn is_message_callsign(token: &str) -> bool {
    let clean = token.trim_matches(|c| c == '<' || c == '>');
    if !(3..=15).contains(&clean.len()) {
        return false;
    }
    if is_terminal_payload(clean) || is_maidenhead_grid(clean) {
        return false;
    }
    let mut has_alpha = false;
    let mut has_digit = false;
    for b in clean.bytes() {
        let u = b.to_ascii_uppercase();
        if u.is_ascii_uppercase() {
            has_alpha = true;
        } else if u.is_ascii_digit() {
            has_digit = true;
        } else if u != b'/' {
            return false;
        }
    }
    has_alpha && has_digit
}

pub fn validate_station_callsign(raw: &str) -> Result<String, String> {
    let upper = raw.trim().to_ascii_uppercase();
    if !(3..=16).contains(&upper.len()) {
        return Err("Callsign must be between 3 and 16 characters".to_string());
    }
    if upper.starts_with("QQ") {
        return Err(
            "Callsigns starting with QQ are reserved for simulated/demo operation and cannot be persisted as station config"
                .to_string(),
        );
    }
    let mut has_alpha = false;
    let mut has_digit = false;
    for b in upper.bytes() {
        if b.is_ascii_uppercase() {
            has_alpha = true;
        } else if b.is_ascii_digit() {
            has_digit = true;
        } else if b != b'/' {
            return Err("Callsign may only contain A-Z, 0-9, and '/'".to_string());
        }
    }
    if !has_alpha || !has_digit {
        return Err("Callsign must contain at least one letter and one digit".to_string());
    }
    Ok(upper)
}

pub fn validate_station_grid(raw: &str) -> Result<String, String> {
    let upper = raw.trim().to_ascii_uppercase();
    if is_terminal_payload(&upper) {
        return Err(format!(
            "'{upper}' is a terminal FT8 payload, not a grid square"
        ));
    }
    if !is_maidenhead_grid(&upper) {
        return Err(
            "Grid must be a valid 4- or 6-character Maidenhead locator (e.g. FN33 or FN33ab)"
                .to_string(),
        );
    }
    Ok(upper)
}

pub fn validate_tx_message(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("TX message cannot be empty".to_string());
    }
    if trimmed.chars().count() > 128 {
        return Err("TX message exceeds maximum 128 characters".to_string());
    }
    if trimmed
        .chars()
        .any(|c| c == '\r' || c == '\n' || c.is_control())
    {
        return Err("TX message cannot contain CR/LF or control characters".to_string());
    }
    Ok(trimmed.to_ascii_uppercase())
}

pub fn parse_ft8_message(raw: &str) -> ParsedFt8Message {
    let (clean, meta) = strip_decoder_metadata(raw);
    let metadata = meta.map(str::to_string);
    let tokens: Vec<String> = clean
        .split_whitespace()
        .map(|t| t.to_ascii_uppercase())
        .collect();

    if tokens.is_empty() {
        return ParsedFt8Message::Raw {
            text: String::new(),
            metadata,
        };
    }

    if tokens[0] == "CQ" {
        match tokens.as_slice() {
            [_, call] if is_message_callsign(call) => {
                return ParsedFt8Message::Cq {
                    directed: None,
                    callsign: call.clone(),
                    grid: None,
                    metadata,
                };
            }
            [_, call, grid]
                if is_message_callsign(call)
                    && !is_terminal_payload(grid)
                    && is_maidenhead_grid(grid) =>
            {
                return ParsedFt8Message::Cq {
                    directed: None,
                    callsign: call.clone(),
                    grid: Some(grid.clone()),
                    metadata,
                };
            }
            [_, dir, call] if is_message_callsign(call) => {
                return ParsedFt8Message::Cq {
                    directed: Some(dir.clone()),
                    callsign: call.clone(),
                    grid: None,
                    metadata,
                };
            }
            [_, dir, call, grid]
                if is_message_callsign(call)
                    && !is_terminal_payload(grid)
                    && is_maidenhead_grid(grid) =>
            {
                return ParsedFt8Message::Cq {
                    directed: Some(dir.clone()),
                    callsign: call.clone(),
                    grid: Some(grid.clone()),
                    metadata,
                };
            }
            _ => {}
        }
    }

    if tokens.len() >= 2 && is_message_callsign(&tokens[1]) {
        let to = tokens[0].clone();
        let from = tokens[1].clone();
        let payload = tokens.get(2).map(|tok| classify_payload(tok));
        return ParsedFt8Message::Directed {
            to,
            from,
            payload,
            metadata,
        };
    }

    ParsedFt8Message::Raw {
        text: tokens.join(" "),
        metadata,
    }
}

fn classify_payload(tok: &str) -> Ft8Payload {
    // CRITICAL: check terminal literals (RRR, RR73, 73) BEFORE Maidenhead grid regex!
    if is_terminal_payload(tok) {
        return Ft8Payload::Terminal(tok.to_string());
    }
    if let Some(rep) = parse_signal_report(tok) {
        return Ft8Payload::Report {
            is_roger: rep.is_roger,
            snr_db: rep.snr_db,
        };
    }
    if is_maidenhead_grid(tok) {
        return Ft8Payload::Grid(tok.to_string());
    }
    Ft8Payload::Unknown(tok.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_jt9_metadata_suffix() {
        let (clean, meta) = strip_decoder_metadata("CQ PY7XC HI21                       ? a1");
        assert_eq!(clean, "CQ PY7XC HI21");
        assert_eq!(meta, Some("? a1"));

        let (clean2, meta2) = strip_decoder_metadata("WM8Q DL0EO -17");
        assert_eq!(clean2, "WM8Q DL0EO -17");
        assert_eq!(meta2, None);
    }

    #[test]
    fn rr73_is_terminal_never_grid() {
        assert!(is_maidenhead_grid("RR73"));
        assert!(is_terminal_payload("RR73"));

        let parsed = parse_ft8_message("K1ABC N1MPM RR73 ? a1");
        assert_eq!(
            parsed,
            ParsedFt8Message::Directed {
                to: "K1ABC".to_string(),
                from: "N1MPM".to_string(),
                payload: Some(Ft8Payload::Terminal("RR73".to_string())),
                metadata: Some("? a1".to_string()),
            }
        );
    }

    #[test]
    fn parses_cq_directed_and_reports() {
        assert_eq!(
            parse_ft8_message("CQ DX JA1ABC PM95"),
            ParsedFt8Message::Cq {
                directed: Some("DX".to_string()),
                callsign: "JA1ABC".to_string(),
                grid: Some("PM95".to_string()),
                metadata: None,
            }
        );

        assert_eq!(
            parse_ft8_message("N1MPM JA1ABC R-12"),
            ParsedFt8Message::Directed {
                to: "N1MPM".to_string(),
                from: "JA1ABC".to_string(),
                payload: Some(Ft8Payload::Report {
                    is_roger: true,
                    snr_db: -12
                }),
                metadata: None,
            }
        );
    }

    #[test]
    fn rejects_qq_demo_callsigns_and_control_chars() {
        assert!(validate_station_callsign("QQ0DEMO").is_err());
        assert!(validate_station_callsign("qq9xyz").is_err());
        assert_eq!(validate_station_callsign("n1mpm").unwrap(), "N1MPM");
        assert_eq!(validate_station_grid("fn33ab").unwrap(), "FN33AB");
        assert!(validate_station_grid("RR73").is_err());
        assert!(validate_tx_message("CQ N1MPM\nFN33").is_err());
        assert!(validate_tx_message("CQ N1MPM\u{0007}").is_err());
        assert_eq!(
            validate_tx_message("  cq n1mpm fn33  ").unwrap(),
            "CQ N1MPM FN33"
        );
    }

    #[test]
    fn infers_caller_and_hunter_roles_across_ft8_sequence() {
        assert_eq!(
            infer_station_role(&parse_ft8_message("CQ N1MPM FN33")),
            Some(StationRole::Caller)
        );
        assert_eq!(
            infer_station_role(&parse_ft8_message("N1MPM JA1ABC PM95")),
            Some(StationRole::Hunter)
        );
        assert_eq!(
            infer_station_role(&parse_ft8_message("JA1ABC N1MPM -08")),
            Some(StationRole::Caller)
        );
        assert_eq!(
            infer_station_role(&parse_ft8_message("N1MPM JA1ABC R+03")),
            Some(StationRole::Hunter)
        );
        assert_eq!(
            infer_station_role(&parse_ft8_message("JA1ABC N1MPM RR73")),
            Some(StationRole::Caller)
        );
        assert_eq!(
            infer_station_role(&parse_ft8_message("JA1ABC N1MPM RRR")),
            Some(StationRole::Caller)
        );
        assert_eq!(
            infer_station_role(&parse_ft8_message("N1MPM JA1ABC 73")),
            Some(StationRole::Hunter)
        );
        assert_eq!(
            infer_station_role(&parse_ft8_message("SOME FREE TEXT")),
            None
        );
    }
}
