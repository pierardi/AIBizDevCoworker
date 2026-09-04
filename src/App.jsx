import { useEffect, useMemo, useRef, useState } from "react";
import { parseLinkedInCsv, rowsToRoster } from "./lib/csv";
import { scoreBatch, generateDraft, emailToLine, exportCsv } from "./lib/openai";
import {
  createRun,
  deleteRun,
  getRun,
  getSession,
  getStoredUserName,
  matchesFromRanked,
  normalizeUserKey,
  saveDraft,
  setStoredUserName,
  updateSettings,
} from "./lib/api";
import {
  loadSettings,
  saveSettings,
  localRunsPendingMigration,
  markRunsMigrated,
  formatRunTime,
  normalizeMatchCount,
} from "./lib/storage";
import { envOpenAiKey, resolveOpenAiKey } from "./lib/config";
import "./App.css";

const BATCH_SIZE = 60;
const savedSettings = loadSettings();

function initialDarkMode() {
  if (typeof savedSettings.darkMode === "boolean") return savedSettings.darkMode;
  return Boolean(window.matchMedia?.("(prefers-color-scheme: dark)")?.matches);
}

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function truncateTopic(topic, max = 42) {
  const text = (topic || "").trim() || "(no topic)";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function formatRunLabel(run, name) {
  const who = (name || "").trim() || "Unknown";
  const when = formatRunTime(run.savedAt) || "Unknown time";
  const what = truncateTopic(run.topic);
  const count = run.matchCount ?? (run.ranked || []).length;
  const matches = `${count} match${count === 1 ? "" : "es"}`;
  return `${who} · ${when} · ${what} · ${matches}`;
}

function applyRun(run, setters) {
  setters.setActiveRunId(run.id || "");
  setters.setTopic(run.topic || "");
  setters.setRankedTopic(run.topic || "");
  setters.setRankedSavedAt(run.savedAt || "");
  setters.setRanked(run.ranked || []);
  setters.setDrafts(run.drafts || {});
  setters.setDraftPerson(null);
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [openaiApiKey, setOpenaiApiKey] = useState(envOpenAiKey || savedSettings.openaiApiKey || "");
  const activeOpenAiKey = resolveOpenAiKey(openaiApiKey);
  const [userName, setUserName] = useState(savedSettings.userName || getStoredUserName());
  const [userHeadline, setUserHeadline] = useState("");
  const [matchCount, setMatchCount] = useState(10);
  const [darkMode, setDarkMode] = useState(initialDarkMode);
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);
  const [csvError, setCsvError] = useState("");
  const [topic, setTopic] = useState("");
  const [ranked, setRanked] = useState([]);
  const [rankedTopic, setRankedTopic] = useState("");
  const [rankedSavedAt, setRankedSavedAt] = useState("");
  const [drafts, setDrafts] = useState({});
  const [runs, setRuns] = useState([]);
  const [activeRunId, setActiveRunId] = useState("");
  const [ranking, setRanking] = useState(false);
  const [processed, setProcessed] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");
  const [draftPerson, setDraftPerson] = useState(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [recalling, setRecalling] = useState(false);
  const persistReady = useRef(false);
  const draftTimer = useRef(null);
  const sessionGen = useRef(0);

  const runSetters = {
    setActiveRunId,
    setTopic,
    setRankedTopic,
    setRankedSavedAt,
    setRanked,
    setDrafts,
    setDraftPerson,
  };

  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? "dark" : "light";
  }, [darkMode]);

  useEffect(() => {
    saveSettings({ openaiApiKey: envOpenAiKey ? "" : openaiApiKey, userName, darkMode });
    setStoredUserName(userName);
  }, [openaiApiKey, userName, darkMode]);

  async function loadSessionForName(name, { migrate = false } = {}) {
    const gen = ++sessionGen.current;
    persistReady.current = false;
    if (!normalizeUserKey(name)) {
      setUserHeadline("");
      setRuns([]);
      applyRun({ id: "", topic: "", savedAt: "", ranked: [], drafts: {} }, runSetters);
      return;
    }
    const session = await getSession(name);
    let nextRuns = session.runs || [];
    if (migrate) {
      const pending = localRunsPendingMigration();
      if (!nextRuns.length && pending.length) {
        for (const local of pending) {
          if (!local.ranked?.length) continue;
          const created = await createRun({
            topic: local.topic || "Untitled search",
            requestedCount: local.ranked.length,
            matches: matchesFromRanked(local.ranked, local.drafts || {}),
          });
          nextRuns = [created, ...nextRuns.filter((r) => r.id !== created.id)];
        }
        markRunsMigrated();
      } else if (pending.length) {
        markRunsMigrated();
      }
    }
    if (gen !== sessionGen.current) return;
    setUserHeadline(session.user.headline || "");
    setMatchCount(normalizeMatchCount(session.settings.matchCount));
    setDarkMode(Boolean(session.settings.darkMode));
    setRuns(nextRuns);
    if (nextRuns[0]?.id) {
      const latest = nextRuns[0].ranked?.length ? nextRuns[0] : await getRun(nextRuns[0].id);
      if (gen !== sessionGen.current) return;
      applyRun(latest, runSetters);
    } else {
      applyRun({ id: "", topic: "", savedAt: "", ranked: [], drafts: {} }, runSetters);
    }
    persistReady.current = true;
  }

  useEffect(() => {
    persistReady.current = false;
    const first = !ready;
    const timer = setTimeout(() => {
      loadSessionForName(userName, { migrate: first })
        .catch((e) => setError(`Database unavailable: ${e.message || e}`))
        .finally(() => setReady(true));
    }, first ? 0 : 500);
    return () => clearTimeout(timer);
  }, [userName]);

  useEffect(() => {
    if (!persistReady.current || !normalizeUserKey(userName)) return;
    const timer = setTimeout(() => {
      updateSettings({
        headline: userHeadline,
        matchCount: normalizeMatchCount(matchCount),
        darkMode,
      }).catch((e) => setError(`Couldn't save settings: ${e.message || e}`));
    }, 400);
    return () => clearTimeout(timer);
  }, [userHeadline, matchCount, darkMode]);

  const previewRows = useMemo(() => rows.slice(0, 20), [rows]);

  async function recallRun(run) {
    if (!run?.id) return;
    setRecalling(true);
    setError("");
    try {
      const full = run.ranked?.length ? run : await getRun(run.id);
      applyRun(full, runSetters);
    } catch (e) {
      setError(`Couldn't open that search: ${e.message || e}`);
    } finally {
      setRecalling(false);
    }
  }

  function onPickRun(runId) {
    const run = runs.find((r) => r.id === runId);
    if (run) recallRun(run);
  }

  async function removeRun(runId) {
    try {
      await deleteRun(runId);
      const next = runs.filter((r) => r.id !== runId);
      setRuns(next);
      if (activeRunId === runId) {
        if (next[0]) recallRun(next[0]);
        else {
          setActiveRunId("");
          setRanked([]);
          setRankedTopic("");
          setRankedSavedAt("");
          setDrafts({});
        }
      }
    } catch (e) {
      setError(`Couldn't delete that search: ${e.message || e}`);
    }
  }

  async function onFile(file) {
    setCsvError("");
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseLinkedInCsv(text);
      setHeaders(parsed.headers);
      setRows(parsed.rows);
    } catch (e) {
      setCsvError(`Couldn't parse this file: ${e.message || e}`);
      setHeaders([]);
      setRows([]);
    }
  }

  async function findMatches() {
    setError("");
    if (!rows.length) {
      setError("Upload your connections CSV first.");
      return;
    }
    if (!topic.trim()) {
      setError("Enter a topic first.");
      return;
    }
    if (!activeOpenAiKey) {
      setError("Add your OpenAI API key in Setup, or set openai_api_key in Amplify / .env.");
      return;
    }
    if (!normalizeUserKey(userName)) {
      setError("Enter your name in Setup first. Saved searches are stored under that name.");
      return;
    }

    const roster = rowsToRoster(headers, rows);
    const scores = {};
    setRanking(true);
    setProcessed(0);
    setTotal(roster.length);
    try {
      for (let start = 0; start < roster.length; start += BATCH_SIZE) {
        const batch = roster.slice(start, start + BATCH_SIZE).map(({ id, name, company, position }) => ({
          id, name, company, position,
        }));
        setProcessed(start);
        try {
          const scored = await scoreBatch({
            apiKey: activeOpenAiKey,
            userName,
            userHeadline,
            topic,
            batch,
          });
          scored.forEach((item) => {
            scores[item.id] = item;
          });
        } catch (e) {
          setError((prev) => prev || `A batch failed to score (${e.message || e}); skipping those connections.`);
        }
        setProcessed(Math.min(start + batch.length, roster.length));
      }
      const withScores = roster.map((r) => {
        const s = scores[r.id] || { score: 0, reason: "not scored" };
        return { ...r, score: s.score || 0, reason: s.reason || "" };
      });
      const take = Math.min(normalizeMatchCount(matchCount), withScores.length);
      const top = [...withScores].sort((a, b) => b.score - a.score).slice(0, take);
      const saved = await createRun({
        topic: topic.trim(),
        requestedCount: take,
        matches: matchesFromRanked(top),
      });
      setRuns((prev) => [saved, ...prev.filter((r) => r.id !== saved.id)].slice(0, 50));
      applyRun(saved, runSetters);
    } catch (e) {
      setError((prev) => prev || `Couldn't save this search: ${e.message || e}`);
    } finally {
      setRanking(false);
    }
  }

  async function openDraft(person) {
    setDraftPerson(person);
    const key = String(person.id);
    if (drafts[key]) return;
    if (!activeOpenAiKey) {
      setError("Add your OpenAI API key in Setup, or set openai_api_key in Amplify / .env.");
      return;
    }
    setDraftBusy(true);
    try {
      const draft = await generateDraft({
        apiKey: activeOpenAiKey,
        userName,
        userHeadline,
        person,
        topic: rankedTopic || topic,
      });
      setDrafts((d) => ({ ...d, [key]: draft }));
      if (person.matchId) await saveDraft(person.matchId, draft);
    } catch (e) {
      setError(`Couldn't draft this message: ${e.message || e}`);
      setDraftPerson(null);
    } finally {
      setDraftBusy(false);
    }
  }

  function updateDraft(person, patch) {
    const key = String(person.id);
    setDrafts((d) => {
      const next = { ...d, [key]: { ...(d[key] || {}), ...patch } };
      if (person.matchId) {
        clearTimeout(draftTimer.current);
        draftTimer.current = setTimeout(() => {
          saveDraft(person.matchId, next[key]).catch((e) => {
            setError(`Couldn't save draft: ${e.message || e}`);
          });
        }, 400);
      }
      return next;
    });
  }

  const left = Math.max(0, total - processed);
  const draft = draftPerson ? drafts[String(draftPerson.id)] : null;
  const fromName = userName || "Me";

  if (!ready) {
    return (
      <div className="app">
        <main className="main">
          <div className="info">Connecting to your saved searches…</div>
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <h2>⚙️ Setup</h2>
        <label className="theme-switch">
          <span>Dark mode</span>
          <span className="switch">
            <input
              type="checkbox"
              checked={darkMode}
              onChange={(e) => setDarkMode(e.target.checked)}
            />
            <span className="track" />
          </span>
        </label>
        <div className="field">
          <h3>OpenAI API Key</h3>
          {envOpenAiKey ? (
            <span className="hint">Using openai_api_key from the environment.</span>
          ) : (
            <>
              <input
                type="password"
                value={openaiApiKey}
                onChange={(e) => setOpenaiApiKey(e.target.value)}
                placeholder="sk-..."
                autoComplete="off"
              />
              <span className="hint">Saved in this browser only, or set openai_api_key in Amplify / .env.</span>
            </>
          )}
        </div>
        <hr className="div" />
        <h3>Your LinkedIn Profile</h3>
        <p className="hint">Your name is the account key. The same name loads the same saved searches.</p>
        <div className="field">
          <label htmlFor="userName">Your name</label>
          <input id="userName" value={userName} onChange={(e) => setUserName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="userHeadline">Your headline / role</label>
          <input
            id="userHeadline"
            value={userHeadline}
            onChange={(e) => setUserHeadline(e.target.value)}
            placeholder="e.g. Founder @ Acme AI | Building tools for sales teams"
          />
        </div>
        <hr className="div" />
        <p className="fine">
          This app never logs into LinkedIn or scrapes it. You provide your own connections export,
          and all outreach messages are drafted for you to send manually.
        </p>
      </aside>

      <main className="main">
        <h1>🤝 BizDev Coworker</h1>
        <p className="lede">Inside-sales coworker: rank connections for a topic, then draft outreach to send yourself.</p>
        {!activeOpenAiKey && (
          <div className="warn">Add your OpenAI API key in Setup, or set openai_api_key in Amplify / .env.</div>
        )}

        <div className="layout">
          <section className="panel">
            <h2>Connections</h2>
            <p className="hint">
              Export from LinkedIn: Settings &amp; Privacy → Data Privacy → Get a copy of your data → Connections.
            </p>
            <div className="drop">
              <div>Drop Connections.csv here</div>
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => onFile(e.target.files?.[0])}
              />
            </div>
            {csvError && <p className="err">{csvError}</p>}
            {rows.length > 0 && (
              <div className="ok">
                Loaded {rows.length} connections.{" "}
                <button type="button" className="btn-secondary btn" style={{ width: "auto", display: "inline", padding: "0.2rem 0.5rem" }} onClick={() => setShowPreview((v) => !v)}>
                  {showPreview ? "Hide preview" : "Preview data"}
                </button>
              </div>
            )}
            {showPreview && previewRows.length > 0 && (
              <div className="preview">
                <table>
                  <thead>
                    <tr>{headers.map((h) => <th key={h}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {previewRows.map((row, i) => (
                      <tr key={i}>
                        {headers.map((h) => <td key={h}>{row[h]}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <h2>Topic</h2>
            <div className="field">
              <label htmlFor="topic">What do you want to reach out about?</label>
              <textarea
                id="topic"
                rows={2}
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="e.g. our new AI-powered inventory forecasting tool for retail ops teams"
              />
            </div>
            <div className="field match-count-field">
              <label htmlFor="matchCount">Number of top matches</label>
              <input
                id="matchCount"
                type="number"
                min="1"
                max="100"
                step="1"
                value={matchCount}
                onChange={(e) => setMatchCount(e.target.value === "" ? "" : Number(e.target.value))}
                onBlur={() => setMatchCount(normalizeMatchCount(matchCount))}
              />
              <span className="hint">Everyone is scored; this is how many of the highest matches to keep (1–100).</span>
            </div>
            <button className="btn btn-primary" type="button" onClick={findMatches} disabled={ranking}>
              {ranking ? "Scoring…" : `🔍 Find top ${matchCount} matches`}
            </button>
            {error && <p className="err">{error}</p>}
            {ranking && (
              <div className="progress-wrap">
                <div className="progress-label">
                  {processed} of {total} contacts processed, {left} left
                </div>
                <div className="progress-bar">
                  <span style={{ width: `${total ? (processed / total) * 100 : 0}%` }} />
                </div>
              </div>
            )}
          </section>

          <section className="panel">
            <h2>Top {ranked.length || matchCount} matches</h2>
            <div className="run-picker">
              <label htmlFor="priorRun">Prior runs</label>
              <div className="run-picker-row">
                <select
                  id="priorRun"
                  value={activeRunId}
                  disabled={!runs.length || recalling}
                  onChange={(e) => onPickRun(e.target.value)}
                >
                  {!runs.length ? (
                    <option value="">
                      {normalizeUserKey(userName)
                        ? "No saved runs for this name yet"
                        : "Enter your name to see saved runs"}
                    </option>
                  ) : !activeRunId ? (
                    <option value="">Select a prior run…</option>
                  ) : null}
                  {runs.map((run) => (
                    <option key={run.id} value={run.id}>
                      {formatRunLabel(run, userName)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="run-delete"
                  disabled={!activeRunId || recalling}
                  onClick={() => activeRunId && removeRun(activeRunId)}
                  aria-label="Delete this saved search"
                >
                  ×
                </button>
              </div>
              <p className="hint">
                {recalling
                  ? "Loading that run…"
                  : "Each row is name · timestamp · topic. Pick one to show its match list."}
              </p>
            </div>
            {ranked.length > 0 ? (
              <>
                {rankedTopic && <p className="hint">Ranked for: {rankedTopic}</p>}
                {rankedSavedAt && <p className="hint">Run: {formatRunTime(rankedSavedAt)}</p>}
                <div className="btn-row">
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={() => downloadText(`bizdev_top${ranked.length}_matches.csv`, exportCsv(ranked, drafts), "text/csv")}
                  >
                    Export list
                  </button>
                </div>
                <div className="scroll">
                  {ranked.map((person, i) => (
                    <article className="card" key={person.matchId || person.id}>
                      <div className="card-top">
                        <div>
                          <h3>{i + 1}. {person.name}</h3>
                          <p className="meta">
                            <b>{person.position}</b> at <b>{person.company}</b>
                          </p>
                          {person.email ? (
                            <p className="mail">📧 {person.email}</p>
                          ) : (
                            <p className="mail">No email in export — reach out via LinkedIn.</p>
                          )}
                          <p className="why">Why: {person.reason}</p>
                        </div>
                        <div className="score">{person.score}</div>
                      </div>
                      <button className="btn btn-secondary" type="button" onClick={() => openDraft(person)}>
                        ✍️ Draft message
                      </button>
                    </article>
                  ))}
                </div>
              </>
            ) : (
              <div className="info">Matches will appear here after you upload a list, enter a topic, and find the top {matchCount}.</div>
            )}
          </section>
        </div>
      </main>

      {draftPerson && (
        <div className="modal-backdrop" onClick={() => setDraftPerson(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Draft message</h2>
            {draftBusy && !draft ? (
              <p>Drafting…</p>
            ) : (
              <>
                <div className="email-chrome">
                  <div className="hdr">
                    <div className="row"><span className="lbl">From</span><span>{fromName}</span></div>
                    <div className="row"><span className="lbl">To</span><span>{emailToLine(draftPerson)}</span></div>
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="subject">Subject</label>
                  <input
                    id="subject"
                    value={draft?.subject || ""}
                    onChange={(e) => updateDraft(draftPerson, { subject: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="body">Message</label>
                  <textarea
                    id="body"
                    rows={8}
                    value={draft?.body || ""}
                    onChange={(e) => updateDraft(draftPerson, { body: e.target.value })}
                  />
                </div>
                <div className="actions">
                  <button
                    className="btn btn-primary"
                    type="button"
                    onClick={() => {
                      const eml = `From: ${fromName}\nTo: ${emailToLine(draftPerson)}\nSubject: ${draft?.subject || ""}\nMIME-Version: 1.0\nContent-Type: text/plain; charset=utf-8\n\n${draft?.body || ""}\n`;
                      const fname = `outreach_${(draftPerson.name || "contact").replace(/\s+/g, "_")}.eml`;
                      downloadText(fname, eml, "message/rfc822");
                    }}
                  >
                    Download .eml
                  </button>
                  <button className="btn btn-secondary" type="button" onClick={() => setDraftPerson(null)}>
                    Close
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
