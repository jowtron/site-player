# site-player

The audio player from [The Good Behaviours' website](https://www.thegoodbehaviours.com.au), made reusable for other band and artist sites on Cloudflare Workers.

- **A player that keeps playing from page to page.** It's pinned to the bottom of the screen, opens up to full screen with the album's tracks, tucks away into a button in the header, and puts the track and controls on the phone's lock screen.
- **The site's own audio, kept private.** Files live in a private R2 bucket and play through signed links that expire after six hours. A link pasted into the address bar is refused.
- **Play counts** in D1, anonymous: every start, every "stream" (30 seconds heard, the way streaming services count a play) and every track played to the end, with the listener's town.
- **Page views and link clicks** (`hits.js`): which towns visitors are in and which links off the site they click (Bandcamp, YouTube, email…). The town comes from Cloudflare's own lookup of each request; no IP address, cookie or visitor id is stored.
- **A private stats page** at `/stats/`: visits from Cloudflare Web Analytics, plus towns, clicks and which tracks get played, behind Cloudflare Access.

No framework and no runtime dependencies. The browser side is one script and one stylesheet; the Worker side is two ES modules.

## Files

| File | What |
|---|---|
| `player.js` | The player, in the browser: `SitePlayer.init({...})` |
| `player.css` | Its styles, themed with `--sp-*` custom properties (list at the top of the file) |
| `hits.js` | Page views and clicks on links off the site → `POST /api/hit`. Works with or without the player |
| `worker.js` | `playerRoutes()`: `/api/album/<slug>`, `/audio/…`, `/api/plays` and `/api/hit` |
| `stats.js` | `statsRoutes()`: the `/stats/` page and its numbers |
| `schema.sql` | The D1 tables, `plays` and `hits` (`migrations/` for a database made by an earlier version) |
| `build.mjs` | `copyAssets()` and `writeAlbums()` (track lists from Bandcamp) for a site's build |
| `tools/encode.sh` | Masters → `NN.webm` (Opus) and `NN.m4a` (AAC) |
| `tools/upload.sh` | An album's files → the R2 bucket |

## Adding it to a site

```sh
npm install github:jowtron/site-player#v0.2.2
```

**1. Build.** Copy the player's files into the site and write each album's track list:

```js
import { copyAssets, writeAlbums } from 'site-player/build';
copyAssets((rel, data) => write(`assets/${rel}`, data));
await writeAlbums({ bandcamp: 'thegoodbehaviours', slugs: ['home'], audioDir: 'research/audio', write });
```

**2. Pages.** Load `player.css` before the site's own stylesheet, so the site's `--sp-*` values win. Load `player.js` before the site's script, and `hits.js` on every page. Put an empty `<span class="mp-slot"></span>` in the header for the tucked-away button. Then play buttons:

```html
<button data-play-album="home" data-art="/img/home-600.webp" data-url="/music/#home"
        class="btn-play"><svg>…</svg><span class="bp-label">Play</span></button>
<ol class="tracks">
  <li><button class="track-play" data-play-album="home" data-index="0" data-art="…" data-url="…">
    <span class="tp-icon"><svg>…</svg><span class="tp-eq"><i></i><i></i><i></i></span></span>
    <span class="tp-name">Cloudy in the Gully</span></button><span class="dur">3:43</span></li>
</ol>
```

**3. Start it** from the site's script:

```js
SitePlayer.init({
  artist: 'The Good Behaviours',
  beforeSwap: function () { /* remove this page's listeners */ },
  afterSwap: function (doc) { /* set the new page up */ },
});
```

Once a player is open, links swap pages in without a reload so the music carries on. Everything in `<body>` is replaced except elements with `data-persist`, so the site's own page set-up has to be able to run again (`afterSwap`) and clean up after itself (`beforeSwap`).

**4. Worker.**

```js
import { playerRoutes } from 'site-player/worker';
import { statsRoutes } from 'site-player/stats';
const player = playerRoutes({ albums: ['home'] });
const stats = statsRoutes({ title: 'The Good Behaviours', sources: { 'cf-email.example': 'Back from newsletter signup' } });
export default {
  async fetch(request, env, ctx) {
    return (await player(request, env, ctx)) || (await stats(request, env)) || siteRoutes(request, env, ctx);
  },
};
```

**5. Cloudflare**, in the site's `wrangler.jsonc`:

```jsonc
"assets": { "directory": "./public", "binding": "ASSETS", "run_worker_first": ["/api/*", "/audio/*", "/stats*"] },
"r2_buckets": [{ "binding": "AUDIO", "bucket_name": "<site>-audio" }],
"d1_databases": [{ "binding": "PLAYS_DB", "database_name": "<site>-plays", "database_id": "…" }],
"vars": { "CF_ACCOUNT_ID": "…", "RUM_SITE_TAG": "…", "ACCESS_TEAM": "…", "ACCESS_AUD": "…" }
```

- `wrangler r2 bucket create <site>-audio`, then `tools/encode.sh` and `tools/upload.sh` for each album.
- `wrangler secret put AUDIO_KEY`: any long random string (`openssl rand -base64 32`). It signs the audio links.
- `wrangler d1 create <site>-plays`, then `wrangler d1 execute <site>-plays --remote --file node_modules/site-player/schema.sql`.

## The stats page

- **Visits** come from Cloudflare Web Analytics. On a domain whose DNS is on Cloudflare it's usually already on: Cloudflare adds its beacon to every page by itself (check for `cloudflareinsights` in a page's source). The site tag is in the dashboard (Analytics & Logs → Web Analytics) or from `GET /accounts/<id>/rum/site_info/list`. The page reads the numbers through the GraphQL API, so it needs a secret `STATS_API_TOKEN`: an API token with **Account → Account Analytics → Read** for that account. Without it the page shows plays only.
- **Plays, towns and clicks** come straight from D1; nothing to set up beyond the binding. Web Analytics only knows countries, and misses people with tracker blockers; `hits.js` is first-party, so blockers rarely stop it, and its counts run a little higher.
- **Privacy.** Nothing that identifies a person is kept: no IP, cookie or id, just the town, the page, the time and the kind of device. It's still worth a line in the site's privacy notice if it has one.
- **Who can see it:** Cloudflare Access (Zero Trust, free for up to 50 people).
  1. Enable Zero Trust once for the account and pick a team name.
  2. Access → Applications → Add → Self-hosted: domain `www.<site>`, path `stats`. Policy: Allow, emails of the people who should see it. Sign-in by emailed code (One-time PIN) needs nothing else.
  3. Put the team name in `ACCESS_TEAM` and the application's Audience (AUD) tag in `ACCESS_AUD`.

  `stats.js` checks Access's signed token itself and answers 404 unless both are set, so a missing or mis-set Access policy never leaves the page open.

