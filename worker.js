/**
 * site-player, the Worker side: album data with signed audio links, the audio
 * itself from a private R2 bucket, and anonymous play counts in D1.
 *
 *   import { playerRoutes } from 'site-player/worker';
 *   const player = playerRoutes({ albums: ['home', 'itll-be-alright'] });
 *   export default {
 *     async fetch(request, env, ctx) {
 *       const res = await player(request, env, ctx);
 *       if (res) return res;
 *       …the site's own routes…
 *     },
 *   };
 *
 * Routes (wrangler.jsonc needs "run_worker_first": ["/api/*", "/audio/*"]):
 *
 *   GET  /api/album/<slug>   the album's tracks, each with a fresh signed
 *                            link: src (WebM Opus) and srcAlt (AAC). Read from
 *                            the build's /assets/albums/<slug>.json (build.mjs).
 *   GET  /audio/<slug>/NN.webm|m4a?e=…&s=…
 *                            the file from R2, with range requests so the
 *                            player can seek.
 *   POST /api/plays          {e, album, n} from player.js → a row in D1.
 *
 * Bindings and secrets (names can be changed in the options):
 *   AUDIO      R2 bucket, files at <slug>/NN.webm and <slug>/NN.m4a
 *   AUDIO_KEY  secret that signs the links (any long random string)
 *   PLAYS_DB   D1 database with schema.sql applied (optional: without it
 *              plays aren't counted)
 *
 * Casual copying of the audio is made useless, not impossible (a browser
 * has to receive the audio to play it):
 *   - a link is signed and expires after linkLife, so a copied link soon
 *     stops working and an edited one never works;
 *   - a link opened as a page (pasted into the address bar) is refused:
 *     browsers mark those Sec-Fetch-Dest: document, the player's requests
 *     audio (or nothing, from iOS's media stack, so absence is allowed);
 *   - the bucket itself is private.
 */

const NOINDEX = 'noindex, nofollow, noarchive, nosnippet, noimageindex';
const EVENTS = new Set(['start', 'stream', 'complete']);

export function playerRoutes(options = {}) {
  const o = {
    albums: [],
    albumPath: '/api/album/',
    audioPath: '/audio/',
    playsPath: '/api/plays',
    albumJson: (slug) => `/assets/albums/${slug}.json`,
    audioBinding: 'AUDIO',
    keyName: 'AUDIO_KEY',
    playsBinding: 'PLAYS_DB',
    linkLife: 6 * 3600,
    ...options,
  };
  const albums = new Set(o.albums);
  const baked = new Map(); // slug → the build's album JSON, per isolate

  async function readAlbum(slug, url, env) {
    if (!baked.has(slug)) {
      const res = await env.ASSETS.fetch(new URL(o.albumJson(slug), url));
      if (!res.ok) return null;
      baked.set(slug, await res.text());
    }
    return JSON.parse(baked.get(slug));
  }

  return async function (request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith(o.albumPath)) return album(url, env);
    if (url.pathname.startsWith(o.audioPath)) return audio(request, url, env);
    if (url.pathname === o.playsPath) return plays(request, url, env);
    return null;
  };

  async function album(url, env) {
    const slug = url.pathname.slice(o.albumPath.length).split('/')[0];
    if (!albums.has(slug)) return json({ ok: false, message: 'Unknown album' }, 404);
    const data = await readAlbum(slug, url, env);
    if (!data || !data.local) return json({ ok: false, message: 'This album has no audio yet' }, 404);
    const exp = Math.floor(Date.now() / 1000) + o.linkLife;
    for (const t of data.tracks) {
      t.src = `${o.audioPath}${t.file}?e=${exp}&s=${await sign(env[o.keyName], `${t.file}:${exp}`)}`;
      if (t.alt) t.srcAlt = `${o.audioPath}${t.alt}?e=${exp}&s=${await sign(env[o.keyName], `${t.alt}:${exp}`)}`;
    }
    return json(data);
  }

  async function audio(request, url, env) {
    const deny = (why) => new Response(why, { status: 403, headers: { 'X-Robots-Tag': NOINDEX, 'Cache-Control': 'no-store' } });
    const bucket = env[o.audioBinding];
    if (!bucket || !env[o.keyName]) return deny('Not available');
    if (request.method !== 'GET' && request.method !== 'HEAD') return deny('Not allowed');
    if (request.headers.get('Sec-Fetch-Dest') === 'document') return deny('This audio plays on the site.');
    const file = url.pathname.slice(o.audioPath.length);
    const exp = Number(url.searchParams.get('e') || 0);
    if (!/^[a-z0-9-]+\/\d{2}\.(webm|m4a)$/.test(file) || exp < Date.now() / 1000) return deny('This link has expired.');
    if (url.searchParams.get('s') !== (await sign(env[o.keyName], `${file}:${exp}`))) return deny('Not allowed');

    const obj = await bucket.get(file, { range: request.headers });
    if (!obj) return new Response('Not found', { status: 404, headers: { 'X-Robots-Tag': NOINDEX } });
    const headers = new Headers({
      'Content-Type': file.endsWith('.m4a') ? 'audio/mp4' : 'audio/webm',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
      'Content-Disposition': 'inline',
      'X-Robots-Tag': NOINDEX,
      ETag: obj.httpEtag,
    });
    let status = 200;
    if (obj.range && request.headers.has('Range')) {
      const start = obj.range.offset ?? 0;
      const length = obj.range.length ?? obj.size - start;
      headers.set('Content-Range', `bytes ${start}-${start + length - 1}/${obj.size}`);
      headers.set('Content-Length', String(length));
      status = 206;
    } else {
      headers.set('Content-Length', String(obj.size));
    }
    return new Response(request.method === 'HEAD' ? null : obj.body, { status, headers });
  }

  // Anonymous: no IP, no cookie, no visitor id. The country comes from
  // Cloudflare, the page from the Referer (path only).
  async function plays(request, url, env) {
    if (request.method !== 'POST') return json({ ok: false, message: 'Method not allowed' }, 405, { Allow: 'POST' });
    // Only from the site's own pages (browsers send Origin on every POST).
    const origin = request.headers.get('Origin');
    if (!origin || new URL(origin).host !== url.host) return new Response(null, { status: 403 });
    const db = env[o.playsBinding];
    if (!db) return new Response(null, { status: 204 });
    let d;
    try {
      const text = await request.text();
      if (text.length > 300) throw new Error('too long');
      d = JSON.parse(text);
    } catch {
      return new Response(null, { status: 400 });
    }
    const n = Number(d.n);
    if (!EVENTS.has(d.e) || !albums.has(d.album) || !Number.isInteger(n) || n < 1 || n > 99) return new Response(null, { status: 400 });
    const data = await readAlbum(d.album, url, env);
    const track = data && data.tracks.find((t) => Number(t.n) === n);
    if (!track) return new Response(null, { status: 400 });
    let path = '';
    try { path = new URL(request.headers.get('Referer') || '').pathname.slice(0, 200); } catch { /* none */ }
    await db.prepare('INSERT INTO plays (ts, event, album, n, title, country, path) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(Date.now(), d.e, d.album, n, String(track.title).slice(0, 200), (request.cf && request.cf.country) || '', path)
      .run();
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  }
}

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function sign(secret, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret || ''), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': NOINDEX, ...headers },
  });
}
