-- Commented version of migrations/0001_init.sql (for reading only; D1 requires a comment-free migration).
-- After changing either of the two files, regenerate the other: python3 liga/tools/strip_sql.py

-- ============================================================
-- League: database schema for Cloudflare D1 (SQLite)
-- ============================================================
-- Migration for the league (see liga/PLAN.md and liga/DEPLOY.md).
-- Apply:  npx wrangler d1 migrations apply groupride --remote
--
-- Rules:
--   * Times are milliseconds since 1970 (UTC), like in the rest of the app.
--   * Distances in metres, speed in m/s, duration in milliseconds.
--   * Nothing here stores live data or group recordings.
--   * Read costs count (D1 free: 5 million rows read/day). That is why
--     account_id/start_ts are also in ride_values: a ranking reads
--     only this one table, without a join.
-- ============================================================

PRAGMA foreign_keys = ON;

/* ---------- Accounts and devices ---------- */
CREATE TABLE accounts (
    id          TEXT PRIMARY KEY,               -- random, 16 bytes base64url
    name        TEXT NOT NULL,                  -- max. 14 characters like in the live group
    emoji       INTEGER,                        -- index into UI.EMOJIS or NULL
    color       TEXT,
    -- HMAC-SHA256(AUTH_SECRET, lower-cased e-mail). We do not store the address itself:
    -- To log in you type it, the code goes to the typed address. The server can
    -- therefore neither lose an address list nor write to anybody unasked.
    email_hash  TEXT NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL,
    deleted_at  INTEGER
);

-- Every device has its own key and signs every request with it. The e-mail
-- is the way to a NEW key (new phone, browser data cleared): code to the
-- address -> the new key is assigned to the account.
CREATE TABLE devices (
    pubkey      TEXT PRIMARY KEY,               -- ECDSA P-256, raw x||y, base64url
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    label       TEXT,
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER
);
CREATE INDEX devices_account ON devices(account_id);

-- One-time codes for login (6 digits, 10 min, 5 attempts). The code is bound to the
-- key that requested it.
CREATE TABLE login_codes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email_hash  TEXT NOT NULL,
    pubkey      TEXT NOT NULL,
    code_hash   TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
);
CREATE INDEX login_codes_email ON login_codes(email_hash, created_at);

/* ---------- Leagues ---------- */
CREATE TABLE leagues (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    admin_id    TEXT NOT NULL REFERENCES accounts(id),
    invite_hash TEXT NOT NULL,                  -- SHA-256 of the invitation secret (only in the link)
    tz          TEXT NOT NULL DEFAULT 'Europe/Berlin',
    -- Period: 'once' = one-off from start_ts to end_ts; otherwise recurring
    -- every `every` units, anchored at start_ts (in the time zone tz).
    --   week=week/1, month=month/1, 3 months=month/3, year=year/1, 10 days=day/10
    unit        TEXT NOT NULL DEFAULT 'month' CHECK (unit IN ('once','day','week','month','year')),
    every       INTEGER NOT NULL DEFAULT 1 CHECK (every BETWEEN 1 AND 366),
    start_ts    INTEGER NOT NULL,
    end_ts      INTEGER,
    cats        TEXT NOT NULL DEFAULT '[]',     -- JSON: active categories ["dist","time",...]
    scoring     INTEGER NOT NULL DEFAULT 1,     -- 1 = overall standing by place points
    no_points   TEXT NOT NULL DEFAULT '[]',     -- JSON: categories that do not count towards the overall standing
    goals       TEXT NOT NULL DEFAULT '[]',     -- team goals JSON [{"cat":"dist","target":3000000}]
    grace_h     INTEGER NOT NULL DEFAULT 48,    -- grace period for late-uploaded rides
    created_at  INTEGER NOT NULL,
    closed_at   INTEGER,
    CHECK (unit <> 'once' OR end_ts IS NOT NULL)
);

CREATE TABLE memberships (
    league_id   TEXT NOT NULL REFERENCES leagues(id)  ON DELETE CASCADE,
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    joined_at   INTEGER NOT NULL,
    goals       TEXT NOT NULL DEFAULT '[]',     -- personal goals JSON, visible to the league
    PRIMARY KEY (league_id, account_id)
);
CREATE INDEX memberships_account ON memberships(account_id);

/* ---------- Rides ---------- */
-- A ride belongs to the account, not to a league. Every league only queries
-- which rides fall into its period. That makes "several leagues" work without extra effort.
CREATE TABLE rides (
    id          TEXT PRIMARY KEY,               -- client: hash of account + start time (makes upload idempotent)
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    src         TEXT NOT NULL CHECK (src IN ('ride','gpx')),   -- sim/ghost/plan are rejected
    start_ts    INTEGER NOT NULL,
    end_ts      INTEGER NOT NULL,
    day         TEXT NOT NULL,                  -- rider's local calendar day 'YYYY-MM-DD'
    dist_m      REAL NOT NULL,
    moving_ms   INTEGER NOT NULL,
    n_points    INTEGER NOT NULL,
    algo        INTEGER NOT NULL,               -- version of the metrics computation (see PLAN.md)
    created_at  INTEGER NOT NULL
);
CREATE INDEX rides_account_start ON rides(account_id, start_ts);

