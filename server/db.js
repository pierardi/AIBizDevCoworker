import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

function firstEnv(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (value != null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

const ssl =
  firstEnv("PGSSLMODE", "database_sslmode") === "disable"
    ? false
    : { rejectUnauthorized: false };

const connectionString = firstEnv("DATABASE_URL", "database_url");

export const pool = new pg.Pool(
  connectionString
    ? { connectionString, ssl, max: 8, connectionTimeoutMillis: 15_000 }
    : {
        host: firstEnv("PGHOST", "database_host", "DB_HOST", "RDS_HOSTNAME"),
        port: Number(firstEnv("PGPORT", "database_port", "DB_PORT", "RDS_PORT") || 5432),
        database: firstEnv("PGDATABASE", "database_name", "database", "DB_NAME", "RDS_DB_NAME"),
        user: firstEnv("PGUSER", "database_user", "database_username", "DB_USER", "RDS_USERNAME"),
        password: firstEnv("PGPASSWORD", "database_password", "DB_PASSWORD", "RDS_PASSWORD"),
        ssl,
        max: 8,
        connectionTimeoutMillis: 15_000,
      },
);

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

export function displayName(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

export function normalizeUserKey(value) {
  return displayName(value).toLowerCase();
}

export function clampMatchCount(value, fallback = 10) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(1, n));
}

export function iso(value) {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}
