import { useEffect, useMemo, useState } from "react";
import { parseLinkedInCsv, rowsToRoster } from "./lib/csv";
import { scoreBatch, generateDraft, emailToLine, exportCsv } from "./lib/openai";
import { loadSettings, saveSettings, loadTop10, saveTop10, normalizeMatchCount } from "./lib/storage";
import "./App.css";

const BATCH_SIZE = 60;
const savedSettings = loadSettings();
const savedTop10 = loadTop10();

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

export default function App() {
  const [openaiApiKey, setOpenaiApiKey] = useState(savedSettings.openaiApiKey || "");
  const [userName, setUserName] = useState(savedSettings.userName || "");
  const [userHeadline, setUserHeadline] = useState(savedSettings.userHeadline || "");
  const [matchCount, setMatchCount] = useState(normalizeMatchCount(savedSettings.matchCount));
  const [darkMode, setDarkMode] = useState(initialDarkMode);
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);
  const [csvError, setCsvError] = useState("");
  const [topic, setTopic] = useState(savedTop10?.rankedTopic || "");
  const [ranked, setRanked] = useState(savedTop10?.ranked || []);
  const [rankedTopic, setRankedTopic] = useState(savedTop10?.rankedTopic || "");
  const [drafts, setDrafts] = useState(savedTop10?.drafts || {});
  const [ranking, setRanking] = useState(false);
  const [processed, setProcessed] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");
  const [draftPerson, setDraftPerson] = useState(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    saveSettings({ openaiApiKey, userName, userHeadline, matchCount, darkMode });
  }, [openaiApiKey, userName, userHeadline, matchCount, darkMode]);

  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? "dark" : "light";
  }, [darkMode]);

  useEffect(() => {
    if (ranked.length) saveTop10({ ranked, rankedTopic, drafts });
  }, [ranked, rankedTopic, drafts]);

  const previewRows = useMemo(() => rows.slice(0, 20), [rows]);

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
    if (!openaiApiKey.trim()) {
      setError("Add your OpenAI API key in Setup first.");
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
            apiKey: openaiApiKey.trim(),
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
      setRanked(top);
      setRankedTopic(topic);
      setDrafts({});
    } finally {
      setRanking(false);
    }
  }

  async function openDraft(person) {
    setDraftPerson(person);
    const key = String(person.id);
    if (drafts[key]) return;
    if (!openaiApiKey.trim()) {
      setError("Add your OpenAI API key in Setup first.");
      return;
    }
    setDraftBusy(true);
    try {
      const draft = await generateDraft({
        apiKey: openaiApiKey.trim(),
        userName,
        userHeadline,
        person,
        topic: rankedTopic || topic,
      });
      setDrafts((d) => ({ ...d, [key]: draft }));
    } catch (e) {
      setError(`Couldn't draft this message: ${e.message || e}`);
      setDraftPerson(null);
    } finally {
      setDraftBusy(false);
    }
  }

  function updateDraft(personId, patch) {
    const key = String(personId);
    setDrafts((d) => ({ ...d, [key]: { ...(d[key] || {}), ...patch } }));
  }

  const left = Math.max(0, total - processed);
  const draft = draftPerson ? drafts[String(draftPerson.id)] : null;
  const fromName = userName || "Me";

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
          <input
            type="password"
            value={openaiApiKey}
            onChange={(e) => setOpenaiApiKey(e.target.value)}
            placeholder="sk-..."
            autoComplete="off"
          />
          <span className="hint">Saved in this browser only. Get a key at platform.openai.com.</span>
        </div>
        <hr className="div" />
        <h3>Your LinkedIn Profile</h3>
        <p className="hint">Used so drafted messages sound like you. Saved in this browser.</p>
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
        <div className="field">
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
        <hr className="div" />
        <p className="fine">
          This app never logs into LinkedIn or scrapes it. You provide your own connections export,
          and all outreach messages are drafted for you to send manually.
        </p>
      </aside>

      <main className="main">
        <h1>🤝 BizDev Coworker</h1>
        <p className="lede">Inside-sales coworker: rank connections for a topic, then draft outreach to send yourself.</p>
        {!openaiApiKey.trim() && (
          <div className="warn">Add your OpenAI API key in Setup to get started.</div>
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
            {ranked.length > 0 ? (
              <>
                {rankedTopic && <p className="hint">Ranked for: {rankedTopic}</p>}
                <p className="hint">Saved in this browser — the list stays after refresh.</p>
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
                    <article className="card" key={person.id}>
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
                    onChange={(e) => updateDraft(draftPerson.id, { subject: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="body">Message</label>
                  <textarea
                    id="body"
                    rows={8}
                    value={draft?.body || ""}
                    onChange={(e) => updateDraft(draftPerson.id, { body: e.target.value })}
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
