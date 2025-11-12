"""
Tests for the FT8 message parser.
"""
import pytest
from src.digi_dx.message_parsing import ft8

# Sample log lines for testing
# The message payload starts at column 48
LOG_PREFIX = "250105_033945    28.074 Tx FT8      0  0.0 1500 "

SAMPLE_LINES = {
    "cq": f"{LOG_PREFIX}CQ KF0SUI EM48",
    "cq_dx": f"{LOG_PREFIX}CQ DX IZ8VYU JN71",
    "reply": f"{LOG_PREFIX}ZW5B KF0SUI EM48",
    "report": f"{LOG_PREFIX}W9OAA ZW5B -15",
    "roger_report": f"{LOG_PREFIX}V31DL IZ2QDC R+05",
    "rogers_rrr": f"{LOG_PREFIX}F1XYZ DL4ABC RRR",
    "rogers_rr73": f"{LOG_PREFIX}W2UH ZW5B RR73",
    "signoff": f"{LOG_PREFIX}ZW5B W2FLY 73",
    "unknown": f"{LOG_PREFIX}SOME UNPARSABLE MESSAGE",
    "empty_payload": "250105_033945    28.074 Tx FT8      0  0.0 1500",
    "empty_line": "",
}


def test_parse_cq_message():
    """Tests parsing of a standard CQ message."""
    msg = ft8.parse_message(SAMPLE_LINES["cq"])
    assert isinstance(msg, ft8.CQ)
    assert msg.callsign == "KF0SUI"
    assert msg.grid == "EM48"
    assert not msg.is_dx
    assert msg.raw_message == "CQ KF0SUI EM48"


def test_parse_cq_dx_message():
    """Tests parsing of a CQ DX message."""
    msg = ft8.parse_message(SAMPLE_LINES["cq_dx"])
    assert isinstance(msg, ft8.CQ)
    assert msg.callsign == "IZ8VYU"
    assert msg.grid == "JN71"
    assert msg.is_dx
    assert msg.raw_message == "CQ DX IZ8VYU JN71"


def test_parse_reply_message():
    """Tests parsing of a reply message."""
    msg = ft8.parse_message(SAMPLE_LINES["reply"])
    assert isinstance(msg, ft8.Reply)
    assert msg.caller_callsign == "ZW5B"
    assert msg.called_callsign == "KF0SUI"
    assert msg.grid == "EM48"
    assert msg.raw_message == "ZW5B KF0SUI EM48"


def test_parse_report_message():
    """Tests parsing of a signal report message."""
    msg = ft8.parse_message(SAMPLE_LINES["report"])
    assert isinstance(msg, ft8.Report)
    assert msg.caller_callsign == "W9OAA"
    assert msg.called_callsign == "ZW5B"
    assert msg.report == "-15"
    assert msg.raw_message == "W9OAA ZW5B -15"


def test_parse_roger_report_message():
    """Tests parsing of a roger + report message."""
    msg = ft8.parse_message(SAMPLE_LINES["roger_report"])
    assert isinstance(msg, ft8.RogerReport)
    assert msg.caller_callsign == "V31DL"
    assert msg.called_callsign == "IZ2QDC"
    assert msg.report == "R+05"
    assert msg.raw_message == "V31DL IZ2QDC R+05"


def test_parse_rogers_rrr_message():
    """Tests parsing of a Rogers (RRR) message."""
    msg = ft8.parse_message(SAMPLE_LINES["rogers_rrr"])
    assert isinstance(msg, ft8.Rogers)
    assert msg.caller_callsign == "F1XYZ"
    assert msg.called_callsign == "DL4ABC"
    assert msg.raw_message == "F1XYZ DL4ABC RRR"


def test_parse_rogers_rr73_message():
    """Tests parsing of a Rogers (RR73) message."""
    msg = ft8.parse_message(SAMPLE_LINES["rogers_rr73"])
    assert isinstance(msg, ft8.Rogers)
    assert msg.caller_callsign == "W2UH"
    assert msg.called_callsign == "ZW5B"
    assert msg.raw_message == "W2UH ZW5B RR73"


def test_parse_signoff_message():
    """Tests parsing of a signoff (73) message."""
    msg = ft8.parse_message(SAMPLE_LINES["signoff"])
    assert isinstance(msg, ft8.Signoff)
    assert msg.caller_callsign == "ZW5B"
    assert msg.called_callsign == "W2FLY"
    assert msg.raw_message == "ZW5B W2FLY 73"


def test_parse_unknown_message():
    """Tests that an unparsable message returns an Unknown object."""
    msg = ft8.parse_message(SAMPLE_LINES["unknown"])
    assert isinstance(msg, ft8.Unknown)
    assert msg.raw_message == "SOME UNPARSABLE MESSAGE"


def test_parse_empty_payload():
    """Tests that a line with no message payload returns None."""
    msg = ft8.parse_message(SAMPLE_LINES["empty_payload"])
    assert msg is None


def test_parse_empty_line():
    """Tests that an empty line returns None."""
    msg = ft8.parse_message(SAMPLE_LINES["empty_line"])
    assert msg is None
