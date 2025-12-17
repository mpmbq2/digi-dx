# Research Notes — Caller Contact Probability Integration

## Problem statement & requirements
- Need to surface the Kedro-derived probability of contact (logistic regression of contact success vs CQ SNR) for Callers in the UI.
- Goal: rank Callers by distance **weighted by** probability of contact; Hunters are not modeled yet.
- Integration should align data flowing from Kedro outputs into the Shiny UI tables used for prioritization.

## What we found
- **Model location:** `src/digi_dx/pipelines/p_contact/nodes.py` and `pipeline.py`. Bayesian logistic regression (`bambi`) predicting `p(success | snr_cq)` across SNR -30..30 dB; outputs summarized to `inference::table#ContactProbabilities` with `p_mean/p_lower/p_upper` per integer SNR.
- **Inputs to model:** `prepare_attempted_contacts` joins Reply_Tx with heard CQ_Rx and Signoff_Tx, filters reply delay=15s, aggregates by `caller_callsign` with attempts, last_reply, mean `snr_cq`; joins signoff timestamps. (Note: no explicit `success` column currently set—needs clarification.)
- **Current prioritization (UI-facing):** `active_callsigns` pipeline builds `table#Callers` from `CQ_Rx` and `table#Hunters` from `Reply_Rx`, computes distance/bearing from reference grid EM48, and ranks by distance + SNR ordinal ranks (`priority_score` lower is better). No probability used yet. Contacts combined into `table#Contacts`.
- **Distance/bearing calc:** Uses `geopy.distance.geodesic` (`geography/distance.py`) and simple bearing math; reference location is hardcoded EM48.
- **UI consumption:** `app/app.py` Shiny app loads Kedro catalog; tabs render `Callers`, `Hunters`, `Contacts` via `table#*` datasets, filtered by date range. No access to inference outputs today.
- **Data catalog:** `conf/base/catalog.yml` defines transformed tables in `data/02_transformed`, features in `03`, inference outputs in `05`; contact model artifacts stored under `data/04_models`.

## Key questions (answers where known)
- **Where to get probability values?** From `inference::table#ContactProbabilities` (SNR → p_mean and bounds).
- **How Callers are defined?** Latest CQ per callsign from `CQ_Rx`, with `snr` from message.
- **How priority currently computed?** Distance rank + SNR rank (descending) summed.
- **Is probability per-callsign or global?** Global curve vs SNR; not caller-specific.
- **Success label source?** Not set in code; unclear how success is derived from signoff join.

## Architectural options considered
- **Option A: Pipeline join & new priority column**
  - Join `Callers` with `ContactProbabilities` on nearest/rounded `snr` to assign `p_contact` per caller; compute new `priority_score` using distance weighted by `p_contact`. Pros: consistent, cached dataset for UI; no extra UI logic. Cons: needs decision on interpolation and weighting formula; requires rerunning pipeline when model updates.
- **Option B: UI-side weighting**
  - Load `ContactProbabilities` in Shiny, map SNR → probability, compute priority on the fly. Pros: fast iteration without pipeline change; can swap formulas via UI. Cons: duplicates logic, harder to keep in sync with data versioning; heavier client computation for large tables.
- **Option C: Hybrid**
  - Pipeline stores `p_contact` per caller; UI chooses among multiple priority formulas (distance-only vs prob-weighted). Pros: flexibility for experiments. Cons: added UI complexity.

## Potential gotchas
- Missing/undefined `success` column in `fit_contact_model` input; need confirmation on label definition and encoding for binomial model.
- Callers’ `snr` may be non-integer; probability table is integer -30..30—interpolation or rounding strategy required.
- SNRs outside modeled range need a clamp/default.
- Reference grid is fixed to EM48; if station grid changes, distance weighting must update.
- Date-range filtering in UI pulls from `table#Callers`/`Hunters`; ensure prob/priorities align with same timestamp scope.
- Hunters currently lack a probability model; rankings remain distance/SNR based unless extended.

## Open questions
- Exact weighting formula: distance * p_contact? distance_rank / p? log-weight? Should higher distance still dominate when probability is low?
- Do we prefer pipeline-level computation (and persisted columns) or UI-layer computation?
- How to handle non-integer or missing SNR values for callers?
- What defines contact “success” for the model—presence of Signoff within a window? Needs to be reflected in features.
- How frequently is the model retrained, and how should the UI react to updated inference outputs?
- Should we display uncertainty (p_lower/p_upper) or only mean?
- Any station-location variability (EM48 hardcoded) that should be parameterized?

## Implementation status
- Pipeline-side enrichment implemented:
  - `active_callsigns` now loads `p_contact_model` and `p_contact_idata` artifacts.
  - New node computes per-caller `p_contact` using the Bayesian logistic regression model and each caller's `snr`.
  - New column `priority_score_prob` is computed as `distance_miles * p_contact` (lower is better).
  - `table#Callers` carries `p_contact` and `priority_score_prob`, and these propagate into `table#Contacts` for caller rows.
- UI integration:
  - `Caller` and `Contacts` tables default-sort by `priority_score_prob` when available (falling back to `priority_score`).
  - `Hunters` remain ranked by the existing distance/SNR-based `priority_score`; no probability model applied yet.

## Recommended next steps for planning
- Clarify/implement the `success` label in `prepare_attempted_contacts` to ensure the model is learning the intended outcome.

