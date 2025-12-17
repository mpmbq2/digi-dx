import polars as pl
import arviz as az
import pandas as pd
from typing import Any

from digi_dx.geography import (
    calc_distance,
    calc_bearing,
    maidenhead_to_lat,
    maidenhead_to_lon,
)


def convert_cq_to_callers(cq: pl.LazyFrame) -> pl.LazyFrame:
    return (
        cq.select(["timestamp", "frequency", "callsign", "grid", "snr"])
        .sort(["timestamp", "callsign"], descending=True)
        .unique(pl.col("callsign"), keep="first")
        .with_columns(
            contact_role=pl.lit("caller"),
            latitude=pl.col("grid").map_elements(
                maidenhead_to_lat, return_dtype=pl.Float64
            ),
            longitude=pl.col("grid").map_elements(
                maidenhead_to_lon, return_dtype=pl.Float64
            ),
            reference_latitude=pl.lit(maidenhead_to_lat("EM48")),
            reference_longitude=pl.lit(maidenhead_to_lon("EM48")),
        )
        .with_columns(
            locations=pl.struct(
                ["reference_latitude", "reference_longitude", "latitude", "longitude"]
            ),
        )
        .with_columns(
            distance_miles=(
                pl.col("locations").map_elements(calc_distance, return_dtype=pl.Float64)
            ),
            bearing_degrees=(
                pl.col("locations").map_elements(calc_bearing, return_dtype=pl.Float64)
            ),
        )
        .select(
            [
                "timestamp",
                "frequency",
                "callsign",
                "grid",
                "snr",
                "contact_role",
                "latitude",
                "longitude",
                "distance_miles",
                "bearing_degrees",
            ]
        )
    )


def convert_reply_to_hunters(reply: pl.LazyFrame) -> pl.LazyFrame:
    return (
        reply.select(["timestamp", "frequency", "called_callsign", "grid", "snr"])
        .sort(["timestamp", "called_callsign"], descending=True)
        .unique(pl.col("called_callsign"), keep="first")
        .with_columns(
            callsign=pl.col("called_callsign"),
            contact_role=pl.lit("hunter"),
            latitude=pl.col("grid").map_elements(
                maidenhead_to_lat, return_dtype=pl.Float64
            ),
            longitude=pl.col("grid").map_elements(
                maidenhead_to_lon, return_dtype=pl.Float64
            ),
            reference_latitude=pl.lit(maidenhead_to_lat("EM48")),
            reference_longitude=pl.lit(maidenhead_to_lon("EM48")),
        )
        .with_columns(
            locations=pl.struct(
                ["reference_latitude", "reference_longitude", "latitude", "longitude"]
            ),
        )
        .with_columns(
            distance_miles=(
                pl.col("locations").map_elements(calc_distance, return_dtype=pl.Float64)
            ),
            bearing_degrees=(
                pl.col("locations").map_elements(calc_bearing, return_dtype=pl.Float64)
            ),
        )
        .select(
            [
                "timestamp",
                "frequency",
                "callsign",
                "grid",
                "snr",
                "contact_role",
                "latitude",
                "longitude",
                "distance_miles",
                "bearing_degrees",
            ]
        )
    )


def add_priority(contacts: pl.LazyFrame) -> pl.LazyFrame:
    """Add priority score based on distance and SNR ranking.

    Priority score is calculated as the sum of:
    - Distance rank (furthest = rank 1)
    - SNR rank (highest = rank 1)

    Lower priority scores indicate higher priority contacts.

    Args:
        contacts: LazyFrame with distance_miles and snr columns

    Returns:
        LazyFrame with added distance_rank, snr_rank, and priority_score columns,
        sorted by priority_score (ascending)
    """
    return (
        contacts.with_columns(
            [
                pl.col("distance_miles")
                .rank(method="ordinal", descending=True)
                .alias("distance_rank"),
                pl.col("snr")
                .rank(method="ordinal", descending=True)
                .alias("snr_rank"),
            ]
        )
        .with_columns(
            priority_score=(pl.col("distance_rank") + pl.col("snr_rank"))
        )
        .sort("priority_score")
    )


def add_contact_probability(
    callers: pl.LazyFrame,
    model: Any,
    idata: Any,
) -> pl.LazyFrame:
    """Add contact probability and probability-weighted priority score.

    Uses the fitted Bayesian logistic regression contact model to compute
    per-caller contact probabilities based on SNR, then multiplies by distance
    to get a probability-weighted priority score. Lower scores are better.

    Args:
        callers: LazyFrame with at least snr and distance_miles columns, and
            existing rank-based priority columns.
        model: Fitted Bambi contact model (p_contact_model).
        idata: ArviZ InferenceData from the fitted model (p_contact_idata).

    Returns:
        LazyFrame with added p_contact and priority_score_prob columns,
        sorted by probability-weighted priority (ascending).
    """
    callers_df = callers.collect()

    if callers_df.height == 0:
        # Preserve empty LazyFrame and schema
        return callers

    # Build prediction data frame compatible with the contact model
    prediction_data = pd.DataFrame(
        {"snr_cq": callers_df["snr"].to_pandas()}
    )

    prediction = model.predict(idata, data=prediction_data, inplace=False)

    posterior = (
        az.extract(prediction, var_names="p")
        .to_dataframe()
        .reset_index()
        .groupby("__obs__")
        .agg(p_mean=("p", "mean"))
        .reset_index(drop=True)
    )

    callers_df = callers_df.with_columns(
        [
            pl.Series(
                name="p_contact",
                values=posterior["p_mean"].to_numpy(),
            ),
        ]
    ).with_columns(
        (pl.col("distance_miles") * pl.col("p_contact")).alias(
            "priority_score_prob"
        )
    )

    # Sort by probability-weighted priority (lower is better)
    callers_df = callers_df.sort("priority_score_prob")

    return callers_df.lazy()


def combine_target_contacts(callers: pl.LazyFrame, hunters: pl.LazyFrame) -> pl.DataFrame:
    return (
        pl.concat([callers, hunters], how="vertical")
        .sort(["callsign", "timestamp"], descending=True)
        .unique("callsign", keep="first")
    )
