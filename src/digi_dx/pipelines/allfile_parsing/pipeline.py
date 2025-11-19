"""
This is a boilerplate pipeline 'allfile_parsing'
generated using Kedro 1.0.0
"""

from kedro.pipeline import Node, Pipeline, pipeline  # noqa
from .nodes import convert_all_to_messages, create_message_tables, split_table_by_direction


def create_split_pipeline() -> Pipeline:
    """Create a reusable modular pipeline that splits a table by direction.

    This pipeline takes a single input table and produces tx/rx split outputs.
    It's designed to be instantiated multiple times with different namespaces.
    """
    return Pipeline([
        Node(
            split_table_by_direction,
            inputs="input_table",
            outputs={"tx": "tx_table", "rx": "rx_table"},
        )
    ])


def create_pipeline(**kwargs) -> Pipeline:
    # Base pipeline: parse ALL.TXT and create message type tables
    base_pipeline = Pipeline([
        Node(
            convert_all_to_messages,
            inputs="all_txt_lines",
            outputs="all_txt_messages"
        ),
        Node(
            create_message_tables,
            inputs="all_txt_messages",
            outputs=[
                "table#CQ",
                "table#Reply",
                "table#Report",
                "table#RogerReport",
                "table#Rogers",
                "table#Signoff",
            ]
        )
    ])

    # Create split pipelines for each message type
    message_types = ["CQ", "Reply", "Report", "RogerReport", "Rogers", "Signoff"]
    split_pipelines = []

    for msg_type in message_types:
        split_pipelines.append(
            pipeline(
                create_split_pipeline(),
                inputs={"input_table": f"table#{msg_type}"},
                outputs={
                    "tx_table": f"table#{msg_type}_Tx",
                    "rx_table": f"table#{msg_type}_Rx",
                },
                namespace=msg_type.lower(),
            )
        )

    # Combine base pipeline with all split pipelines
    return sum([base_pipeline] + split_pipelines)
