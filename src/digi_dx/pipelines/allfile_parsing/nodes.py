"""
This is a boilerplate pipeline 'allfile_parsing'
generated using Kedro 1.0.0
"""

from collections import defaultdict
from dataclasses import asdict

import polars as pl

from digi_dx.message_parsing.ft8 import FT8Message, parse_message


def convert_all_to_messages(allfile_lines: list[str]) -> list[FT8Message]:
    return [parse_message(line) for line in allfile_lines]


def _group_messages_by_type(messages):
    """Single pass, O(n) time complexity, no if statements."""
    grouped = defaultdict(list)

    for msg in messages:
        msg_type = type(msg).__name__
        grouped[msg_type].append(asdict(msg))

    return dict(grouped)


def create_message_tables(allfile_messages: list[FT8Message]) -> list[pl.DataFrame]:

    messages = _group_messages_by_type(allfile_messages)
    message_tables = dict()
    for message_type, message_list in messages.items():
        message_tables[message_type] = pl.from_dicts(message_list)

    return [
        message_tables["CQ"],
        message_tables["Reply"],
        message_tables["Report"],
        message_tables["RogerReport"],
        message_tables["Rogers"],
        message_tables["Signoff"],
    ]