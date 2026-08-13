---
title: Hamlib Radio Control Platform - Plan
type: feat
date: 2026-07-21
topic: hamlib-radio-control-platform
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
---

# Hamlib Radio Control Platform - Plan

## Goal Capsule

- **Objective:** Make the daemon own radio control end-to-end — speaking hamlib's rigctld protocol directly instead of relying on the external `ft8cat` binary — and establish feasibility and requirements for three non-FT8 remote-operation tiers (listen-only, CW paddle, SSB voice), repositioning Digi-Dx as a remote radio operation platform with FT8 as the flagship mode.
- **Product authority:** `STRATEGY.md`. Its current framing ("Operating FT8 on a remote radio box") is narrower than the platform positioning this plan establishes.
- **Open blockers:**
  - The CW paddle tier's keying mechanism is unresolved — see Outstanding Questions.
  - `STRATEGY.md` has not yet been updated to the platform positioning; this plan does not update it, but the gap should be closed before the positioning is treated as final.

---

## Product Contract

### Summary

Absorb `ft8cat`'s CAT-control responsibilities into the daemon as first-party code that speaks hamlib's rigctld protocol directly, replacing today's stdout-scraping subprocess wrapper. Keep `ft8modem` as an external, swappable decoder. On top of that CAT foundation, define the requirements for three remote-operation tiers beyond FT8 — listen-only, CW with a real paddle, and SSB voice — so their feasibility is established even though none is built yet.

### Problem Frame

Today, CAT control lives entirely inside the external `ft8cat` binary: the daemon spawns it, hands it a port, and learns frequency and PTT state only by regex-parsing `TX:`/`FA:` lines from its stdout. Hamlib itself appears in the project only as a bundled `rigctld` binary used as a dummy CAT server for testing — there are no direct hamlib calls anywhere, and the daemon-to-client protocol has no commands for setting frequency, mode, or PTT at all, only for observing them.

This has two costs. First, installability: a new user's "out-of-box first QSO" (the strategy's own success metric) depends on binaries built by `ft8modem`'s upstream project, not on Digi-Dx's own build. Second, ceiling: because CAT control is opaque inside `ft8cat` and the client protocol carries no radio-control verbs, there is no path today to any remote operation that isn't FT8 — including modes the operator personally wants to use, like listening to a band remotely or working CW with a real paddle.

### Key Decisions

