-- ============================================================
-- Liga: Datenbank-Schema fuer Cloudflare D1 (SQLite)
-- ============================================================
-- VORBEREITUNG -- noch nicht angebunden. Siehe liga/PLAN.md.
-- Anwenden (spaeter):  npx wrangler d1 migrations apply groupride --remote
--
-- Regeln:
--   * Zeiten sind Millisekunden seit 1970 (UTC), wie im Rest der App.
--   * Strecken in Metern, Tempo in m/s, Dauer in Millisekunden.
--   * Nichts hier speichert Live-Daten oder Gruppenaufzeichnungen.
--   * Lese-Kosten zaehlen (D1 Free: 5 Mio. gelesene Zeilen/Tag). Darum
--     steht account_id/start_ts auch in ride_values: eine Rangliste liest
--     nur diese eine Tabelle, ohne Join.
-- ============================================================

PRAGMA foreign_keys = ON;

/* ---------- Konten und Geraete ---------- */
CREATE TABLE accounts (
    id          TEXT PRIMARY KEY,               -- zufaellig, 16 Byte base64url
    name        TEXT NOT NULL,                  -- max. 14 Zeichen wie in der Live-Gruppe
    emoji       INTEGER,                        -- Index in UI.EMOJIS oder NULL
    color       TEXT,
    -- HMAC-SHA256(AUTH_SECRET, kleingeschriebene E-Mail). Die Adresse selbst speichern wir nicht:
    -- Zum Anmelden tippt man sie ein, der Code geht an die getippte Adresse. Der Server kann
    -- deshalb keine Adressliste verlieren und niemanden ungefragt anschreiben.
    email_hash  TEXT NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL,
    deleted_at  INTEGER
);

-- Jedes Geraet hat seinen eigenen Schluessel und signiert damit jede Anfrage. Die E-Mail
-- ist der Weg zu einem NEUEN Schluessel (neues Handy, Browserdaten geloescht): Code an die
-- Adresse -> der neue Schluessel wird dem Konto zugeordnet.
CREATE TABLE devices (
    pubkey      TEXT PRIMARY KEY,               -- ECDSA P-256, roh x||y, base64url
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    label       TEXT,
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER
);
CREATE INDEX devices_account ON devices(account_id);

-- Einmalcodes fuer die Anmeldung (6 Ziffern, 10 min, 5 Versuche). Der Code ist an den
-- Schluessel gebunden, der ihn angefordert hat.
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

/* ---------- Ligen ---------- */
CREATE TABLE leagues (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    admin_id    TEXT NOT NULL REFERENCES accounts(id),
    invite_hash TEXT NOT NULL,                  -- SHA-256 des Einladungsgeheimnisses (steht nur im Link)
    tz          TEXT NOT NULL DEFAULT 'Europe/Berlin',
    -- Zeitraum: 'once' = einmalig von start_ts bis end_ts; sonst wiederkehrend
    -- alle `every` Einheiten, verankert bei start_ts (in der Zeitzone tz).
    --   Woche=week/1, Monat=month/1, 3 Monate=month/3, Jahr=year/1, 10 Tage=day/10
    unit        TEXT NOT NULL DEFAULT 'month' CHECK (unit IN ('once','day','week','month','year')),
    every       INTEGER NOT NULL DEFAULT 1 CHECK (every BETWEEN 1 AND 366),
    start_ts    INTEGER NOT NULL,
    end_ts      INTEGER,
    cats        TEXT NOT NULL DEFAULT '[]',     -- JSON: aktive Kategorien ["dist","time",...]
    scoring     INTEGER NOT NULL DEFAULT 1,     -- 1 = Gesamtwertung nach Platzpunkten
    no_points   TEXT NOT NULL DEFAULT '[]',     -- JSON: Kategorien, die nicht in die Gesamtwertung zaehlen
    goals       TEXT NOT NULL DEFAULT '[]',     -- Team-Ziele JSON [{"cat":"dist","target":3000000}]
    grace_h     INTEGER NOT NULL DEFAULT 48,    -- Nachfrist fuer spaet hochgeladene Fahrten
    created_at  INTEGER NOT NULL,
    closed_at   INTEGER,
    CHECK (unit <> 'once' OR end_ts IS NOT NULL)
);

CREATE TABLE memberships (
    league_id   TEXT NOT NULL REFERENCES leagues(id)  ON DELETE CASCADE,
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    joined_at   INTEGER NOT NULL,
    goals       TEXT NOT NULL DEFAULT '[]',     -- persoenliche Ziele JSON, fuer die Liga sichtbar
    PRIMARY KEY (league_id, account_id)
);
CREATE INDEX memberships_account ON memberships(account_id);

