/**
 * site-player stats: a private page showing the site's visits (Cloudflare Web
 * Analytics) and what's been played (the plays table, worker.js).
 *
 *   import { statsRoutes } from 'site-player/stats';
 *   const stats = statsRoutes({ title: 'The Good Behaviours' });
 *   …in fetch: const res = await stats(request, env, ctx); if (res) return res;
 *
 * Routes (add "/stats*" to run_worker_first):
 *   GET /stats/        the page
 *   GET /stats/data    its numbers, ?days=1|7|30|90
 *
 * ⚠ Who can see it: put the path behind Cloudflare Access (Zero Trust →
 * Access → Applications, self-hosted, path /stats). This code checks Access's
 * signed token as well, and refuses everything unless ACCESS_TEAM and
 * ACCESS_AUD are set, so a missing Access policy never leaves it open.
 *
 * Env:
 *   ACCESS_TEAM      the Zero Trust team name (<team>.cloudflareaccess.com)
 *   ACCESS_AUD       the Access application's audience tag
 *   PLAYS_DB         the D1 database (worker.js)
 *   CF_ACCOUNT_ID    the Cloudflare account, and
 *   RUM_SITE_TAG     the Web Analytics site, for visits
 *   STATS_API_TOKEN  secret: an API token with Account Analytics: Read.
 *                    Without it (or the two above) the page shows plays only.
 */

const DAYS = [1, 7, 30, 90];

