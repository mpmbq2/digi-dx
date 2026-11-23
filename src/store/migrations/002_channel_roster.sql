-- Digi-Dx v2 Channel Roster Schema
-- Stores deduplicated FT8 station activity per channel with a 5-minute sliding window.

CREATE TABLE IF NOT EXISTS channel_roster (
    is_demo             INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
    channel_key         TEXT NOT NULL,
    callsign            TEXT NOT NULL,
    mode                TEXT NOT NULL DEFAULT 'FT8',
    dial_freq_hz        INTEGER,
    band                TEXT,
    grid                TEXT,
    last_snr_db         INTEGER NOT NULL,
    last_dt_sec         REAL NOT NULL,
    last_af_hz          INTEGER NOT NULL,
    last_slot           TEXT NOT NULL CHECK (last_slot IN ('even', 'odd')),
    last_message        TEXT NOT NULL,
    is_cq               INTEGER NOT NULL DEFAULT 0 CHECK (is_cq IN (0, 1)),
    directed_cq         TEXT,
    calling_me          INTEGER NOT NULL DEFAULT 0 CHECK (calling_me IN (0, 1)),
    first_seen_ts_sec   INTEGER NOT NULL,
    last_seen_ts_sec    INTEGER NOT NULL,
    last_seen_wall_ms   INTEGER NOT NULL,
    decode_count        INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (is_demo, channel_key, callsign)
);

CREATE INDEX IF NOT EXISTS idx_channel_roster_lookup
    ON channel_roster(is_demo, channel_key, last_seen_wall_ms DESC);
