"""Nodes for message processing pipeline."""
from pathlib import Path
import polars as pl


def load_raw_messages(filepath: str) -> pl.DataFrame:
    """Load raw message data from file.

    Args:
        filepath: Path to the raw message file

    Returns:
        DataFrame with raw message data in a single column
    """
    return pl.read_csv(
        str(filepath),
        has_header=False,
        new_columns=["raw"],
        separator="\x01",  # Use a delimiter that doesn't exist in the file
    )


def parse_messages(raw_df: pl.DataFrame) -> pl.DataFrame:
    """Parse raw messages into structured columns.

    This function splits the whitespace-separated raw message data
    into individual columns and converts timestamps to datetime.

    Args:
        raw_df: DataFrame with raw message data

    Returns:
        DataFrame with parsed message columns
    """
    return (
        raw_df
        .with_columns(
            pl.col("raw").str.replace_all(r"\s+", " ").str.split(" ").alias("split")
        )
        .filter(pl.col("split").list.len() == 10)
        .with_columns(
            pl.col("split").list.get(0).alias("timestamp"),
            pl.col("split").list.get(1).alias("frequency"),
            pl.col("split").list.get(2).alias("direction"),
            pl.col("split").list.get(3).alias("protocol"),
            pl.col("split").list.get(4).alias("signal_report"),
            pl.col("split").list.get(5).alias("time_offset"),
            pl.col("split").list.get(6).alias("freq_offset"),
            pl.col("split").list.get(7).alias("target"),
            pl.col("split").list.get(8).alias("sender"),
            pl.col("split").list.get(9).alias("message"),
        )
        .with_columns(
            pl.col("timestamp")
            .str.to_datetime(format="%y%m%d_%H%M%S")
            .alias("datetime")
        )
        .select(
            [
                "timestamp",
                "datetime",
                "frequency",
                "direction",
                "protocol",
                "signal_report",
                "time_offset",
                "freq_offset",
                "target",
                "sender",
                "message",
            ]
        )
        .sort("timestamp", descending=True)
    )


def filter_by_direction(messages_df: pl.DataFrame, direction: str) -> pl.DataFrame:
    """Filter messages by direction (Rx or Tx).

    Args:
        messages_df: DataFrame with parsed messages
        direction: Direction to filter by ("Rx" for received, "Tx" for transmitted)

    Returns:
        DataFrame with only messages matching the specified direction
    """
    return messages_df.filter(pl.col("direction") == direction)
