-- v0.1.0 → v0.2.0: where plays happen (region, city) and the hits table.
--   wrangler d1 execute <db> --remote --file node_modules/site-player/migrations/0.2.0.sql
ALTER TABLE plays ADD COLUMN region TEXT NOT NULL DEFAULT '';
ALTER TABLE plays ADD COLUMN city TEXT NOT NULL DEFAULT '';

-- Page views and link clicks (hits.js → worker.js, POST /api/hit), also
-- anonymous. Where someone is comes from Cloudflare's own lookup of the
-- request (country, region, city); the IP itself is never stored.
--   kind:   view (a page was shown) or click (a link off the site)
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