- **Wrap hamlib via its rigctld network protocol, not native library bindings** (session-settled: user-directed — chosen over in-process libhamlib FFI bindings: a rigctld-protocol client run as pure TypeScript keeps install to a single step with no per-platform compiled binding to build or ship; native bindings remain a documented future CAT backend that can swap in behind the same seam without protocol changes).
- **Absorb `ft8cat` into the daemon; keep `ft8modem` external** (session-settled: user-directed — chosen over rebuilding both in-tree: preserves the swappable-FT8-decoder experimentation seam the engine-backend work already established, while still eliminating the CAT-control subprocess and its stdout-parsing).
- **Reposition as a platform, FT8-first** (session-settled: user-directed — chosen over keeping the product framed strictly as "remote FT8" with the other tiers as a private experimental track: the three tiers become part of the product's roadmap and identity, not a side branch that must stay invisible to the brother/dad use case).
- **Design for LAN operation first, without precluding a VPN path** (session-settled: user-directed — chosen over an internet-first design: the primary real-world scenario is same-network operation, which keeps latency-sensitive tiers like CW paddle tractable, while nothing in the design should assume the client can never be on a VPN).
- **"Full remote op" scopes to SSB voice specifically** (session-settled: user-directed — chosen over a generic bidirectional-audio-passthrough tier or a CAT-only "audio handled elsewhere" tier: the concrete want is a voice QSO end-to-end through the client).
- **"CW remote op" scopes to real paddle keying, not typed-text or engine-assisted CW** (session-settled: user-directed — chosen over typing text with the rig's internal keyer, and over an FT8-style assisted mode with a CW decoder: this is deliberately the hardest variant, accepted as such).

### Actors

- **A1. Operator** — the remote client user; selects a tier, controls frequency/mode/PTT/paddle/mic within it.
- **A2. Daemon** — owns the radio control session; speaks rigctld to the radio, manages the CAT driver, publishes state and (per tier) audio to the client.
- **A3. Engine (ft8modem)** — the external, swappable FT8/FT4 decoder; present only in FT8 sessions, absent in the three new tiers.
- **A4. Radio** — the physical rig, addressed over CAT (via rigctld) and, per tier, audio and keying lines.

### Requirements

**CAT control (hamlib wrapping)**

- R1. The daemon controls frequency, mode, and PTT by speaking hamlib's rigctld protocol directly, replacing `ft8cat`'s stdout-parsing approach.
- R2. CAT capability is not narrowed relative to today — the daemon supports any rig hamlib's rigctld supports, not a subset `ft8cat` happened to expose.
- R3. `rigctld` remains installable as part of the daemon's own install step, so the out-of-box install stays single-step for the common case.
- R4. The CAT control path is implemented behind a driver seam analogous to `EngineDriver`, so a native-bindings backend can be swapped in later without changing the protocol or callers.

**`ft8cat`/`ft8modem` rebuild**

- R5. `ft8cat`'s responsibilities — CAT connection lifecycle, TX framing, decode/PTT/frequency parsing — are absorbed into the daemon as first-party code.
- R6. `ft8modem` remains an external, swappable engine binary that the daemon launches and manages as a subprocess, preserving the ability to experiment with alternate FT8 decoders.

**Radio control protocol surface**

- R7. The daemon-client protocol gains commands to set frequency, mode, and PTT, not only to observe them.
- R8. The session concept generalizes to support an engine-less "control session" — CAT control (and, per tier, audio) with no FT8/FT4 engine running.
- R9. Only one session may own the radio's CAT and audio path at a time; the tiers are mutually exclusive sessions, not layers that stack.

**Listen-only tier**

- R10. A listen-only session lets the operator tune frequency and mode remotely and receive live RX audio, with no engine and no transmit capability.

**CW paddle tier**

- R11. A CW session accepts real-time paddle input from the remote client and regenerates it as the rig's actual CW keying, within the timing tolerance real-time CW requires on the target network path.
- R12. A CW session provides live RX audio so the operator can copy by ear.

**SSB voice tier**

- R13. An SSB voice session supports bidirectional audio — microphone to rig, rig receive to client — plus remote PTT control, sufficient for a live voice QSO conducted entirely through the client.

### Key Flows

- F1. Listen-only session
  - **Trigger:** Operator starts a listen-only session with a chosen frequency/mode.
  - **Actors:** A1, A2, A4
  - **Steps:** Daemon opens a CAT connection via rigctld, applies the requested frequency/mode, opens an RX audio stream to the client. No engine driver is loaded.
  - **Outcome:** Operator hears live RX audio and can retune remotely; no decode, QSO, or logging activity occurs.
  - **Covers:** R8, R10

- F2. CW paddle session
  - **Trigger:** Operator starts a CW session and begins keying with a physical paddle at the client end.
  - **Actors:** A1, A2, A4
  - **Steps:** Daemon opens a CAT connection in keying mode, receives paddle element events from the client, regenerates the keying on the rig in real time; RX audio streams back concurrently.
  - **Outcome:** Operator sends live CW and copies by ear over one session. Network latency and jitter directly affect keying fidelity — the tier's central open risk (see Outstanding Questions).
  - **Covers:** R8, R11, R12

- F3. SSB voice session
  - **Trigger:** Operator starts an SSB voice session.
  - **Actors:** A1, A2, A4
  - **Steps:** Daemon opens a CAT connection, sets mode/frequency, opens a bidirectional audio path (mic to rig, rig RX to client); operator asserts PTT remotely to transmit.
  - **Outcome:** Operator conducts a live voice QSO end-to-end through the client.
  - **Covers:** R8, R13

### Acceptance Examples

- AE1. **Covers R9.** Given a listen-only session is active, when the operator attempts to start an SSB voice session concurrently, then the second session is rejected until the first is stopped.
- AE2. **Covers R8, R10.** Given no engine is configured for the session, when the operator starts a listen-only session, then CAT control and RX audio work normally with no decode or QSO functionality present.

### Scope Boundaries

**Deferred for later**

- Build order across the CAT/hamlib rebuild and the three tiers — this plan establishes requirements for all of them without committing to a sequence.
- Native hamlib library (libhamlib) bindings as a CAT backend — documented as a future swap-in behind the driver seam (R4), not built now.
- The exact transport mechanism for paddle keying events (dedicated low-latency channel vs. an extension of the existing control protocol) — left for planning once the CW tier is prioritized.
- Updating `STRATEGY.md` to the platform positioning — this plan establishes the decision; the document update is separate follow-up work.

**Outside this product's identity**

- Multi-operator / concurrent control — one radio, one operator holds even as the set of controllable operations expands (consistent with `STRATEGY.md`'s existing "Not working on").
- Replacing the FT8 decoder algorithm itself — `ft8modem` stays external and swappable, not something this project reimplements.

### Dependencies / Assumptions

- Assumes hamlib's rigctld protocol is documented and stable enough to implement a direct TypeScript client against, and that it's sufficient for the CAT commands each tier needs — should be validated against the operator's actual rig(s) during planning.
- Assumes audio transport is genuinely new infrastructure: no audio streaming path exists in the daemon-client protocol today (FT8 crosses the network as decoded text only), so listen-only and SSB voice both require building this from scratch, not extending something partial.
- Assumes paddle-to-keying regeneration is feasible on a LAN path; this is explicitly unresolved (see Outstanding Questions), not assumed safe to build.

### Outstanding Questions

**Deferred to planning**

- What actually keys the rig from remote paddle input — hamlib CAT keying commands, a dedicated keying line, a virtual/software keyer, or hardware in the loop at the radio end? This determines whether the CW paddle tier is feasible at all within the platform's control surface; investigate against hamlib's documented capabilities and the operator's actual rig before committing engineering time to this tier.
- Concrete audio transport technology for listen-only and SSB voice (e.g., WebRTC vs. raw PCM over a websocket).
- Sequencing and build order across the hamlib/ft8cat rebuild and the three tiers.
- Whether/how `STRATEGY.md`'s "Who it's for," "Key metrics," and "Not working on" sections should change to reflect the platform positioning.

### Sources / Research

- Current `ft8cat`/`ft8modem` spawn and install path: `scripts/install-engine.sh`, `src/daemon/ft8-cat-modem-driver.ts`
- `EngineDriver` seam this plan's CAT driver mirrors: `src/daemon/engine-driver.ts`, `src/daemon/engine.ts`
- Protocol surface to extend with radio-control commands: `core/protocol.ts`
- Prior related plan (established the `EngineDriver` seam, excluded multi-operator control): `docs/plans/2026-07-12-001-feat-engine-backend-plan.md`
- Product positioning to reconcile: `STRATEGY.md`
