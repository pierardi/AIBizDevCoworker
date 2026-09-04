import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

function firstValue(...values) {
  for (const value of values) {
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return "";
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const openaiKey = firstValue(
    env.VITE_OPENAI_API_KEY,
    env.openai_api_key,
    env.OPENAI_API_KEY,
    process.env.VITE_OPENAI_API_KEY,
    process.env.openai_api_key,
    process.env.OPENAI_API_KEY,
  );

  return {
    plugins: [react()],
    base: "/",
    define: {
      "import.meta.env.VITE_OPENAI_API_KEY": JSON.stringify(openaiKey),
    },
    server: {
      proxy: {
        "/api": "http://127.0.0.1:8787",
      },
    },
  };
});

