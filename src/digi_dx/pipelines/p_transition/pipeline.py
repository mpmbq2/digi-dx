"""
This is a boilerplate pipeline 'p_contact'
generated using Kedro 1.0.0
"""

from kedro.pipeline import Node, Pipeline

from .nodes import (
    extract_transition_probabilities,
    fit_transition_model,
    prepare_state_sequence,
    prepare_transitions_data,
)


def create_pipeline(**kwargs) -> Pipeline:
    return Pipeline(
        [
            Node(
                prepare_state_sequence,
                inputs=["table#CQ_Rx", "table#Reply_Rx"],
                outputs="all_events",
            ),
            Node(
                prepare_transitions_data,
                inputs="all_events",
                outputs="features::table#Transitions",
            ),
            Node(
                fit_transition_model,
                inputs="features::table#Transitions",
                outputs=["p_transition_model", "p_transition_idata"],
            ),
            Node(
                extract_transition_probabilities,
                inputs="p_transition_idata",
                outputs="inference::table#TransitionProbabilities",
            ),
        ]
    )
