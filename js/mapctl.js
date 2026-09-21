/* ============================================================
 * mapctl.js -- eine bedienbare Karte: Werkzeugleiste, Gesten, Zeichenschleife
 * ============================================================
 * MapView zeichnet ein Bild. MapCtl macht daraus eine Karte, die man
 * benutzt: Knoepfe (Alle / Ich / Route, Nord / Kurs, Zoom, Strassenkarte),
 * Verschieben und Zoomen per Geste, eine Zeichenschleife mit ~30 Bildern
 * pro Sekunde, solange die Karte sichtbar ist.
 *
 * Es gibt mehr als eine Karte (live und Replay), deshalb ist das eine Fabrik
 * und kein Singleton: jede Karte hat eigenen Zustand und eigene Element-IDs
 * (prefix + "Svg", "All", ...).
 *
 *   MapCtl.mount(rootElement, {
 *     prefix:    'map',
 *     getData:   () => { route, riders, meId, climbs, heading, overlay, smooth },
 *     isActive:  () => Karte gerade sichtbar?
 *     hasRoute:  () => gibt es eine Streckenueberlagerung? (zeigt den Knopf "Route")
 *     persist:   true -> Strassenkarten-Wahl merken
 *     extras:    [ { id, label, title } ]   weitere Knoepfe der Leiste
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

        /* Verschiebung (panU/panV, Meter) und Zoomfaktor (zoomMul) liegen ueber dem
           automatischen Ausschnitt von "Alle", "Ich" bzw. "Route". Ein Fingerzeig
           verschiebt also relativ dazu -- die Karte folgt weiter der Gruppe. */
        var opt = { follow: false, fitRoute: false, trackUp: false, tiles: false, zoom: 1,
                    zoomMul: 1, panU: 0, panV: 0 };
        if (cfg.persist) opt.tiles = store('tiles') === '1' && store('tilesOn') === '1';   // nur nach frueherer Einwilligung
        var v = { k: 1, cx: 0, cy: 0 };            // Massstab/Mitte des letzten Zeichnens
        var raf = 0, loopOn = false, loopT = 0;

        function dirty() { return !!(opt.panU || opt.panV) || Math.abs(opt.zoomMul - 1) > 0.01; }
        function reset() { opt.panU = opt.panV = 0; opt.zoomMul = 1; }

        function pan(dx, dy) { opt.panU -= dx / v.k; opt.panV += dy / v.k; }

        // Zoom um einen Bildpunkt: der Punkt unter dem Finger bleibt unter dem Finger
        function zoomAbout(px, py, f) {
            var k0 = v.k, k1 = Math.max(K_MIN, Math.min(K_MAX, k0 * f));
            if (k1 === k0) return;
            var dx = px - v.cx, dy = py - v.cy;
            opt.panU += dx * (1 / k0 - 1 / k1);
            opt.panV += dy * (1 / k1 - 1 / k0);
            opt.zoomMul *= k1 / k0;
            v.k = k1;                              // gleich weiterrechnen, bevor neu gezeichnet ist
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
                txt = info.riders + ' Fahrer';
                if (info.length > 0) txt += ' · Streckenachse ' + UI.fmtDist(info.length);
            }
            if (d.overlay) txt += (txt ? ' · ' : '') + 'Route „' + d.overlay.name + '“ ' + UI.fmtDist(d.overlay.len);
            if (opt.trackUp && d.heading === null && info.riders) txt += ' · noch kein Kurs, Norden oben';
            $('Info').textContent = txt;
        }

        // hoechstens einmal je Bild neu zeichnen, auch wenn Gesten schneller kommen
        function redraw() {
            if (raf) return;
            raf = requestAnimationFrame(function () {
                raf = 0;
                if (cfg.isActive()) draw();
                sync();
            });
        }

        /* Die Karte zeichnet mit ~30 Bildern pro Sekunde, solange sie sichtbar ist
           (die Positionen selbst kommen nur ~1x pro Sekunde -- dazwischen glaettet
           MapView, siehe smooth.js). Ist ein anderer Reiter offen oder die Seite im
           Hintergrund, laeuft nichts: das schont den Akku. */
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

        // --- Knoepfe ---
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
                if (!confirm('Für die Straßenkarte lädt dein Handy Kartenbilder von tile.openstreetmap.org.\n\n' +
                             'Der Anbieter sieht dabei deine IP-Adresse und den ungefähren Kartenausschnitt – ' +
                             'nicht deinen Namen, deine Gruppe oder den Gruppenschlüssel.\n\n' +
                             'Ohne Straßenkarte bleibt alles wie bisher, auch offline.\n\nEinschalten?')) return;
                store('tiles', '1');
            }
            opt.tiles = !opt.tiles;
            store('tilesOn', opt.tiles ? '1' : '0');
            again();
        });

        sync();
        return { opt: opt, draw: draw, sync: sync, redraw: redraw, ensureLoop: ensureLoop, reset: reset,
                 el: function (id) { return $(id); } };
    }

    return { mount: mount };
})();
