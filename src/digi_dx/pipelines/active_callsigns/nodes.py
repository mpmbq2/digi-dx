"""
This is a boilerplate pipeline 'active_callsigns'
generated using Kedro 1.0.0
"""

import polars as pl

from digi_dx.geography import (
    calc_distance,
    calc_bearing,
    maidenhead_to_lat,
    maidenhead_to_lon,
)


def convert_cq_to_callers(cq: pl.LazyFrame) -> pl.LazyFrame:
    return (
        cq.filter(pl.col("direction") == "Rx")
        .select(["timestamp", "frequency", "callsign", "grid", "snr"])
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
        reply.filter(pl.col("direction") == "Rx")
        .select(["timestamp", "frequency", "called_callsign", "grid", "snr"])
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


def combine_target_contacts(callers: pl.LazyFrame, hunters: pl.LazyFrame) -> pl.DataFrame:
    return (
        pl.concat([callers, hunters], how="vertical")
        .sort(["callsign", "timestamp"], descending=True)
        .unique("callsign", keep="first")
    )
