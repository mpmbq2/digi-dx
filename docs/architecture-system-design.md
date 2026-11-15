# Digi-Dx System Architecture & Design Document
**Architecture: Edge Radio Daemon, Cloud Gateway, and Unified Web App**
**Status:** Living Design Document (September 2026)

---

## 1. Executive Summary & Vision

Traditional digital mode software (e.g., WSJT-X, JTDX) bundles radio CAT control, soundcard DSP, contact sequencing logic, and user interface into a monolithic desktop application. This design forces operators to physically sit at their radio bench, while presenting complex, cluttered interfaces with flat unranked decode feeds.

**Digi-Dx** splits this architecture into three clean, focused layers:

1. **Unitary Edge Client:** A lean daemon running on the radio-connected machine (Raspberry Pi, Linux PC, Mac). It handles soundcard audio I/O, transceiver CAT/PTT control, FT8 DSP modulation/demodulation, a local diagnostics dashboard (GUI/TUI), and an autonomous 500ms hardware PTT fail-safe watchdog.
2. **Cloud Gateway & Station Coordinator:** A lightweight service (running in the cloud or locally) responsible for station pairing via ephemeral 6-digit PINs, single-operator transmitter exclusivity enforcement, telemetry persistence, and low-latency bidirectional command routing.
3. **Unified Web App (Standard App UI):** A responsive, intuitive web application accessible from any browser (desktop, tablet, or phone). It gives the operator full FT8 operating capabilities: live band decodes, interactive audio frequency picker, priority caller queueing, automatic/manual QSO sequencing, and ADIF logging.

*(Note: Agentic UI customization has been intentionally deferred until the standard web application and edge-to-cloud operating flows are completely established and battle-tested.)*

---

## 2. System Topology & Physical Boundaries

```mermaid
flowchart TB
    subgraph Tier1["Tier 1: Radio Rig Machine (Edge)"]
        Radio["Transceiver / Rig Hardware"] <-->|Audio In/Out + CAT Serial| Rigctld["Hamlib / rigctld"]
        Rigctld <--> EdgeRuntime["Digi-Dx Edge Runtime"]
        EdgeRuntime <--> AudioDSP["FT8 DSP Engine (ft8cat / ft8modem)"]
        EdgeRuntime <--> LocalUI["Local Setup GUI (:8792) & Blessed TUI"]
        EdgeRuntime <--> PttWatchdog["Hardware PTT Watchdog (&lt;500ms)"]
    end

    subgraph Tier2["Tier 2: Cloud / Gateway Infrastructure"]
        CloudGate["Cloud Gateway (WebSocket :8795)"]
        SessionMgr["Station Exclusivity Manager"]
        StationStore[("Station State & QSO Store")]
        WebServer["Web Server (HTTP :8080)"]
        CloudGate <--> SessionMgr
        CloudGate <--> StationStore
    end

    subgraph Tier3["Tier 3: Operator Device (Normal Web App)"]
        Browser["Modern Browser (Desktop, Tablet, Phone)"]
        PairingModal["Pairing & Station Connect Modal"]
        StationHeader["Station Header & Live Slot Clock"]
        SpectrumPicker["Interactive AF Spectrum Lanes (200-3000 Hz)"]
        DecodesRoster["Live FT8 Decodes Table & Filtering"]
        QsoEngine["Active QSO Sequencer & Caller Queue"]
        CompletedLog["Completed Contacts & ADIF Export"]
        TxSafetyBar["TX State Indicator & Emergency Halt"]

        Browser --> PairingModal
        Browser --> StationHeader
        Browser --> SpectrumPicker
        Browser --> DecodesRoster
        Browser --> QsoEngine
        Browser --> CompletedLog
        Browser --> TxSafetyBar
    end

    %% Network Connections
    EdgeRuntime == "Outbound Secure WebSocket (TLS)<br/>Decodes, Telemetry, Heartbeat, TX Commands" ==> CloudGate
    Browser == "Bidirectional WebSocket (WSS)<br/>State Streaming & Operator Commands" ==> CloudGate
    WebServer -. "Serves App Assets (HTML/JS/CSS)" .-> Browser
```

