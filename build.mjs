// site-player, build-time helpers (Node 20+, no dependencies).
//
//   import { copyAssets, writeAlbums } from 'site-player/build';
//   copyAssets((rel, data) => write(`assets/${rel}`, data));      // player.js, player.css
//   await writeAlbums({ bandcamp: 'thegoodbehaviours', slugs: ['home'],
//                       audioDir: 'research/audio', write });
//
// writeAlbums reads each album's track list (titles, numbers, durations)
// from its Bandcamp page and writes assets/albums/<slug>.json, which
// worker.js reads. Only the list comes from Bandcamp, never its stream links:
// playing those outside Bandcamp's own player breaks their terms. The audio
// is the site's own, in R2 as <slug>/NN.webm and <slug>/NN.m4a; an album
// whose folder isn't in audioDir is written with local: false and has no
// audio.
//
// ⚠ Bandcamp's host answers Cloudflare's servers with a bot challenge, so
// this runs at build time (from a home connection), not in the Worker.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENT = { '&quot;': '"', '&amp;': '&', '&#39;': "'", '&lt;': '<', '&gt;': '>' };

export function copyAssets(write) {
  for (const f of ['player.js', 'player.css']) write(f, fs.readFileSync(path.join(HERE, f)));
}

export async function writeAlbums({ bandcamp, slugs, audioDir, write, out = (slug) => `assets/albums/${slug}.json` }) {
  const done = {};
  for (const slug of slugs) {
    try {
      const res = await fetch(`https://${bandcamp}.bandcamp.com/album/${slug}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' } });
      const m = /data-tralbum="([^"]+)"/.exec(await res.text());
      if (!m) throw new Error('no track list on the page');
      const data = JSON.parse(m[1].replace(/&(quot|amp|#39|lt|gt);/g, (e) => ENT[e]));
      const local = !!audioDir && fs.existsSync(path.join(audioDir, slug));
      const tracks = data.trackinfo.map((t) => {
        const n = String(t.track_num).padStart(2, '0');
        return { n: t.track_num, title: t.title, duration: t.duration, ...(local ? { file: `${slug}/${n}.webm`, alt: `${slug}/${n}.m4a` } : {}) };
      });
      write(out(slug), JSON.stringify({ ok: true, title: data.current.title, local, tracks, fetched: new Date().toISOString() }));
      done[slug] = tracks.length;
    } catch (err) {
      console.warn(`Album ${slug}: could not read it from Bandcamp (${err.message}); the player will be silent for it.`);
    }
  }
  return done;
}
