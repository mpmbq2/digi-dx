"""
Pipeline for modeling contact success probability.

This pipeline models the probability of successful contact completion
(reaching signoff) given that we reply to a CQ with a certain SNR,
using Bayesian logistic regression.
"""

from kedro.pipeline import Node, Pipeline

from .nodes import (
    extract_contact_probabilities,
    fit_contact_model,
    predict_contact_probabilities,
    prepare_attempted_contacts,
)


def create_pipeline(**kwargs) -> Pipeline:
    return Pipeline(
        [
            Node(
                prepare_attempted_contacts,
                inputs=["table#Reply_Tx", "table#CQ_Rx", "table#Signoff_Tx"],
                outputs="features::table#AttemptedContacts",
            ),
            Node(
                fit_contact_model,
                inputs="features::table#AttemptedContacts",
                outputs=["p_contact_model", "p_contact_idata"],
            ),
            Node(
                predict_contact_probabilities,
                inputs=["p_contact_model", "p_contact_idata"],
                outputs="p_contact_predictions",
            ),
            Node(
                extract_contact_probabilities,
                inputs="p_contact_predictions",
                outputs="inference::table#ContactProbabilities",
            ),
        ]
    )