### Physical Tier Responsibilities

| Tier | Host | Key Components | Network Exits |
| :--- | :--- | :--- | :--- |
| **Tier 1: Edge** | Raspberry Pi / Radio PC | Audio DSP, Hamlib CAT, PTT Watchdog, Local GUI/TUI, Pairing Service | Only **one outbound** WebSocket connection to Cloud Gateway. Zero inbound router ports required. |
| **Tier 2: Cloud** | Cloud Server (or Localhost) | Cloud Gateway WS server, Session Exclusivity, SQLite/JSON Store, Web Server | Standard HTTP & WebSocket endpoints. |
| **Tier 3: Web App** | Laptop, Phone, Tablet | Dedicated Web App: Decodes table, AF picker, QSO sequencer, TX controls | Single WebSocket connection to Cloud Gateway. |

---

## 3. Subsystem Architecture & Responsibilities

```mermaid
classDiagram
    direction TB

    class EdgeRuntime {
        +StationConfig currentConfig
        +EdgeTelemetry telemetry
        +PttWatchdog watchdog
        +EdgePairingService pairingService
        +Engine engine
        +connectCloudGateway(url)
        +generatePairingCode()
        +testCat()
        +testPtt()
    }

    class CloudGateway {
        +StationStore store
        +StationSessionManager sessionManager
        +registerEdge(stationId, token)
        +announcePairing(code)
        +claimPairing(code, operatorId)
        +relayCommand(stationId, cmd)
        +broadcastTelemetry(stationId, data)
    }

    class OperatorController {
        +ControllerState state
        +callCq(slot)
        +replyToCall(call)
        +setAf(af)
        +setSlot(slot)
        +setDialFreq(mhz)
        +haltTx()
        +qsoAction(id, action)
    }

    class WebAppUI {
        +renderStationHeader(state)
        +renderSpectrumPicker(af, slot, decodes)
        +renderDecodesTable(decodes)
        +renderActiveQsoCard(qso)
        +renderCompletedLog(qsos)
        +onUserAction(cmd)
    }

    EdgeRuntime --> CloudGateway : Outbound WS
    CloudGateway --> OperatorController : Telemetry & Relay
    OperatorController --> WebAppUI : Synchronized State
    WebAppUI --> OperatorController : User Commands
```

### 3.1 Tier 1: Unitary Edge Client (`src/edge/`) — *Built & Verified*
- **5 Diagnostic Pillars:** Continuously monitored and displayed on local GUI (`http://localhost:8792`) and terminal TUI:
  1. *Program & Watchdog:* Process health, uptime, engine status.
  2. *Config Setup:* Callsign, grid square, audio soundcard ID, CAT serial port.
  3. *Cloud Communication:* Pairing status (Unpaired / Pairing / Paired), ping latency, heartbeat ack.
  4. *Radio CAT:* Live dial frequency, CAT communication health, PTT state.
  5. *FT8 Engine & DSP:* Even/odd slot clock, countdown seconds, decode counter, SNR.
- **PTT Hardware Watchdog (`watchdog.ts`):** Operates on a strict 500ms sliding timer. Every transmission requires active heartbeat pings from the control stream. If the network drops for >500ms, the watchdog de-asserts PTT immediately to protect radio amplifiers.
- **Ephemeral Pairing Service (`pairing.ts`):** Generates a random 6-digit numeric PIN (expires in 5 minutes). Transmits pairing code to Cloud Gateway. Once claimed in the web app, permanent cryptographic session tokens are exchanged.

