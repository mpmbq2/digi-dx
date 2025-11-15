"""
Tests for the FT8 message parser.
"""
from datetime import datetime

import pytest
from src.digi_dx.message_parsing import ft8

# Sample log lines for testing
# The message payload starts at column 48
LOG_PREFIX_TX = "250105_033945    28.074 Tx FT8      0  0.0 1500 "
LOG_PREFIX_RX = "250105_034530    28.074 Rx FT8    -15  1.1 1234 "

SAMPLE_LINES = {
    "cq": f"{LOG_PREFIX_TX}CQ KF0SUI EM48",
    "cq_dx": f"{LOG_PREFIX_RX}CQ DX IZ8VYU JN71",
    "reply": f"{LOG_PREFIX_TX}ZW5B KF0SUI EM48",
    "report": f"{LOG_PREFIX_RX}W9OAA ZW5B -15",
    "roger_report": f"{LOG_PREFIX_RX}V31DL IZ2QDC R+05",
    "rogers_rrr": f"{LOG_PREFIX_TX}F1XYZ DL4ABC RRR",
    "rogers_rr73": f"{LOG_PREFIX_RX}W2UH ZW5B RR73",
    "signoff": f"{LOG_PREFIX_TX}ZW5B W2FLY 73",
    "unknown": f"{LOG_PREFIX_RX}SOME UNPARSABLE MESSAGE",
    "empty_payload": "250105_033945    28.074 Tx FT8      0  0.0 1500",
    "empty_line": "",
    "malformed": "this is not a valid log line",
}

# Expected metadata for the two prefixes
META_TX = {
    "timestamp": datetime(2025, 1, 5, 3, 39, 45),
    "frequency": 28.074,
    "direction": "Tx",
    "mode": "FT8",
    "snr": 0,
    "time_offset": 0.0,
    "audio_frequency": 1500,
}
META_RX = {
    "timestamp": datetime(2025, 1, 5, 3, 45, 30),
    "frequency": 28.074,
    "direction": "Rx",
    "mode": "FT8",
    "snr": -15,
    "time_offset": 1.1,
    "audio_frequency": 1234,
}


def assert_metadata(msg: ft8.FT8Message, expected_meta: dict, expected_raw_line: str):
    """Helper function to assert common metadata fields."""
    assert msg.timestamp == expected_meta["timestamp"]
    assert msg.frequency == expected_meta["frequency"]
    assert msg.direction == expected_meta["direction"]
    assert msg.mode == expected_meta["mode"]
    assert msg.snr == expected_meta["snr"]
    assert msg.time_offset == expected_meta["time_offset"]
    assert msg.audio_frequency == expected_meta["audio_frequency"]
    assert msg.raw_line == expected_raw_line.strip()


def test_parse_cq_message():
    """Tests parsing of a standard CQ message."""
    line_key = "cq"
    msg = ft8.parse_message(SAMPLE_LINES[line_key])
    assert isinstance(msg, ft8.CQ)
    assert_metadata(msg, META_TX, SAMPLE_LINES[line_key])
    assert msg.callsign == "KF0SUI"
    assert msg.grid == "EM48"
    assert not msg.is_dx
    assert msg.raw_message == "CQ KF0SUI EM48"


def test_parse_cq_dx_message():
    """Tests parsing of a CQ DX message."""
    line_key = "cq_dx"
    msg = ft8.parse_message(SAMPLE_LINES[line_key])
    assert isinstance(msg, ft8.CQ)
    assert_metadata(msg, META_RX, SAMPLE_LINES[line_key])
    assert msg.callsign == "IZ8VYU"
    assert msg.grid == "JN71"
    assert msg.is_dx
    assert msg.raw_message == "CQ DX IZ8VYU JN71"


def test_parse_reply_message():
    """Tests parsing of a reply message."""
    line_key = "reply"
    msg = ft8.parse_message(SAMPLE_LINES[line_key])
    assert isinstance(msg, ft8.Reply)
    assert_metadata(msg, META_TX, SAMPLE_LINES[line_key])
    assert msg.caller_callsign == "ZW5B"
    assert msg.called_callsign == "KF0SUI"
    assert msg.grid == "EM48"
    assert msg.raw_message == "ZW5B KF0SUI EM48"


def test_parse_report_message():
    """Tests parsing of a signal report message."""
    line_key = "report"
    msg = ft8.parse_message(SAMPLE_LINES[line_key])
    assert isinstance(msg, ft8.Report)
    assert_metadata(msg, META_RX, SAMPLE_LINES[line_key])
    assert msg.caller_callsign == "W9OAA"
    assert msg.called_callsign == "ZW5B"
    assert msg.report == "-15"
    assert msg.raw_message == "W9OAA ZW5B -15"


def test_parse_roger_report_message():
    """Tests parsing of a roger + report message."""
    line_key = "roger_report"
    msg = ft8.parse_message(SAMPLE_LINES[line_key])
    assert isinstance(msg, ft8.RogerReport)
    assert_metadata(msg, META_RX, SAMPLE_LINES[line_key])
    assert msg.caller_callsign == "V31DL"
    assert msg.called_callsign == "IZ2QDC"
    assert msg.report == "R+05"
    assert msg.raw_message == "V31DL IZ2QDC R+05"


def test_parse_rogers_rrr_message():
    """Tests parsing of a Rogers (RRR) message."""
    line_key = "rogers_rrr"
    msg = ft8.parse_message(SAMPLE_LINES[line_key])
    assert isinstance(msg, ft8.Rogers)
    assert_metadata(msg, META_TX, SAMPLE_LINES[line_key])
    assert msg.caller_callsign == "F1XYZ"
    assert msg.called_callsign == "DL4ABC"
    assert msg.raw_message == "F1XYZ DL4ABC RRR"


def test_parse_rogers_rr73_message():
    """Tests parsing of a Rogers (RR73) message."""
    line_key = "rogers_rr73"
    msg = ft8.parse_message(SAMPLE_LINES[line_key])
    assert isinstance(msg, ft8.Rogers)
    assert_metadata(msg, META_RX, SAMPLE_LINES[line_key])
    assert msg.caller_callsign == "W2UH"
    assert msg.called_callsign == "ZW5B"
    assert msg.raw_message == "W2UH ZW5B RR73"


def test_parse_signoff_message():
    """Tests parsing of a signoff (73) message."""
    line_key = "signoff"
    msg = ft8.parse_message(SAMPLE_LINES[line_key])
    assert isinstance(msg, ft8.Signoff)
    assert_metadata(msg, META_TX, SAMPLE_LINES[line_key])
    assert msg.caller_callsign == "ZW5B"
    assert msg.called_callsign == "W2FLY"
    assert msg.raw_message == "ZW5B W2FLY 73"


def test_parse_unknown_message():
    """Tests that an unparsable message returns an Unknown object."""
    line_key = "unknown"
    msg = ft8.parse_message(SAMPLE_LINES[line_key])
    assert isinstance(msg, ft8.Unknown)
    assert_metadata(msg, META_RX, SAMPLE_LINES[line_key])
    assert msg.raw_message == "SOME UNPARSABLE MESSAGE"


def test_parse_empty_payload():
    """Tests that a line with no message payload returns None."""
    msg = ft8.parse_message(SAMPLE_LINES["empty_payload"])
    assert msg is None


def test_parse_empty_line():
    """Tests that an empty line returns None."""
    msg = ft8.parse_message(SAMPLE_LINES["empty_line"])
    assert msg is None


def test_parse_malformed_line():
    """Tests that a malformed line returns None."""
    msg = ft8.parse_message(SAMPLE_LINES["malformed"])
    assert msg is None
