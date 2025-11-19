"""
This is a boilerplate pipeline 'active_callsigns'
generated using Kedro 1.0.0
"""

from kedro.pipeline import Node, Pipeline  # noqa
from .nodes import convert_cq_to_callers, convert_reply_to_hunters, add_priority, combine_target_contacts

def create_pipeline(**kwargs) -> Pipeline:
    return Pipeline(
        [
            Node(
                convert_cq_to_callers,
                inputs="table#CQ",
                outputs="callers_raw"
            ),
            Node(
                add_priority,
                inputs="callers_raw",
                outputs="table#Callers"
            ),
            Node(
                convert_reply_to_hunters,
                inputs="table#Reply",
                outputs="hunters_raw"
            ),
            Node(
                add_priority,
                inputs="hunters_raw",
                outputs="table#Hunters"
            ),
            Node(
                combine_target_contacts,
                inputs=["table#Callers", "table#Hunters"],
                outputs="table#Contacts"
            ),
        ]
    )
