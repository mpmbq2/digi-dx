use crate::domain::clock::{SlotParity, UnixSecs};
use crate::domain::ft8::{parse_ft8_message, Ft8Payload, ParsedFt8Message};
use crate::modem::{Ft8Decode, TxIntent};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PeerQsoStage {
    Idle,
    SentGrid,
    SentReport,
    SentRReport,
    SentRR73,
}

#[derive(Debug, Clone)]
struct SimPeer {
    callsign: String,
    grid: String,
    parity: SlotParity,
    af_hz: u16,
    snr_db: i8,
    stage: PeerQsoStage,
}

/// Deterministic in-memory FT8 peer simulator strictly using ITU `QQ*` callsigns.
#[derive(Debug, Clone)]
pub struct SimulatedModem {
    local_callsign: String,
    local_grid: String,
    peers: Vec<SimPeer>,
    pending_local_tx: Option<(SlotParity, ParsedFt8Message)>,
}

impl Default for SimulatedModem {
    fn default() -> Self {
        Self::new("QQ0DEMO", "FN33")
    }
}

impl SimulatedModem {
    pub fn new(local_callsign: &str, local_grid: &str) -> Self {
        let call = local_callsign.trim().to_ascii_uppercase();
        assert!(
            call.starts_with("QQ"),
            "SimulatedModem local callsign must use ITU QQ* prefix (got {call})"
        );
        Self {
            local_callsign: call,
            local_grid: local_grid.trim().to_ascii_uppercase(),
            peers: default_peers(),
            pending_local_tx: None,
        }
    }

    pub fn local_callsign(&self) -> &str {
        &self.local_callsign
    }

    pub fn local_grid(&self) -> &str {
        &self.local_grid
    }

    pub fn reset(&mut self) {
        self.pending_local_tx = None;
        for p in &mut self.peers {
            p.stage = PeerQsoStage::Idle;
        }
    }

    pub fn register_local_tx(&mut self, slot_ts: UnixSecs, intent: &TxIntent) {
        let tx_parity = SlotParity::from_unix_secs(slot_ts);
        let parsed = parse_ft8_message(&intent.message);
        self.pending_local_tx = Some((tx_parity, parsed));
    }

