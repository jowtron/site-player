-- Play counts for site-player (worker.js, POST /api/plays). One row per
-- event, anonymous: no IP, no cookie, no visitor id.
--   event: start (it began playing), stream (30 seconds heard, the way
--          streaming services count a play), complete (played to the end)
--   ts:    milliseconds since 1970 (UTC)
CREATE TABLE IF NOT EXISTS plays (
  id      INTEGER PRIMARY KEY,
  ts      INTEGER NOT NULL,
  event   TEXT    NOT NULL,
  album   TEXT    NOT NULL,
  n       INTEGER NOT NULL,
  title   TEXT    NOT NULL,
  country TEXT    NOT NULL DEFAULT '',
  path    TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS plays_ts ON plays (ts);