/* ---------- Fahrten ---------- */
-- Eine Fahrt gehoert dem Konto, nicht einer Liga. Jede Liga fragt nur ab,
-- welche Fahrten in ihren Zeitraum fallen. So geht "mehrere Ligen" ohne Mehrarbeit.
CREATE TABLE rides (
    id          TEXT PRIMARY KEY,               -- Client: Hash aus Konto + Startzeit (macht Upload idempotent)
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    src         TEXT NOT NULL CHECK (src IN ('ride','gpx')),   -- sim/ghost/plan werden abgelehnt
    start_ts    INTEGER NOT NULL,
    end_ts      INTEGER NOT NULL,
    day         TEXT NOT NULL,                  -- lokaler Kalendertag des Fahrers 'YYYY-MM-DD'
    dist_m      REAL NOT NULL,
    moving_ms   INTEGER NOT NULL,
    n_points    INTEGER NOT NULL,
    algo        INTEGER NOT NULL,               -- Version der Kennzahlen-Berechnung (siehe PLAN.md)
    created_at  INTEGER NOT NULL
);
CREATE INDEX rides_account_start ON rides(account_id, start_ts);

-- Alle Kategorie-Werte einer Fahrt, eine Zeile je Kategorie. Einheitlich, damit eine
-- neue Kategorie nur Code und keine Migration braucht.
CREATE TABLE ride_values (
    ride_id     TEXT NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
    cat         TEXT NOT NULL,                  -- 'dist','gain','top','t10k','front',...
    v           REAL NOT NULL,
    account_id  TEXT NOT NULL,                  -- absichtlich doppelt: Rangliste ohne Join
    start_ts    INTEGER NOT NULL,
    day         TEXT NOT NULL,
    PRIMARY KEY (ride_id, cat)
);
CREATE INDEX ride_values_board ON ride_values(cat, start_ts, account_id);

-- Der ganze Track, privat (nur der Besitzer darf ihn lesen).
-- Format 1 (js/liga-codec.js): Varint-Differenzen (dt, dlat, dlon, dele), gzip, als Base64-TEXT.
-- Text statt BLOB, weil D1 BLOBs als Zahlenlisten zurueckgibt.
CREATE TABLE tracks (
    ride_id     TEXT PRIMARY KEY REFERENCES rides(id) ON DELETE CASCADE,
    fmt         INTEGER NOT NULL DEFAULT 1,
    data        TEXT NOT NULL,
    tiles       TEXT                            -- besuchte Kacheln (z15), Varint-Delta, Base64, fuer "Entdecken"
);

/* ---------- Teilen: gekuerzte Kopie fuer die Mitglieder ---------- */
-- Beim Teilen laedt der Client eine Kopie hoch, bei der Anfang und Ende (Standard 300 m)
-- fehlen. Der Server kuerzt nichts selbst (10 ms CPU im Free Plan). Wird nirgends mehr
-- geteilt, wird die Kopie geloescht.
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

/* ---------- Entdecken ---------- */
-- Erste Besuchszeit je Kachel und Konto. Eine Rangliste zaehlt nur Zeilen im
-- Zeitraum ueber den Index -- sie liest nicht die ganze Historie.
CREATE TABLE account_tiles (
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    tile        INTEGER NOT NULL,               -- z15: x * 32768 + y
    first_ts    INTEGER NOT NULL,
    PRIMARY KEY (account_id, tile)
);
CREATE INDEX account_tiles_first ON account_tiles(account_id, first_ts);

/* ---------- Liga-Segmente (Kletterkoenig, Bestzeiten) ---------- */
CREATE TABLE league_segments (
    id          TEXT PRIMARY KEY,
    league_id   TEXT NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'climb' CHECK (kind IN ('climb','sprint','other')),
    len_m       REAL NOT NULL,
    gain_m      REAL,
    poly        TEXT NOT NULL,                  -- ausgeduennte Punkte, gleiches Format wie Tracks (Base64)
    created_by  TEXT NOT NULL REFERENCES accounts(id),
    created_at  INTEGER NOT NULL
);
CREATE INDEX league_segments_league ON league_segments(league_id);

-- Die Zeiten berechnet der Client der Fahrer (Segments.match), der Server sortiert nur.
CREATE TABLE segment_efforts (
    segment_id  TEXT NOT NULL REFERENCES league_segments(id) ON DELETE CASCADE,
    ride_id     TEXT NOT NULL REFERENCES rides(id)           ON DELETE CASCADE,
    account_id  TEXT NOT NULL,
    start_ts    INTEGER NOT NULL,
    ms          INTEGER NOT NULL,
    PRIMARY KEY (segment_id, ride_id)
);
CREATE INDEX segment_efforts_board ON segment_efforts(segment_id, start_ts, ms);

/* ---------- Ruhmeshalle: eingefrorene Ergebnisse ---------- */
-- Wird beim ersten Zugriff nach Ablauf von Zeitraum + grace_h geschrieben (ohne Cron).
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
    cat         TEXT NOT NULL,                  -- Kategorie oder '_total' fuer die Gesamtwertung
    rank        INTEGER NOT NULL,
    account_id  TEXT NOT NULL,
    v           REAL NOT NULL,
    points      REAL,
    PRIMARY KEY (league_id, period_start, cat, rank, account_id),
    FOREIGN KEY (league_id, period_start) REFERENCES league_periods(league_id, period_start) ON DELETE CASCADE
);
