"""Project pipelines."""
from __future__ import annotations

from kedro.pipeline import Pipeline
from digi_dx.pipelines.message_processing import create_pipeline


def register_pipelines() -> dict[str, Pipeline]:
    """Register the project's pipelines.

    This registers two namespaced pipelines:
    - rx: Processes received (Rx) messages
    - tx: Processes transmitted (Tx) messages

    Both pipelines share the same processing logic but filter
    messages by direction and output to separate datasets.

    Returns:
        A mapping from pipeline names to ``Pipeline`` objects.
    """
    # Create the base message processing pipeline
    message_pipeline = create_pipeline()

    # Create namespaced instances for Rx and Tx
    rx_pipeline = message_pipeline.map(namespace="rx")
    tx_pipeline = message_pipeline.map(namespace="tx")

    # Register all pipelines
    return {
        "rx": rx_pipeline,
        "tx": tx_pipeline,
        "__default__": rx_pipeline + tx_pipeline,
    }
