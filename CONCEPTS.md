# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Session and engines

### Session
A contiguous period in which the daemon is running a chosen engine against a station identity (callsign, grid, audio device, CAT). Only one session is active at a time. Ending a session must leave the daemon idle with no leftover driver, clock, or client automation from that session.

### Engine driver
The process boundary that starts/stops the FT8 modem path, publishes decodes and transmit state, and exposes the authoritative time base for the session. Live operation uses the real radio/modem driver; demo and container verification use a separate simulated driver. The two must never alias onto the same process — idle always reports the live driver.

### Demo mode
An interactive session that runs the simulated engine so an operator can try the software without a radio, audio device, or CAT. It reuses the same client and protocol paths as a live session, but uses a reserved non-assignable station identity, never persists that identity as station config, and must be unmistakably labeled in every client. Interactive demo stays in real time; scaled time is reserved for headless verification.

### Slot clock
The daemon-published virtual time base that every client uses for FT8 slot parity, countdowns, and transmit scheduling. Clients adopt it; they do not invent slot timing from local wall clocks. Missing a published clock means no automation timer is armed. Scale other than real time exists for verification workloads, not for interactive demo.

## Identities and config

### Session config
The persistable station description used to start a live session (identity, devices, CAT). Completeness of a saved session config is what clears the daemon's "config required" gate. Demo synthesizes a valid-looking config in memory only; that shape must never satisfy the gate on disk for a later live start.

### Reserved demo identity
Simulated stations use callsigns from an ITU non-assignable prefix so a leaked demo transmission or log entry cannot be mistaken for a real licensee. Persistence rejects that identity class outright.

## Relationships

- A Session selects exactly one Engine driver for its lifetime and publishes one Slot clock derived from that driver.
- Demo mode is a Session whose engine driver is simulated and whose Session config is never persisted.
- Live Sessions consume a persisted Session config; Demo mode must never write or accept that config as the saved station.

## Flagged ambiguities

- "'KTD5' is plan-local numbering — the demo-mode plan's KTD5 is 'demo is real-time; only verification scales,' not the similarly numbered item in the earlier engine-backend plan."
- "'Engine' in conversation may mean the daemon's session orchestrator or the external modem binary; prefer Engine driver for the process boundary and Session for the orchestrated lifetime."
