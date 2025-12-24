import numpy as np
import pandas as pd
import polars as pl

from digi_dx.pipelines.active_callsigns.nodes import (
    add_contact_probability,
    add_priority,
)
from digi_dx.pipelines.p_contact.nodes import fit_contact_model


def _build_test_contact_model():
    """Create a small synthetic contact model for testing."""
    attempted = pd.DataFrame(
        {
            "snr_cq": [-20, -10, 0, 10, 20],
            "success": [0, 0, 0, 1, 1],
            "attempts": [1, 1, 1, 1, 1],
        }
    )
    model, idata = fit_contact_model(attempted)
    return model, idata


def test_add_contact_probability_adds_columns_and_priority():
    model, idata = _build_test_contact_model()

    callers = pl.DataFrame(
        {
            "timestamp": [0, 1, 2],
            "frequency": [7.074, 7.074, 7.074],
            "callsign": ["A", "B", "C"],
            "grid": ["EM48", "EM48", "EM48"],
            "snr": [-10.0, 0.0, 10.0],
            "contact_role": ["caller", "caller", "caller"],
            "latitude": [0.0, 0.0, 0.0],
            "longitude": [0.0, 0.0, 0.0],
            "distance_miles": [100.0, 200.0, 300.0],
            "bearing_degrees": [0.0, 0.0, 0.0],
        }
    ).lazy()

    callers_with_priority = add_priority(callers)
    enriched = add_contact_probability(callers_with_priority, model, idata).collect()

    # New columns are present
    assert "p_contact" in enriched.columns
    assert "priority_score_prob" in enriched.columns

    # Probabilities are in [0, 1]
    assert enriched["p_contact"].min() >= 0.0
    assert enriched["p_contact"].max() <= 1.0

    # Check that probability increases with SNR for this synthetic model
    probs_by_callsign = dict(zip(enriched["callsign"], enriched["p_contact"]))
    assert probs_by_callsign["A"] <= probs_by_callsign["B"] <= probs_by_callsign["C"]

    # priority_score_prob should equal distance_miles * p_contact
    expected_priority = enriched["distance_miles"] * enriched["p_contact"]
    assert np.allclose(
        enriched["priority_score_prob"].to_numpy(),
        expected_priority.to_numpy(),
        rtol=1e-6,
    )


def test_add_contact_probability_handles_empty_input():
    model, idata = _build_test_contact_model()

    empty_callers = pl.DataFrame(
        {
            "timestamp": pl.Series([], dtype=pl.Int64),
            "frequency": pl.Series([], dtype=pl.Float64),
            "callsign": pl.Series([], dtype=pl.String),
            "grid": pl.Series([], dtype=pl.String),
            "snr": pl.Series([], dtype=pl.Float64),
            "contact_role": pl.Series([], dtype=pl.String),
            "latitude": pl.Series([], dtype=pl.Float64),
            "longitude": pl.Series([], dtype=pl.Float64),
            "distance_miles": pl.Series([], dtype=pl.Float64),
            "bearing_degrees": pl.Series([], dtype=pl.Float64),
            "distance_rank": pl.Series([], dtype=pl.Float64),
            "snr_rank": pl.Series([], dtype=pl.Float64),
            "priority_score": pl.Series([], dtype=pl.Float64),
        }
    ).lazy()

    enriched = add_contact_probability(empty_callers, model, idata).collect()

    # Should remain empty and preserve columns
    assert enriched.height == 0
    assert "p_contact" not in enriched.columns or enriched["p_contact"].is_empty()
