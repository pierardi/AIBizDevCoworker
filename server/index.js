import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import express from "express";
import { clampMatchCount, displayName, iso, isUuid, normalizeUserKey, pool } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const MAX_RUNS = 50;

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

function mapUser(row) {
  return {
    id: row.id,
    displayName: row.display_name || "",
    headline: row.headline || "",
  };
}

function mapSettings(row) {
  return {
    matchCount: clampMatchCount(row?.match_count),
    darkMode: Boolean(row?.dark_mode),
  };
}

function mapRunSummary(row) {
  return {
    id: row.run_id || row.id,
    topic: row.topic || "",
    savedAt: iso(row.ran_at),
    matchCount: Number(row.match_count || 0),
    ranked: [],
    drafts: {},
  };
}

function mapPerson(row) {
  return {
    id: row.source_contact_id == null ? row.id : row.source_contact_id,
    matchId: row.id,
    name: row.name || "",
    position: row.position || "",
    company: row.company || "",
    email: row.email || "",
    score: Number(row.score || 0),
    reason: row.reason || "",
  };
}

function mapRunDetail(run, matches) {
  const drafts = {};
  const ranked = matches.map((row) => {
    const person = mapPerson(row);
    if (row.draft_subject != null || row.draft_body != null) {
      drafts[String(person.id)] = {
        subject: row.draft_subject || "",
        body: row.draft_body || "",
      };
    }
    return person;
  });
  return {
    id: run.id,
    topic: run.topic || "",
    savedAt: iso(run.ran_at),
    matchCount: ranked.length,
    ranked,
    drafts,
  };
}

async function loadSettings(userId) {
  const result = await pool.query(
    `SELECT match_count, dark_mode FROM user_settings WHERE user_id = $1`,
    [userId],
  );
  if (!result.rowCount) {
    await pool.query(`INSERT INTO user_settings (user_id) VALUES ($1)`, [userId]);
    return mapSettings({ match_count: 10, dark_mode: false });
  }
  return mapSettings(result.rows[0]);
}

async function listRuns(userId) {
  const result = await pool.query(
    `SELECT run_id, topic, ran_at, match_count
     FROM v_user_search_history
     WHERE user_id = $1
     ORDER BY ran_at DESC`,
    [userId],
  );
  return result.rows.map(mapRunSummary);
}

async function loadRun(userId, runId) {
  const run = await pool.query(
    `SELECT id, topic, ran_at, requested_count
     FROM search_runs
     WHERE id = $1 AND user_id = $2`,
    [runId, userId],
  );
  if (!run.rowCount) return null;
  const matches = await pool.query(
    `SELECT
        m.id, m.rank, m.source_contact_id, m.name, m.position, m.company,
        m.email, m.score, m.reason, d.subject AS draft_subject, d.body AS draft_body
     FROM run_matches m
     LEFT JOIN match_drafts d ON d.match_id = m.id
     WHERE m.run_id = $1
     ORDER BY m.rank`,
    [runId],
  );
  return mapRunDetail(run.rows[0], matches.rows);
}

function headerUserName(req) {
  const raw = req.get("X-User-Name") || "";
  try {
    return displayName(decodeURIComponent(raw));
  } catch {
    return displayName(raw);
  }
}