-- All category values of a ride, one row per category. Uniform, so that a
-- new category needs only code and no migration.
CREATE TABLE ride_values (
    ride_id     TEXT NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
    cat         TEXT NOT NULL,                  -- 'dist','gain','top','t10k','front',...
    v           REAL NOT NULL,
    account_id  TEXT NOT NULL,                  -- deliberately duplicated: ranking without a join
    start_ts    INTEGER NOT NULL,
    day         TEXT NOT NULL,
    PRIMARY KEY (ride_id, cat)
);
CREATE INDEX ride_values_board ON ride_values(cat, start_ts, account_id);

-- The whole track, private (only the owner may read it).
-- Format 1 (js/liga-codec.js): varint differences (dt, dlat, dlon, dele), gzip, as Base64 TEXT.
-- Text instead of BLOB, because D1 returns BLOBs as lists of numbers.
CREATE TABLE tracks (
    ride_id     TEXT PRIMARY KEY REFERENCES rides(id) ON DELETE CASCADE,
    fmt         INTEGER NOT NULL DEFAULT 1,
    data        TEXT NOT NULL,
    tiles       TEXT                            -- visited tiles (z15), varint delta, Base64, for "Explore"
);

/* ---------- Sharing: trimmed copy for the members ---------- */
-- When sharing, the client uploads a copy from which the start and end (default 300 m)
-- are missing. The server trims nothing itself (10 ms CPU on the free plan). If it is
-- no longer shared anywhere, the copy is deleted.
CREATE TABLE ride_shares (
    ride_id     TEXT NOT NULL REFERENCES rides(id)   ON DELETE CASCADE,
    league_id   TEXT NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    shared_at   INTEGER NOT NULL,
    PRIMARY KEY (ride_id, league_id)
);
CREATE INDEX ride_shares_league ON ride_shares(league_id, shared_at);

CREATE TABLE shared_tracks (
    ride_id     TEXT PRIMARY KEY REFERENCES rides(id) ON DELETE CASCADE,
    fmt         INTEGER NOT NULL DEFAULT 1,
    trim_m      INTEGER NOT NULL,
    data        TEXT NOT NULL
);

/* ---------- Explore ---------- */
-- First visit time per tile and account. A ranking only counts rows in the
-- period via the index -- it does not read the whole history.
CREATE TABLE account_tiles (
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    tile        INTEGER NOT NULL,               -- z15: x * 32768 + y
    first_ts    INTEGER NOT NULL,
    PRIMARY KEY (account_id, tile)
);
CREATE INDEX account_tiles_first ON account_tiles(account_id, first_ts);

/* ---------- League segments (king of the mountains, best times) ---------- */
CREATE TABLE league_segments (
    id          TEXT PRIMARY KEY,
    league_id   TEXT NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'climb' CHECK (kind IN ('climb','sprint','other')),
    len_m       REAL NOT NULL,
    gain_m      REAL,
    poly        TEXT NOT NULL,                  -- thinned-out points, same format as tracks (Base64)
    created_by  TEXT NOT NULL REFERENCES accounts(id),
    created_at  INTEGER NOT NULL
);
CREATE INDEX league_segments_league ON league_segments(league_id);

-- The times are computed by the riders' client (Segments.match), the server only sorts.
CREATE TABLE segment_efforts (
    segment_id  TEXT NOT NULL REFERENCES league_segments(id) ON DELETE CASCADE,
    ride_id     TEXT NOT NULL REFERENCES rides(id)           ON DELETE CASCADE,
    account_id  TEXT NOT NULL,
    start_ts    INTEGER NOT NULL,
    ms          INTEGER NOT NULL,
    PRIMARY KEY (segment_id, ride_id)
);
CREATE INDEX segment_efforts_board ON segment_efforts(segment_id, start_ts, ms);

/* ---------- Hall of fame: frozen results ---------- */
-- Written on first access after the period + grace_h has expired (without cron).
CREATE TABLE league_periods (
    league_id   TEXT NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    period_start INTEGER NOT NULL,
    period_end  INTEGER NOT NULL,
    frozen_at   INTEGER NOT NULL,
    PRIMARY KEY (league_id, period_start)
);

CREATE TABLE league_results (
    league_id   TEXT NOT NULL,
    period_start INTEGER NOT NULL,
    cat         TEXT NOT NULL,                  -- category or '_total' for the overall standing
    rank        INTEGER NOT NULL,
    account_id  TEXT NOT NULL,
    v           REAL NOT NULL,
    points      REAL,
    PRIMARY KEY (league_id, period_start, cat, rank, account_id),
    FOREIGN KEY (league_id, period_start) REFERENCES league_periods(league_id, period_start) ON DELETE CASCADE
);