### 3.2 Tier 2: Cloud Gateway & Station Coordinator (`src/cloud/`)
- **Cloud Gateway (`gateway.ts`):** Multiplexes inbound connections from Edge daemons and Web browser clients. Translates FT8 decodes, slot clock ticks, and transmit intents.
- **Session Exclusivity Manager (`session.ts`):** Radio regulations require single-operator transmitter control. The manager grants exclusive TX control to one operator session while allowing secondary connections in read-only "monitor" mode.
- **Station Store (`store.ts`):** Persists station settings, decode history, and completed QSO logs (ADIF format).
- **Web App Host:** Serves static frontend assets (HTML, CSS, JS) over HTTP.

### 3.3 Tier 3: Unified Web App UI (`ui/web/` / Browser)
- **Pairing & Station Connect:** Operators enter the 6-digit pairing code shown on their Edge client's local GUI or TUI. Once verified, the web client receives an auth token and automatically reconnects in future sessions.
- **Operating Dashboard:**
  - **Station Banner:** Callsign, Maidenhead grid, dial frequency, CAT status, and live 15-second FT8 slot clock countdown.
  - **AF Spectrum Picker:** Visual 200–3000 Hz spectrum with separate EVEN and ODD lanes showing current band activity and allowing 1-click TX audio frequency selection.
  - **Live Decodes Stream:** Chronological and searchable decode table with SNR, DT, frequency, callsign, and grid. Responders to the operator's CQ are highlighted.
  - **Active QSO & Auto-Sequencer:** Call CQ, manage staged callers in a priority queue, and progress automatically through FT8 sequence states (Report -> RRR/RR73 -> 73).
  - **Completed Log & ADIF Export:** Visual log of completed contacts with 1-click ADIF export.
  - **Transmitter Controls & Safety:** TX enable toggle, live TX status banner (Idle / Armed / Transmitting), and an instant **Emergency Halt** button.

---

## 4. Key Sequence Flows

### Flow 1: Edge-to-Cloud Pairing Handshake
How an operator connects a newly installed edge client to their web browser.

```mermaid
sequenceDiagram
    autonumber
    actor Op as Operator
    participant Edge as Edge Client (Pi/PC)
    participant Cloud as Cloud Gateway
    participant Web as Web App (Browser)

    Op->>Edge: Launches edge client (`npm run edge`)
    Edge->>Edge: Generates 6-digit pairing code (e.g. "849201")
    Edge->>Edge: Displays code on Local GUI (:8792) and Blessed TUI
    Edge->>Cloud: Connects WS & announces { type: "edge_pairing_code", code: "849201" }
    
    Op->>Web: Navigates to Web App in browser (`http://localhost:8080`)
    Op->>Web: Enters 6-digit code "849201" in Connect dialog
    Web->>Cloud: Sends { type: "claim_pairing", code: "849201" }
    Cloud->>Cloud: Validates code & generates Session Auth Token
    Cloud-->>Web: Returns { type: "pairing_claimed", token: "tok_abc123" }
    Cloud-->>Edge: Emits { type: "pairing_complete", token: "tok_abc123" }
    Edge->>Edge: Saves token to config; status updates to "Paired & Connected"
    Web->>Cloud: Opens authenticated control stream with token
    Cloud-->>Web: Streams live station status, decodes, and slot clock
