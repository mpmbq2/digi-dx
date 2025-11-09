from pathlib import Path
import polars as pl


# def load_data(filepath: str="data/01_raw/ALL.TXT") -> pl.DataFrame:
#    import re
#
#    # Read the file and replace multi-byte whitespace with a single delimiter
#    with open(filepath, 'r') as f:
#        content = f.read(5_000)
#
#    # Replace one or more whitespace characters with a single pipe character
#    content = re.sub(r'\s+', '|', content)
#
#    # Write to a temporary location or use StringIO
#    from io import StringIO
#    return (
#        pl.read_csv(
#            StringIO(content),
#            has_header=False,
#            new_columns=[
#                "date",
#                "freq",
#                "transmission_type",
#                "protocol",
#                "snr",
#                "freq_offset",
#                "signal_report",
#                "message",
#                "sender",
#                "grid_square",
#            ],
#            separator="|",
#        )
#    )


# def load_data(filepath: str="data/01_raw/ALL.TXT") -> pl.DataFrame:
#    return (
#        pl.read_csv(
#            filepath,
#            has_header=False,
#            new_columns=[
#                "date",
#                "freq",
#                "transmission_type",
#                "protocol",
#                "snr",
#                "freq_offset",
#                "signal_report",
#                "message",
#                "sender",
#                "grid_square",
#            ],
#            separator=r"\s+",
#        )
#    )
#


def load_data(filepath: str = "data/01_raw/ALL.TXT"):
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