async function resolveOrCreateUser(name) {
  const visible = displayName(name);
  const key = normalizeUserKey(visible);
  if (!key) return null;
  const upserted = await pool.query(
    `INSERT INTO users (auth_subject, display_name)
     VALUES ($1, $2)
     ON CONFLICT (auth_subject) DO UPDATE
     SET display_name = EXCLUDED.display_name,
         updated_at = now()
     RETURNING id, display_name, headline`,
    [key, visible],
  );
  const userRow = upserted.rows[0];
  await pool.query(
    `INSERT INTO user_settings (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userRow.id],
  );
  return userRow;
}

async function requireUser(req, res, next) {
  try {
    const name = headerUserName(req);
    if (normalizeUserKey(name)) {
      const userRow = await resolveOrCreateUser(name);
      req.userId = userRow.id;
      next();
      return;
    }
    const userId = req.get("X-User-Id");
    if (isUuid(userId)) {
      const found = await pool.query(`SELECT id FROM users WHERE id = $1`, [userId]);
      if (found.rowCount) {
        req.userId = userId;
        next();
        return;
      }
    }
    res.status(401).json({ error: "Enter your name in Setup to load and save searches." });
  } catch (err) {
    next(err);
  }
}

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

app.get("/api/session", async (req, res) => {
  try {
    const name = headerUserName(req);
    if (!normalizeUserKey(name)) {
      res.status(400).json({ error: "Enter your name in Setup to load and save searches." });
      return;
    }
    const userRow = await resolveOrCreateUser(name);
    const [settings, runs] = await Promise.all([
      loadSettings(userRow.id),
      listRuns(userRow.id),
    ]);
    res.json({ user: mapUser(userRow), settings, runs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/settings", requireUser, async (req, res) => {
  try {
    const headline = String(req.body?.headline ?? "");
    const matchCount = clampMatchCount(req.body?.matchCount);
    const darkMode = Boolean(req.body?.darkMode);
    await pool.query(
      `UPDATE users
       SET headline = $2, updated_at = now()
       WHERE id = $1`,
      [req.userId, headline],
    );
    await pool.query(
      `INSERT INTO user_settings (user_id, match_count, dark_mode, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id) DO UPDATE
       SET match_count = EXCLUDED.match_count,
           dark_mode = EXCLUDED.dark_mode,
           updated_at = now()`,
      [req.userId, matchCount, darkMode],
    );
    const named = await pool.query(
      `SELECT display_name FROM users WHERE id = $1`,
      [req.userId],
    );
    res.json({
      user: {
        id: req.userId,
        displayName: named.rows[0]?.display_name || headerUserName(req),
        headline,
      },
      settings: { matchCount, darkMode },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/runs", requireUser, async (req, res) => {
  try {
    res.json({ runs: await listRuns(req.userId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/runs/:id", requireUser, async (req, res) => {
  try {
    if (!isUuid(req.params.id)) {
      res.status(400).json({ error: "Invalid run id" });
      return;
    }
    const run = await loadRun(req.userId, req.params.id);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    res.json(run);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/runs", requireUser, async (req, res) => {
  const topic = String(req.body?.topic ?? "").trim();
  const requestedCount = clampMatchCount(req.body?.requestedCount);
  const matches = Array.isArray(req.body?.matches) ? req.body.matches : [];
  if (!topic) {
    res.status(400).json({ error: "Topic is required" });
    return;
  }
  if (!matches.length) {
    res.status(400).json({ error: "At least one match is required" });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const runResult = await client.query(
      `INSERT INTO search_runs (user_id, topic, topic_normalized, requested_count)
       VALUES ($1, $2, lower(btrim(regexp_replace($2, '\\s+', ' ', 'g'))), $3)
       RETURNING id, topic, ran_at, requested_count`,
      [req.userId, topic, requestedCount],
    );
    const run = runResult.rows[0];
    const inserted = [];
    for (const [index, match] of matches.slice(0, 100).entries()) {
      const sourceId = Number.isInteger(match.sourceContactId)
        ? match.sourceContactId
        : Number.isInteger(match.id)
          ? match.id
          : null;
      const row = await client.query(
        `INSERT INTO run_matches (
            run_id, rank, source_contact_id, name, position, company, email, score, reason
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, rank, source_contact_id, name, position, company, email, score, reason`,
        [
          run.id,
          Number.parseInt(match.rank, 10) || index + 1,
          sourceId,
          String(match.name || ""),
          String(match.position || ""),
          String(match.company || ""),
          String(match.email || ""),
          Math.min(100, Math.max(0, Number.parseInt(match.score, 10) || 0)),
          String(match.reason || ""),
        ],
      );
      const saved = row.rows[0];
      const draft = match.draft || null;
      if (draft && (draft.subject || draft.body)) {
        await client.query(
          `INSERT INTO match_drafts (match_id, subject, body)
           VALUES ($1, $2, $3)`,
          [saved.id, String(draft.subject || ""), String(draft.body || "")],
        );
        saved.draft_subject = draft.subject || "";
        saved.draft_body = draft.body || "";
      }
      inserted.push(saved);
    }
    await client.query(
      `DELETE FROM search_runs
       WHERE user_id = $1
         AND id NOT IN (
           SELECT id FROM search_runs
           WHERE user_id = $1
           ORDER BY ran_at DESC
           LIMIT $2
         )`,
      [req.userId, MAX_RUNS],
    );
    await client.query("COMMIT");
    res.status(201).json(mapRunDetail(run, inserted));
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete("/api/runs/:id", requireUser, async (req, res) => {
  try {
    if (!isUuid(req.params.id)) {
      res.status(400).json({ error: "Invalid run id" });
      return;
    }
    const result = await pool.query(
      `DELETE FROM search_runs WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.userId],
    );
    if (!result.rowCount) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/matches/:id/draft", requireUser, async (req, res) => {
  try {
    if (!isUuid(req.params.id)) {
      res.status(400).json({ error: "Invalid match id" });
      return;
    }
    const owned = await pool.query(
      `SELECT m.id
       FROM run_matches m
       JOIN search_runs r ON r.id = m.run_id
       WHERE m.id = $1 AND r.user_id = $2`,
      [req.params.id, req.userId],
    );
    if (!owned.rowCount) {
      res.status(404).json({ error: "Match not found" });
      return;
    }
    const subject = String(req.body?.subject ?? "");
    const body = String(req.body?.body ?? "");
    await pool.query(
      `INSERT INTO match_drafts (match_id, subject, body, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (match_id) DO UPDATE
       SET subject = EXCLUDED.subject,
           body = EXCLUDED.body,
           updated_at = now()`,
      [req.params.id, subject, body],
    );
    res.json({ subject, body });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message || "Server error" });
});

const dist = path.join(__dirname, "..", "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) return next();
    res.sendFile(path.join(dist, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`BizDev API listening on http://127.0.0.1:${PORT}`);
});
