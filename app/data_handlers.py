import os
from pathlib import Path
import yaml

import polars as pl
from kedro.io import DataCatalog


def get_data_catalog():

    conf_path = Path(__file__).parent / ".." / "conf" / "base" / "catalog.yml"

    with open(conf_path) as f:
        conf = yaml.safe_load(f)

    catalog = DataCatalog.from_config(conf)
    return catalog


def load_data(filepath: str = "../data/01_raw/ALL.TXT"):
    return (
        pl.read_csv(
            str(filepath),
            has_header=False,
            new_columns=["raw"],
            separator="\x01",  # Use a delimiter that doesn't exist in the file
        )
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
