/* ============================================================
 * maptouch.js -- gestures for the map
 * ============================================================
 * What you expect from a map:
 *   - Dragging with one finger (or the mouse) pans
 *   - Spreading/pinching two fingers zooms around the point between the
 *     fingers while you pan at the same time
 *   - Double tap (double click) zooms in around the point
 *   - Mouse wheel and trackpad pinch zoom around the mouse pointer
 *   - After a quick swipe the map coasts to a stop
 *
 * Pointer Events cover touch, pen and mouse in one go. The
 * element needs "touch-action: none", otherwise the browser scrolls or
 * zooms by itself. The map knows nothing about gestures: this module only calls
 * api.pan / api.zoomAbout / api.redraw.
 *
 *   api.pan(dx, dy)            shift of the map in pixels
 *   api.zoomAbout(x, y, f)     zoom factor f around the picture point (x, y)
 *   api.redraw()               redraw (may be throttled)
 * ============================================================ */

var MapTouch = (function () {
    'use strict';

    var TAP_MS = 300, TAP_PX = 8, DOUBLE_MS = 320, DOUBLE_PX = 30;

    function attach(el, api) {
        var ptrs = {};                   // active pointers: id -> {x, y}
        var downT = 0, downX = 0, downY = 0, moved = false;
        var tapT = 0, tapX = 0, tapY = 0;
        var vx = 0, vy = 0, lastT = 0;   // swipe speed in px/ms
        var fling = null;

        function pos(e) {
            var r = el.getBoundingClientRect();
            return { x: e.clientX - r.left, y: e.clientY - r.top };
        }
        function ids() { return Object.keys(ptrs); }
        function stopFling() { if (fling) { cancelAnimationFrame(fling); fling = null; } }

        el.addEventListener('pointerdown', function (e) {
            stopFling();
            try { el.setPointerCapture(e.pointerId); } catch (x) {}
            ptrs[e.pointerId] = pos(e);
            if (ids().length === 1) {
                var p = ptrs[e.pointerId];
                downT = Date.now(); downX = p.x; downY = p.y; moved = false; vx = vy = 0; lastT = 0;
            } else {
                moved = true;            // second finger: no longer a tap
            }
        });

        el.addEventListener('pointermove', function (e) {
            var prev = ptrs[e.pointerId];
            if (!prev) return;
            var cur = pos(e), list = ids();

            if (list.length === 1) {
                // a small tremor when tapping does not count as dragging yet
                if (!moved && Math.hypot(cur.x - downX, cur.y - downY) < TAP_PX) return;
                moved = true;
                var dx = cur.x - prev.x, dy = cur.y - prev.y, now = performance.now();
                if (lastT) {
                    var dt = Math.max(1, now - lastT);
                    vx = 0.6 * vx + 0.4 * (dx / dt); vy = 0.6 * vy + 0.4 * (dy / dt);
                }
                lastT = now;
                api.pan(dx, dy);
            } else if (list.length === 2) {
                var other = ptrs[list[0] === String(e.pointerId) ? list[1] : list[0]];
                var d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
                var d1 = Math.hypot(cur.x - other.x, cur.y - other.y);
                var m0 = { x: (prev.x + other.x) / 2, y: (prev.y + other.y) / 2 };
                var m1 = { x: (cur.x + other.x) / 2, y: (cur.y + other.y) / 2 };
                api.pan(m1.x - m0.x, m1.y - m0.y);
                if (d0 > 10 && d1 > 10) api.zoomAbout(m1.x, m1.y, d1 / d0);
            }
            ptrs[e.pointerId] = cur;
            api.redraw();
        });

        function up(e) {
            if (!ptrs[e.pointerId]) return;
            var p = ptrs[e.pointerId];
            delete ptrs[e.pointerId];
            var left = ids().length;

            if (left === 0 && !moved && Date.now() - downT < TAP_MS) {
                // Tap: twice in quick succession at the same spot = zoom in
                var now = Date.now();
                if (now - tapT < DOUBLE_MS && Math.hypot(p.x - tapX, p.y - tapY) < DOUBLE_PX) {
                    api.zoomAbout(p.x, p.y, 2); api.redraw(); tapT = 0;
                } else { tapT = now; tapX = p.x; tapY = p.y; }
            } else if (left === 0 && moved && lastT && performance.now() - lastT < 80 &&
                       Math.hypot(vx, vy) > 0.15) {
                // Coasting: the speed decays exponentially
                var t0 = performance.now();
                (function step(t) {
                    var dt = Math.min(32, t - t0); t0 = t;
                    api.pan(vx * dt, vy * dt); api.redraw();
                    var f = Math.pow(0.94, dt / 16);
                    vx *= f; vy *= f;
                    fling = Math.hypot(vx, vy) > 0.02 ? requestAnimationFrame(step) : null;
                })(t0);
            }
            if (left === 1) {            // from zooming back to dragging: carry on without a jump
                vx = vy = 0; lastT = 0;
            }
        }
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);

        el.addEventListener('wheel', function (e) {
            e.preventDefault();          // the page should not scroll along
            var p = pos(e);
            api.zoomAbout(p.x, p.y, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0016)));
            api.redraw();
        }, { passive: false });
    }

    return { attach: attach };
})();
