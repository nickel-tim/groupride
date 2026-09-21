/* ============================================================
 * sensors.js -- GPS, heading, keeping the display awake
 * ============================================================
 * The heading is the interesting part here.
 *
 * The reflex would be to use the magnetometer. On a bicycle that is
 * the worse choice: most handlebar phone mounts are MAGNETIC, and
 * handlebar, stem and brake cables are steel. The compass then points
 * reliably wrong -- sometimes by 90 degrees and more.
 *
 * coords.heading from the GNSS chip does not have this problem: it comes
 * from the Doppler shift, so it is purely kinematic. The price is
 * that it only exists while moving.
 *
 * So: above HEAD_MIN_SPEED the GPS, below it the magnetometer
 * as a fallback. Exactly the opposite of the naive expectation.
 * ============================================================ */

var Sensors = (function () {
    'use strict';

    var HEAD_MIN_SPEED = 2.5;    // m/s, above this the GPS heading is reliable

    var onPos = null, onErr = null;
    var watchId = null;
    var wakeLock = null;

    var magHeading = null;       // degrees, from the magnetometer
    var gpsHeading = null;       // degrees, from the GNSS chip
    var lastSpeed  = 0;
    var magSource  = 'keiner';

    /* ---------- GPS ---------- */
    function startGps(cb, errCb) {
        onPos = cb; onErr = errCb;
        if (!navigator.geolocation) {
            if (onErr) onErr(T('Dieser Browser hat keine Geolocation-API.'));
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
            var msg = T('GPS-Fehler');
            if (e.code === 1) msg = T('Standortfreigabe verweigert. In den Browser-Einstellungen für diese Seite erlauben.');
            else if (e.code === 2) msg = T('Kein GPS-Empfang.');
            else if (e.code === 3) msg = T('GPS antwortet nicht (Timeout).');
            if (onErr) onErr(msg);
        }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
        return true;
    }

    function stopGps() {
        if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }

    /* ---------- Magnetometer ----------
       Must be requested from a user gesture (iOS 13+),
       otherwise Safari silently refuses. */
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

        // Absolute orientation where available (Android/Chrome)
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
            // iOS: already degrees clockwise from magnetic north
            h = e.webkitCompassHeading;
            magSource = 'iOS';
        } else if (typeof e.alpha === 'number' && e.alpha !== null) {
            // W3C: alpha counts COUNTER-clockwise from north
            h = 360 - e.alpha;
            if (e.absolute === true) magSource = 'absolut';
        }
        if (h === null) return;

        /* Factor out the screen rotation: in landscape the
           device axis points 90 degrees away from the viewing direction. */
        var angle = 0;
        if (screen.orientation && typeof screen.orientation.angle === 'number') {
            angle = screen.orientation.angle;
        } else if (typeof window.orientation === 'number') {
            angle = window.orientation;
        }
        magHeading = (h + angle + 360) % 360;
    }

    /* The effective heading plus the source, so that the app can honestly
       show what the arrows are based on. */
    function heading() {
        if (lastSpeed >= HEAD_MIN_SPEED && gpsHeading !== null) {
            return { deg: gpsHeading, src: 'GPS' };
        }
        if (magHeading !== null) return { deg: magHeading, src: T('Kompass') };
        if (gpsHeading !== null) return { deg: gpsHeading, src: T('GPS (alt)') };
        return { deg: null, src: magSource === 'abgelehnt' ? 'verweigert' : '--' };
    }

    /* ---------- Keeping the display awake ----------
       Without it the phone locks after seconds, and in many browsers
       the GPS stream dies with it. */
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

    // After coming back from the background the lock is gone
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
