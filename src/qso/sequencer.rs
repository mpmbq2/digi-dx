use std::collections::{HashMap, VecDeque};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::domain::adif::QsoRecord;
use crate::domain::bands::derive_band;
use crate::domain::clock::{SlotParity, UnixSecs};
use crate::domain::ft8::{
    infer_station_role, maidenhead_distance_km, parse_ft8_message, Ft8Payload, ParsedFt8Message,
    StationRole,
};
use crate::modem::{Ft8Decode, TxIntent};
use crate::store::now_utc_str;

const MAX_RECENT_DECODES: usize = 300;
const MAX_KNOWN_GRIDS: usize = 2000;
const MAX_CONFIRMED_RETRIES: u8 = 5;
const OCCUPIED_AF_TOLERANCE_HZ: i32 = 50;
const OCCUPIED_LOOKBACK_SECS: i64 = 60;
const SURVEY_MIN_AF_HZ: u16 = 300;
const SURVEY_MAX_AF_HZ: u16 = 2700;
const SURVEY_HALF_WIDTH_HZ: u16 = 50;

fn strip_call_brackets(s: &str) -> &str {
    s.trim().trim_matches(|c| c == '<' || c == '>')
}

fn random_u64() -> u64 {
    let bytes = *Uuid::new_v4().as_bytes();
    u64::from_le_bytes([
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
    ])
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QsoStep {
    CallingCq,
    SendGrid,
    SendReport,
    SendRReport,
    #[serde(rename = "send_rr73")]
    SendRr73,
    #[serde(rename = "send_73")]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SequencerMode {
    #[default]
    AutoSequence,
    Manual,
}

impl SequencerMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AutoSequence => "auto_sequence",
            Self::Manual => "manual",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "auto_sequence" => Ok(Self::AutoSequence),
            "manual" => Ok(Self::Manual),
            other => Err(format!(
                "invalid sequencer mode '{other}' (expected 'auto_sequence' or 'manual')"
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CqState {
    pub qso_id: String,
    pub tx_slot: SlotParity,
    pub directed_cq: Option<String>,
    pub attempts: u8,
    pub armed: bool,
    pub started_at_utc: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum ArmedTarget {
    #[default]
    None,
    Cq,
    Qso(String),
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub their_role: Option<StationRole>,
    pub tx_slot: SlotParity,
    pub step: QsoStep,
    pub status: QsoStatus,
    pub attempts_on_step: u8,
    pub last_their_snr_db: Option<i8>,
    #[serde(default)]
    pub last_rx_slot_ts: Option<i64>,
    #[serde(skip)]
    pub tie_breaker: u64,
    pub rst_sent: Option<String>,
    pub rst_rcvd: Option<String>,
    pub started_at_utc: String,
    pub updated_at_utc: String,
    pub transcript: Vec<TranscriptEntry>,
}

impl ActiveQso {
    pub fn has_confirmed_tx(&self) -> bool {
        self.attempts_on_step > 0 || self.transcript.iter().any(|t| t.direction == "tx")
    }

    pub fn advancement_rank(&self) -> u8 {
        match self.step {
            QsoStep::CallingCq => 0,
            QsoStep::SendGrid => 10,
            QsoStep::SendReport => {
                if self.has_confirmed_tx() {
                    30
                } else {
                    20
                }
            }
            QsoStep::SendRReport => {
                if self.their_role == Some(StationRole::Hunter) && !self.has_confirmed_tx() {
                    25
                } else {
                    40
                }
            }
            QsoStep::SendRr73 => 50,
            QsoStep::Send73 => 60,
        }
    }
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decoder_metadata: Option<String>,
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
    Arm,
    Resume,
    Pause,
    Retry,
    Complete,
    Abandon,
    PrevStep,
    NextStep,
    MoveUp,
    MoveDown,
    MoveToTop,
}

impl QsoAction {
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim() {
            "arm" => Ok(Self::Arm),
            "resume" => Ok(Self::Resume),
            "pause" => Ok(Self::Pause),
            "retry" => Ok(Self::Retry),
            "complete" => Ok(Self::Complete),
            "abandon" => Ok(Self::Abandon),
            "prev_step" => Ok(Self::PrevStep),
            "next_step" => Ok(Self::NextStep),
            "move_up" => Ok(Self::MoveUp),
            "move_down" => Ok(Self::MoveDown),
            "move_to_top" => Ok(Self::MoveToTop),
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
    pub mode: SequencerMode,
    pub cq: Option<CqState>,
    pub armed_target: ArmedTarget,
    pub queue: Vec<ActiveQso>,
    pub known_grids: HashMap<String, String>,
    pub recent_decodes: VecDeque<RecentDecodeEntry>,
    pub survey: Option<AfSurveyState>,
    pub last_cq_tx_slot_ts: Option<i64>,
    pub last_cq_reply_slot_ts: Option<i64>,
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
            mode: SequencerMode::AutoSequence,
            cq: None,
            armed_target: ArmedTarget::None,
            queue: Vec::new(),
            known_grids: HashMap::new(),
            recent_decodes: VecDeque::with_capacity(MAX_RECENT_DECODES),
            survey: None,
            last_cq_tx_slot_ts: None,
            last_cq_reply_slot_ts: None,
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

    fn sync_cq_armed(&mut self) {
        if let Some(ref mut cq) = self.cq {
            cq.armed = matches!(self.armed_target, ArmedTarget::Cq);
        }
    }

    fn fallback_arm_cq_or_none(&mut self) {
        if self.cq.is_some() {
            self.armed_target = ArmedTarget::Cq;
        } else {
            self.armed_target = ArmedTarget::None;
        }
        self.sync_cq_armed();
    }

    pub fn armed_qso_id(&self) -> Option<String> {
        match &self.armed_target {
            ArmedTarget::Qso(id)
                if self
                    .queue
                    .iter()
                    .any(|q| q.qso_id == *id && q.status == QsoStatus::Active) =>
            {
                Some(id.clone())
            }
            _ => None,
        }
    }

    pub fn format_cq_message(&self, cq: &CqState) -> String {
        let g4 = self.grid4();
        match cq.directed_cq {
            Some(ref dir) => format!("CQ {} {} {}", dir, self.my_call, g4)
                .trim()
                .to_string(),
            None => format!("CQ {} {}", self.my_call, g4).trim().to_string(),
        }
    }

    fn cache_known_grid(&mut self, call: &str, grid: &str) {
        let call_clean = strip_call_brackets(call).to_ascii_uppercase();
        let grid_clean = grid.trim().to_ascii_uppercase();
        if call_clean.is_empty() || grid_clean.is_empty() {
            return;
        }
        if self.known_grids.len() >= MAX_KNOWN_GRIDS && !self.known_grids.contains_key(&call_clean)
        {
            self.known_grids.clear();
        }
        self.known_grids.insert(call_clean, grid_clean);
    }

    pub fn reselect_armed_auto(&mut self) {
        let winner_id = self
            .queue
            .iter()
            .filter(|q| !q.is_cq && q.status == QsoStatus::Active)
            .max_by_key(|q| {
                let dist = q
                    .their_grid
                    .as_deref()
                    .and_then(|g| maidenhead_distance_km(&self.my_grid, g));
                (
                    q.last_rx_slot_ts,
                    q.advancement_rank(),
                    dist,
                    q.last_their_snr_db,
                    q.tie_breaker,
                )
            })
            .map(|q| q.qso_id.clone());

        if let Some(id) = winner_id {
            self.armed_target = ArmedTarget::Qso(id);
        } else if self.cq.is_some() {
            self.armed_target = ArmedTarget::Cq;
        } else {
            self.armed_target = ArmedTarget::None;
        }
        self.sync_cq_armed();
    }

    pub fn set_mode(&mut self, mode: SequencerMode) {
        self.mode = mode;
        if mode == SequencerMode::AutoSequence && self.armed_target != ArmedTarget::Cq {
            self.reselect_armed_auto();
        }
        self.sync_cq_armed();
    }

    pub fn start_cq(&mut self, slot: SlotParity, directed: Option<String>) -> CqState {
        let now = now_utc_str();
        let dir_norm = directed
            .map(|d| d.trim().to_ascii_uppercase())
            .filter(|d| !d.is_empty());

        self.queue.retain(|q| !q.is_cq);
        self.manual_tx = None;
        self.tx_enabled = true;
        self.last_cq_reply_slot_ts = None;

        let cq = CqState {
            qso_id: Uuid::now_v7().to_string(),
            tx_slot: slot,
            directed_cq: dir_norm,
            attempts: 0,
            armed: true,
            started_at_utc: now,
        };
        self.cq = Some(cq.clone());
        self.armed_target = ArmedTarget::Cq;
        cq
    }

    pub fn stop_cq(&mut self) {
        self.cq = None;
        if self.armed_target == ArmedTarget::Cq {
            self.armed_target = ArmedTarget::None;
            if self.mode == SequencerMode::AutoSequence {
                self.reselect_armed_auto();
            }
        }
    }

    pub fn start_reply(
        &mut self,
        their_call: &str,
        their_grid: Option<String>,
        rx_slot: SlotParity,
        snr_db: Option<i8>,
    ) -> ActiveQso {
        self.start_reply_with_rx(their_call, their_grid, rx_slot, snr_db, None)
    }

    pub fn start_reply_with_rx(
        &mut self,
        their_call: &str,
        their_grid: Option<String>,
        rx_slot: SlotParity,
        snr_db: Option<i8>,
        initial_rx: Option<TranscriptEntry>,
    ) -> ActiveQso {
        let now = now_utc_str();
        let call = their_call.trim().to_ascii_uppercase();
        let grid = their_grid
            .map(|g| g.trim().to_ascii_uppercase())
            .filter(|g| !g.is_empty())
            .or_else(|| self.known_grids.get(&call).cloned());
        if let Some(ref g) = grid {
            self.cache_known_grid(&call, g);
        }

        self.queue.retain(|q| !q.is_cq && q.their_call != call);
        self.cq = None;
        self.manual_tx = None;
        self.tx_enabled = true;

        let transcript = match initial_rx {
            Some(entry) if !entry.message.trim().is_empty() => vec![entry],
            _ => Vec::new(),
        };

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
            their_role: Some(StationRole::Caller),
            tx_slot: rx_slot.opposite(),
            step: QsoStep::SendGrid,
            status: QsoStatus::Active,
            attempts_on_step: 0,
            last_their_snr_db: snr_db,
            last_rx_slot_ts: None,
            tie_breaker: random_u64(),
            rst_sent: None,
            rst_rcvd: None,
            started_at_utc: now.clone(),
            updated_at_utc: now,
            transcript,
        };
        self.armed_target = ArmedTarget::Qso(qso.qso_id.clone());
        self.queue.insert(0, qso.clone());
        qso
    }

    pub fn apply_action(
        &mut self,
        qso_id: &str,
        action: QsoAction,
        dial_freq_hz: Option<i64>,
    ) -> Result<Option<QsoRecord>, String> {
        if self.cq.as_ref().is_some_and(|c| c.qso_id == qso_id) {
            match action {
                QsoAction::Abandon | QsoAction::Pause => {
                    self.stop_cq();
                    return Ok(None);
                }
                QsoAction::Arm | QsoAction::Resume | QsoAction::Retry => {
                    if action == QsoAction::Retry {
                        if let Some(ref mut cq) = self.cq {
                            cq.attempts = 0;
                        }
                    }
                    self.armed_target = ArmedTarget::Cq;
                    self.sync_cq_armed();
                    return Ok(None);
                }
                _ => {}
            }
        }

        let Some(idx) = self.queue.iter().position(|q| q.qso_id == qso_id) else {
            return Err(format!("QSO '{qso_id}' not found in active queue"));
        };

        let now = now_utc_str();
        match action {
            QsoAction::Arm => {
                if self.queue[idx].status == QsoStatus::Paused {
                    return Err("Cannot arm a paused QSO; set it to Active first".to_string());
                }
                self.cq = None;
                self.armed_target = ArmedTarget::Qso(qso_id.to_string());
                if idx > 0 {
                    let item = self.queue.remove(idx);
                    self.queue.insert(0, item);
                }
                Ok(None)
            }
            QsoAction::Resume => {
                self.queue[idx].status = QsoStatus::Active;
                self.queue[idx].updated_at_utc = now;
                if self.mode == SequencerMode::AutoSequence && self.armed_target != ArmedTarget::Cq
                {
                    self.reselect_armed_auto();
                }
                Ok(None)
            }
            QsoAction::Pause => {
                self.queue[idx].status = QsoStatus::Paused;
                self.queue[idx].updated_at_utc = now;
                if self.armed_target == ArmedTarget::Qso(qso_id.to_string()) {
                    self.armed_target = ArmedTarget::None;
                    if self.mode == SequencerMode::AutoSequence {
                        self.reselect_armed_auto();
                    } else {
                        self.fallback_arm_cq_or_none();
                    }
                }
                Ok(None)
            }
            QsoAction::Retry => {
                self.queue[idx].attempts_on_step = 0;
                self.queue[idx].status = QsoStatus::Active;
                self.queue[idx].updated_at_utc = now;
                if self.mode == SequencerMode::AutoSequence && self.armed_target != ArmedTarget::Cq
                {
                    self.reselect_armed_auto();
                }
                Ok(None)
            }
            QsoAction::PrevStep => {
                self.queue[idx].step = self.queue[idx].step.prev();
                self.queue[idx].attempts_on_step = 0;
                self.queue[idx].updated_at_utc = now;
                if self.mode == SequencerMode::AutoSequence && self.armed_target != ArmedTarget::Cq
                {
                    self.reselect_armed_auto();
                }
                Ok(None)
            }
            QsoAction::NextStep => {
                self.queue[idx].step = self.queue[idx].step.next();
                self.queue[idx].attempts_on_step = 0;
                self.queue[idx].updated_at_utc = now;
                if self.mode == SequencerMode::AutoSequence && self.armed_target != ArmedTarget::Cq
                {
                    self.reselect_armed_auto();
                }
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
            QsoAction::MoveToTop => {
                if idx > 0 {
                    let item = self.queue.remove(idx);
                    self.queue.insert(0, item);
                }
                Ok(None)
            }
            QsoAction::Abandon => {
                let removed = self.queue.remove(idx);
                if self.armed_target == ArmedTarget::Qso(removed.qso_id) {
                    self.armed_target = ArmedTarget::None;
                    if self.mode == SequencerMode::AutoSequence {
                        self.reselect_armed_auto();
                    } else {
                        self.fallback_arm_cq_or_none();
                    }
                }
                Ok(None)
            }
            QsoAction::Complete => {
                let q = self.queue.remove(idx);
                if q.is_cq {
                    return Err("cannot log a pure CQ call as a completed QSO".to_string());
                }
                if self.armed_target == ArmedTarget::Qso(q.qso_id.clone()) {
                    self.armed_target = ArmedTarget::None;
                    if self.mode == SequencerMode::AutoSequence {
                        self.reselect_armed_auto();
                    } else {
                        self.fallback_arm_cq_or_none();
                    }
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
        match &self.armed_target {
            ArmedTarget::Cq => {
                let cq = self.cq.as_ref()?;
                if cq.tx_slot != slot {
                    return None;
                }
                Some(TxIntent {
                    af_hz: self.tx_af_hz,
                    slot,
                    message: self.format_cq_message(cq),
                })
            }
            ArmedTarget::Qso(id) => {
                let next_qso = self
                    .queue
                    .iter()
                    .find(|q| q.qso_id == *id && q.status == QsoStatus::Active)?;
                if next_qso.tx_slot != slot {
                    return None;
                }
                Some(TxIntent {
                    af_hz: self.tx_af_hz,
                    slot,
                    message: self.format_step_message(next_qso),
                })
            }
            ArmedTarget::None => None,
        }
    }

    pub fn on_rx_decode(
        &mut self,
        decode: &Ft8Decode,
        dial_freq_hz: Option<i64>,
    ) -> Vec<QsoRecord> {
        let rx_slot = SlotParity::from_unix_secs(decode.slot_ts);
        let entry = RecentDecodeEntry {
            ts_sec: decode.slot_ts.0,
            slot: rx_slot,
            snr_db: decode.snr_db,
            dt_sec: decode.dt_sec,
            af_hz: decode.af_hz,
            message: decode.message.clone(),
            decoder_backend: decode.decoder_backend.clone(),
            decoder_metadata: decode.raw_metadata.clone(),
        };
        let insert_idx = self
            .recent_decodes
            .iter()
            .position(|d| d.ts_sec <= decode.slot_ts.0)
            .unwrap_or(self.recent_decodes.len());
        self.recent_decodes.insert(insert_idx, entry);
        while self.recent_decodes.len() > MAX_RECENT_DECODES {
            self.recent_decodes.pop_back();
        }

        if let Some(ref mut survey) = self.survey {
            survey.collected_afs.push(decode.af_hz);
        }

        let mut completed = Vec::new();
        let parsed = parse_ft8_message(&decode.message);
        match &parsed {
            ParsedFt8Message::Cq {
                callsign,
                grid: Some(grid),
                ..
            } => self.cache_known_grid(callsign, grid),
            ParsedFt8Message::Directed {
                from,
                payload: Some(Ft8Payload::Grid(grid)),
                ..
            } => self.cache_known_grid(from, grid),
            _ => {}
        }

        let inferred_role = infer_station_role(&parsed);
        let ParsedFt8Message::Directed {
            to, from, payload, ..
        } = parsed
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

        let mut new_cq_reply = false;
        let target_idx = match existing_idx {
            Some(idx) => idx,
            None => {
                // Never log or open a QSO on unsolicited bare "73".
                if matches!(payload, Some(Ft8Payload::Terminal(ref t)) if t == "73") {
                    return completed;
                }
                let has_active_cq = self.cq.is_some();
                let in_same_reply_slot = self.last_cq_reply_slot_ts == Some(decode.slot_ts.0);
                let recent_cq_tx = self
                    .last_cq_tx_slot_ts
                    .is_some_and(|ts| decode.slot_ts.0 > ts && decode.slot_ts.0 <= ts + 30);
                let is_cq_reply = has_active_cq || in_same_reply_slot || recent_cq_tx;

                if is_cq_reply {
                    new_cq_reply = true;
                    self.last_cq_reply_slot_ts = Some(decode.slot_ts.0);
                }

                let their_role = if is_cq_reply {
                    Some(StationRole::Hunter)
                } else {
                    inferred_role.or(Some(StationRole::Hunter))
                };
                let known_grid = self.known_grids.get(&from).cloned();

                let now = now_utc_str();
                let incoming = ActiveQso {
                    qso_id: Uuid::now_v7().to_string(),
                    radio_id: self.radio_id.clone(),
                    is_demo: self.is_demo,
                    is_cq: false,
                    directed_cq: None,
                    my_call: self.my_call.clone(),
                    my_grid: self.my_grid.clone(),
                    their_call: from,
                    their_grid: known_grid,
                    their_role,
                    tx_slot: rx_slot.opposite(),
                    step: QsoStep::SendReport,
                    status: if is_cq_reply {
                        QsoStatus::Active
                    } else {
                        QsoStatus::Paused
                    },
                    attempts_on_step: 0,
                    last_their_snr_db: Some(decode.snr_db),
                    last_rx_slot_ts: Some(decode.slot_ts.0),
                    tie_breaker: random_u64(),
                    rst_sent: None,
                    rst_rcvd: None,
                    started_at_utc: now.clone(),
                    updated_at_utc: now,
                    transcript: Vec::new(),
                };
                self.queue.push(incoming);
                self.queue.len() - 1
            }
        };

        let now = now_utc_str();
        let mut finished_qso = false;
        let qso_id_owned: String;
        let q_is_active: bool;

        {
            let q = &mut self.queue[target_idx];
            qso_id_owned = q.qso_id.clone();
            q_is_active = q.status == QsoStatus::Active;
            q.last_their_snr_db = Some(decode.snr_db);
            q.tx_slot = rx_slot.opposite();
            q.updated_at_utc = now.clone();
            if q.last_rx_slot_ts != Some(decode.slot_ts.0) {
                q.last_rx_slot_ts = Some(decode.slot_ts.0);
                q.tie_breaker = random_u64();
            }
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
            if self.armed_target == ArmedTarget::Qso(qso_id_owned) {
                self.armed_target = ArmedTarget::None;
                if self.mode == SequencerMode::AutoSequence {
                    self.reselect_armed_auto();
                } else {
                    self.fallback_arm_cq_or_none();
                }
            }
        } else if (new_cq_reply || q_is_active) && self.mode == SequencerMode::AutoSequence {
            self.cq = None;
            self.reselect_armed_auto();
        }

        completed
    }

    /// Update an already-ingested RX decode in place when a later decoder pass refines its
    /// SNR/DT/AF or upgrades its AP/uncertainty metadata, without re-triggering QSO transitions
    /// or duplicating transcript lines. Returns `true` if any `ActiveQso` was updated.
    pub fn on_rx_decode_refined(&mut self, previous: &Ft8Decode, updated: &Ft8Decode) -> bool {
        if let Some(entry) = self.recent_decodes.iter_mut().find(|d| {
            d.ts_sec == updated.slot_ts.0
                && d.message == updated.message
                && ((i32::from(d.af_hz) - i32::from(previous.af_hz)).abs() <= 15
                    || (i32::from(d.af_hz) - i32::from(updated.af_hz)).abs() <= 15)
        }) {
            entry.snr_db = updated.snr_db;
            entry.dt_sec = updated.dt_sec;
            entry.af_hz = updated.af_hz;
            entry.decoder_backend = updated.decoder_backend.clone();
            entry.decoder_metadata = updated.raw_metadata.clone();
        }

        let mut qso_changed = false;
        let mut active_qso_changed = false;
        let now = now_utc_str();
        for q in &mut self.queue {
            if q.is_cq {
                continue;
            }
            let last_rx_idx = q.transcript.iter().rposition(|t| t.direction == "rx");
            for (idx, t) in q.transcript.iter_mut().enumerate() {
                if t.direction == "rx"
                    && t.slot_ts == updated.slot_ts.0
                    && t.message == updated.message
                    && ((i32::from(t.af_hz) - i32::from(previous.af_hz)).abs() <= 15
                        || (i32::from(t.af_hz) - i32::from(updated.af_hz)).abs() <= 15)
                {
                    t.snr_db = Some(updated.snr_db);
                    t.af_hz = updated.af_hz;
                    if Some(idx) == last_rx_idx {
                        q.last_their_snr_db = Some(updated.snr_db);
                    }
                    q.updated_at_utc = now.clone();
                    qso_changed = true;
                    if q.status == QsoStatus::Active {
                        active_qso_changed = true;
                    }
                }
            }
        }
        if active_qso_changed
            && self.mode == SequencerMode::AutoSequence
            && self.armed_target != ArmedTarget::Cq
        {
            self.reselect_armed_auto();
        }
        qso_changed
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

        let now = now_utc_str();
        let parsed = parse_ft8_message(&intent.message);

        match parsed {
            ParsedFt8Message::Cq { .. } => {
                self.last_cq_tx_slot_ts = Some(slot_ts.0);
                if let Some(ref mut cq) = self.cq {
                    cq.attempts = cq.attempts.saturating_add(1);
                }
                None
            }
            ParsedFt8Message::Directed { to, payload, .. } => {
                let to_clean = strip_call_brackets(&to);
                let idx = self.queue.iter().position(|q| {
                    !q.is_cq && strip_call_brackets(&q.their_call).eq_ignore_ascii_case(to_clean)
                })?;

                let (tx_step, sent_snr) = match payload {
                    Some(Ft8Payload::Grid(_)) => (Some(QsoStep::SendGrid), None),
                    Some(Ft8Payload::Report {
                        is_roger: false,
                        snr_db,
                    }) => (Some(QsoStep::SendReport), Some(snr_db)),
                    Some(Ft8Payload::Report {
                        is_roger: true,
                        snr_db,
                    }) => (Some(QsoStep::SendRReport), Some(snr_db)),
                    Some(Ft8Payload::Terminal(ref term)) if term == "RR73" || term == "RRR" => {
                        (Some(QsoStep::SendRr73), None)
                    }
                    Some(Ft8Payload::Terminal(ref term)) if term == "73" => {
                        (Some(QsoStep::Send73), None)
                    }
                    None if self.grid4().is_empty() => (Some(QsoStep::SendGrid), None),
                    _ => (None, None),
                };

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

                    match tx_step {
                        Some(QsoStep::Send73) => {
                            complete_now = true;
                        }
                        Some(step @ (QsoStep::SendReport | QsoStep::SendRReport)) => {
                            if let Some(snr) = sent_snr {
                                q.rst_sent = Some(format!("{snr:+03}"));
                            }
                            if q.step == step {
                                q.attempts_on_step = q.attempts_on_step.saturating_add(1);
                            }
                        }
                        Some(step) if q.step == step => {
                            q.attempts_on_step = q.attempts_on_step.saturating_add(1);
                        }
                        Some(_) | None => {}
                    }

                    if !q.is_cq && !complete_now && q.attempts_on_step >= MAX_CONFIRMED_RETRIES {
                        timed_out = true;
                    }
                }

                if complete_now {
                    let done = self.queue.remove(idx);
                    if self.armed_target == ArmedTarget::Qso(done.qso_id.clone()) {
                        self.armed_target = ArmedTarget::None;
                        if self.mode == SequencerMode::AutoSequence {
                            self.reselect_armed_auto();
                        } else {
                            self.fallback_arm_cq_or_none();
                        }
                    }
                    return Some(self.build_qso_record(done, "73_sent", dial_freq_hz));
                }

                if timed_out {
                    let removed = self.queue.remove(idx);
                    if self.armed_target == ArmedTarget::Qso(removed.qso_id) {
                        self.armed_target = ArmedTarget::None;
                        if self.mode == SequencerMode::AutoSequence {
                            self.reselect_armed_auto();
                        } else {
                            self.fallback_arm_cq_or_none();
                        }
                    }
                }

                None
            }
            ParsedFt8Message::Raw { .. } => None,
        }
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
            qrz_status: None,
            qrz_logid: None,
            qrz_pushed_at_utc: None,
            qrz_error: None,
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

    #[test]
    fn multiple_cq_replies_in_same_slot_all_enqueue_and_work_in_order() {
        let mut seq = QsoSequencer::new("rad_1", false, "N1MPM", "FN33ab");
        seq.start_cq(SlotParity::Even, None);
        let cq_tx = seq.compose_tx_for_slot(SlotParity::Even, 0).unwrap();
        assert!(seq
            .on_tx_confirmed(UnixSecs(0), &cq_tx, Some(14_074_000))
            .is_none());

        for (i, (call, grid)) in [
            ("K1AAA", "FN42"),
            ("W2BBB", "EM10"),
            ("N3CCC", "DN70"),
            ("JA4DDD", "PM95"),
            ("DL5EEE", "JO31"),
        ]
        .iter()
        .enumerate()
        {
            let msg = format!("N1MPM {call} {grid}");
            seq.on_rx_decode(
                &mk_decode(15, -5 - i as i8, 900 + (i as u16) * 100, &msg),
                Some(14_074_000),
            );
        }

        assert_eq!(seq.queue.len(), 5);
        assert!(seq
            .queue
            .iter()
            .all(|q| !q.is_cq && q.status == QsoStatus::Active));
        assert!(seq.cq.is_none());

        // Same slot & step: Decision Engine prioritizes farthest Maidenhead distance from FN33ab:
        // JA4DDD (PM95) > DL5EEE (JO31) > N3CCC (DN70) > W2BBB (EM10) > K1AAA (FN42)
        let next_tx = seq.compose_tx_for_slot(SlotParity::Even, 30_000).unwrap();
        assert_eq!(next_tx.message, "JA4DDD N1MPM -08");
        let armed_id = seq.armed_qso_id().unwrap();
        seq.apply_action(&armed_id, QsoAction::Complete, Some(14_074_000))
            .unwrap();
        let second_tx = seq.compose_tx_for_slot(SlotParity::Even, 60_000).unwrap();
        assert_eq!(second_tx.message, "DL5EEE N1MPM -09");
    }

    #[test]
    fn unsolicited_directed_call_without_cq_auto_enqueues_paused() {
        let mut seq = QsoSequencer::new("rad_1", false, "N1MPM", "FN33ab");
        let done = seq.on_rx_decode(
            &mk_decode(15, -11, 1300, "N1MPM K9XYZ EN52"),
            Some(14_074_000),
        );
        assert!(done.is_empty());
        assert_eq!(seq.queue.len(), 1);
        assert_eq!(seq.queue[0].their_call, "K9XYZ");
        assert_eq!(seq.queue[0].status, QsoStatus::Paused);
        assert!(seq.compose_tx_for_slot(SlotParity::Even, 30_000).is_none());

        // Follow-up decode updates SNR/step while staying Paused
        seq.on_rx_decode(
            &mk_decode(45, -7, 1300, "N1MPM K9XYZ +01"),
            Some(14_074_000),
        );
        assert_eq!(seq.queue[0].status, QsoStatus::Paused);
        assert_eq!(seq.queue[0].step, QsoStep::SendRReport);

        // Resuming allows TX
        let qid = seq.queue[0].qso_id.clone();
        seq.apply_action(&qid, QsoAction::Resume, Some(14_074_000))
            .unwrap();
        let tx = seq.compose_tx_for_slot(SlotParity::Even, 60_000).unwrap();
        assert_eq!(tx.message, "K9XYZ N1MPM R-07");
    }

    #[test]
    fn mixed_parity_queue_only_transmits_head_active_qso() {
        let mut seq = QsoSequencer::new("rad_1", false, "N1MPM", "FN33ab");
        seq.start_reply("K1EVEN", Some("FN42".into()), SlotParity::Odd, Some(-5));
        // Second station replies in Even slot -> wants Odd TX, inserted at head and armed
        seq.start_reply("W2ODD", Some("EM10".into()), SlotParity::Even, Some(-8));
        assert!(seq.compose_tx_for_slot(SlotParity::Even, 0).is_none());
        let tx = seq.compose_tx_for_slot(SlotParity::Odd, 15_000).unwrap();
        assert!(tx.message.starts_with("W2ODD "));
    }

    #[test]
    fn move_to_top_promotes_queued_caller() {
        let mut seq = QsoSequencer::new("rad_1", false, "N1MPM", "FN33ab");
        seq.start_cq(SlotParity::Even, None);
        seq.on_rx_decode(&mk_decode(15, -10, 900, "N1MPM K1AAA FN42"), None);
        seq.on_rx_decode(&mk_decode(15, -4, 1200, "N1MPM W2BBB EM10"), None);
        let second_id = seq.queue[1].qso_id.clone();
        seq.apply_action(&second_id, QsoAction::MoveToTop, None)
            .unwrap();
        assert_eq!(seq.queue[0].their_call, "W2BBB");
    }

    #[test]
    fn late_rr73_decode_during_r_report_tx_does_not_skip_sending_73() {
        let mut seq = QsoSequencer::new("rad_1", false, "N1MPM", "FN33ab");
        seq.start_reply("K1ABC", Some("FN42".into()), SlotParity::Odd, Some(-10));

        // Peer replies with SNR report -> advances us to SendRReport
        let done = seq.on_rx_decode(
            &mk_decode(45, -8, 1200, "N1MPM K1ABC +02"),
            Some(14_074_000),
        );
        assert!(done.is_empty());

        let tx_r = seq.compose_tx_for_slot(SlotParity::Even, 60_000).unwrap();
        assert_eq!(tx_r.message, "K1ABC N1MPM R-08");

        // Race: late RR73 decode arrives BEFORE tx_r confirmation runs, bumping q.step to Send73
        let done_late = seq.on_rx_decode(
            &mk_decode(75, -9, 1200, "N1MPM K1ABC RR73"),
            Some(14_074_000),
        );
        assert!(done_late.is_empty());
        assert_eq!(seq.queue[0].step, QsoStep::Send73);

        // Confirming tx_r (R-08) must NOT complete the QSO as 73_sent!
        assert!(seq
            .on_tx_confirmed(UnixSecs(60), &tx_r, Some(14_074_000))
            .is_none());
        assert_eq!(seq.queue.len(), 1);
        assert_eq!(seq.queue[0].step, QsoStep::Send73);
        assert_eq!(seq.queue[0].attempts_on_step, 0);
        assert_eq!(seq.queue[0].rst_sent.as_deref(), Some("-08"));

        // Next slot actually composes and transmits "73"
        let tx_73 = seq.compose_tx_for_slot(SlotParity::Even, 90_000).unwrap();
        assert_eq!(tx_73.message, "K1ABC N1MPM 73");

        let rec = seq
            .on_tx_confirmed(UnixSecs(90), &tx_73, Some(14_074_000))
            .expect("confirmed 73 TX must complete QSO");
        assert_eq!(rec.completion_reason, "73_sent");
        assert!(seq.queue.is_empty());
        assert!(rec.transcript_json.contains("K1ABC N1MPM R-08"));
        assert!(rec.transcript_json.contains("K1ABC N1MPM 73"));
    }

    #[test]
    fn tx_confirmation_matches_target_call_even_if_queue_reordered() {
        let mut seq = QsoSequencer::new("rad_1", false, "N1MPM", "FN33ab");
        seq.start_reply("K1AAA", Some("FN42".into()), SlotParity::Odd, Some(-5));
        let in_flight = seq.compose_tx_for_slot(SlotParity::Even, 30_000).unwrap();
        assert_eq!(in_flight.message, "K1AAA N1MPM FN33");

        // Operator replies to W2BBB while K1AAA's TX is in flight -> W2BBB becomes head
        seq.start_reply("W2BBB", Some("EM10".into()), SlotParity::Odd, Some(-9));
        assert_eq!(seq.queue[0].their_call, "W2BBB");
        assert_eq!(seq.queue[1].their_call, "K1AAA");

        assert!(seq
            .on_tx_confirmed(UnixSecs(30), &in_flight, Some(14_074_000))
            .is_none());
        assert_eq!(seq.queue[0].attempts_on_step, 0);
        assert!(seq.queue[0].transcript.is_empty());
        assert_eq!(seq.queue[1].attempts_on_step, 1);
        assert_eq!(seq.queue[1].transcript.len(), 1);
        assert_eq!(seq.queue[1].transcript[0].message, "K1AAA N1MPM FN33");
    }

    #[test]
    fn start_reply_with_rx_seeds_initial_rx_transcript() {
        let mut seq = QsoSequencer::new("rad_1", false, "N1MPM", "FN33ab");
        let qso = seq.start_reply_with_rx(
            "K1ABC",
            Some("FN42".into()),
            SlotParity::Odd,
            Some(-6),
            Some(TranscriptEntry {
                at_utc: "2026-11-23T14:00:00.000Z".to_string(),
                direction: "rx".to_string(),
                slot_ts: 1_795_212_915,
                af_hz: 1420,
                snr_db: Some(-6),
                message: "CQ K1ABC FN42".to_string(),
            }),
        );
        assert_eq!(qso.transcript.len(), 1);
        assert_eq!(qso.transcript[0].direction, "rx");
        assert_eq!(qso.transcript[0].message, "CQ K1ABC FN42");
    }

    #[test]
    fn refined_rx_decode_updates_metadata_and_snr_in_place_without_duplicating() {
        let mut seq = QsoSequencer::new("rad_1", false, "N1MPM", "FN33ab");
        seq.start_cq(SlotParity::Even, None);

        let initial = Ft8Decode {
            slot_ts: UnixSecs(15),
            snr_db: -14,
            dt_sec: 0.4,
            af_hz: 1200,
            message: "N1MPM JA1ABC PM95".to_string(),
            raw_metadata: Some("? a1".to_string()),
            decoder_backend: "jt9".to_string(),
        };
        assert!(seq.on_rx_decode(&initial, Some(14_074_000)).is_empty());
        assert_eq!(seq.recent_decodes.len(), 1);
        assert_eq!(
            seq.recent_decodes[0].decoder_metadata.as_deref(),
            Some("? a1")
        );
        assert_eq!(seq.queue.len(), 1);
        assert_eq!(seq.queue[0].step, QsoStep::SendReport);
        assert_eq!(seq.queue[0].last_their_snr_db, Some(-14));
        assert_eq!(seq.queue[0].transcript.len(), 1);

        let refined = Ft8Decode {
            slot_ts: UnixSecs(15),
            snr_db: -11,
            dt_sec: 0.4,
            af_hz: 1202,
            message: "N1MPM JA1ABC PM95".to_string(),
            raw_metadata: None,
            decoder_backend: "jt9".to_string(),
        };
        assert!(seq.on_rx_decode_refined(&initial, &refined));

        assert_eq!(seq.recent_decodes.len(), 1);
        assert_eq!(seq.recent_decodes[0].snr_db, -11);
        assert_eq!(seq.recent_decodes[0].af_hz, 1202);
        assert_eq!(seq.recent_decodes[0].decoder_metadata, None);

        assert_eq!(seq.queue.len(), 1);
        assert_eq!(seq.queue[0].step, QsoStep::SendReport);
        assert_eq!(seq.queue[0].attempts_on_step, 0);
        assert_eq!(seq.queue[0].last_their_snr_db, Some(-11));
        assert_eq!(seq.queue[0].transcript.len(), 1);
        assert_eq!(seq.queue[0].transcript[0].snr_db, Some(-11));
        assert_eq!(seq.queue[0].transcript[0].af_hz, 1202);
    }

    #[test]
    fn qso_step_serde_roundtrip_matches_as_str_including_send_73() {
        for step in [
            QsoStep::CallingCq,
            QsoStep::SendGrid,
            QsoStep::SendReport,
            QsoStep::SendRReport,
            QsoStep::SendRr73,
            QsoStep::Send73,
        ] {
            let serialized = serde_json::to_string(&step).unwrap();
            let expected = format!("\"{}\"", step.as_str());
            assert_eq!(serialized, expected, "QsoStep::{step:?} mismatch");
            let roundtrip: QsoStep = serde_json::from_str(&serialized).unwrap();
            assert_eq!(roundtrip, step);
        }
    }

    #[test]
    fn decision_engine_follows_5_level_priority_hierarchy() {
        let mut seq = QsoSequencer::new("rad_1", false, "N1MPM", "FN33ab");
        seq.start_cq(SlotParity::Even, None);

        // Slot 15: K1AAA (FN42, nearby, strong -02) and JA1XYZ (PM95, far DX, weak -18)
        seq.on_rx_decode(&mk_decode(15, -2, 900, "N1MPM K1AAA FN42"), None);
        seq.on_rx_decode(&mk_decode(15, -18, 1100, "N1MPM JA1XYZ PM95"), None);
        // Same slot & rank -> Criterion 3 (distance) picks JA1XYZ
        assert_eq!(
            seq.compose_tx_for_slot(SlotParity::Even, 30_000)
                .unwrap()
                .message,
            "JA1XYZ N1MPM -18"
        );

        // Slot 45: ONLY K1AAA replies with +02 -> Criterion 1 (most recent cycle 45 > 15) picks K1AAA!
        seq.on_rx_decode(&mk_decode(45, -4, 900, "N1MPM K1AAA +02"), None);
        assert_eq!(
            seq.compose_tx_for_slot(SlotParity::Even, 60_000)
                .unwrap()
                .message,
            "K1AAA N1MPM R-04"
        );

        // Slot 75: Both reply in same cycle 75, JA1XYZ sends +05 (rank 50 SendRr73) while K1AAA repeats +02 (rank 40 SendRReport)
        // Criterion 2 (advancement_rank) picks JA1XYZ even though K1AAA is stronger (-2 vs -18)!
        seq.on_rx_decode(&mk_decode(75, -2, 900, "N1MPM K1AAA +02"), None);
        seq.on_rx_decode(&mk_decode(75, -18, 1100, "N1MPM JA1XYZ R+05"), None);
        assert_eq!(
            seq.compose_tx_for_slot(SlotParity::Even, 90_000)
                .unwrap()
                .message,
            "JA1XYZ N1MPM RR73"
        );

        // Criterion 4 (SNR tie-break): two stations at identical slot 105, identical rank, identical grid EM10
        let mut seq2 = QsoSequencer::new("rad_1", false, "N1MPM", "FN33ab");
        seq2.start_cq(SlotParity::Even, None);
        seq2.on_rx_decode(&mk_decode(105, -15, 800, "N1MPM W5WEAK EM10"), None);
        seq2.on_rx_decode(&mk_decode(105, -3, 1200, "N1MPM W5STRG EM10"), None);
        assert_eq!(
            seq2.compose_tx_for_slot(SlotParity::Even, 120_000)
                .unwrap()
                .message,
            "W5STRG N1MPM -03"
        );

        // Criterion 5 (coin flip): identical slot, rank, grid, AND SNR; deterministic non-panic selection
        let mut seq3 = QsoSequencer::new("rad_1", false, "N1MPM", "FN33ab");
        seq3.start_cq(SlotParity::Even, None);
        seq3.on_rx_decode(&mk_decode(135, -10, 800, "N1MPM W5ONE EM10"), None);
        seq3.on_rx_decode(&mk_decode(135, -10, 1200, "N1MPM W5TWO EM10"), None);
        let armed = seq3.armed_qso_id().expect("one tied station must be armed");
        assert!(seq3.queue.iter().any(|q| q.qso_id == armed));
    }

    #[test]
    fn cq_supersedes_paused_and_yields_when_active_or_new_reply_advances() {
        let mut seq = QsoSequencer::new("rad_1", false, "N1MPM", "FN33ab");

        // Unsolicited Paused QSO does not block CQ
        seq.on_rx_decode(&mk_decode(15, -9, 1000, "N1MPM K9PAU EM10"), None);
        assert_eq!(seq.queue[0].status, QsoStatus::Paused);
        let paused_id = seq.queue[0].qso_id.clone();

        seq.start_cq(SlotParity::Even, None);
        assert!(seq.cq.as_ref().unwrap().armed);
        assert_eq!(
            seq.compose_tx_for_slot(SlotParity::Even, 30_000)
                .unwrap()
                .message,
            "CQ N1MPM FN33"
        );
        // Paused QSO advancing on RX must NOT preempt CQ
        seq.on_rx_decode(&mk_decode(45, -8, 1000, "N1MPM K9PAU +01"), None);
        assert!(seq.cq.as_ref().unwrap().armed);
        assert!(seq.apply_action(&paused_id, QsoAction::Arm, None).is_err());

        // User starts an Active QSO while CQ is not running, then calls CQ
        seq.stop_cq();
        let active_qso = seq.start_reply("K1ACT", Some("FN42".into()), SlotParity::Odd, Some(-6));
        assert_eq!(
            seq.armed_qso_id().as_deref(),
            Some(active_qso.qso_id.as_str())
        );

        // Calling CQ while Active QSO exists makes CQ Armed
        seq.start_cq(SlotParity::Even, None);
        assert!(seq.cq.as_ref().unwrap().armed);
        assert!(seq.armed_qso_id().is_none());
        assert_eq!(
            seq.compose_tx_for_slot(SlotParity::Even, 60_000)
                .unwrap()
                .message,
            "CQ N1MPM FN33"
        );

        // When the Active QSO advances via RX reply, CQ clears and that QSO becomes Armed
        seq.on_rx_decode(&mk_decode(75, -5, 1400, "N1MPM K1ACT -04"), None);
        assert!(seq.cq.is_none());
        assert_eq!(
            seq.armed_qso_id().as_deref(),
            Some(active_qso.qso_id.as_str())
        );
        assert_eq!(
            seq.compose_tx_for_slot(SlotParity::Even, 90_000)
                .unwrap()
                .message,
            "K1ACT N1MPM R-05"
        );
    }

    #[test]
    fn manual_mode_preserves_target_until_user_changes_it() {
        let mut seq = QsoSequencer::new("rad_1", false, "N1MPM", "FN33ab");
        seq.set_mode(SequencerMode::Manual);
        seq.start_cq(SlotParity::Even, None);

        // CQ replies enqueue as Active, but Manual mode keeps CQ armed until user picks a station
        seq.on_rx_decode(&mk_decode(15, -10, 900, "N1MPM K1AAA FN42"), None);
        seq.on_rx_decode(&mk_decode(15, -8, 1200, "N1MPM JA4DDD PM95"), None);
        assert_eq!(seq.queue.len(), 2);
        assert!(seq.queue.iter().all(|q| q.status == QsoStatus::Active));
        assert!(seq.cq.as_ref().unwrap().armed);
        assert!(seq.armed_qso_id().is_none());

        // User manually arms K1AAA
        let k1_id = seq.queue[0].qso_id.clone();
        seq.apply_action(&k1_id, QsoAction::Arm, None).unwrap();
        assert!(seq.cq.is_none());
        assert_eq!(seq.armed_qso_id().as_deref(), Some(k1_id.as_str()));

        // JA4DDD advances further (sends R+02 in slot 45), yet Manual mode keeps K1AAA targeted!
        seq.on_rx_decode(&mk_decode(45, -7, 1200, "N1MPM JA4DDD R+02"), None);
        assert_eq!(seq.armed_qso_id().as_deref(), Some(k1_id.as_str()));
        assert_eq!(
            seq.compose_tx_for_slot(SlotParity::Even, 60_000)
                .unwrap()
                .message,
            "K1AAA N1MPM -10"
        );

        // Switching back to AutoSequence immediately selects the winning QSO (JA4DDD)
        seq.set_mode(SequencerMode::AutoSequence);
        let ja_id = seq
            .queue
            .iter()
            .find(|q| q.their_call == "JA4DDD")
            .unwrap()
            .qso_id
            .clone();
        assert_eq!(seq.armed_qso_id().as_deref(), Some(ja_id.as_str()));
    }

    #[test]
    fn aborted_tx_does_not_promote_hunter_advancement_rank() {
        let mut seq = QsoSequencer::new("rad_1", false, "N1MPM", "FN33ab");
        seq.start_cq(SlotParity::Even, None);
        seq.on_rx_decode(&mk_decode(15, -8, 1200, "N1MPM QQ1AAA EM10"), None);
        let q = &seq.queue[0];
        assert_eq!(q.their_role, Some(StationRole::Hunter));
        assert_eq!(q.step, QsoStep::SendReport);
        assert!(!q.has_confirmed_tx());
        assert_eq!(q.advancement_rank(), 20);

        // Confirming report TX moves rank from 20 (Initiating) to 30 (Signal Reports)
        let tx1 = seq.compose_tx_for_slot(SlotParity::Even, 30_000).unwrap();
        seq.on_tx_confirmed(UnixSecs(30), &tx1, None);
        assert!(seq.queue[0].has_confirmed_tx());
        assert_eq!(seq.queue[0].advancement_rank(), 30);
    }
}
