"""Message processing pipeline definition."""
from kedro.pipeline import Pipeline, node, pipeline
from .nodes import load_raw_messages, parse_messages, filter_by_direction


def create_pipeline(**kwargs) -> Pipeline:
    """Create a namespaced pipeline for processing messages.

    This pipeline can be instantiated with different namespaces (e.g., "rx" and "tx")
    to process received and transmitted messages separately while sharing the
    common parsing logic.

    The pipeline consists of three main steps:
    1. Load raw messages from file
    2. Parse messages into structured format
    3. Filter by direction (Rx or Tx)

    Example usage in pipeline_registry:
        rx_pipeline = create_pipeline().map(namespace="rx", params={"direction": "Rx"})
        tx_pipeline = create_pipeline().map(namespace="tx", params={"direction": "Tx"})

    Returns:
        A Kedro Pipeline object
    """
    return pipeline(
        [
            node(
                func=load_raw_messages,
                inputs="raw_messages_file",
                outputs="raw_messages",
                name="load_raw_messages_node",
            ),
            node(
                func=parse_messages,
                inputs="raw_messages",
                outputs="parsed_messages",
                name="parse_messages_node",
            ),
            node(
                func=filter_by_direction,
                inputs=["parsed_messages", "params:direction"],
                outputs="filtered_messages",
                name="filter_by_direction_node",
            ),
        ]
    )
