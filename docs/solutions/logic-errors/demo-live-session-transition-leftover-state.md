---
title: Demo to live session transitions left leftover demo state that could key the radio
date: 2026-07-14
category: logic-errors
module: demo session transition (engine, websocket, web/tui clients)
problem_type: logic_error
component: tooling
symptoms:
  - Leftover QQ0DEMO automation could transmit after switching into a real session
  - Sticky simulated EngineDriver after stop kept status.engine as simulated while inactive
  - DIGI_DX_SIM_SCALE leaked into interactive demo contrary to KTD5
  - Setup overlay remained after demo start, trapping the band UI
  - Demo-shaped session config could be saved without demo:true
root_cause: logic_error
resolution_type: code_fix
severity: critical
tags: [demo-mode, session-transition, engine-driver, qq0demo, slot-clock, config-persistence]
---

# Demo to live session transitions left leftover demo state that could key the radio

## Problem

digi-dx's "try it without a radio" demo reuses the same daemon/client plumbing as a live session (`Engine`, client `QsoAutomation`, websocket protocol). That shared design left session-scoped state — selected driver/clock, armed automation timers, in-flight `QQ0DEMO` QSOs, and a synthesized demo `SessionConfig` — able to outlive the demo and ride into a real session. Blast radius if any of that fired on a live rig: keying with an unlicensed, ITU-reserved `QQ` identity, or permanently satisfying `CONFIG_REQUIRED` with a fabricated station.

## Symptoms

- After ending a demo session (or switching demo → real without restart), previously scheduled or in-flight automation could still be armed against the new engine/session.
- The web UI's first-run station-setup overlay could remain visible while a demo session was already active.
- A demo-shaped `SessionConfig` (`QQ0DEMO`, simulated device id) could be accepted by `save_config`.
- After stop, inactive daemon status/clock could still reflect the just-stopped simulated driver.

## What Didn't Work

- **Scale-only clock dirty-checking.** Treating the published slot clock as dirty only when `scale` changed misses demo→real at `scale: 1` (interactive demo's default). An armed timer or in-flight `QQ0DEMO` QSO rides through. Dirty-check must cover every clock field (`epochMs`, `anchorWallMs`, `slotMs`, `scale`), plus session-end and engine-kind change as independent triggers.
- **Boot-time `DIGI_DX_ENGINE` as the only way to pick simulated.** A process-lifetime driver choice leaves a normally launched daemon stuck on the real engine forever, so the demo button is dead on arrival. Selection is per-`Engine.start(session, kind)`.
- **Relying on the UI `configComplete` check to gate demo start.** That check is advisory; the real gate and the "never persist demo config" rule must live in `handleStartSession`.
- **Aliasing `simulatedDriver` onto the real radio.** A silent alias keys the real radio under the "simulated" label — the constructor refuses the alias.
- **Unconditionally persisting every `start_session` payload** (session history). Early design would have run the synthesized demo config through `saveConfig`. That was a P0 review finding: a complete, valid-looking demo identity on disk permanently satisfies `CONFIG_REQUIRED`, so the next real start keys the actual rig on fabricated callsign/device/CAT. Caught in a second plan-review round, not the first.
- **"Daemon just reports a timestamp" for the slot clock** (session history). Clients still scheduled TX from local wall/`setTimeout`; a countdown needs a rate and an anchor (`anchorWallMs`), and every TX path must use the published clock — with no wall-clock fallback when the clock is missing.

## Solution

Reset every seam where demo residue can outlive the demo. Load-bearing pieces on `feat/slot-clock` (committed there as of 2026-07-14; not yet claimed merged to `main`):

**1. Daemon: always return to the real driver + realtime clock when inactive.**

`stop()`, crash handling, and failed `start()` all call `selectDefaultDriver()` so idle status never keeps `engine: simulated` or a scaled clock. Constructor refuses `simulatedDriver === driver`.

```263:269:src/daemon/engine.ts
  // Inactive status always reports the real driver at scale 1. Leaving a demo
  // session selected after stop would keep the DEMO banner up and leave a
  // scaled clock published while no session is running.
  private selectDefaultDriver(): void {
    this.driver = this.drivers.ft8cat;
    this.clock = new SlotClock(this.driver.clock());
  }
```

**2. Clients: clear automation on session end, engine-kind change, full clock dirty, and disconnect.**

Both `ui/web/server.ts` and `ui/tui.ts` clear in-flight QSOs/timers on those boundaries (not scale alone), drop the clock on reconnect, and gate `scheduleAutomation()` on `sessionActive`.

**3. Interactive demo stays scale 1; only the verification path scales.**

`DIGI_DX_SIM_SCALE` is consulted only when `DIGI_DX_ENGINE=sim`. UI demo constructs `new SimulatedDriver({})` (default scale 1) — KTD5 in the demo-mode plan.

**4. Demo identities never reach disk; `save_config` rejects them.**

`handleStartSession` builds `demoSessionConfig()` in memory and passes it straight to `engine.start(..., "simulated")`. `assertPersistableSession` rejects non-assignable `QQ*` callsigns and the simulated device id on any save path.

**5. Setup overlay defers to `station.demo`.**

While `engineKind === "simulated"`, the first-run overlay stays hidden.

**6. Coverage.** `test/demo-mode.test.ts` exercises demo→real in one daemon, config byte-identity after demo, reject demo-shaped save, real engine after stop, and unbound simulated decodes after session end. `test/engine-driver.test.ts` covers alias refusal and inactive-driver reset.

## Why This Works

"Demo" and "real" are states of one long-lived process, not two static deployments. Session-scoped caches need explicit invalidation on the *right* triggers:

- Driver selection is session-scoped; idle always means the real driver at scale 1.
- Automation validity dies on any clock identity change, kind change, session end, or disconnect — including scale-1 demo→real.
- Fabricated identities are structurally detectable (`QQ` + reserved device id) and blocked at persistence, with the demo start path never calling `saveConfig` at all.
- Scaled time exists only on the headless verification path, shrinking what interactive demo can leak.

## Prevention

- Treat session/engine-kind boundaries as first-class events for any client-derived state (timers, identities, in-flight actions) — do not infer invalidation from a single numeric field.
- Keep fabricated identities structurally rejectable (ITU non-assignable `QQ` prefix), not just "plausible fakes."
- Never route synthesized demo config through the same save path as real station config; keep `assertPersistableSession` as defense in depth.
- Push gates to the daemon authority; keep UI `configComplete` advisory.
- Default to the known-safe idle state after every stop/crash/failed start.
- A client with no published clock must arm no TX timer — no silent wall-clock fallback (session history).
- Simulator code must stay independent of `core/qso.ts` so it cannot agree with itself and mask automation bugs (session history).
- Container/smoke green is not live-rig proof — see AGENTS.md hardware-verification reachability. Operator hardware regression remains required before user-facing ship.

## Related Issues

- Design decisions: [docs/plans/2026-07-13-001-feat-simulated-engine-demo-mode-plan.md](../../plans/2026-07-13-001-feat-simulated-engine-demo-mode-plan.md) (KTD5 scale; KTD6b per-session driver; never persist demo config)
- Shipping residuals for the same branch: [docs/residual-review-findings/feat-slot-clock.md](../../residual-review-findings/feat-slot-clock.md)
- Standing reachability policy: [AGENTS.md](../../../AGENTS.md) (demo/sim does not prove the live radio path)
- Automated coverage: `test/demo-mode.test.ts`, `test/engine-driver.test.ts`
