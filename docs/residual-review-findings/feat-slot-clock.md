# Known Residuals — feat/slot-clock (U8–U10 shipping review)

Source: `/tmp/compound-engineering/ce-code-review/20260714-122740-u8u10/`

## Accepted (by design)

- **R17 soft banner does not fail the smoke exit code.** R17 requires phone-visible disclosure when simulator/smoke/automation paths change; failing the gate on every such PR would make verification forever red on the PR that introduces them. No merge base still fails closed. CI now emits a `::warning::` annotation when the banner fires.

## Deferred / optional

- Further de-duplication of daemon spawn between `scripts/smoke.ts` and `scripts/smoke-ui.ts`
- Direct unit tests of `git merge-base` resolution against a real shallow clone fixture
