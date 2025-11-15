"""
This is a boilerplate pipeline 'allfile_parsing'
generated using Kedro 1.0.0
"""

from kedro.pipeline import Node, Pipeline  # noqa
from .nodes import convert_all_to_messages, create_message_tables

def create_pipeline(**kwargs) -> Pipeline:
    return Pipeline(
        [
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
        ]
    )
