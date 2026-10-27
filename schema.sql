-- site-player's tables. A new database: run this file. One made with
-- v0.1.0: run migrations/0.2.0.sql instead.
--
-- Play counts (worker.js, POST /api/plays). One row per event, anonymous:
-- no IP, no cookie, no visitor id.
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
  region  TEXT    NOT NULL DEFAULT '',
  city    TEXT    NOT NULL DEFAULT '',
  path    TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS plays_ts ON plays (ts);

-- Page views and link clicks (hits.js → worker.js, POST /api/hit), also
-- anonymous. Where someone is comes from Cloudflare's own lookup of the
-- request (country, region, city); the IP itself is never stored.
--   kind:   view (a page was shown), click (a link off the site) or arrive
--           (a visit by a tagged link, e.g. a newsletter's; written by the
--           site itself, target naming the link; stats.js `arrivals`)
--   target: for a click, where it went (host and path, no query string)
--   ref:    for a view, the site the visitor came from (host only)
--   device: mobile, tablet or desktop, from the browser's user agent
CREATE TABLE IF NOT EXISTS hits (
  id      INTEGER PRIMARY KEY,
  ts      INTEGER NOT NULL,
  kind    TEXT    NOT NULL,
  path    TEXT    NOT NULL DEFAULT '',
  target  TEXT    NOT NULL DEFAULT '',
  ref     TEXT    NOT NULL DEFAULT '',
  country TEXT    NOT NULL DEFAULT '',
  region  TEXT    NOT NULL DEFAULT '',
  city    TEXT    NOT NULL DEFAULT '',
  device  TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS hits_ts ON hits (ts);
