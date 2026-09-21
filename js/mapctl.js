/* ============================================================
 * mapctl.js -- a usable map: toolbar, gestures, drawing loop
 * ============================================================
 * MapView draws a picture. MapCtl turns it into a map you
 * use: buttons (All / Me / Route, North / Heading, zoom, street map),
 * pan and zoom by gesture, a drawing loop with ~30 frames
 * per second while the map is visible.
 *
 * There is more than one map (live and replay), so this is a factory
 * and not a singleton: every map has its own state and its own element IDs
 * (prefix + "Svg", "All", ...).
 *
 *   MapCtl.mount(rootElement, {
 *     prefix:    'map',
 *     getData:   () => { route, riders, meId, climbs, heading, overlay, smooth },
 *     isActive:  () => is the map currently visible?
 *     hasRoute:  () => is there a route overlay? (shows the "Route" button)
 *     persist:   true -> remember the street map choice
 *     extras:    [ { id, label, title } ]   further buttons of the bar
 *   })
 * ============================================================ */

var MapCtl = (function () {
    'use strict';

    var K_MIN = 0.004, K_MAX = 30;

    function store(k, v) {
        try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); }
        catch (e) { return null; }
    }

    function template(p, cfg) {
        var extra = (cfg.extras || []).map(function (x) {
            return '<div class="seg"><button id="' + p + x.id + '" aria-pressed="false">' + x.label + '</button></div>';
        }).join('');
        return '' +
          '<div class="maptools">' +
            '<div class="seg" role="group" aria-label="Ausschnitt">' +
              '<button id="' + p + 'All" class="on">Alle</button>' +
              '<button id="' + p + 'Me">Ich</button>' +
              '<button id="' + p + 'Route" hidden>Route</button>' +
            '</div>' +
            '<div class="seg" role="group" aria-label="Ausrichtung">' +
              '<button id="' + p + 'North" class="on">Nord</button>' +
              '<button id="' + p + 'Course">Kurs</button>' +
            '</div>' +
            '<div class="seg" role="group" aria-label="Zoom">' +
              '<button id="' + p + 'Out" aria-label="Herauszoomen">−</button>' +
              '<button id="' + p + 'In" aria-label="Hineinzoomen">+</button>' +
            '</div>' +
            '<div class="seg" role="group" aria-label="Kartenhintergrund">' +
              '<button id="' + p + 'TilesBtn" aria-pressed="false">Straßenkarte</button>' +
            '</div>' + extra +
          '</div>' +
          '<div class="mapbox">' +
            '<svg id="' + p + 'Tiles" class="mtiles" aria-hidden="true"></svg>' +
            '<svg id="' + p + 'Svg" class="msvg" aria-label="Karte"></svg>' +
            '<button class="mapctr" id="' + p + 'Center" hidden aria-label="Ansicht zurücksetzen">⌖</button>' +
            '<a class="mapattr" id="' + p + 'Attr" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener" hidden>© OpenStreetMap-Mitwirkende</a>' +
          '</div>' +
          '<div class="mapinfo" id="' + p + 'Info"></div>';
    }

    function mount(root, cfg) {
        var p = cfg.prefix;
        root.innerHTML = template(p, cfg);
        function $(id) { return root.querySelector('#' + p + id); }

        /* Shift (panU/panV, metres) and zoom factor (zoomMul) lie on top of the
           automatic section of "All", "Me" or "Route". A finger movement
           therefore shifts relative to it -- the map keeps following the group. */
        var opt = { follow: false, fitRoute: false, trackUp: false, tiles: false, zoom: 1,
                    zoomMul: 1, panU: 0, panV: 0 };
        if (cfg.persist) opt.tiles = store('tiles') === '1' && store('tilesOn') === '1';   // only after earlier consent
        var v = { k: 1, cx: 0, cy: 0 };            // scale/centre of the last drawing
        var raf = 0, loopOn = false, loopT = 0;

        function dirty() { return !!(opt.panU || opt.panV) || Math.abs(opt.zoomMul - 1) > 0.01; }
        function reset() { opt.panU = opt.panV = 0; opt.zoomMul = 1; }

        function pan(dx, dy) { opt.panU -= dx / v.k; opt.panV += dy / v.k; }

        // Zoom around a picture point: the point under the finger stays under the finger
        function zoomAbout(px, py, f) {
            var k0 = v.k, k1 = Math.max(K_MIN, Math.min(K_MAX, k0 * f));
            if (k1 === k0) return;
            var dx = px - v.cx, dy = py - v.cy;
            opt.panU += dx * (1 / k0 - 1 / k1);
            opt.panV += dy * (1 / k1 - 1 / k0);
            opt.zoomMul *= k1 / k0;
            v.k = k1;                              // keep computing right away, before it is redrawn
        }

        function sync() {
            $('All').classList.toggle('on', !opt.follow && !opt.fitRoute);
            $('Me').classList.toggle('on', opt.follow);
            var hasRoute = !!(cfg.hasRoute && cfg.hasRoute());
            $('Route').hidden = !hasRoute;
            $('Route').classList.toggle('on', opt.fitRoute && hasRoute);
            $('TilesBtn').classList.toggle('on', opt.tiles);
            $('TilesBtn').setAttribute('aria-pressed', opt.tiles ? 'true' : 'false');
            $('Attr').hidden = !opt.tiles;
            $('North').classList.toggle('on', !opt.trackUp);
            $('Course').classList.toggle('on', opt.trackUp);
            $('Center').hidden = !dirty();
        }

        function draw() {
            var d = cfg.getData();
            if (!d) return;
            var info = MapView.render($(  'Svg'), {
                zoomMul: opt.zoomMul, panU: opt.panU, panV: opt.panV,
                route: d.route, riders: d.riders, meId: d.meId, climbs: d.climbs, overlay: d.overlay,
                follow: opt.follow, fitOverlay: opt.fitRoute && (!!d.overlay || !!d.axisFit), zoom: opt.zoom,
                trackUp: opt.trackUp, heading: d.heading, smooth: d.smooth,
                tiles: opt.tiles, tileSvg: $('Tiles'), tileUrl: store('tileurl') || undefined
            });
            if (!info) return;
            if (info.k) v = { k: info.k, cx: info.cx, cy: info.cy };
            var txt = '';
            if (info.riders) {
                txt = T('{n} Fahrer', { n: info.riders });
                if (info.length > 0) txt += ' · ' + T('Streckenachse {d}', { d: UI.fmtDist(info.length) });
            }
            if (d.overlay) txt += (txt ? ' · ' : '') + T('Route „{name}“ {d}', { name: d.overlay.name, d: UI.fmtDist(d.overlay.len) });
            if (opt.trackUp && d.heading === null && info.riders) txt += ' · ' + T('noch kein Kurs, Norden oben');
            $('Info').textContent = txt;
        }

        // redraw at most once per frame, even if gestures arrive faster
        function redraw() {
            if (raf) return;
            raf = requestAnimationFrame(function () {
                raf = 0;
                if (cfg.isActive()) draw();
                sync();
            });
        }

        /* The map draws at ~30 frames per second while it is visible
           (the positions themselves only arrive ~1x per second -- in between
           MapView smooths, see smooth.js). If another tab is open or the page is in the
           background, nothing runs: that saves the battery. */
        function loop(ts) {
            if (!cfg.isActive() || document.hidden) { loopOn = false; return; }
            if (ts - loopT >= 33) { loopT = ts; draw(); }
            requestAnimationFrame(loop);
        }
        function ensureLoop() {
            if (loopOn) return;
            loopOn = true;
            requestAnimationFrame(loop);
        }

        // --- Buttons ---
        function again() { sync(); draw(); }
        $('All').addEventListener('click',    function () { opt.follow = false; opt.fitRoute = false; reset(); again(); });
        $('Me').addEventListener('click',     function () { opt.follow = true;  opt.fitRoute = false; reset(); again(); });
        $('Route').addEventListener('click',  function () { opt.follow = false; opt.fitRoute = true;  reset(); again(); });
        $('Center').addEventListener('click', function () { reset(); again(); });
        $('North').addEventListener('click',  function () { opt.trackUp = false; again(); });
        $('Course').addEventListener('click', function () { opt.trackUp = true;  again(); });
        $('In').addEventListener('click',     function () { zoomAbout(v.cx, v.cy, 1.5); again(); });
        $('Out').addEventListener('click',    function () { zoomAbout(v.cx, v.cy, 1 / 1.5); again(); });
        MapTouch.attach($('Svg'), { pan: pan, zoomAbout: zoomAbout, redraw: redraw });

        $('TilesBtn').addEventListener('click', function () {
            if (!opt.tiles && store('tiles') !== '1') {
                if (!confirm(T('Für die Straßenkarte lädt dein Handy Kartenbilder von tile.openstreetmap.org.\n\nDer Anbieter sieht dabei deine IP-Adresse und den ungefähren Kartenausschnitt – nicht deinen Namen, deine Gruppe oder den Gruppenschlüssel.\n\nOhne Straßenkarte bleibt alles wie bisher, auch offline.\n\nEinschalten?'))) return;
                store('tiles', '1');
            }
            opt.tiles = !opt.tiles;
            store('tilesOn', opt.tiles ? '1' : '0');
            again();
        });

        /* Texts of the toolbar (the template is built once, so a language switch calls this again) */
        function relabel() {
            var groups = root.querySelectorAll('.seg[role="group"]');
            [T('Ausschnitt'), T('Ausrichtung'), T('Zoom'), T('Kartenhintergrund')].forEach(function (s, i) { if (groups[i]) groups[i].setAttribute('aria-label', s); });
            $('All').textContent = T('Alle'); $('Me').textContent = T('Ich'); $('Route').textContent = T('Route');
            $('North').textContent = T('Nord'); $('Course').textContent = T('Kurs');
            $('Out').setAttribute('aria-label', T('Herauszoomen')); $('In').setAttribute('aria-label', T('Hineinzoomen'));
            $('TilesBtn').textContent = T('Straßenkarte');
            $('Svg').setAttribute('aria-label', T('Karte')); $('Center').setAttribute('aria-label', T('Ansicht zurücksetzen'));
            $('Attr').textContent = T('© OpenStreetMap-Mitwirkende');
            (cfg.extras || []).forEach(function (x) { var b = $(x.id); if (b) b.textContent = T(x.label); });
        }
        relabel();

        sync();
        return { opt: opt, draw: draw, sync: sync, redraw: redraw, ensureLoop: ensureLoop, reset: reset, relabel: relabel,
                 el: function (id) { return $(id); } };
    }

    return { mount: mount };
})();
