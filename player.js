/* site-player: a small audio player for band and artist websites.

   A player pinned to the bottom of the screen that keeps playing from page
   to page. Play buttons and track lists on the page drive it:

     <button data-play-album="home" data-index="0" data-art="/img/home-600.webp"
             data-url="/music/#home">…</button>

   data-play-album is the album's slug, data-index the track (0-based; leave
   it off for "play the album"), data-art its cover and data-url the page
   about it. Because the page owns the <audio>, everything can follow it: the
   track lists show the playing track and how far through it is, album
   buttons turn to Pause (a .btn-play with a .bp-label and an <svg> inside),
   the tucked-away button in the header animates only while music plays and
   rings with progress, and the phone's lock screen gets the track and
   controls (Media Session).

   The tracks come from GET {albumUrl}<slug> (worker.js: signed links to
   the site's own files). Plays are counted with sendBeacon to {playsUrl}
   (worker.js), anonymously: "start", "stream" (30 seconds heard, the way
   streaming services count a play) and "complete".

   So it can keep playing from page to page, links swap pages in without a
   reload once a player is open: fetch the page, replace everything in <body>
   except elements with data-persist, and call the site's beforeSwap() and
   afterSwap() so it can tear down and set up its own page behaviour. Links
   behave normally whenever no player is open.

   Set-up, after this file has loaded:

     SitePlayer.init({
       artist: 'The Good Behaviours',   // lock screen, and the player's second line
       albumUrl: '/api/album/',         // default
       playsUrl: '/api/plays',          // default; '' turns counting off
       defaultUrl: '/music/',           // "Album notes and credits" when a button has no data-url
       dockSlot: '.site-header .mp-slot', // where the tucked-away button goes
       beforeSwap: function () {},      // before a page swap: remove listeners etc.
       afterSwap: function (doc) {},    // after it: set the new page up
     });

   Styles: player.css, themed with --sp-* custom properties. */