export function statsRoutes(options = {}) {
  // timeZone: the days the charts are grouped into (daylight saving included).
  const o = { path: '/stats', title: 'Site', playsBinding: 'PLAYS_DB', timeZone: 'Australia/Sydney', albumJson: (slug) => `/assets/albums/${slug}.json`, ...options };
  return async function (request, env) {
    const url = new URL(request.url);
    if (url.pathname !== o.path && !url.pathname.startsWith(o.path + '/')) return null;
    const who = await accessUser(request, env);
    if (!who) return new Response('Not found', { status: 404, headers: { 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' } });
    if (url.pathname === o.path) return Response.redirect(new URL(o.path + '/', url), 301);
    if (url.pathname === o.path + '/') return page(o, who);
    if (url.pathname === o.path + '/data') {
      const days = DAYS.includes(Number(url.searchParams.get('days'))) ? Number(url.searchParams.get('days')) : 30;
      return data(request, env, o, days);
    }
    return new Response('Not found', { status: 404 });
  };
}

// ── Cloudflare Access ─────────────────────────────────────────────────────
// Access puts a signed token (RS256) in Cf-Access-Jwt-Assertion. Check its
// signature against the team's published keys, its audience and its expiry.
let certs = null; // { at, keys }
async function accessUser(request, env) {
  const team = env.ACCESS_TEAM, aud = env.ACCESS_AUD;
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!team || !aud || !jwt) return null;
  try {
    const [h, p, s] = jwt.split('.');
    const dec = (x) => JSON.parse(new TextDecoder().decode(b64(x)));
    const head = dec(h), claims = dec(p);
    const iss = `https://${team}.cloudflareaccess.com`;
    if (head.alg !== 'RS256' || claims.iss !== iss) return null;
    if (!(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(aud)) return null;
    if (!claims.exp || claims.exp * 1000 < Date.now()) return null;
    if (!certs || Date.now() - certs.at > 3600e3) {
      const r = await fetch(`${iss}/cdn-cgi/access/certs`);
      certs = { at: Date.now(), keys: (await r.json()).keys || [] };
    }
    const jwk = certs.keys.find((k) => k.kid === head.kid);
    if (!jwk) { certs = null; return null; }
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64(s), new TextEncoder().encode(`${h}.${p}`));
    return ok ? (claims.email || 'signed in') : null;
  } catch {
    return null;
  }
}
function b64(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// ── The numbers ───────────────────────────────────────────────────────────
async function data(request, env, o, days) {
  const since = Date.now() - days * 86400e3;
  const out = { days, plays: null, visits: null };
  const db = env[o.playsBinding];
  if (db) {
    const q = (sql, ...args) => db.prepare(sql).bind(...args).all().then((r) => r.results);
    const [tracks, byDay, countries, pages, allTime] = await Promise.all([
      q(`SELECT album, n, title,
           SUM(event = 'start') AS starts, SUM(event = 'stream') AS streams, SUM(event = 'complete') AS completes
         FROM plays WHERE ts >= ? GROUP BY album, n ORDER BY streams DESC, starts DESC`, since),
      q(`SELECT ts / 3600000 AS hour, SUM(event = 'stream') AS streams FROM plays WHERE ts >= ? GROUP BY hour`, since),
      q(`SELECT city, region, country, COUNT(*) AS streams FROM plays WHERE ts >= ? AND event = 'stream' GROUP BY city, region, country ORDER BY streams DESC LIMIT 15`, since),
      q(`SELECT path, COUNT(*) AS starts FROM plays WHERE ts >= ? AND event = 'start' GROUP BY path ORDER BY starts DESC LIMIT 10`, since),
      q(`SELECT SUM(event = 'stream') AS streams, MIN(ts) AS first FROM plays`),
    ]);
    // Album titles from the build's album files (the table stores slugs).
    const titles = {};
    await Promise.all([...new Set(tracks.map((t) => t.album))].map(async (slug) => {
      try { titles[slug] = (await (await env.ASSETS.fetch(new URL(o.albumJson(slug), request.url))).json()).title; } catch { /* keep the slug */ }
    }));
    for (const t of tracks) t.albumTitle = titles[t.album] || t.album;
    // Page views and clicks counted by the site itself (hits.js).
    const [towns, clicks, views] = await Promise.all([
      q(`SELECT city, region, country, COUNT(*) AS views FROM hits WHERE ts >= ? AND kind = 'view' GROUP BY city, region, country ORDER BY views DESC LIMIT 15`, since),
      q(`SELECT target, COUNT(*) AS clicks FROM hits WHERE ts >= ? AND kind = 'click' GROUP BY target ORDER BY clicks DESC LIMIT 15`, since),
      q(`SELECT COUNT(*) AS views FROM hits WHERE ts >= ? AND kind = 'view'`, since),
    ]).catch(() => [[], [], [{ views: 0 }]]); // a database from v0.1.0 has no hits table
    out.hits = { towns, clicks, views: views[0].views };
    out.plays = { tracks, byDay: perDay(o, days, byDay.map((x) => [x.hour * 3600e3, x.streams])), countries, pages, allTime: allTime[0] };
  }
  if (env.STATS_API_TOKEN && env.CF_ACCOUNT_ID && env.RUM_SITE_TAG) {
    out.visits = await visits(env, since).catch((e) => ({ error: String(e.message || e) }));
    if (out.visits.hours) {
      out.visits.days = perDay(o, days, out.visits.hours.map((x) => [Date.parse(x.dimensions.datetimeHour), x.sum.visits]));
      delete out.visits.hours;
    }
  }
  return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
}

// Hourly counts → one number per day of the period in o.timeZone, quiet
// days included, oldest first: [{ day: 'YYYY-MM-DD', n }].
function perDay(o, days, hourly) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: o.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const list = [], at = {};
  for (let i = days - 1; i >= 0; i--) {
    const day = fmt.format(new Date(Date.now() - i * 86400e3));
    if (!(day in at)) { at[day] = list.length; list.push({ day, n: 0 }); }
  }
  for (const [ms, n] of hourly) {
    const day = fmt.format(new Date(ms));
    if (day in at) list[at[day]].n += Number(n) || 0;
  }
  return list;
}

// Web Analytics (cookieless, Cloudflare's own beacon on every page), through
// the GraphQL Analytics API.
// ⚠ Asked in pieces of at most 7 days, added up here. A single query over
// more than 7 days is answered from a different, lagging table: on
// 2026-09-26 the last 7 days showed 46 page views and the last 8 days 10.
async function visits(env, since) {
  const until = Date.now();
  const spans = [];
  for (let a = since; a < until; a += 7 * 86400e3) spans.push([a, Math.min(until, a + 7 * 86400e3)]);
  const parts = await Promise.all(spans.map(([a, b]) => visitsSpan(env, a, b)));
  // Merge the pieces: sum every group by its dimension value.
  const merge = (name, key, sortBy, limit) => {
    const m = new Map();
    for (const p of parts) for (const x of p[name] || []) {
      const k = key(x);
      const y = m.get(k) || { count: 0, sum: { visits: 0 }, dimensions: x.dimensions };
      y.count += x.count; y.sum.visits += x.sum.visits;
      m.set(k, y);
    }
    const list = [...m.values()];
    if (sortBy) list.sort((p, q) => sortBy(q) - sortBy(p));
    return limit ? list.slice(0, limit) : list;
  };
  const byDim = (d) => (x) => x.dimensions[d];
  return {
    totals: merge('totals', () => 'all'),
    hours: merge('hours', byDim('datetimeHour')),
    pages: merge('pages', byDim('requestPath'), (x) => x.count, 12),
    refs: merge('refs', byDim('refererHost'), (x) => x.sum.visits).filter((x) => x.sum.visits > 0).slice(0, 12), // page-to-page moves inside the site count 0
    countries: merge('countries', byDim('countryName'), (x) => x.sum.visits, 10),
    devices: merge('devices', byDim('deviceType'), (x) => x.sum.visits, 5),
  };
}
async function visitsSpan(env, since, until) {
  const f = '{siteTag:$site,datetime_geq:$since,datetime_lt:$until}';
  const g = (name, limit, order, dims) => `${name}:rumPageloadEventsAdaptiveGroups(limit:${limit},filter:${f}${order ? `,orderBy:[${order}]` : ''}){count sum{visits}${dims ? ` dimensions{${dims}}` : ''}}`;
  const query = `query($acc:String!,$site:String!,$since:Time!,$until:Time!){viewer{accounts(filter:{accountTag:$acc}){
    ${g('totals', 1)} ${g('hours', 200, 'datetimeHour_ASC', 'datetimeHour')} ${g('pages', 50, 'count_DESC', 'requestPath')}
    ${g('refs', 50, 'sum_visits_DESC', 'refererHost')} ${g('countries', 50, 'sum_visits_DESC', 'countryName')}
    ${g('devices', 5, 'sum_visits_DESC', 'deviceType')}}}}`;
  const variables = { acc: env.CF_ACCOUNT_ID, site: env.RUM_SITE_TAG, since: new Date(since).toISOString(), until: new Date(until).toISOString() };
  const r = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.STATS_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors && j.errors.length) throw new Error(j.errors[0].message);
  return j.data.viewer.accounts[0];
}

// ── The page ──────────────────────────────────────────────────────────────
function page(o, who) {
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Stats · ${esc(o.title)}</title>
<style>
:root { --bg: #f6f1e7; --card: #fffdf8; --fg: #1d2a22; --dim: #6b6f68; --line: #e4dccb; --accent: #b8622e; --bar: #e39a62; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg: #111814; --card: #18221c; --fg: #f0e6d2; --dim: #9aa39b; --line: #2c3a31; --bar: #b8622e; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; padding: max(16px, env(safe-area-inset-top)) 16px 48px; }
.wrap { max-width: 980px; margin: 0 auto; }
header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px 16px; margin-bottom: 20px; }
h1 { font: 600 1.6rem/1.2 Georgia, serif; margin: 0; }
.who { color: var(--dim); font-size: 0.85rem; }
.range { display: flex; gap: 4px; margin-bottom: 20px; }
.range button { font: inherit; padding: 6px 14px; border-radius: 999px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; }
.range button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 20px; }
.kpi, .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; }
.kpi b { display: block; font: 600 1.8rem/1.1 Georgia, serif; font-variant-numeric: tabular-nums; }
.kpi span { color: var(--dim); font-size: 0.85rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
.card h2 { font-size: 0.78rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent); margin: 0 0 10px; }
.card.wide { grid-column: 1 / -1; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 6px 8px 6px 0; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { color: var(--dim); font-weight: 500; font-size: 0.8rem; }
td.num, th.num { text-align: right; }
td.name { white-space: normal; }
.row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; padding: 5px 0; border-bottom: 1px solid var(--line); position: relative; }
.row i { position: absolute; left: 0; bottom: -1px; height: 2px; background: var(--bar); }
.row span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chart { display: flex; align-items: flex-end; gap: 2px; height: 120px; border-bottom: 1px solid var(--line); }
.chart div { flex: 1; max-width: 40px; background: var(--bar); border-radius: 2px 2px 0 0; min-height: 1px; position: relative; }
.chart div:hover::after { content: attr(data-tip); position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); background: var(--fg); color: var(--bg); font-size: 0.75rem; padding: 2px 6px; border-radius: 4px; white-space: nowrap; }
.note, .empty { color: var(--dim); font-size: 0.85rem; }
</style></head><body><div class="wrap">
<header><h1>${esc(o.title)} · stats</h1><span class="who">Signed in as ${esc(who)}</span></header>
<div class="range" role="group" aria-label="Period">${DAYS.map((d) => `<button type="button" data-days="${d}" aria-pressed="${d === 30}">${d === 1 ? 'Today' : `${d} days`}</button>`).join('')}</div>
<div id="out"><p class="note">Loading…</p></div>
<p class="note">Visits, pages, sources, countries and devices come from Cloudflare Web Analytics, which people with tracker blockers don't show up in. Towns, links clicked and plays are counted by the site itself: towns come from Cloudflare's lookup of each visit, and no IP address, cookie or visitor id is kept. A stream is a track heard for 30 seconds or more; a start is any press of play.</p>
</div>
<script>
(function () {
  var out = document.getElementById('out');
  var esc = function (t) { var d = document.createElement('div'); d.textContent = t == null ? '' : String(t); return d.innerHTML; };
  var fmt = function (n) { return (Number(n) || 0).toLocaleString(); };
  var names = null;
  try { names = new Intl.DisplayNames(undefined, { type: 'region' }); } catch (e) { /* older browsers: codes */ }
  var country = function (c) { if (!c) return 'Unknown'; try { return names ? names.of(c) : c; } catch (e) { return c; } };
  // "Marrickville, New South Wales" at home; the country added abroad.
  var home = null;
  var town = function (x) {
    var parts = [x.city, x.region].filter(Boolean);
    if (x.country && x.country !== home) parts.push(country(x.country));
    return parts.join(', ') || country(x.country);
  };
  function rows(list, label, value) {
    if (!list || !list.length) return '<p class="empty">Nothing yet.</p>';
    var max = Math.max.apply(null, list.map(value)) || 1;
    return list.map(function (x) { return '<div class="row"><span>' + esc(label(x) || '(none)') + '</span><span>' + fmt(value(x)) + '</span><i style="width:' + (100 * value(x) / max).toFixed(1) + '%"></i></div>'; }).join('');
  }
  function chart(list, value, tip) {
    if (!list || !list.length) return '<p class="empty">Nothing yet.</p>';
    var max = Math.max.apply(null, list.map(value)) || 1;
    return '<div class="chart">' + list.map(function (x) { return '<div style="height:' + (100 * value(x) / max).toFixed(1) + '%" data-tip="' + esc(tip(x)) + '"></div>'; }).join('') + '</div>';
  }
  function draw(d) {
    var v = d.visits, p = d.plays, hi = d.hits, h = '';
    // The country most visits come from is "home": its name is left off towns.
    var first = (hi && hi.towns[0]) || (p && p.countries[0]);
    home = first ? first.country : null;
    var t = v && !v.error && v.totals && v.totals[0];
    var streams = p ? p.tracks.reduce(function (s, x) { return s + (x.streams || 0); }, 0) : 0;
    var starts = p ? p.tracks.reduce(function (s, x) { return s + (x.starts || 0); }, 0) : 0;
    h += '<div class="kpis">';
    if (v && !v.error) h += '<div class="kpi"><b>' + fmt(t ? t.sum.visits : 0) + '</b><span>visits</span></div><div class="kpi"><b>' + fmt(t ? t.count : 0) + '</b><span>page views</span></div>';
    if (p) h += '<div class="kpi"><b>' + fmt(streams) + '</b><span>streams</span></div><div class="kpi"><b>' + fmt(starts) + '</b><span>plays started</span></div>' +
      '<div class="kpi"><b>' + fmt(p.allTime && p.allTime.streams) + '</b><span>streams, all time</span></div>';
    h += '</div>';
    if (v && v.error) h += '<p class="note">Visits could not be loaded: ' + esc(v.error) + '</p>';
    if (!v) h += '<p class="note">Visits aren\\'t connected yet (STATS_API_TOKEN, CF_ACCOUNT_ID, RUM_SITE_TAG).</p>';
    h += '<div class="grid">';
    if (p) {
      h += '<div class="card wide"><h2>Tracks</h2><div class="scroll"><table><thead><tr><th>Track</th><th>Album</th><th class="num">Streams</th><th class="num">Starts</th><th class="num">Played to the end</th></tr></thead><tbody>' +
        (p.tracks.length ? p.tracks.map(function (x) { return '<tr><td class="name">' + esc(x.title) + '</td><td>' + esc(x.albumTitle || x.album) + '</td><td class="num">' + fmt(x.streams) + '</td><td class="num">' + fmt(x.starts) + '</td><td class="num">' + fmt(x.completes) + '</td></tr>'; }).join('') : '<tr><td colspan="5" class="empty">Nothing played yet.</td></tr>') +
        '</tbody></table></div></div>';
      h += '<div class="card"><h2>Streams by day</h2>' + chart(p.byDay, function (x) { return x.n; }, function (x) { return x.day + ': ' + x.n; }) + '</div>';
    }
    if (v && !v.error) {
      h += '<div class="card"><h2>Visits by day</h2>' + chart(v.days, function (x) { return x.n; }, function (x) { return x.day + ': ' + x.n; }) + '</div>';
      h += '<div class="card"><h2>Pages</h2>' + rows(v.pages, function (x) { return x.dimensions.requestPath; }, function (x) { return x.count; }) + '</div>';
      h += '<div class="card"><h2>Where visitors came from</h2>' + rows(v.refs, function (x) { return x.dimensions.refererHost || 'Direct or unknown'; }, function (x) { return x.sum.visits; }) + '</div>';
      h += '<div class="card"><h2>Visitors\\' countries</h2>' + rows(v.countries, function (x) { return country(x.dimensions.countryName); }, function (x) { return x.sum.visits; }) + '</div>';
      h += '<div class="card"><h2>Devices</h2>' + rows(v.devices, function (x) { return x.dimensions.deviceType; }, function (x) { return x.sum.visits; }) + '</div>';
    }
    if (hi) {
      h += '<div class="card"><h2>Where visitors are</h2>' + rows(hi.towns, town, function (x) { return x.views; }) + '</div>';
      h += '<div class="card"><h2>Links clicked</h2>' + rows(hi.clicks, function (x) { return x.target === 'mailto' ? 'Email links' : x.target === 'tel' ? 'Phone links' : x.target.replace(/\\/$/, ''); }, function (x) { return x.clicks; }) + '</div>';
    }
    if (p) {
      h += '<div class="card"><h2>Where listeners are</h2>' + rows(p.countries, town, function (x) { return x.streams; }) + '</div>';
      h += '<div class="card"><h2>Pages where play was pressed</h2>' + rows(p.pages, function (x) { return x.path; }, function (x) { return x.starts; }) + '</div>';
    }
    out.innerHTML = h + '</div>';
  }
  var asked = 0; // only the latest request draws (a slow 90 days mustn't overwrite a quick 7)
  function load(days) {
    var mine = ++asked;
    document.querySelectorAll('[data-days]').forEach(function (b) { b.setAttribute('aria-pressed', String(Number(b.dataset.days) === days)); });
    fetch('data?days=' + days, { credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (d) { if (mine === asked) draw(d); }, function (e) { if (mine !== asked) return; out.innerHTML = '<p class="note">Could not load the numbers (' + esc(e.message) + ').</p>'; });
  }
  document.addEventListener('click', function (e) { var b = e.target.closest('[data-days]'); if (b) load(Number(b.dataset.days)); });
  load(30);
})();
</script></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' } });
}
