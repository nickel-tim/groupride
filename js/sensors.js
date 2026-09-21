/* ============================================================
 * sensors.js -- GPS, Kurs, Display wachhalten
 * ============================================================
 * Der Kurs ist hier der interessante Teil.
 *
 * Man wuerde reflexhaft den Magnetometer nehmen. Auf dem Fahrrad ist
 * das die schlechtere Wahl: Die meisten Handyhalterungen am Lenker
 * sind MAGNETISCH, und Lenker, Vorbau und Bremszuege sind Stahl. Der
 * Kompass zeigt dann verlaesslich falsch -- teils um 90 Grad und mehr.
 *
 * coords.heading aus dem GNSS-Chip hat dieses Problem nicht: Es kommt
 * aus der Doppler-Verschiebung, ist also rein kinematisch. Der Preis
 * ist, dass es nur bei Bewegung existiert.
 *
 * Also: oberhalb von HEAD_MIN_SPEED das GPS, darunter der Magnetometer
 * als Rueckfall. Genau umgekehrt zur naiven Erwartung.
 * ============================================================ */

var Sensors = (function () {
    'use strict';

    var HEAD_MIN_SPEED = 2.5;    // m/s, darueber ist GPS-Kurs verlaesslich

    var onPos = null, onErr = null;
    var watchId = null;
    var wakeLock = null;

    var magHeading = null;       // Grad, aus dem Magnetometer
    var gpsHeading = null;       // Grad, aus dem GNSS-Chip
    var lastSpeed  = 0;
    var magSource  = 'keiner';

    /* ---------- GPS ---------- */
    function startGps(cb, errCb) {
        onPos = cb; onErr = errCb;
        if (!navigator.geolocation) {
            if (onErr) onErr('Dieser Browser hat keine Geolocation-API.');
            return false;
        }
        watchId = navigator.geolocation.watchPosition(function (pos) {
            var c = pos.coords;
            lastSpeed = (c.speed !== null && !isNaN(c.speed) && c.speed >= 0) ? c.speed : 0;
            if (c.heading !== null && !isNaN(c.heading) && lastSpeed >= HEAD_MIN_SPEED) {
                gpsHeading = c.heading;
            }
            if (onPos) onPos(pos);
        }, function (e) {
            var msg = 'GPS-Fehler';
            if (e.code === 1) msg = 'Standortfreigabe verweigert. In den ' +
                                    'Browser-Einstellungen fuer diese Seite erlauben.';
            else if (e.code === 2) msg = 'Kein GPS-Empfang.';
            else if (e.code === 3) msg = 'GPS antwortet nicht (Timeout).';
            if (onErr) onErr(msg);
        }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
        return true;
    }

    function stopGps() {
        if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }

    /* ---------- Magnetometer ----------
       Muss aus einer Nutzergeste heraus angefragt werden (iOS 13+),
       sonst lehnt Safari stillschweigend ab. */
    async function startCompass() {
        try {
            if (typeof DeviceOrientationEvent !== 'undefined' &&
                typeof DeviceOrientationEvent.requestPermission === 'function') {
                var res = await DeviceOrientationEvent.requestPermission();
                if (res !== 'granted') { magSource = 'abgelehnt'; return false; }
            }
        } catch (e) {
            magSource = 'abgelehnt'; return false;
        }

        // Absolute Orientierung, wo verfuegbar (Android/Chrome)
        if ('ondeviceorientationabsolute' in window) {
            window.addEventListener('deviceorientationabsolute', handleOrient, true);
            magSource = 'absolut';
        } else {
            window.addEventListener('deviceorientation', handleOrient, true);
            magSource = 'relativ';
        }
        return true;
    }

    function handleOrient(e) {
        var h = null;
        if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
            // iOS: bereits Grad im Uhrzeigersinn ab magnetisch Nord
            h = e.webkitCompassHeading;
            magSource = 'iOS';
        } else if (typeof e.alpha === 'number' && e.alpha !== null) {
            // W3C: alpha zaehlt GEGEN den Uhrzeigersinn ab Nord
            h = 360 - e.alpha;
            if (e.absolute === true) magSource = 'absolut';
        }
        if (h === null) return;

        /* Bildschirmdrehung herausrechnen: im Querformat zeigt die
           Geraeteachse 90 Grad neben der Blickrichtung. */
        var angle = 0;
        if (screen.orientation && typeof screen.orientation.angle === 'number') {
            angle = screen.orientation.angle;
        } else if (typeof window.orientation === 'number') {
            angle = window.orientation;
        }
        magHeading = (h + angle + 360) % 360;
    }

    /* Der effektive Kurs plus die Quelle, damit die App ehrlich
       anzeigen kann, worauf die Pfeile beruhen. */
    function heading() {
        if (lastSpeed >= HEAD_MIN_SPEED && gpsHeading !== null) {
            return { deg: gpsHeading, src: 'GPS' };
        }
        if (magHeading !== null) return { deg: magHeading, src: 'Kompass' };
        if (gpsHeading !== null) return { deg: gpsHeading, src: 'GPS (alt)' };
        return { deg: null, src: magSource === 'abgelehnt' ? 'verweigert' : '--' };
    }

    /* ---------- Display wachhalten ----------
       Ohne das sperrt das Handy nach Sekunden, und in vielen Browsern
       stirbt damit auch der GPS-Strom. */
    async function keepAwake(on) {
        try {
            if (!('wakeLock' in navigator)) return false;
            if (on) {
                if (wakeLock) return true;
                wakeLock = await navigator.wakeLock.request('screen');
                wakeLock.addEventListener('release', function () { wakeLock = null; });
                return true;
            }
            if (wakeLock) { await wakeLock.release(); wakeLock = null; }
            return true;
        } catch (e) { return false; }
    }

    // Nach dem Zurueckholen aus dem Hintergrund ist die Sperre weg
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible' && wakeLock === null) keepAwake(true);
    });

    return {
        startGps: startGps, stopGps: stopGps,
        startCompass: startCompass,
        heading: heading,
        keepAwake: keepAwake,
        hasWakeLock: function () { return !!wakeLock; },
        compassSource: function () { return magSource; }
    };
})();
