-- BizDev Coworker — PostgreSQL 13+
-- Placeholders are $1, $2, ... (psql / libpq / JDBC).

-- List a user's saved searches (topic + run time + how many matches).
-- $1 uuid  user_id
SELECT
    run_id,
    topic,
    ran_at,
    match_count
FROM v_user_search_history
WHERE user_id = $1
ORDER BY ran_at DESC;

-- All runs for one topic (normalized) for a user.
-- $1 uuid  user_id
-- $2 text  topic
SELECT
    run_id,
    topic,
    ran_at,
    match_count
FROM v_user_search_history
WHERE user_id = $1
  AND topic_normalized = lower(btrim(regexp_replace($2, '\s+', ' ', 'g')))
ORDER BY ran_at DESC;

-- Recall a run's match list (and any drafts).
-- $1 uuid  run_id
-- $2 uuid  user_id
SELECT
    m.rank,
    m.source_contact_id,
    m.name,
    m.position,
    m.company,
    m.email,
    m.score,
    m.reason,
    d.subject AS draft_subject,
    d.body    AS draft_body
FROM run_matches m
LEFT JOIN match_drafts d ON d.match_id = m.id
JOIN search_runs r ON r.id = m.run_id
WHERE m.run_id = $1
  AND r.user_id = $2
ORDER BY m.rank;

-- Insert a new run.
-- $1 uuid     user_id
-- $2 text     topic
-- $3 integer  requested_count
INSERT INTO search_runs (user_id, topic, topic_normalized, requested_count)
VALUES (
    $1,
    $2,
    lower(btrim(regexp_replace($2, '\s+', ' ', 'g'))),
    $3
)
RETURNING id, ran_at;

-- Insert one ranked match
-- $1 uuid     run_id
-- $2 integer  rank
-- $3 integer  source_contact_id
-- $4 text     name
-- $5 text     position
-- $6 text     company
-- $7 text     email
-- $8 integer  score
-- $9 text     reason
INSERT INTO run_matches (
    run_id, rank, source_contact_id, name, position, company, email, score, reason
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9
);

-- Upsert a draft for a match
-- $1 uuid  match_id
-- $2 text  subject
-- $3 text  body
INSERT INTO match_drafts (match_id, subject, body)
VALUES ($1, $2, $3)
ON CONFLICT (match_id) DO UPDATE
SET subject = EXCLUDED.subject,
    body = EXCLUDED.body,
    updated_at = now();

-- Delete a run (matches and drafts cascade).
-- $1 uuid  run_id
-- $2 uuid  user_id
DELETE FROM search_runs WHERE id = $1 AND user_id = $2;

-- Touch user / settings timestamps on update
-- UPDATE users SET display_name = $2, headline = $3, updated_at = now() WHERE id = $1;
-- UPDATE user_settings SET match_count = $2, dark_mode = $3, updated_at = now() WHERE user_id = $1;
