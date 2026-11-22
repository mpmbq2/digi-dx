use std::collections::VecDeque;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::domain::adif::QsoRecord;
use crate::domain::bands::derive_band;
use crate::domain::clock::{SlotParity, UnixSecs};
use crate::domain::ft8::{parse_ft8_message, Ft8Payload, ParsedFt8Message};
use crate::modem::{Ft8Decode, TxIntent};
use crate::store::now_utc_str;

const MAX_RECENT_DECODES: usize = 150;
const MAX_CONFIRMED_RETRIES: u8 = 5;
const OCCUPIED_AF_TOLERANCE_HZ: i32 = 50;
const OCCUPIED_LOOKBACK_SECS: i64 = 60;
const SURVEY_MIN_AF_HZ: u16 = 300;
const SURVEY_MAX_AF_HZ: u16 = 2700;
const SURVEY_HALF_WIDTH_HZ: u16 = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QsoStep {
    CallingCq,
    SendGrid,
    SendReport,
    SendRReport,
    #[serde(rename_all = "snake_case")]
    SendRr73,
    Send73,
}

impl QsoStep {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CallingCq => "calling_cq",
            Self::SendGrid => "send_grid",
            Self::SendReport => "send_report",
            Self::SendRReport => "send_r_report",
            Self::SendRr73 => "send_rr73",
            Self::Send73 => "send_73",
        }
    }

    fn prev(self) -> Self {
        match self {
            Self::CallingCq => Self::CallingCq,
            Self::SendGrid => Self::SendGrid,
            Self::SendReport => Self::SendGrid,
            Self::SendRReport => Self::SendReport,
            Self::SendRr73 => Self::SendRReport,
            Self::Send73 => Self::SendRr73,
        }
    }

    fn next(self) -> Self {
        match self {
            Self::CallingCq => Self::SendGrid,
            Self::SendGrid => Self::SendReport,
            Self::SendReport => Self::SendRReport,
            Self::SendRReport => Self::SendRr73,
            Self::SendRr73 => Self::Send73,
            Self::Send73 => Self::Send73,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QsoStatus {
    Active,
    Paused,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TranscriptEntry {
    pub at_utc: String,
    pub direction: String,
    pub slot_ts: i64,
    pub af_hz: u16,
    pub snr_db: Option<i8>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActiveQso {
    pub qso_id: String,
    pub radio_id: String,
    pub is_demo: bool,
    pub is_cq: bool,
    pub directed_cq: Option<String>,
    pub my_call: String,
    pub my_grid: String,
    pub their_call: String,
    pub their_grid: Option<String>,
    pub tx_slot: SlotParity,
    pub step: QsoStep,
    pub status: QsoStatus,
    pub attempts_on_step: u8,
    pub last_their_snr_db: Option<i8>,
    pub rst_sent: Option<String>,
    pub rst_rcvd: Option<String>,
    pub started_at_utc: String,
    pub updated_at_utc: String,
    pub transcript: Vec<TranscriptEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecentDecodeEntry {
    pub ts_sec: i64,
    pub slot: SlotParity,
    pub snr_db: i8,
    pub dt_sec: f32,
    pub af_hz: u16,
    pub message: String,
    pub decoder_backend: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OccupiedAfStatus {
    pub occupied: bool,
    pub conflicting_af_hz: Option<u16>,
    pub conflicting_call: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QsoAction {
    Resume,
    Pause,
    Retry,
    Complete,
    Abandon,
    PrevStep,
    NextStep,
    MoveUp,
    MoveDown,
}

impl QsoAction {
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim() {
            "resume" => Ok(Self::Resume),
            "pause" => Ok(Self::Pause),
            "retry" => Ok(Self::Retry),
            "complete" => Ok(Self::Complete),
            "abandon" => Ok(Self::Abandon),
            "prev_step" => Ok(Self::PrevStep),
            "next_step" => Ok(Self::NextStep),
            "move_up" => Ok(Self::MoveUp),
            "move_down" => Ok(Self::MoveDown),
            other => Err(format!("invalid qso.action '{other}'")),
        }
    }
}

#[derive(Debug, Clone)]
pub struct AfSurveyState {
    pub hold_until_virtual_ms: i64,
    pub collected_afs: Vec<u16>,
}

#[derive(Debug, Clone)]
pub struct QsoSequencer {
    pub radio_id: String,
    pub is_demo: bool,
    pub my_call: String,
    pub my_grid: String,
    pub tx_af_hz: u16,
    pub tx_enabled: bool,
    pub manual_tx: Option<TxIntent>,
    pub queue: Vec<ActiveQso>,
    pub recent_decodes: VecDeque<RecentDecodeEntry>,
    pub survey: Option<AfSurveyState>,
}

impl QsoSequencer {
    pub fn new(radio_id: &str, is_demo: bool, my_call: &str, my_grid: &str) -> Self {
        Self {
            radio_id: radio_id.to_string(),
            is_demo,
            my_call: my_call.trim().to_ascii_uppercase(),
            my_grid: my_grid.trim().to_ascii_uppercase(),
            tx_af_hz: 1500,
            tx_enabled: true,
            manual_tx: None,
            queue: Vec::new(),
            recent_decodes: VecDeque::with_capacity(MAX_RECENT_DECODES),
            survey: None,
        }
    }

    pub fn grid4(&self) -> &str {
        let len = self.my_grid.len().min(4);
        &self.my_grid[..len]
    }

    pub fn set_af(&mut self, af_hz: u16) {
        self.tx_af_hz = af_hz.clamp(200, 3000);
    }

    pub fn set_tx_enabled(&mut self, enabled: bool) {
        self.tx_enabled = enabled;
    }

    pub fn arm_manual_tx(&mut self, intent: TxIntent) {
        self.tx_af_hz = intent.af_hz.clamp(200, 3000);
        self.tx_enabled = true;
        self.manual_tx = Some(intent);
    }

    pub fn cancel_manual_tx(&mut self) {
        self.manual_tx = None;
    }

    pub fn start_cq(&mut self, slot: SlotParity, directed: Option<String>) -> ActiveQso {
        let now = now_utc_str();
        let dir_norm = directed
            .map(|d| d.trim().to_ascii_uppercase())
            .filter(|d| !d.is_empty());

        self.queue.retain(|q| !q.is_cq);
        self.manual_tx = None;
        self.tx_enabled = true;

        let cq = ActiveQso {
            qso_id: Uuid::now_v7().to_string(),
            radio_id: self.radio_id.clone(),
            is_demo: self.is_demo,
            is_cq: true,
            directed_cq: dir_norm,
            my_call: self.my_call.clone(),
            my_grid: self.my_grid.clone(),
            their_call: "CQ".to_string(),
            their_grid: None,
            tx_slot: slot,
            step: QsoStep::CallingCq,
            status: QsoStatus::Active,
            attempts_on_step: 0,
            last_their_snr_db: None,
            rst_sent: None,
            rst_rcvd: None,
            started_at_utc: now.clone(),
            updated_at_utc: now,
            transcript: Vec::new(),
        };
        self.queue.push(cq.clone());
        cq
    }

    pub fn start_reply(
        &mut self,
        their_call: &str,
        their_grid: Option<String>,
        rx_slot: SlotParity,
        snr_db: Option<i8>,
    ) -> ActiveQso {
        let now = now_utc_str();
        let call = their_call.trim().to_ascii_uppercase();
        let grid = their_grid
            .map(|g| g.trim().to_ascii_uppercase())
            .filter(|g| !g.is_empty());

        self.queue.retain(|q| q.is_cq || q.their_call != call);
        self.manual_tx = None;
        self.tx_enabled = true;

        let qso = ActiveQso {
            qso_id: Uuid::now_v7().to_string(),
            radio_id: self.radio_id.clone(),
            is_demo: self.is_demo,
            is_cq: false,
            directed_cq: None,
            my_call: self.my_call.clone(),
            my_grid: self.my_grid.clone(),
            their_call: call,
            their_grid: grid,
            tx_slot: rx_slot.opposite(),
            step: QsoStep::SendGrid,
            status: QsoStatus::Active,
            attempts_on_step: 0,
            last_their_snr_db: snr_db,
            rst_sent: None,
            rst_rcvd: None,
            started_at_utc: now.clone(),
            updated_at_utc: now,
            transcript: Vec::new(),
        };
        self.queue.insert(0, qso.clone());
        qso
    }

    pub fn apply_action(
        &mut self,
        qso_id: &str,
        action: QsoAction,
        dial_freq_hz: Option<i64>,
    ) -> Result<Option<QsoRecord>, String> {
        let Some(idx) = self.queue.iter().position(|q| q.qso_id == qso_id) else {
            return Err(format!("QSO '{qso_id}' not found in active queue"));
        };

        let now = now_utc_str();
        match action {
            QsoAction::Resume => {
                self.queue[idx].status = QsoStatus::Active;
                self.queue[idx].updated_at_utc = now;
                Ok(None)
            }
            QsoAction::Pause => {
                self.queue[idx].status = QsoStatus::Paused;
                self.queue[idx].updated_at_utc = now;
                Ok(None)
            }
            QsoAction::Retry => {
                self.queue[idx].attempts_on_step = 0;
                self.queue[idx].status = QsoStatus::Active;
                self.queue[idx].updated_at_utc = now;
                Ok(None)
            }
            QsoAction::PrevStep => {
                self.queue[idx].step = self.queue[idx].step.prev();
                self.queue[idx].attempts_on_step = 0;
                self.queue[idx].updated_at_utc = now;
                Ok(None)
            }
            QsoAction::NextStep => {
                self.queue[idx].step = self.queue[idx].step.next();
                self.queue[idx].attempts_on_step = 0;
                self.queue[idx].updated_at_utc = now;
                Ok(None)
            }
            QsoAction::MoveUp => {
                if idx > 0 {
                    self.queue.swap(idx, idx - 1);
                }
                Ok(None)
            }
            QsoAction::MoveDown => {
                if idx + 1 < self.queue.len() {
                    self.queue.swap(idx, idx + 1);
                }
                Ok(None)
            }
            QsoAction::Abandon => {
                self.queue.remove(idx);
                Ok(None)
            }
            QsoAction::Complete => {
                let q = self.queue.remove(idx);
                if q.is_cq {
                    return Err("cannot log a pure CQ call as a completed QSO".to_string());
                }
                Ok(Some(self.build_qso_record(
                    q,
                    "manual_complete",
                    dial_freq_hz,
                )))
            }
        }
    }

    pub fn format_step_message(&self, qso: &ActiveQso) -> String {
        let g4 = self.grid4();
        let their_snr = qso.last_their_snr_db.unwrap_or(-10).clamp(-50, 49);
        match qso.step {
            QsoStep::CallingCq => match qso.directed_cq {
                Some(ref dir) => format!("CQ {} {} {}", dir, qso.my_call, g4),
                None => format!("CQ {} {}", qso.my_call, g4),
            },
            QsoStep::SendGrid => format!("{} {} {}", qso.their_call, qso.my_call, g4),
            QsoStep::SendReport => {
                format!("{} {} {:+03}", qso.their_call, qso.my_call, their_snr)
            }
            QsoStep::SendRReport => {
                format!("{} {} R{:+03}", qso.their_call, qso.my_call, their_snr)
            }
            QsoStep::SendRr73 => format!("{} {} RR73", qso.their_call, qso.my_call),
            QsoStep::Send73 => format!("{} {} 73", qso.their_call, qso.my_call),
        }
    }

    pub fn compose_tx_for_slot(&self, slot: SlotParity, virtual_now_ms: i64) -> Option<TxIntent> {
        if !self.tx_enabled {
            return None;
        }
        if let Some(ref survey) = self.survey {
            if virtual_now_ms < survey.hold_until_virtual_ms {
                return None;
            }
        }
        if let Some(ref manual) = self.manual_tx {
            if manual.slot == slot {
                return Some(manual.clone());
            }
        }
        let next_qso = self
            .queue
            .iter()
            .find(|q| q.status == QsoStatus::Active && q.tx_slot == slot)?;

        Some(TxIntent {
            af_hz: self.tx_af_hz,
            slot,
            message: self.format_step_message(next_qso),
        })
    }

    pub fn on_rx_decode(
        &mut self,
        decode: &Ft8Decode,
        dial_freq_hz: Option<i64>,
    ) -> Vec<QsoRecord> {
        let rx_slot = SlotParity::from_unix_secs(decode.slot_ts);
        if self.recent_decodes.len() >= MAX_RECENT_DECODES {
            self.recent_decodes.pop_back();
        }
        self.recent_decodes.push_front(RecentDecodeEntry {
            ts_sec: decode.slot_ts.0,
            slot: rx_slot,
            snr_db: decode.snr_db,
            dt_sec: decode.dt_sec,
            af_hz: decode.af_hz,
            message: decode.message.clone(),
            decoder_backend: decode.decoder_backend.clone(),
        });

        if let Some(ref mut survey) = self.survey {
            survey.collected_afs.push(decode.af_hz);
        }

        let mut completed = Vec::new();
        let ParsedFt8Message::Directed {
            to, from, payload, ..
        } = parse_ft8_message(&decode.message)
        else {
            return completed;
        };

        if to != self.my_call || from == self.my_call {
            return completed;
        }

        let existing_idx = self
            .queue
            .iter()
            .position(|q| !q.is_cq && q.their_call == from);

        let target_idx = match existing_idx {
            Some(idx) => idx,
            None => {
                // Never log or open a QSO on unsolicited bare "73".
                if matches!(payload, Some(Ft8Payload::Terminal(ref t)) if t == "73") {
                    return completed;
                }
                let has_active_cq = self
                    .queue
                    .iter()
                    .any(|q| q.is_cq && q.status == QsoStatus::Active);
                if !has_active_cq {
                    return completed;
                }
                self.queue.retain(|q| !q.is_cq);
                let now = now_utc_str();
                let promoted = ActiveQso {
                    qso_id: Uuid::now_v7().to_string(),
                    radio_id: self.radio_id.clone(),
                    is_demo: self.is_demo,
                    is_cq: false,
                    directed_cq: None,
                    my_call: self.my_call.clone(),
                    my_grid: self.my_grid.clone(),
                    their_call: from,
                    their_grid: None,
                    tx_slot: rx_slot.opposite(),
                    step: QsoStep::SendReport,
                    status: QsoStatus::Active,
                    attempts_on_step: 0,
                    last_their_snr_db: Some(decode.snr_db),
                    rst_sent: None,
                    rst_rcvd: None,
                    started_at_utc: now.clone(),
                    updated_at_utc: now,
                    transcript: Vec::new(),
                };
                self.queue.insert(0, promoted);
                0
            }
        };

        let now = now_utc_str();
        let mut finished_qso = false;

        {
            let q = &mut self.queue[target_idx];
            q.last_their_snr_db = Some(decode.snr_db);
            q.tx_slot = rx_slot.opposite();
            q.updated_at_utc = now.clone();
            q.transcript.push(TranscriptEntry {
                at_utc: now,
                direction: "rx".to_string(),
                slot_ts: decode.slot_ts.0,
                af_hz: decode.af_hz,
                snr_db: Some(decode.snr_db),
                message: decode.message.clone(),
            });

            match payload {
                Some(Ft8Payload::Grid(grid)) => {
                    q.their_grid = Some(grid);
                    q.step = QsoStep::SendReport;
                    q.attempts_on_step = 0;
                }
                Some(Ft8Payload::Report {
                    is_roger: false,
                    snr_db,
                }) => {
                    q.rst_rcvd = Some(format!("{snr_db:+03}"));
                    q.step = QsoStep::SendRReport;
                    q.attempts_on_step = 0;
                }
                Some(Ft8Payload::Report {
                    is_roger: true,
                    snr_db,
                }) => {
                    q.rst_rcvd = Some(format!("{snr_db:+03}"));
                    q.step = QsoStep::SendRr73;
                    q.attempts_on_step = 0;
                }
                Some(Ft8Payload::Terminal(ref term)) if term == "RR73" || term == "RRR" => {
                    q.step = QsoStep::Send73;
                    q.attempts_on_step = 0;
                }
                Some(Ft8Payload::Terminal(ref term)) if term == "73" => {
                    finished_qso = true;
                }
                _ => {}
            }
        }

        if finished_qso {
            let done = self.queue.remove(target_idx);
            completed.push(self.build_qso_record(done, "73_rcvd", dial_freq_hz));
        }

        completed
    }

    pub fn on_tx_confirmed(
        &mut self,
        slot_ts: UnixSecs,
        intent: &TxIntent,
        dial_freq_hz: Option<i64>,
    ) -> Option<QsoRecord> {
        if let Some(ref manual) = self.manual_tx {
            if manual == intent {
                self.manual_tx = None;
                return None;
            }
        }

        let tx_parity = SlotParity::from_unix_secs(slot_ts);
        let idx = self
            .queue
            .iter()
            .position(|q| q.status == QsoStatus::Active && q.tx_slot == tx_parity)?;

        let now = now_utc_str();
        let mut complete_now = false;
        let mut timed_out = false;

        {
            let q = &mut self.queue[idx];
            q.updated_at_utc = now.clone();
            q.transcript.push(TranscriptEntry {
                at_utc: now,
                direction: "tx".to_string(),
                slot_ts: slot_ts.0,
                af_hz: intent.af_hz,
                snr_db: None,
                message: intent.message.clone(),
            });

            match q.step {
                QsoStep::SendReport | QsoStep::SendRReport => {
                    let sent = q.last_their_snr_db.unwrap_or(-10).clamp(-50, 49);
                    q.rst_sent = Some(format!("{sent:+03}"));
                    q.attempts_on_step = q.attempts_on_step.saturating_add(1);
                }
                QsoStep::Send73 => {
                    complete_now = true;
                }
                QsoStep::CallingCq => {
                    q.attempts_on_step = q.attempts_on_step.saturating_add(1);
                }
                QsoStep::SendGrid | QsoStep::SendRr73 => {
                    q.attempts_on_step = q.attempts_on_step.saturating_add(1);
                }
            }

            if !q.is_cq && !complete_now && q.attempts_on_step >= MAX_CONFIRMED_RETRIES {
                timed_out = true;
            }
        }

        if complete_now {
            let done = self.queue.remove(idx);
            return Some(self.build_qso_record(done, "73_sent", dial_freq_hz));
        }

        if timed_out {
            self.queue.remove(idx);
        }

        None
    }

    pub fn is_af_occupied(
        &self,
        af_hz: u16,
        tx_slot: SlotParity,
        current_slot_ts: UnixSecs,
    ) -> OccupiedAfStatus {
        for d in &self.recent_decodes {
            if d.slot == tx_slot
                && current_slot_ts.0 - d.ts_sec <= OCCUPIED_LOOKBACK_SECS
                && (i32::from(d.af_hz) - i32::from(af_hz)).abs() <= OCCUPIED_AF_TOLERANCE_HZ
            {
                return OccupiedAfStatus {
                    occupied: true,
                    conflicting_af_hz: Some(d.af_hz),
                    conflicting_call: Some(d.message.clone()),
                };
            }
        }
        OccupiedAfStatus {
            occupied: false,
            conflicting_af_hz: None,
            conflicting_call: None,
        }
    }

    pub fn occupied_afs_by_parity(&self, current_slot_ts: UnixSecs) -> (Vec<u16>, Vec<u16>) {
        let mut even = Vec::new();
        let mut odd = Vec::new();
        for d in &self.recent_decodes {
            if current_slot_ts.0 - d.ts_sec <= OCCUPIED_LOOKBACK_SECS {
                match d.slot {
                    SlotParity::Even => even.push(d.af_hz),
                    SlotParity::Odd => odd.push(d.af_hz),
                }
            }
        }
        even.sort_unstable();
        even.dedup();
        odd.sort_unstable();
        odd.dedup();
        (even, odd)
    }

    pub fn begin_af_survey(&mut self, virtual_now_ms: i64, slot_ms: i64) {
        let rem_ms = slot_ms - virtual_now_ms.rem_euclid(slot_ms);
        let hold_until_virtual_ms = virtual_now_ms + rem_ms + slot_ms + 5_000;
        self.survey = Some(AfSurveyState {
            hold_until_virtual_ms,
            collected_afs: Vec::new(),
        });
    }

    pub fn maybe_finish_af_survey(&mut self, virtual_now_ms: i64) -> Option<u16> {
        let done = self
            .survey
            .as_ref()
            .is_some_and(|s| virtual_now_ms >= s.hold_until_virtual_ms);
        if !done {
            return None;
        }
        let survey = self.survey.take()?;
        let chosen = select_widest_clear_af(&survey.collected_afs);
        self.tx_af_hz = chosen;
        Some(chosen)
    }

    fn build_qso_record(
        &self,
        qso: ActiveQso,
        completion_reason: &str,
        dial_freq_hz: Option<i64>,
    ) -> QsoRecord {
        let band = dial_freq_hz
            .and_then(|hz| u64::try_from(hz).ok())
            .and_then(derive_band)
            .map(str::to_string);
        QsoRecord {
            qso_id: qso.qso_id,
            radio_id: if self.is_demo {
                None
            } else {
                Some(qso.radio_id)
            },
            started_at_utc: qso.started_at_utc,
            completed_at_utc: now_utc_str(),
            my_call: qso.my_call,
            my_grid: qso.my_grid,
            their_call: qso.their_call,
            their_grid: qso.their_grid,
            mode: "FT8".to_string(),
            dial_freq_hz,
            band,
            af_hz: Some(i64::from(self.tx_af_hz)),
            rst_sent: qso.rst_sent,
            rst_rcvd: qso.rst_rcvd,
            completion_reason: completion_reason.to_string(),
            transcript_json: serde_json::to_string(&qso.transcript)
                .unwrap_or_else(|_| "[]".to_string()),
        }
    }
}

/// Select the midpoint (rounded to nearest 10 Hz) of the widest unoccupied gap inside `300..=2700 Hz`.
pub fn select_widest_clear_af(occupied_afs: &[u16]) -> u16 {
    if occupied_afs.is_empty() {
        return 1500;
    }

    let mut intervals: Vec<(u16, u16)> = occupied_afs
        .iter()
        .map(|&af| {
            let lo = af
                .saturating_sub(SURVEY_HALF_WIDTH_HZ)
                .clamp(SURVEY_MIN_AF_HZ, SURVEY_MAX_AF_HZ);
            let hi = af
                .saturating_add(SURVEY_HALF_WIDTH_HZ)
                .clamp(SURVEY_MIN_AF_HZ, SURVEY_MAX_AF_HZ);
            (lo, hi)
        })
        .collect();
    intervals.sort_unstable();

    let mut merged: Vec<(u16, u16)> = Vec::with_capacity(intervals.len());
    for (lo, hi) in intervals {
        if let Some(last) = merged.last_mut() {
            if lo <= last.1 {
                last.1 = last.1.max(hi);
                continue;
            }
        }
        merged.push((lo, hi));
    }

    let mut best_width = 0_u16;
    let mut best_mid = 1500_u16;
    let mut cursor = SURVEY_MIN_AF_HZ;

    for (lo, hi) in merged {
        if lo > cursor {
            let w = lo - cursor;
            if w > best_width {
                best_width = w;
                best_mid = cursor + w / 2;
            }
        }
        cursor = cursor.max(hi);
    }

    if SURVEY_MAX_AF_HZ > cursor {
        let w = SURVEY_MAX_AF_HZ - cursor;
        if w > best_width {
            best_mid = cursor + w / 2;
        }
    }

    let rounded = ((u32::from(best_mid) + 5) / 10) * 10;
    (rounded as u16).clamp(SURVEY_MIN_AF_HZ, SURVEY_MAX_AF_HZ)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_decode(ts: i64, snr: i8, af: u16, msg: &str) -> Ft8Decode {
        Ft8Decode {
            slot_ts: UnixSecs(ts),
            snr_db: snr,
            dt_sec: 0.1,
            af_hz: af,
            message: msg.to_string(),
            raw_metadata: None,
            decoder_backend: "simulated".to_string(),
        }
    }

    #[test]
    fn cq_initiated_qso_completes_on_73_rcvd_and_sends_their_snr() {
        let mut seq = QsoSequencer::new("rad_1", false, "N1MPM", "FN33ab");
        seq.set_af(1420);
        seq.start_cq(SlotParity::Even, None);

        let tx0 = seq.compose_tx_for_slot(SlotParity::Even, 0).unwrap();
        assert_eq!(tx0.message, "CQ N1MPM FN33");
        assert!(seq
            .on_tx_confirmed(UnixSecs(0), &tx0, Some(14_074_000))
            .is_none());

        // Caller replies with grid + SNR -08
        let done0 = seq.on_rx_decode(
            &mk_decode(15, -8, 1200, "N1MPM JA1ABC PM95"),
            Some(14_074_000),
        );
        assert!(done0.is_empty());

        let tx1 = seq.compose_tx_for_slot(SlotParity::Even, 30_000).unwrap();
        assert_eq!(tx1.message, "JA1ABC N1MPM -08");
        assert!(seq
            .on_tx_confirmed(UnixSecs(30), &tx1, Some(14_074_000))
            .is_none());

        // Peer gives us +03 report -> we must STILL send their latest SNR (-12), not +03
        seq.on_rx_decode(
            &mk_decode(45, -12, 1200, "N1MPM JA1ABC +03"),
            Some(14_074_000),
        );
        let tx2 = seq.compose_tx_for_slot(SlotParity::Even, 60_000).unwrap();
        assert_eq!(tx2.message, "JA1ABC N1MPM R-12");
        assert!(seq
            .on_tx_confirmed(UnixSecs(60), &tx2, Some(14_074_000))
            .is_none());

        // Peer sends RR73 -> never treated as a grid; advances to Send73
        seq.on_rx_decode(
            &mk_decode(75, -11, 1200, "N1MPM JA1ABC RR73"),
            Some(14_074_000),
        );
        let tx3 = seq.compose_tx_for_slot(SlotParity::Even, 90_000).unwrap();
        assert_eq!(tx3.message, "JA1ABC N1MPM 73");

        let rec = seq
            .on_tx_confirmed(UnixSecs(90), &tx3, Some(14_074_000))
            .expect("confirmed 73 TX should complete QSO");
        assert_eq!(rec.their_call, "JA1ABC");
        assert_eq!(rec.their_grid.as_deref(), Some("PM95"));
        assert_eq!(rec.rst_sent.as_deref(), Some("-12"));
        assert_eq!(rec.rst_rcvd.as_deref(), Some("+03"));
        assert_eq!(rec.band.as_deref(), Some("20m"));
        assert_eq!(rec.completion_reason, "73_sent");
        assert!(seq.queue.is_empty());
    }

    #[test]
    fn ignores_unsolicited_73_and_times_out_after_5_confirmed_attempts() {
        let mut seq = QsoSequencer::new("rad_1", true, "QQ0DEMO", "FN33");
        let done = seq.on_rx_decode(&mk_decode(15, -5, 1000, "QQ0DEMO QQ9XYZ 73"), None);
        assert!(done.is_empty());
        assert!(seq.queue.is_empty());

        seq.start_reply("QQ2BBB", Some("JO01".into()), SlotParity::Even, Some(-10));
        for step_idx in 0..5 {
            let slot_ts = UnixSecs(15 + step_idx * 30);
            let tx = seq
                .compose_tx_for_slot(SlotParity::Odd, slot_ts.0 * 1000)
                .expect("QSO should stay queued up to 5 attempts");
            assert!(seq
                .on_tx_confirmed(slot_ts, &tx, Some(14_074_000))
                .is_none());
        }
        assert!(
            seq.queue.is_empty(),
            "QSO should expire cleanly after 5 confirmed TX attempts"
        );
    }

    #[test]
    fn detects_occupied_af_and_selects_widest_clear_gap() {
        let mut seq = QsoSequencer::new("rad_1", false, "N1MPM", "FN33");
        seq.on_rx_decode(&mk_decode(60, -10, 1400, "CQ K1ABC FN42"), None);

        let occ = seq.is_af_occupied(1430, SlotParity::Even, UnixSecs(90));
        assert!(occ.occupied);
        assert_eq!(occ.conflicting_af_hz, Some(1400));

        let clear = seq.is_af_occupied(1430, SlotParity::Odd, UnixSecs(90));
        assert!(!clear.occupied);

        // With transmitters around 500 Hz and 900 Hz, widest gap in 300..2700 is 950..2700 -> mid ~1825 -> 1830 Hz
        let best = select_widest_clear_af(&[500, 900]);
        assert!((1800..=1850).contains(&best), "got {best} Hz");
    }
}
