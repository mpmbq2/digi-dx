"""
This pipeline models the probability of successful contact completion
(reaching signoff) given that we reply to a CQ with a certain SNR,
using Bayesian logistic regression.
"""

import arviz as az
import bambi as bmb
import numpy as np
import pandas as pd
import polars as pl


def prepare_attempted_contacts(
    reply_tx: pl.LazyFrame, cq_rx: pl.LazyFrame, signoff_tx: pl.LazyFrame
) -> pd.DataFrame:
    """Prepare attempted contacts data by joining replies with heard CQs and signoffs.

    Args:
        reply_tx: LazyFrame with transmitted Reply messages
        cq_rx: LazyFrame with received CQ messages
        signoff_tx: LazyFrame with transmitted Signoff messages

    Returns:
        DataFrame with attempted contacts including SNR, attempts, and success flag
    """
    attempted_contacts = (
        reply_tx.join(
            cq_rx.select(["callsign", "snr", "timestamp"]),
            left_on="caller_callsign",
            right_on="callsign",
            suffix="_cq",
        )
        .filter(
            pl.col("timestamp") > pl.col("timestamp_cq"),
        )
        .with_columns(reply_delay=pl.col("timestamp") - pl.col("timestamp_cq"))
        .filter(pl.col("reply_delay") == pl.duration(seconds=15))
        .group_by(["caller_callsign"])
        .agg(
            attempts=pl.col("timestamp").count(),
            last_reply=pl.col("timestamp").max(),
            snr_cq=pl.col("snr_cq").mean(),
        )
        .join(
            signoff_tx.select(["caller_callsign", "timestamp"]),
            on="caller_callsign",
            how="left",
            suffix="_completed",
        )
        .with_columns(success=pl.col("timestamp").is_not_null())
        .collect()
    )

    return attempted_contacts.to_pandas()


def fit_contact_model(
    attempted_contacts: pd.DataFrame,
) -> tuple[bmb.Model, az.InferenceData]:
    """Fit Bayesian logistic regression model for contact success probability.

    Models the probability of successful contact completion (reaching signoff)
    as a function of the SNR of the received CQ.

    Args:
        attempted_contacts: DataFrame with attempts, snr_cq, and success columns

    Returns:
        Tuple of (fitted Bambi model, ArviZ InferenceData)
    """
    model = bmb.Model(
        "p(success, attempts) ~ 1 + snr_cq",
        family="binomial",
        data=attempted_contacts.astype({"success": int}),
    )

    idata = model.fit(random_seed=42)

    return model, idata


def predict_contact_probabilities(
    model: bmb.Model,
    idata: az.InferenceData,
) -> az.InferenceData:
    """Generate contact probability predictions across SNR range.

    Args:
        model: Fitted Bambi model
        idata: ArviZ InferenceData from fitted model

    Returns:
        InferenceData with predictions for SNR range -30 to +30 dB
    """
    snr_range = np.arange(-30, 31, 1)
    prediction_data = pd.DataFrame(pd.Series(snr_range, name="snr_cq"))

    prediction = model.predict(idata, data=prediction_data, inplace=False)

    return prediction


def extract_contact_probabilities(
    prediction: az.InferenceData,
) -> pl.DataFrame:
    """Extract and summarize contact probabilities from prediction posterior.

    Args:
        prediction: InferenceData with prediction posterior samples

    Returns:
        Polars DataFrame with SNR and summarized contact probabilities
    """
    snr_range = np.arange(-30, 31, 1)

    snr_pred = (
        az.extract(prediction, var_names="p")
        .to_dataframe()
        .reset_index()
        .groupby("__obs__")
        .agg(
            p_mean=("p", "mean"),
            p_lower=("p", lambda x: np.percentile(x, q=2.5)),
            p_upper=("p", lambda x: np.percentile(x, q=97.5)),
        )
        .assign(snr_cq=snr_range)
        .reset_index(drop=True)
    )

    return pl.from_pandas(snr_pred)