```

### Flow 2: 15-Second FT8 Slot Operating & Fail-Safe Transmit
The real-time cycle of decoding, sequencing, transmitting, and fail-safe watchdog protection.

```mermaid
sequenceDiagram
    autonumber
    participant Radio as Radio Transceiver
    participant Edge as Edge Runtime
    participant Cloud as Cloud Gateway
    participant Web as Web App UI

    Note over Radio,Edge: 0.0s - 12.6s: RX Audio Demodulation
    Radio->>Edge: Audio stream from soundcard
    Edge->>Edge: FT8 demodulation produces decodes
    Edge->>Cloud: Emits DecodeEvent { call: "JA1ABC", grid: "PM95", snr: -08, af: 1420 }
    Cloud->>Web: Relays DecodeEvent over WebSocket
    Web->>Web: Updates Decodes Table & Spectrum lanes

    Note over Web: 12.6s - 14.0s: Operator Action / Auto-Sequencer
    Web->>Web: Operator clicks "Call JA1ABC" (or auto-sequencer triggers)
    Web->>Cloud: Sends transmit command { af: 1420, slot: "odd", message: "JA1ABC K1DEF FN42" }
    Cloud->>Edge: Relays transmit command

    Note over Edge,Radio: 14.0s - 15.0s: Armed Transmit Slot Window
    Edge->>Edge: Verifies slot clock parity & arms PTT watchdog (<500ms)
    Edge->>Radio: Asserts CAT PTT (TX: 1) & streams modulated AF audio
    
    loop Every 4 seconds during TX
        Cloud->>Edge: Heartbeat Ping
        Edge-->>Cloud: Heartbeat Ack & Watchdog.pet()
    end

    alt Network Interruption (Watchdog Fail-Safe)
        Cloud-xEdge: Network drops mid-transmission
        Edge->>Edge: Watchdog timer expires (500ms timeout)
        Edge->>Radio: EMERGENCY DE-ASSERT PTT (TX: 0)
        Edge->>Edge: Logs safety abort, prevents radio damage
    end
```

---

## 5. Implementation Roadmap: Building the Web App Experience

With the **Unitary Edge Client** complete and tested, the immediate implementation roadmap focuses on establishing the end-to-end operating loop:

```mermaid
gantt
    title Digi-Dx Normal App UI Roadmap
    dateFormat  YYYY-MM-DD
    section Milestone 1: Server
    Cloud Gateway & Web Server Runner (npm run cloud) :active, m1, 2026-09-15, 2026-09-16
    section Milestone 2: Web Frontend
    Pairing & Station Connect Modal                    :m2, 2026-09-16, 2026-09-17
    Operating Dashboard & Spectrum Picker              :m3, 2026-09-17, 2026-09-18
    QSO Auto-Sequencer & Priority Queue                :m4, 2026-09-18, 2026-09-19
    section Milestone 3: Verification
    End-to-End Headless & Smoke Verification           :m5, 2026-09-19, 2026-09-20
```

### Next Immediate Deliverables:

1. **Step 1: Cloud Gateway & Web Server Runner (`scripts/cloud.ts` / `npm run cloud`)**
   - Start `CloudGateway` WebSocket server on port `8795`.
   - Start an HTTP server hosting the web application on port `8080`.
   - Add `npm run cloud` script to `package.json`.
   - *Result:* The Edge Client's `ECONNREFUSED 127.0.0.1:8795` log is immediately resolved, connecting the edge daemon to a live gateway.

2. **Step 2: Pairing & Connection Flow in Web App**
   - Implement the 6-digit pairing code modal in the web app:
     - When the operator opens the web app without an active session, prompt: *"Enter the 6-digit code shown on your radio machine"*.
     - Claim pairing via `claim_pairing`, save the session auth token in `localStorage`, and transition to the live operating view.

3. **Step 3: Operating Dashboard & QSO Sequencer**
   - Wire the web interface to the real-time telemetry feed:
     - Live 15-second FT8 slot clock countdown and even/odd parity indicator.
     - Dual-lane AF spectrum picker (200–3000 Hz) showing active decodes and allowing 1-click TX frequency selection.
     - Decodes table with click-to-call, search, and SNR highlights.
     - Active QSO card with automated state transitions (CQ -> Report -> RR73 -> 73) and manual override.
     - Emergency halt button and TX enable/disable toggle.

4. **Step 4: End-to-End Verification**
   - Run simulated end-to-end QSO verification: Edge Client in demo mode (`--sim`) + Cloud Gateway + Web App, proving a complete QSO from pairing to completion.
