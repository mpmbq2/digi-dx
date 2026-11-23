-- QRZ Logbook sync configuration and per-QSO sync tracking (real qso_log only).
ALTER TABLE station_config ADD COLUMN qrz_api_key TEXT;
ALTER TABLE station_config ADD COLUMN qrz_last_push_at_utc TEXT;
ALTER TABLE station_config ADD COLUMN qrz_last_push_summary_json TEXT;

ALTER TABLE qso_log
    ADD COLUMN qrz_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (qrz_status IN ('pending', 'synced', 'failed'));
ALTER TABLE qso_log ADD COLUMN qrz_logid TEXT;
ALTER TABLE qso_log ADD COLUMN qrz_pushed_at_utc TEXT;
ALTER TABLE qso_log ADD COLUMN qrz_error TEXT;

CREATE INDEX IF NOT EXISTS idx_qso_log_qrz_status
    ON qso_log(qrz_status, completed_at_utc ASC);
