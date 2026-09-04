-- BizDev Coworker
-- PostgreSQL 13+
-- Run this entire script in one go (psql -f schema.sql, or DBeaver: execute as script).
-- Results are stored per user, indexed by topic, with a run timestamp.

-- ---------------------------------------------------------------------------
-- Users
-- auth_subject is the account key: the trimmed, lowercased "Your Name" value.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_subject    TEXT UNIQUE,
    email           TEXT UNIQUE,
    display_name    TEXT NOT NULL DEFAULT '',
    headline        TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-user preferences (API key stays out of the database on purpose).
-- Set updated_at = now() in UPDATE statements (see queries.sql).
CREATE TABLE IF NOT EXISTS user_settings (
    user_id         UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    match_count     INTEGER NOT NULL DEFAULT 10
                    CHECK (match_count BETWEEN 1 AND 100),
    dark_mode       BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Search runs: one row per ranking job (same topic can be run many times).
-- Set topic_normalized on INSERT (see queries.sql). Do not use a generated
-- column here: regexp_replace() is not IMMUTABLE, so Postgres rejects it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS search_runs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    topic               TEXT NOT NULL,
    topic_normalized    TEXT NOT NULL,
    requested_count     INTEGER NOT NULL DEFAULT 10
                        CHECK (requested_count BETWEEN 1 AND 100),
    ran_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_search_runs_user_ran_at
    ON search_runs (user_id, ran_at DESC);

CREATE INDEX IF NOT EXISTS idx_search_runs_user_topic
    ON search_runs (user_id, topic_normalized, ran_at DESC);

-- ---------------------------------------------------------------------------
-- Ranked matches belonging to a run (the list the user recalls).
-- source_contact_id is the row index from the uploaded Connections.csv.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS run_matches (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id              UUID NOT NULL REFERENCES search_runs (id) ON DELETE CASCADE,
    rank                INTEGER NOT NULL CHECK (rank >= 1),
    source_contact_id   INTEGER,
    name                TEXT NOT NULL DEFAULT '',
    position            TEXT NOT NULL DEFAULT '',
    company             TEXT NOT NULL DEFAULT '',
    email               TEXT NOT NULL DEFAULT '',
    score               INTEGER NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
    reason              TEXT NOT NULL DEFAULT '',
    UNIQUE (run_id, rank)
);

CREATE INDEX IF NOT EXISTS idx_run_matches_run_rank
    ON run_matches (run_id, rank);

-- ---------------------------------------------------------------------------
-- Drafted outreach for a match (optional; filled when the user drafts).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS match_drafts (
    match_id        UUID PRIMARY KEY REFERENCES run_matches (id) ON DELETE CASCADE,
    subject         TEXT NOT NULL DEFAULT '',
    body            TEXT NOT NULL DEFAULT '',
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- List saved searches for a user: topic, timestamp, match count.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_user_search_history AS
SELECT
    r.user_id,
    r.id                AS run_id,
    r.topic,
    r.topic_normalized,
    r.ran_at,
    r.requested_count,
    COUNT(m.id)::INTEGER AS match_count
FROM search_runs r
LEFT JOIN run_matches m ON m.run_id = r.id
GROUP BY r.user_id, r.id, r.topic, r.topic_normalized, r.ran_at, r.requested_count;
