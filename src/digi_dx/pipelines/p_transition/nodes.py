"""
This is a boilerplate pipeline 'p_contact'
generated using Kedro 1.0.0

This pipeline models the probability of state transitions between CQ (calling)
and Reply states for amateur radio callsigns using a Bayesian hierarchical
binomial regression model.
"""

import arviz as az
import bambi as bmb
import pandas as pd
import polars as pl
from scipy.special import expit


def prepare_state_sequence(
    cq_df: pl.LazyFrame, reply_df: pl.LazyFrame
) -> pd.DataFrame:
    """Combine CQ and Reply tables into a unified sequence of states per callsign.

    Args:
        cq_df: LazyFrame with CQ messages containing callsign and timestamp
        reply_df: LazyFrame with Reply messages containing called_callsign and timestamp

    Returns:
        DataFrame with all events sorted by callsign and timestamp, with prev_state column
    """
    cq_pandas = cq_df.collect().to_pandas()
    reply_pandas = reply_df.collect().to_pandas()

    # Create CQ events (state = 'CQ')
    cq_events = cq_pandas[["callsign", "timestamp"]].copy()
    cq_events["state"] = "CQ"
    cq_events = cq_events.rename(columns={"callsign": "callsign_id"})

    # Create Reply events (state = 'Reply')
    # Each reply represents the called_callsign taking action
    reply_events = reply_pandas[["called_callsign", "timestamp"]].copy()
    reply_events["state"] = "Reply"
    reply_events = reply_events.rename(columns={"called_callsign": "callsign_id"})

    # Combine all events
    all_events = pd.concat([cq_events, reply_events], ignore_index=True)

    # Sort by callsign and timestamp
    all_events = all_events.sort_values(["callsign_id", "timestamp"])

    # Add previous state column
    all_events["prev_state"] = all_events.groupby("callsign_id")["state"].shift(1)

    return all_events


def prepare_transitions_data(all_events: pd.DataFrame) -> pd.DataFrame:
    """Prepare transition data for model fitting.

    Groups events by callsign and previous state, counting transmissions
    and transitions for the binomial model.

    Args:
        all_events: DataFrame with callsign_id, timestamp, state, prev_state columns

    Returns:
        DataFrame with callsign_id, prev_state, transmissions, transitions columns
    """
    transitions = (
        all_events.query("prev_state.notnull()")
        .assign(transition=lambda x: x["state"] != x["prev_state"])
        .groupby(["callsign_id", "prev_state"])
        .agg(transmissions=("timestamp", "count"), transitions=("transition", "sum"))
        .assign(p_transition=lambda x: x["transitions"] / x["transmissions"])
        .reset_index()
    )
    return transitions


def fit_transition_model(
    transitions: pd.DataFrame,
) -> tuple[bmb.Model, az.InferenceData]:
    """Fit Bayesian hierarchical binomial model for state transitions.

    Models the probability of transitioning from one state to another
    with random effects per callsign.

    Args:
        transitions: DataFrame with callsign_id, prev_state, transmissions, transitions

    Returns:
        Tuple of (fitted Bambi model, ArviZ InferenceData)
    """
    model = bmb.Model(
        "p(transitions, transmissions) ~ 1 + (1 + prev_state | callsign_id)",
        family="binomial",
        data=transitions,
        priors={
            "1|callsign_id": bmb.Prior(
                "Normal", mu=0.0, sigma=bmb.Prior("HalfNormal", sigma=0.5)
            )
        },
    )

    idata = model.fit(random_seed=42)

    return model, idata


def extract_transition_probabilities(
    idata: az.InferenceData,
) -> pl.DataFrame:
    """Extract transition probabilities from fitted model posterior.

    Computes per-callsign transition probabilities from CQ and Reply states
    by combining intercept and random effects, then applying logistic transform.

    Args:
        idata: ArviZ InferenceData from fitted model

    Returns:
        Polars DataFrame with summarized transition probabilities per callsign
    """
    # Extract posterior samples and compute transition probabilities
    transition_ps = (
        az.extract(
            idata, var_names=["Intercept", "1|callsign_id", "prev_state|callsign_id"]
        )
        .to_dataframe()
        .assign(
            cq_transition_p=lambda x: expit(x["Intercept"] + x["1|callsign_id"]),
            reply_transition_p=lambda x: expit(
                x["Intercept"]
                + x["1|callsign_id"]
                + x["prev_state|callsign_id"]
            ),
        )
        .reset_index()
    )

    # Summarize by callsign (mean and std of posterior)
    summary = (
        transition_ps.groupby("callsign_id__factor_dim")
        .agg(
            cq_transition_p_mean=("cq_transition_p", "mean"),
            cq_transition_p_std=("cq_transition_p", "std"),
            reply_transition_p_mean=("reply_transition_p", "mean"),
            reply_transition_p_std=("reply_transition_p", "std"),
        )
        .reset_index()
        .rename(columns={"callsign_id__factor_dim": "callsign_id"})
    )

    return pl.from_pandas(summary)
