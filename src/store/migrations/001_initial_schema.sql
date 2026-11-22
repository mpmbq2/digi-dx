-- Digi-Dx v2 Initial SQLite Schema
-- Applied transactionally on StateStore::open().

CREATE TABLE IF NOT EXISTS schema_migrations (
    version         INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    applied_at_utc  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS station_config (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    station_id      TEXT NOT NULL UNIQUE,
    callsign        TEXT,
    grid            TEXT,
    updated_at_utc  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usb_devices (
    device_key          TEXT PRIMARY KEY,
    os_path             TEXT NOT NULL,
    real_tty_path       TEXT,
    usb_vid             TEXT,
    usb_pid             TEXT,
    usb_serial          TEXT,
    usb_interface       TEXT,
    usb_topology_path   TEXT,
    manufacturer        TEXT,
    product             TEXT,
    is_connected        INTEGER NOT NULL DEFAULT 0 CHECK (is_connected IN (0, 1)),
    first_seen_utc      TEXT NOT NULL,
    last_seen_utc       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS radio_profiles (
    radio_id            TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    hamlib_model        INTEGER NOT NULL,
    is_dummy            INTEGER NOT NULL DEFAULT 0 CHECK (is_dummy IN (0, 1)),
    serial_device_key   TEXT REFERENCES usb_devices(device_key) ON DELETE SET NULL,
    serial_baud_rate    INTEGER NOT NULL DEFAULT 9600,
    civ_address         TEXT,
    ptt_method          TEXT NOT NULL DEFAULT 'cat' CHECK (ptt_method IN ('cat', 'cat_data', 'rts', 'dtr', 'vox')),
    rig_options_json    TEXT NOT NULL DEFAULT '{}',
    audio_device_uid    TEXT,
    audio_device_name   TEXT,
    audio_rx_channel    TEXT NOT NULL DEFAULT 'mono' CHECK (audio_rx_channel IN ('mono', 'left', 'right')),
    audio_tx_gain_db    REAL NOT NULL DEFAULT -6.0,
    rigctld_port        INTEGER NOT NULL UNIQUE CHECK (rigctld_port BETWEEN 4532 AND 4599),
    auto_connect        INTEGER NOT NULL DEFAULT 1 CHECK (auto_connect IN (0, 1)),
    last_dial_freq_hz   INTEGER,
    created_at_utc      TEXT NOT NULL,
    updated_at_utc      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS qso_log (
    qso_id              TEXT PRIMARY KEY,
    radio_id            TEXT REFERENCES radio_profiles(radio_id) ON DELETE SET NULL,
    started_at_utc      TEXT NOT NULL,
    completed_at_utc    TEXT NOT NULL,
    my_call             TEXT NOT NULL,
    my_grid             TEXT NOT NULL,
    their_call          TEXT NOT NULL,
    their_grid          TEXT,
    mode                TEXT NOT NULL DEFAULT 'FT8',
    dial_freq_hz        INTEGER,
    band                TEXT,
    af_hz               INTEGER,
    rst_sent            TEXT,
    rst_rcvd            TEXT,
    completion_reason   TEXT NOT NULL,
    transcript_json     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qso_log_completed_at ON qso_log(completed_at_utc DESC);
CREATE INDEX IF NOT EXISTS idx_qso_log_their_call_band ON qso_log(their_call, band);

CREATE TABLE IF NOT EXISTS demo_qso_log (
    qso_id              TEXT PRIMARY KEY,
    started_at_utc      TEXT NOT NULL,
    completed_at_utc    TEXT NOT NULL,
    my_call             TEXT NOT NULL,
    my_grid             TEXT NOT NULL,
    their_call          TEXT NOT NULL,
    their_grid          TEXT,
    mode                TEXT NOT NULL DEFAULT 'FT8',
    dial_freq_hz        INTEGER,
    band                TEXT,
    rst_sent            TEXT,
    rst_rcvd            TEXT,
    completion_reason   TEXT NOT NULL,
    transcript_json     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telemetry_outbox (
    event_id            TEXT PRIMARY KEY,
    schema_version      INTEGER NOT NULL DEFAULT 1,
    station_id          TEXT NOT NULL,
    radio_id            TEXT,
    event_type          TEXT NOT NULL,
    is_demo             INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
    occurred_at_utc     TEXT NOT NULL,
    payload_json        TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'dead_letter')),
    attempts            INTEGER NOT NULL DEFAULT 0,
    next_attempt_at_utc TEXT NOT NULL,
    leased_until_utc    TEXT,
    last_error          TEXT,
    created_at_utc      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON telemetry_outbox(status, next_attempt_at_utc);
CREATE INDEX IF NOT EXISTS idx_outbox_created ON telemetry_outbox(created_at_utc);

CREATE TABLE IF NOT EXISTS command_audit (
    command_id          TEXT PRIMARY KEY,
    idempotency_key     TEXT UNIQUE,
    origin              TEXT NOT NULL CHECK (origin IN ('local_ui', 'cli', 'gcp_bridge')),
    actor               TEXT NOT NULL,
    radio_id            TEXT,
    command_kind        TEXT NOT NULL,
    status              TEXT NOT NULL CHECK (status IN ('ok', 'rejected', 'failed')),
    error_code          TEXT,
    response_json       TEXT NOT NULL,
    created_at_utc      TEXT NOT NULL,
    completed_at_utc    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_command_audit_created ON command_audit(created_at_utc DESC);