    pub fn advance_slot(&mut self, slot_ts: UnixSecs) -> Vec<Ft8Decode> {
        let rx_parity = SlotParity::from_unix_secs(slot_ts);
        let mut decodes = Vec::new();
        let mut handled_peer_call: Option<String> = None;

        if let Some((tx_parity, parsed)) = self.pending_local_tx.take() {
            if tx_parity == rx_parity.opposite() {
                match parsed {
                    ParsedFt8Message::Cq { callsign, .. } if callsign == self.local_callsign => {
                        let peer_idx = self
                            .peers
                            .iter()
                            .position(|p| p.parity == rx_parity && p.stage == PeerQsoStage::Idle)
                            .or_else(|| self.peers.iter().position(|p| p.parity == rx_parity));
                        if let Some(idx) = peer_idx {
                            let peer = &mut self.peers[idx];
                            peer.stage = PeerQsoStage::SentGrid;
                            handled_peer_call = Some(peer.callsign.clone());
                            decodes.push(Ft8Decode {
                                slot_ts,
                                snr_db: peer.snr_db,
                                dt_sec: 0.1,
                                af_hz: peer.af_hz,
                                message: format!(
                                    "{} {} {}",
                                    self.local_callsign, peer.callsign, peer.grid
                                ),
                                raw_metadata: None,
                                decoder_backend: "simulated".to_string(),
                            });
                        }
                    }
                    ParsedFt8Message::Directed {
                        to, from, payload, ..
                    } if from == self.local_callsign => {
                        if let Some(peer) = self.peers.iter_mut().find(|p| p.callsign == to) {
                            peer.parity = rx_parity;
                            let reply_msg = match payload {
                                Some(Ft8Payload::Grid(_)) => {
                                    peer.stage = PeerQsoStage::SentReport;
                                    Some(format!(
                                        "{} {} {:+03}",
                                        self.local_callsign, peer.callsign, peer.snr_db
                                    ))
                                }
                                Some(Ft8Payload::Report {
                                    is_roger: false, ..
                                }) => {
                                    peer.stage = PeerQsoStage::SentRReport;
                                    Some(format!(
                                        "{} {} R{:+03}",
                                        self.local_callsign, peer.callsign, peer.snr_db
                                    ))
                                }
                                Some(Ft8Payload::Report { is_roger: true, .. }) => {
                                    peer.stage = PeerQsoStage::SentRR73;
                                    Some(format!("{} {} RR73", self.local_callsign, peer.callsign))
                                }
                                Some(Ft8Payload::Terminal(ref term))
                                    if term == "RR73" || term == "RRR" =>
                                {
                                    peer.stage = PeerQsoStage::Idle;
                                    Some(format!("{} {} 73", self.local_callsign, peer.callsign))
                                }
                                Some(Ft8Payload::Terminal(_)) => {
                                    peer.stage = PeerQsoStage::Idle;
                                    None
                                }
                                _ => None,
                            };

                            handled_peer_call = Some(peer.callsign.clone());
                            if let Some(msg) = reply_msg {
                                decodes.push(Ft8Decode {
                                    slot_ts,
                                    snr_db: peer.snr_db,
                                    dt_sec: 0.1,
                                    af_hz: peer.af_hz,
                                    message: msg,
                                    raw_metadata: None,
                                    decoder_backend: "simulated".to_string(),
                                });
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        for peer in &self.peers {
            if Some(peer.callsign.as_str()) == handled_peer_call.as_deref() {
                continue;
            }
            if peer.parity == rx_parity && peer.stage == PeerQsoStage::Idle {
                decodes.push(Ft8Decode {
                    slot_ts,
                    snr_db: peer.snr_db,
                    dt_sec: 0.2,
                    af_hz: peer.af_hz,
                    message: format!("CQ {} {}", peer.callsign, peer.grid),
                    raw_metadata: None,
                    decoder_backend: "simulated".to_string(),
                });
            }
        }

        decodes
    }
}

fn default_peers() -> Vec<SimPeer> {
    vec![
        SimPeer {
            callsign: "QQ1AAA".to_string(),
            grid: "EM10".to_string(),
            parity: SlotParity::Odd,
            af_hz: 740,
            snr_db: -8,
            stage: PeerQsoStage::Idle,
        },
        SimPeer {
            callsign: "QQ2BBB".to_string(),
            grid: "JO01".to_string(),
            parity: SlotParity::Even,
            af_hz: 1120,
            snr_db: -12,
            stage: PeerQsoStage::Idle,
        },
        SimPeer {
            callsign: "QQ3CCC".to_string(),
            grid: "PM95".to_string(),
            parity: SlotParity::Odd,
            af_hz: 1580,
            snr_db: -5,
            stage: PeerQsoStage::Idle,
        },
        SimPeer {
            callsign: "QQ4DDD".to_string(),
            grid: "DN70".to_string(),
            parity: SlotParity::Even,
            af_hz: 1940,
            snr_db: -15,
            stage: PeerQsoStage::Idle,
        },
        SimPeer {
            callsign: "QQ5EEE".to_string(),
            grid: "FN42".to_string(),
            parity: SlotParity::Odd,
            af_hz: 2260,
            snr_db: 2,
            stage: PeerQsoStage::Idle,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simulated_modem_completes_full_qso_sequence_on_qq_callsigns() {
        let mut sim = SimulatedModem::default();

        // Even slot TX CQ -> Odd slot RX Grid answer from QQ1AAA
        sim.register_local_tx(
            UnixSecs(0),
            &TxIntent {
                af_hz: 1420,
                slot: SlotParity::Even,
                message: "CQ QQ0DEMO FN33".to_string(),
            },
        );
        let d1 = sim.advance_slot(UnixSecs(15));
        assert!(d1.iter().all(|d| d.decoder_backend == "simulated"));
        assert!(d1.iter().any(|d| d.message == "QQ0DEMO QQ1AAA EM10"));

        // Local replies with Report -> Peer sends R-Report
        sim.register_local_tx(
            UnixSecs(30),
            &TxIntent {
                af_hz: 1420,
                slot: SlotParity::Even,
                message: "QQ1AAA QQ0DEMO -10".to_string(),
            },
        );
        let d2 = sim.advance_slot(UnixSecs(45));
        assert!(d2.iter().any(|d| d.message == "QQ0DEMO QQ1AAA R-08"));

        // Local sends R-Report? No, peer already sent R-08, or local sent R+04 -> Peer sends RR73
        sim.register_local_tx(
            UnixSecs(60),
            &TxIntent {
                af_hz: 1420,
                slot: SlotParity::Even,
                message: "QQ1AAA QQ0DEMO R-08".to_string(),
            },
        );
        let d3 = sim.advance_slot(UnixSecs(75));
        assert!(d3.iter().any(|d| d.message == "QQ0DEMO QQ1AAA RR73"));

        // Local sends RR73 -> Peer sends 73 and returns idle
        sim.register_local_tx(
            UnixSecs(90),
            &TxIntent {
                af_hz: 1420,
                slot: SlotParity::Even,
                message: "QQ1AAA QQ0DEMO RR73".to_string(),
            },
        );
        let d4 = sim.advance_slot(UnixSecs(105));
        assert!(d4.iter().any(|d| d.message == "QQ0DEMO QQ1AAA 73"));

        sim.reset();
        let ambient = sim.advance_slot(UnixSecs(120));
        assert!(!ambient.is_empty());
        assert!(ambient.iter().all(|d| d.message.starts_with("CQ QQ")));
    }
}
