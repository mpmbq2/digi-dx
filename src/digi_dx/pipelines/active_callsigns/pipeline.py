from kedro.pipeline import Node, Pipeline  # noqa

from .nodes import (
    add_contact_probability,
    add_priority,
    combine_target_contacts,
    convert_cq_to_callers,
    convert_reply_to_hunters,
)


def create_pipeline(**kwargs) -> Pipeline:
    return Pipeline(
        [
            Node(
                convert_cq_to_callers,
                inputs="table#CQ_Rx",
                outputs="callers_raw",
            ),
            Node(
                add_priority,
                inputs="callers_raw",
                outputs="callers_with_priority",
            ),
            Node(
                add_contact_probability,
                inputs=["callers_with_priority", "p_contact_model", "p_contact_idata"],
                outputs="table#Callers",
            ),
            Node(
                convert_reply_to_hunters,
                inputs="table#Reply_Rx",
                outputs="hunters_raw",
            ),
            Node(
                add_priority,
                inputs="hunters_raw",
                outputs="table#Hunters",
            ),
            Node(
                combine_target_contacts,
                inputs=["table#Callers", "table#Hunters"],
                outputs="table#Contacts",
            ),
        ]
    )
