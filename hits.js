/* site-player hits: counts page views and clicks on links off the site, so
   the stats page can show which towns visitors are in and what they click
   (Bandcamp, YouTube, socials…). Anonymous: no cookie, no visitor id, and
   the Worker never stores the IP (Cloudflare tells it the town).

   Load it on every page, after player.js if the page has one:
     <script src="/assets/hits.js" defer></script>
   It sends a view on load and after each of the player's page swaps
   (the "siteplayer:swap" event), and a click for any link to another site,
   an email address or a phone number. Set data-hits-url on the script tag
   to post somewhere other than /api/hit. */
(function () {
  'use strict';
  var me = document.currentScript;
  var url = (me && me.dataset.hitsUrl) || '/api/hit';
  function send(data) {
    var body = JSON.stringify(data);
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))) return;
    } catch (err) { /* fall through */ }
    fetch(url, { method: 'POST', body: body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(function () {});
  }
  var ref = '';
  try { ref = document.referrer ? new URL(document.referrer).host : ''; } catch (err) { /* none */ }
  function view() {
    // Only the first page carries where the visitor came from.
    send({ k: 'view', path: location.pathname, ref: ref === location.host ? '' : ref });
    ref = '';
  }
  view();
  document.addEventListener('siteplayer:swap', view);
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var u;
    try { u = new URL(a.href, location.href); } catch (err) { return; }
    var off = (u.protocol === 'http:' || u.protocol === 'https:') ? u.host !== location.host : (u.protocol === 'mailto:' || u.protocol === 'tel:');
    if (!off) return;
    send({ k: 'click', path: location.pathname, target: u.protocol === 'mailto:' || u.protocol === 'tel:' ? u.protocol.replace(':', '') : u.host + u.pathname });
  }, true);
})();
