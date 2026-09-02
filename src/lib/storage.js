const SETTINGS_KEY = "bizdev-settings";
const TOP10_KEY = "bizdev-top10";

export function normalizeMatchCount(value, fallback = 10) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(1, n));
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    return {
      openaiApiKey: typeof data.openaiApiKey === "string" ? data.openaiApiKey : "",
      userName: typeof data.userName === "string" ? data.userName : "",
      userHeadline: typeof data.userHeadline === "string" ? data.userHeadline : "",
      matchCount: normalizeMatchCount(data.matchCount),
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
      userHeadline: settings.userHeadline || "",
      matchCount: normalizeMatchCount(settings.matchCount),
      darkMode: Boolean(settings.darkMode),
    }),
  );
}

export function loadTop10() {
  try {
    const raw = localStorage.getItem(TOP10_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!Array.isArray(data.ranked) || !data.ranked.length) return null;
    return {
      ranked: data.ranked,
      rankedTopic: data.rankedTopic || "",
      drafts: data.drafts && typeof data.drafts === "object" ? data.drafts : {},
    };
  } catch {
    return null;
  }
}

export function saveTop10({ ranked, rankedTopic, drafts }) {
  if (!ranked?.length) return;
  localStorage.setItem(
    TOP10_KEY,
    JSON.stringify({
      savedAt: new Date().toISOString(),
      rankedTopic: rankedTopic || "",
      ranked,
      drafts: drafts || {},
    }),
  );
}