(function () {
  'use strict';
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var root = document.documentElement;
  var opts = null;

  var audio = new Audio();
  audio.preload = 'auto';
  var albums = {};   // slug → Promise of { title, tracks }
  var now = null;    // { slug, index, title, art, url, tracks }
  var player = null;
  var dockBtn = null;
  var pjaxed = false;
  var phone = function () { return window.innerWidth < 900; };
  var fmt = function (t) {
    if (!isFinite(t)) return '0:00';
    t = Math.max(0, Math.floor(t));
    return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
  };
  var ICON = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>',
    prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h2v14H7zM20 5v14L10 12z"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5h2v14h-2zM4 5v14l10-7z"/></svg>',
    down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };

  function loadAlbum(slug, fresh) {
    if (!albums[slug] || fresh) {
      albums[slug] = fetch(opts.albumUrl + slug + (fresh ? '?fresh' : ''))
        .then(function (r) { return r.json(); })
        .then(function (d) { if (!d.ok) throw new Error(d.message); return d; });
      albums[slug].catch(function () { delete albums[slug]; });
    }
    return albums[slug];
  }
  // Fetch the albums on this page ahead of time, so a tap can start the audio
  // straight away (iOS only lets sound start inside the tap itself).
  function prefetch() {
    var seen = {};
    $$('[data-play-album]').forEach(function (b) {
      var slug = b.dataset.playAlbum;
      if (!seen[slug]) { seen[slug] = 1; loadAlbum(slug); }
    });
  }

  // ── Counting plays ──────────────────────────────────────────────────────
  // Anonymous: the album, the track number and what happened. "stream" is
  // sent once 30 seconds of the track have actually been heard (seeking
  // doesn't count), which is how streaming services count a play.
  var heard = 0, lastT = 0, sent = {};
  function count(event) {
    if (!opts.playsUrl || !now) return;
    var t = now.tracks[now.index];
    if (!t) return;
    var body = JSON.stringify({ e: event, album: now.slug, n: t.n || now.index + 1 });
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(opts.playsUrl, new Blob([body], { type: 'application/json' }))) return;
    } catch (err) { /* fall through */ }
    fetch(opts.playsUrl, { method: 'POST', body: body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(function () {});
  }
  function resetCount() { heard = 0; lastT = 0; sent = {}; }
  audio.addEventListener('playing', function () {
    lastT = audio.currentTime;
    if (!sent.start) { sent.start = 1; count('start'); }
  });
  audio.addEventListener('timeupdate', function () {
    var d = audio.currentTime - lastT;
    lastT = audio.currentTime;
    if (!audio.paused && d > 0 && d < 2) heard += d; // a jump is a seek, not listening
    if (heard >= 30 && !sent.stream) { sent.stream = 1; count('stream'); }
  });
  audio.addEventListener('seeked', function () { lastT = audio.currentTime; });

  // ── The player itself ───────────────────────────────────────────────────
  function buildPlayer() {
    player = document.createElement('aside');
    player.className = 'mini-player';
    player.setAttribute('data-persist', '');
    player.setAttribute('aria-label', 'Now playing');
    player.innerHTML =
      '<button type="button" class="mp-art" aria-label="Open the full player"><img alt="" width="56" height="56"></button>' +
      '<div class="mp-meta"><p class="mp-track"></p><p class="mp-album"></p><a class="mp-page" href="' + opts.defaultUrl + '">Album notes and credits</a></div>' +
      '<div class="mp-controls">' +
        '<button type="button" class="mp-btn mp-prev" aria-label="Previous track">' + ICON.prev + '</button>' +
        '<button type="button" class="mp-btn mp-toggle" aria-label="Pause">' + ICON.pause + '</button>' +
        '<button type="button" class="mp-btn mp-next" aria-label="Next track">' + ICON.next + '</button>' +
      '</div>' +
      // Only one of the two chevrons shows at a time (player.css): in the
      // small player it tucks the player away, opened up it goes back to small.
      '<div class="mp-corner">' +
        '<button type="button" class="mp-btn mp-collapse" aria-label="Back to the small player">' + ICON.down + '</button>' +
        '<button type="button" class="mp-btn mp-min" aria-label="Tuck the player away">' + ICON.down + '</button>' +
        '<button type="button" class="mp-btn mp-close" aria-label="Close the player">' + ICON.close + '</button>' +
      '</div>' +
      '<div class="mp-progress"><span class="mp-now">0:00</span>' +
        '<input class="mp-seek" type="range" min="0" max="1000" value="0" step="1" aria-label="Position in the track">' +
        '<span class="mp-dur">0:00</span></div>' +
      // The album's tracks, shown when the player is opened up.
      '<div class="mp-list"><ol class="tracks"></ol></div>';
    player.querySelector('.mp-toggle').addEventListener('click', toggle);
    player.querySelector('.mp-prev').addEventListener('click', function () { step(-1); });
    player.querySelector('.mp-next').addEventListener('click', function () { step(1); });
    player.querySelector('.mp-min').addEventListener('click', function () { setMin(true); });
    player.querySelector('.mp-collapse').addEventListener('click', function () { expand(false); });
    // Tapping the cover or the names opens the full player.
    player.querySelector('.mp-art').addEventListener('click', function () { expand(true); });
    player.querySelector('.mp-meta').addEventListener('click', function (e) {
      if (!e.target.closest('a')) expand(true);
    });
    player.querySelector('.mp-close').addEventListener('click', closePlayer);
    var seek = player.querySelector('.mp-seek');
    seek.addEventListener('input', function () {
      if (isFinite(audio.duration)) audio.currentTime = (seek.value / 1000) * audio.duration;
    });
    document.body.append(player);

    dockBtn = document.createElement('button');
    dockBtn.type = 'button';
    dockBtn.className = 'mp-dock';
    dockBtn.hidden = true;
    dockBtn.setAttribute('aria-label', 'Show the player');
    dockBtn.innerHTML =
      '<svg class="mp-ring" viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="20" pathLength="1"/></svg>' +
      '<span class="mp-eq" aria-hidden="true"><i></i><i></i><i></i></span>';
    dockBtn.addEventListener('click', function () { setMin(false); });
    placeDock();
    root.classList.add('has-player');
  }
  // Tucked away: the player is hidden (the audio carries on) and a small
  // button in the header takes its place.
  function setMin(min) {
    if (!player) return;
    if (min) expand(false);
    root.classList.toggle('player-min', min);
    player.setAttribute('aria-hidden', String(min));
    dockBtn.hidden = !min;
  }
  // Opened up: full screen on a phone, a taller panel on a computer, with
  // big cover art and the album's track list (renderList). Escape, the
  // chevron or tucking it away closes it again.
  function expand(on) {
    if (!player) return;
    player.classList.toggle('is-expanded', on);
    root.classList.toggle('player-expanded', on);
    player.querySelector('.mp-art').setAttribute('aria-label', on ? 'Cover art' : 'Open the full player');
    if (on) {
      var cur = player.querySelector('.mp-list li.is-current');
      if (cur) cur.scrollIntoView({ block: 'nearest' });
    }
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && player && player.classList.contains('is-expanded')) expand(false);
  });
  function renderList() {
    var ol = player.querySelector('.mp-list ol');
    if (ol.dataset.album === now.slug) return;
    ol.dataset.album = now.slug;
    ol.innerHTML = now.tracks.map(function (t, i) {
      var d = document.createElement('div');
      d.textContent = t.title;
      return '<li><button type="button" class="track-play" data-play-album="' + now.slug + '" data-index="' + i +
        '" data-art="' + now.art + '" data-url="' + (now.url || opts.defaultUrl) + '" data-title="' + d.innerHTML.replace(/"/g, '&quot;') + '">' +
        '<span class="tp-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg><span class="tp-eq"><i></i><i></i><i></i></span></span>' +
        '<span class="tp-name">' + d.innerHTML + '</span></button><span class="dur">' + fmt(t.duration) + '</span></li>';
    }).join('');
  }
  // The header is replaced on each page swap, so the button is put back.
  function placeDock() {
    var slot = dockBtn && document.querySelector(opts.dockSlot);
    if (slot && dockBtn.parentNode !== slot) slot.append(dockBtn);
  }

  // Our own files are WebM Opus; a browser that can't play that (mostly older
  // iPhones) gets the AAC copy (srcAlt) instead.
  var webmOK = !!audio.canPlayType('audio/webm; codecs="opus"');
  function playTrack(index) {
    var t = now.tracks[index];
    var src = t && (webmOK || !t.srcAlt ? t.src : t.srcAlt);
    if (!src) return;
    now.index = index;
    resetCount();
    audio.src = src;
    audio.play().catch(function () { /* blocked or interrupted: the button shows Play */ });
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title, artist: opts.artist, album: now.title,
        artwork: [{ src: now.art, sizes: '600x600', type: 'image/webp' }],
      });
    }
    render();
  }
  function start(slug, index, btn) {
    var go = function (data) {
      now = { slug: slug, index: 0, title: data.title, art: btn.dataset.art, url: btn.dataset.url, tracks: data.tracks };
      if (!player) buildPlayer();
      setMin(false);
      player.querySelector('.mp-page').href = now.url || opts.defaultUrl;
      player.querySelector('.mp-art img').src = now.art;
      renderList();
      playTrack(index);
    };
    // Same album and track: just play or pause.
    if (now && now.slug === slug && now.index === index) { toggle(); return; }
    var p = loadAlbum(slug);
    var ready = null;
    p.then(function (d) { ready = d; });
    // Already fetched (usually): start inside the tap, as iOS wants.
    Promise.resolve().then(function () {
      if (ready) go(ready); else p.then(go, function () { /* nothing to play */ });
    });
  }
  function toggle() {
    if (!now) return;
    if (audio.paused) audio.play().catch(function () {}); else audio.pause();
  }
  function step(d) {
    if (!now) return;
    if (d < 0 && audio.currentTime > 3) { audio.currentTime = 0; return; }
    var i = now.index + d;
    if (i >= 0 && i < now.tracks.length) playTrack(i);
  }
  function closePlayer() {
    if (!player) return;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    player.remove();
    dockBtn.remove();
    player = dockBtn = now = null;
    root.classList.remove('has-player', 'player-min', 'player-expanded');
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
    render();
  }

  // Everything that shows the player's state: the player, the tucked-away
  // button, the Play buttons and the track lists. Cheap enough to run on
  // every progress tick.
  function render() {
    var playing = !!now && !audio.paused && !audio.ended;
    var p = now && isFinite(audio.duration) && audio.duration > 0 ? audio.currentTime / audio.duration : 0;
    root.classList.toggle('is-playing', playing);
    if (player && now) {
      var t = now.tracks[now.index];
      player.querySelector('.mp-track').textContent = t.title;
      player.querySelector('.mp-album').textContent = opts.artist ? now.title + ' · ' + opts.artist : now.title;
      var tog = player.querySelector('.mp-toggle');
      tog.innerHTML = playing ? ICON.pause : ICON.play;
      tog.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      player.querySelector('.mp-now').textContent = fmt(audio.currentTime);
      player.querySelector('.mp-dur').textContent = fmt(isFinite(audio.duration) ? audio.duration : t.duration);
      var seek = player.querySelector('.mp-seek');
      if (document.activeElement !== seek) seek.value = Math.round(p * 1000);
      player.style.setProperty('--p', p.toFixed(4));
      dockBtn.style.setProperty('--p', p.toFixed(4));
      player.querySelector('.mp-prev').disabled = now.index === 0 && audio.currentTime <= 3;
      player.querySelector('.mp-next').disabled = now.index >= now.tracks.length - 1;
    }
    $$('[data-play-album]').forEach(function (b) {
      var mine = !!now && b.dataset.playAlbum === now.slug;
      var isTrack = b.hasAttribute('data-index');
      var current = mine && (!isTrack || Number(b.dataset.index) === now.index);
      b.classList.toggle('is-current', current);
      b.classList.toggle('is-playing', current && playing);
      if (isTrack) {
        var row = b.closest('li');
        if (row) {
          row.classList.toggle('is-current', current);
          row.style.setProperty('--p', current ? p.toFixed(4) : '0');
        }
      } else if (b.classList.contains('btn-play')) {
        // Album buttons: Play ↔ Pause while this album plays.
        var label = b.querySelector('.bp-label');
        var svg = b.querySelector('svg');
        if (label) {
          if (!b.dataset.label) b.dataset.label = label.textContent;
          label.textContent = current && playing ? 'Pause' : b.dataset.label;
        }
        if (svg) svg.outerHTML = current && playing ? ICON.pause : ICON.play;
      }
    });
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : (now ? 'paused' : 'none');
  }
  var tick = false;
  ['play', 'pause', 'timeupdate', 'durationchange', 'loadedmetadata', 'seeked'].forEach(function (ev) {
    audio.addEventListener(ev, function () {
      if (tick) return;
      tick = true;
      requestAnimationFrame(function () { tick = false; render(); });
    });
  });
  audio.addEventListener('ended', function () {
    count('complete');
    if (now && now.index < now.tracks.length - 1) playTrack(now.index + 1); else render();
  });
  // The links expire (worker.js): if one has lapsed, fetch fresh ones and
  // carry on from the same place.
  audio.addEventListener('error', function () {
    if (!now || !audio.getAttribute('src')) return;
    var slug = now.slug, index = now.index, at = audio.currentTime;
    loadAlbum(slug, true).then(function (d) {
      if (!now || now.slug !== slug) return;
      now.tracks = d.tracks;
      var keep = sent;
      playTrack(index);
      sent = keep; // the same listen, not a new play
      audio.addEventListener('loadedmetadata', function once() { audio.currentTime = at; audio.removeEventListener('loadedmetadata', once); });
    }, function () {});
  });
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', function () { audio.play(); });
    navigator.mediaSession.setActionHandler('pause', function () { audio.pause(); });
    navigator.mediaSession.setActionHandler('previoustrack', function () { step(-1); });
    navigator.mediaSession.setActionHandler('nexttrack', function () { step(1); });
    try {
      navigator.mediaSession.setActionHandler('seekto', function (e) { audio.currentTime = e.seekTime; });
    } catch (err) { /* older browsers */ }
  }

  // ── Page swaps, so the music carries on ─────────────────────────────────
  function swap(url, push, y) {
    // Remember where this page was scrolled, for the Back button.
    if (push) history.replaceState({ sp: 1, y: window.scrollY }, '');
    return fetch(url, { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok || (r.headers.get('Content-Type') || '').indexOf('text/html') < 0) throw new Error('not a page');
        return r.text();
      })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        opts.beforeSwap();
        $$(':scope > *', document.body).forEach(function (el) { if (!el.hasAttribute('data-persist')) el.remove(); });
        var before = document.body.firstChild;
        $$(':scope > *', doc.body).forEach(function (el) { document.body.insertBefore(document.adoptNode(el), before); });
        document.title = doc.title;
        if (push) history.pushState({ sp: 1 }, '', url);
        pjaxed = true;
        history.scrollRestoration = 'manual';
        var hash = new URL(url, location.href).hash;
        var target = hash && document.getElementById(decodeURIComponent(hash.slice(1)));
        if (typeof y === 'number') window.scrollTo(0, y);
        else if (target) target.scrollIntoView();
        else window.scrollTo(0, 0);
        opts.afterSwap(doc);
        placeDock();
        expand(false);
        prefetch();
        render();
        // On a phone the open player covers a lot of the new page: tuck it away.
        if (phone()) setMin(true);
      })
      .catch(function () { location.href = url; });
  }

  function init(o) {
    if (opts) return;
    o = o || {};
    opts = {
      artist: o.artist || '',
      albumUrl: o.albumUrl || '/api/album/',
      playsUrl: o.playsUrl === undefined ? '/api/plays' : o.playsUrl,
      defaultUrl: o.defaultUrl || '/music/',
      dockSlot: o.dockSlot || '.site-header .mp-slot',
      beforeSwap: o.beforeSwap || function () {},
      afterSwap: o.afterSwap || function () {},
    };
    document.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('[data-play-album]');
      if (!btn) return;
      e.preventDefault();
      start(btn.dataset.playAlbum, Number(btn.dataset.index || 0), btn);
    });
    document.addEventListener('click', function (e) {
      if (!player || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target.closest && e.target.closest('a[href]');
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      var url = new URL(a.href, location.href);
      if (url.origin !== location.origin || url.pathname.indexOf('/api/') === 0) return;
      if (/\.[a-z0-9]+$/i.test(url.pathname) && !/\.html$/.test(url.pathname)) return; // files, not pages
      if (url.pathname === location.pathname && url.search === location.search && url.hash) return; // same-page anchor
      e.preventDefault();
      swap(url.href, true);
    });
    window.addEventListener('popstate', function (e) {
      if (!pjaxed) return;
      if (player) swap(location.href, false, e.state && e.state.y); else location.reload();
    });
    prefetch();
    render();
  }

  window.SitePlayer = { init: init };
})();
