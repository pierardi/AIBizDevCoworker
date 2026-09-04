const SETTINGS_KEY = "bizdev-settings";
const TOP10_KEY = "bizdev-top10";
const RUNS_KEY = "bizdev-runs";
const MIGRATED_KEY = "bizdev-runs-migrated";

export function normalizeMatchCount(value, fallback = 10) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(1, n));
}

export function formatRunTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    return {
      openaiApiKey: typeof data.openaiApiKey === "string" ? data.openaiApiKey : "",
      userName: typeof data.userName === "string" ? data.userName : "",
      darkMode: typeof data.darkMode === "boolean" ? data.darkMode : undefined,
    };
  } catch {
    return {};
  }
}

export function saveSettings(settings) {
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({
      openaiApiKey: settings.openaiApiKey || "",
      userName: settings.userName || "",
      darkMode: Boolean(settings.darkMode),
    }),
  );
}

function sortRuns(runs) {
  return [...runs].sort((a, b) => String(b.savedAt || "").localeCompare(String(a.savedAt || "")));
}

function migrateLegacyRun() {
  try {
    const raw = localStorage.getItem(TOP10_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!Array.isArray(data.ranked) || !data.ranked.length) return null;
    return {
      topic: data.rankedTopic || "",
      savedAt: data.savedAt || new Date().toISOString(),
      ranked: data.ranked,
      drafts: data.drafts && typeof data.drafts === "object" ? data.drafts : {},
    };
  } catch {
    return null;
  }
}

export function loadLocalRuns() {
  let runs = [];
  try {
    const raw = localStorage.getItem(RUNS_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (Array.isArray(data.runs)) runs = data.runs;
    }
  } catch {
    runs = [];
  }
  if (!runs.length) {
    const legacy = migrateLegacyRun();
    if (legacy) runs = [legacy];
  }
  return sortRuns(runs);
}

export function localRunsPendingMigration() {
  if (localStorage.getItem(MIGRATED_KEY)) return [];
  return loadLocalRuns();
}

export function markRunsMigrated() {
  localStorage.setItem(MIGRATED_KEY, "1");
}
