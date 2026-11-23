-- Add inferred Caller/Hunter station_role to channel_roster.
ALTER TABLE channel_roster
    ADD COLUMN station_role TEXT CHECK (station_role IS NULL OR station_role IN ('caller', 'hunter'));