## Gotchas

- **Two chevrons.** `.mp-btn` sets `display: grid`, so the rule hiding the collapse chevron in the small player must beat it: it's scoped to `.mini-player` and comes after `.mp-btn`.
- **iOS starts sound only inside the tap.** Albums on the page are fetched ahead of time (`prefetch`), so a tap can start the audio straight away.
- **Web Analytics over more than 7 days.** A single GraphQL query over more than 7 days is answered from a lagging table and undercounts badly, so `stats.js` asks in 7-day pieces and adds them up.
- **Bandcamp.** Only track lists come from Bandcamp, at build time (its host challenges Cloudflare's servers). Never its stream links: playing them outside Bandcamp's own player breaks their terms.
- **wrangler and accounts.** A folder's `wrangler.jsonc` `account_id` beats `CLOUDFLARE_ACCOUNT_ID`, with no warning. Run `tools/upload.sh` and any `wrangler` command from the site's own folder, and never aim wrangler at another account from there.

## Versions

- **v0.2.2** (2026-09-26): "Where visitors came from" leaves out the site's own addresses (a visit "from" the bare domain was someone crossing to www through the redirect), and `sources` names referring hosts, e.g. a newsletter service's confirmation page.
- **v0.2.1** (2026-09-26): visits leave out the stats page's own views, and Access's sign-in page isn't listed as a source.
- **v0.2.0** (2026-09-26): towns on plays; `hits.js` and `/api/hit` (page views and outbound clicks, with towns); stats cards for them. Existing databases: `wrangler d1 execute <db> --remote --file node_modules/site-player/migrations/0.2.0.sql`.
- **v0.1.0** (2026-09-26): extracted from The Good Behaviours' site.


Sites pin a tag (`#v0.1.0`). To change the player: edit it here, bump `version` in `package.json`, tag it (`git tag v0.1.1 && git push --tags`), then in each site `npm install github:jowtron/site-player#v0.1.1`, build and deploy.
