"""
This module provides a parser for FT8 messages as found in the ALL.TXT log file format.
"""
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Optional, Union


@dataclass(frozen=True)
class FT8Message:
    """Base class for all FT8 messages."""
    raw_line: str
    raw_message: str
    timestamp: datetime
    frequency: float
    direction: str
    mode: str
    snr: int
    time_offset: float
    audio_frequency: int


@dataclass(frozen=True)
class CQ(FT8Message):
    """Represents a CQ (general call) message."""
    callsign: str
    grid: str
    is_dx: bool = False


@dataclass(frozen=True)
class Reply(FT8Message):
    """Represents a reply to a CQ or a directed call."""
    caller_callsign: str
    called_callsign: str
    grid: str


@dataclass(frozen=True)
class Report(FT8Message):
    """Represents a signal report message."""
    caller_callsign: str
    called_callsign: str
    report: str


@dataclass(frozen=True)
class RogerReport(FT8Message):
    """Represents a roger + signal report message (e.g., R-15, R+04)."""
    caller_callsign: str
    called_callsign: str
    report: str


@dataclass(frozen=True)
class Rogers(FT8Message):
    """Represents a roger message (RRR or RR73)."""
    caller_callsign: str
    called_callsign: str


@dataclass(frozen=True)
class Signoff(FT8Message):
    """Represents a signoff message (73)."""
    caller_callsign: str
    called_callsign: str


@dataclass(frozen=True)
class Unknown(FT8Message):
    """Represents a message that could not be parsed."""
    pass


# Type alias for any valid FT8 message type
ParsedMessage = Union[CQ, Reply, Report, RogerReport, Rogers, Signoff, Unknown]

# Regex to parse the entire log line, including metadata
LINE_RE = re.compile(
    r"^(?P<timestamp>\d{6}_\d{6})\s+"
    r"(?P<frequency>\d+\.\d+)\s+"
    r"(?P<direction>Tx|Rx)\s+"
    r"(?P<mode>FT\d+)\s+"
    r"(?P<snr>[-+]?\d+)\s+"
    r"(?P<time_offset>\d+\.\d+)\s+"
    r"(?P<audio_frequency>\d+)\s+"
    r"(?P<payload>.*)$"
)

# Pre-compiled regex patterns for efficiency
# Note on callsign regex: This is a simplified version for common callsigns.
CALLSIGN_RE = r"[A-Z0-9/]{3,}"
GRID_RE = r"[A-R]{2}[0-9]{2}"

PATTERNS = {
    "roger_report": re.compile(
        rf"^(?P<caller>{CALLSIGN_RE}) (?P<called>{CALLSIGN_RE}) R(?P<report>[-+]\d+)$"
    ),
    "rogers": re.compile(
        rf"^(?P<caller>{CALLSIGN_RE}) (?P<called>{CALLSIGN_RE}) (RRR|RR73)$"
    ),
    "report": re.compile(
        rf"^(?P<caller>{CALLSIGN_RE}) (?P<called>{CALLSIGN_RE}) (?P<report>[-+]\d+)$"
    ),
    "signoff": re.compile(
        rf"^(?P<caller>{CALLSIGN_RE}) (?P<called>{CALLSIGN_RE}) 73$"
    ),
    "cq_dx": re.compile(
        rf"^CQ DX (?P<callsign>{CALLSIGN_RE}) (?P<grid>{GRID_RE})$"
    ),
    "cq": re.compile(
        rf"^CQ (?P<callsign>{CALLSIGN_RE}) (?P<grid>{GRID_RE})$"
    ),
    "reply": re.compile(
        rf"^(?P<caller>{CALLSIGN_RE}) (?P<called>{CALLSIGN_RE}) (?P<grid>{GRID_RE})$"
    ),
}


def parse_message(line: str) -> Optional[ParsedMessage]:
    """
    Parses a single raw line from an FT8 log file.

    Args:
        line: The raw string line from the log file.

    Returns:
        A dataclass instance representing the parsed message, or an Unknown
        instance if the message cannot be parsed. Returns None if the line
        is empty or doesn't contain a message payload.
    """
    if not line:
        return None

    line_match = LINE_RE.match(line.strip())
    if not line_match:
        return None

    metadata = line_match.groupdict()
    message_payload = metadata["payload"].strip()
    if not message_payload:
        return None

    base_fields = {
        "raw_line": line.strip(),
        "raw_message": message_payload,
        "timestamp": datetime.strptime(metadata["timestamp"], "%y%m%d_%H%M%S"),
        "frequency": float(metadata["frequency"]),
        "direction": metadata["direction"],
        "mode": metadata["mode"],
        "snr": int(metadata["snr"]),
        "time_offset": float(metadata["time_offset"]),
        "audio_frequency": int(metadata["audio_frequency"]),
    }

    # Iterate through patterns, from most specific to most general
    if match := PATTERNS["roger_report"].match(message_payload):
        return RogerReport(
            **base_fields,
            caller_callsign=match.group("caller"),
            called_callsign=match.group("called"),
            report=f"R{match.group('report')}",
        )
    if match := PATTERNS["rogers"].match(message_payload):
        return Rogers(
            **base_fields,
            caller_callsign=match.group("caller"),
            called_callsign=match.group("called"),
        )
    if match := PATTERNS["report"].match(message_payload):
        return Report(
            **base_fields,
            caller_callsign=match.group("caller"),
            called_callsign=match.group("called"),
            report=match.group("report"),
        )
    if match := PATTERNS["signoff"].match(message_payload):
        return Signoff(
            **base_fields,
            caller_callsign=match.group("caller"),
            called_callsign=match.group("called"),
        )
    if match := PATTERNS["cq_dx"].match(message_payload):
        return CQ(
            **base_fields,
            callsign=match.group("callsign"),
            grid=match.group("grid"),
            is_dx=True,
        )
    if match := PATTERNS["cq"].match(message_payload):
        return CQ(
            **base_fields,
            callsign=match.group("callsign"),
            grid=match.group("grid"),
        )
    if match := PATTERNS["reply"].match(message_payload):
        return Reply(
            **base_fields,
            caller_callsign=match.group("caller"),
            called_callsign=match.group("called"),
            grid=match.group("grid"),
        )

    return Unknown(**base_fields)
