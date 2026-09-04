const USER_KEY = "bizdev-user-name";
const API_BASE = import.meta.env.VITE_API_URL || "";

export function normalizeUserKey(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function getStoredUserName() {
  return localStorage.getItem(USER_KEY) || "";
}

export function setStoredUserName(name) {
  const trimmed = String(name || "").trim().replace(/\s+/g, " ");
  if (trimmed) localStorage.setItem(USER_KEY, trimmed);
  else localStorage.removeItem(USER_KEY);
  localStorage.removeItem("bizdev-user-id");
}

function headers() {
  const result = { "Content-Type": "application/json" };
  const name = getStoredUserName();
  if (name) result["X-User-Name"] = encodeURIComponent(name);
  return result;
}

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...headers(), ...options.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || res.statusText || "Request failed");
  }
  return data;
}

export async function getSession(name) {
  if (name != null) setStoredUserName(name);
  if (!normalizeUserKey(getStoredUserName())) {
    throw new Error("Enter your name in Setup to load and save searches.");
  }
  return request("/api/session");
}

export function updateSettings(settings) {
  return request("/api/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export function listRuns() {
  return request("/api/runs");
}

export function getRun(runId) {
  return request(`/api/runs/${runId}`);
}

export function createRun({ topic, requestedCount, matches }) {
  return request("/api/runs", {
    method: "POST",
    body: JSON.stringify({ topic, requestedCount, matches }),
  });
}

export function deleteRun(runId) {
  return request(`/api/runs/${runId}`, { method: "DELETE" });
}

export function saveDraft(matchId, draft) {
  return request(`/api/matches/${matchId}/draft`, {
    method: "PUT",
    body: JSON.stringify({
      subject: draft?.subject || "",
      body: draft?.body || "",
    }),
  });
}

export function matchesFromRanked(ranked, drafts = {}) {
  return ranked.map((person, index) => ({
    rank: index + 1,
    sourceContactId: Number.isInteger(person.id) ? person.id : null,
    name: person.name || "",
    position: person.position || "",
    company: person.company || "",
    email: person.email || "",
    score: person.score || 0,
    reason: person.reason || "",
    draft: drafts[String(person.id)] || null,
  }));
}
