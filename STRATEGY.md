---
name: Digi-Dx
last_updated: 2026-07-12
---

# Digi-Dx Strategy

## Target problem

Operating FT8 on a remote radio box is time-critical — every ~15-second decode
cycle you must quickly pick which stations to answer before the TX window closes.
Remote-desktop into a GUI (WSJT-X) is too heavyweight and laggy for that fast
action, and today's FT8 stack has no lightweight headless boundary built for
responsive remote operation.

## Our approach

Make a narrow, well-documented daemon↔client protocol the product's spine and an
experimentation platform: hold the contract stable and swap either side around it —
new UIs improve the operating experience with the engine held constant, new engines
get faster or simpler with the UI held constant. The contract is documented in an
agent-friendly way so a custom UI (or, less often, QSO logic or a decoder) can be
vibe-coded easily.

## Who it's for

**Primary:** The ham radio tinkerer — a technically-capable operator who wants an
open, hackable FT8 stack rather than a black-box GUI, but mostly won't write code
themselves. They're hiring Digi-Dx to operate FT8 on their own terms, out of the
box, on a contract open enough that anyone who *wants* to build a custom UI around
it easily can.

## Key metrics

- **Brother + dad actively using it** - the north star: two hams who aren't the
  author running Digi-Dx for real, across real sessions (target ~early 2027).
- **Out-of-box first QSO** - a new user reaches a first decode/QSO with no manual
  `ft8modem`/`ft8cat` install and no hand-holding; checked by watching a real fresh
  setup.
- **Return usage** - each new user makes QSOs across more than one session (not a
  one-time demo); read from the QSO log.

## Tracks

### The contract (spine)

Define, document (agent-friendly), and stabilize the daemon↔client protocol as the
durable asset both sides build against.

_Why it serves the approach:_ it *is* the approach — the stable boundary is what
makes independent experimentation on either side possible.

### Engine backend (turnkey now, swappable later)

Own how the FT8 engine is provided below the contract: near-term, bundle a default
engine so it runs out of the box with no manual install; later, the same
`EngineDriver` seam lets a custom decoder swap in.

_Why it serves the approach:_ the "back half" of the platform, and its first payoff —
zero-install onboarding — is what makes the brother-and-dad metric reachable.

### Reference clients

Build the web and TUI clients that make responsive remote operation genuinely good,
and that double as the worked examples the community forks into custom UIs.

_Why it serves the approach:_ proves the contract and seeds the "front half"
experimentation the approach is betting on.

## Milestones

- **2027-01-31** - Brother and dad both actively operating with Digi-Dx (target, approx).

## Not working on

- Multi-operator / concurrent control — one radio, one operator. Multiple *views* of
  one session may come later; shared multi-writer control is out for now.
