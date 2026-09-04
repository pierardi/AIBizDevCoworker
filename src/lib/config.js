export const envOpenAiKey = String(import.meta.env.VITE_OPENAI_API_KEY || "").trim();

export function resolveOpenAiKey(userKey) {
  return envOpenAiKey || String(userKey || "").trim();
}
