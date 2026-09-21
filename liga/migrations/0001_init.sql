CREATE TABLE accounts (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    emoji       INTEGER,
    color       TEXT,

    email_hash  TEXT NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL,
    deleted_at  INTEGER
);

CREATE TABLE devices (
    pubkey      TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    label       TEXT,
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER
);
CREATE INDEX devices_account ON devices(account_id);

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

CREATE TABLE leagues (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    admin_id    TEXT NOT NULL REFERENCES accounts(id),
    invite_hash TEXT NOT NULL,
    tz          TEXT NOT NULL DEFAULT 'Europe/Berlin',

    unit        TEXT NOT NULL DEFAULT 'month' CHECK (unit IN ('once','day','week','month','year')),
    every       INTEGER NOT NULL DEFAULT 1 CHECK (every BETWEEN 1 AND 366),
    start_ts    INTEGER NOT NULL,
    end_ts      INTEGER,
    cats        TEXT NOT NULL DEFAULT '[]',
    scoring     INTEGER NOT NULL DEFAULT 1,
    no_points   TEXT NOT NULL DEFAULT '[]',
    goals       TEXT NOT NULL DEFAULT '[]',
    grace_h     INTEGER NOT NULL DEFAULT 48,
    created_at  INTEGER NOT NULL,
    closed_at   INTEGER,
    CHECK (unit <> 'once' OR end_ts IS NOT NULL)
);

CREATE TABLE memberships (
    league_id   TEXT NOT NULL REFERENCES leagues(id)  ON DELETE CASCADE,
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    joined_at   INTEGER NOT NULL,
    goals       TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (league_id, account_id)
);
CREATE INDEX memberships_account ON memberships(account_id);

CREATE TABLE rides (
    id          TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    src         TEXT NOT NULL CHECK (src IN ('ride','gpx')),
    start_ts    INTEGER NOT NULL,
    end_ts      INTEGER NOT NULL,
    day         TEXT NOT NULL,
    dist_m      REAL NOT NULL,
    moving_ms   INTEGER NOT NULL,
    n_points    INTEGER NOT NULL,
    algo        INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
);
CREATE INDEX rides_account_start ON rides(account_id, start_ts);

CREATE TABLE ride_values (
    ride_id     TEXT NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
    cat         TEXT NOT NULL,
    v           REAL NOT NULL,
    account_id  TEXT NOT NULL,
    start_ts    INTEGER NOT NULL,
    day         TEXT NOT NULL,
    PRIMARY KEY (ride_id, cat)
);
CREATE INDEX ride_values_board ON ride_values(cat, start_ts, account_id);

CREATE TABLE tracks (
    ride_id     TEXT PRIMARY KEY REFERENCES rides(id) ON DELETE CASCADE,
    fmt         INTEGER NOT NULL DEFAULT 1,
    data        TEXT NOT NULL,
    tiles       TEXT
);

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

CREATE TABLE account_tiles (
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    tile        INTEGER NOT NULL,
    first_ts    INTEGER NOT NULL,
    PRIMARY KEY (account_id, tile)
);
CREATE INDEX account_tiles_first ON account_tiles(account_id, first_ts);

CREATE TABLE league_segments (
    id          TEXT PRIMARY KEY,
    league_id   TEXT NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'climb' CHECK (kind IN ('climb','sprint','other')),
    len_m       REAL NOT NULL,
    gain_m      REAL,
    poly        TEXT NOT NULL,
    created_by  TEXT NOT NULL REFERENCES accounts(id),
    created_at  INTEGER NOT NULL
);
CREATE INDEX league_segments_league ON league_segments(league_id);

CREATE TABLE segment_efforts (
    segment_id  TEXT NOT NULL REFERENCES league_segments(id) ON DELETE CASCADE,
    ride_id     TEXT NOT NULL REFERENCES rides(id)           ON DELETE CASCADE,
    account_id  TEXT NOT NULL,
    start_ts    INTEGER NOT NULL,
    ms          INTEGER NOT NULL,
    PRIMARY KEY (segment_id, ride_id)
);
CREATE INDEX segment_efforts_board ON segment_efforts(segment_id, start_ts, ms);

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
    cat         TEXT NOT NULL,
    rank        INTEGER NOT NULL,
    account_id  TEXT NOT NULL,
    v           REAL NOT NULL,
    points      REAL,
    PRIMARY KEY (league_id, period_start, cat, rank, account_id),
    FOREIGN KEY (league_id, period_start) REFERENCES league_periods(league_id, period_start) ON DELETE CASCADE
);
