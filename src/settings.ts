/**
 * QMD global settings — runtime-configurable parameters.
 *
 * Persisted to ~/.config/qmd/settings.json. Replaces the many hardcoded
 * constants scattered across chunking.ts / hybrid-search.ts / search.ts / store.ts
 * so they can be tuned at runtime (CLI now; HTTP API for the frontend in Phase 2).
 *
 * Precedence: runtime updateSettings() > settings.json > built-in defaults.
 */
import { homedir } from "os";
import { join, dirname } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";

export const QMD_CONFIG_DIR = join(homedir(), ".config", "qmd");
export const SETTINGS_PATH = join(QMD_CONFIG_DIR, "settings.json");
export const USERS_DIR = join(QMD_CONFIG_DIR, "users");
export const TOKENS_PATH = join(QMD_CONFIG_DIR, "tokens.json");

// Built-in model defaults (kept as literals here to avoid an import cycle with llm.ts).
const DEFAULT_EMBED_MODEL_URI = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";
const DEFAULT_RERANK_MODEL_URI = "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf";
// Local GGUF used for query expansion. MUST stay in sync with DEFAULT_GENERATE_MODEL in llm.ts.
const DEFAULT_QUERY_EXPANSION_MODEL = "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf";
const DEFAULT_MODEL_CACHE_DIR = join(QMD_CONFIG_DIR, "models");

export const QmdSettingsSchema = z.object({
  // --- Chunking ---
  chunkSizeTokens: z.number().int().positive().default(900),
  chunkOverlapRatio: z.number().min(0).max(0.9).default(0.15),
  chunkWindowTokens: z.number().int().positive().default(200),

  // --- Retrieval / search ---
  queryLimit: z.number().int().positive().default(10),
  minScore: z.number().min(0).max(1).default(0),
  candidateLimit: z.number().int().positive().default(40),
  strongSignalMinScore: z.number().min(0).max(1).default(0.85),
  strongSignalMinGap: z.number().min(0).max(1).default(0.15),
  intentWeightSnippet: z.number().min(0).default(0.3),
  intentWeightChunk: z.number().min(0).default(0.5),
  rrfK: z.number().positive().default(60),

  // --- Embedding ---
  embedBatchSize: z.number().int().positive().default(32),
  // When true (default), writeDocument() auto-runs an incremental embed of the
  // affected collection so freshly written pages are immediately retrievable.
  // Turn OFF for high-volume batch wiki writes, then run a single `qmd embed`
  // (or POST /api/embed) at the end to build all vectors in one pass.
  autoEmbedOnWrite: z.boolean().default(true),

  // --- Answer-generation LLM (RAG synthesis) ---
  // Defaults read env LLM_BASE_URL / LLM_API_KEY / LLM_MODEL; can be overridden
  // persistently via `qmd config set` (note: the API key is then stored in plaintext).
  llmBaseUrl: z.string().default(process.env.LLM_BASE_URL ?? ""),
  llmApiKey: z.string().default(process.env.LLM_API_KEY ?? ""),
  llmModel: z.string().default(process.env.LLM_MODEL ?? ""),

  // --- Models (reserved; effective switching wired up in Phase 2 session layer) ---
  embedModel: z.string().default(DEFAULT_EMBED_MODEL_URI),
  rerankModel: z.string().default(DEFAULT_RERANK_MODEL_URI),
  // Whether to run the local reranker over retrieval candidates.
  // Default OFF: ranking falls back to BM25 + vector cosine scores, so the
  // rerank model is not loaded at all until explicitly enabled (UI checkbox /
  // CLI --rerank / MCP skipRerank=false). Turn on for maximum ranking precision.
  enableRerank: z.boolean().default(false),
  // Whether to run LLM query expansion (typed lex/vec/hyde variants).
  // Default OFF: queries skip the expansion model entirely, so it is not
  // loaded until explicitly enabled (UI checkbox). Turn on for richer
  // multi-variant retrieval at the cost of loading the expansion model.
  enableQueryExpansion: z.boolean().default(false),
  queryExpansionModel: z.string().default(DEFAULT_QUERY_EXPANSION_MODEL),
  modelCacheDir: z.string().default(DEFAULT_MODEL_CACHE_DIR),
});

export type QmdSettings = z.infer<typeof QmdSettingsSchema>;

let cache: QmdSettings | null = null;

// Per-user request context. The HTTP API sets this via AsyncLocalStorage so that
// `getSettings()` automatically returns the calling user's merged config without
// threading a userId through every core-layer function signature.
const userContext = new AsyncLocalStorage<string | undefined>();
export function runWithUser<T>(uid: string | undefined, fn: () => T): T {
  return userContext.run(uid, fn);
}
export function runWithUserAsync<T>(uid: string | undefined, fn: () => Promise<T>): Promise<T> {
  return userContext.run(uid, fn);
}
export function getUserContext(): string | undefined {
  return userContext.getStore();
}

/** Load settings from disk (or cache). Missing/invalid fields fall back to defaults. */
export function loadSettings(force = false): QmdSettings {
  if (cache && !force) return cache;
  let raw: Record<string, unknown> = {};
  try {
    if (existsSync(SETTINGS_PATH)) {
      raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    }
  } catch {
    raw = {};
  }
  const parsed = QmdSettingsSchema.parse(raw);
  cache = parsed;
  return parsed;
}

/** Get the current settings (loads from disk on first call).
 *  When running inside a user context (set by the API via AsyncLocalStorage),
 *  returns the global defaults merged with that user's per-user override layer. */
export function getSettings(): QmdSettings {
  const base = cache ?? loadSettings();
  const uid = getUserContext();
  if (!uid) return base;
  const overlay = getUserOverlay(uid);
  if (!overlay || Object.keys(overlay).length === 0) return base;
  return QmdSettingsSchema.parse({ ...base, ...overlay });
}

/** Merge a partial update, validate, persist to disk, and update the in-memory cache. */
export function updateSettings(partial: Partial<QmdSettings>): QmdSettings {
  const current = getSettings();
  const merged = { ...current, ...partial };
  const parsed = QmdSettingsSchema.parse(merged);
  cache = parsed;
  persist(parsed);
  return parsed;
}

/** Reset all settings to built-in defaults and persist. */
export function resetSettings(): QmdSettings {
  const parsed = QmdSettingsSchema.parse({});
  cache = parsed;
  persist(parsed);
  return parsed;
}

function persist(settings: QmdSettings): void {
  try {
    if (!existsSync(QMD_CONFIG_DIR)) mkdirSync(QMD_CONFIG_DIR, { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
  } catch (e) {
    process.stderr.write(`qmd: failed to persist settings: ${(e as Error).message}\n`);
  }
}

// =============================================================================
// Per-user configuration overlay
//
// Design: a single global "default layer" (settings.json) plus one override
// layer per user (users/<userId>.json#settings). getSettings() merges them.
// Users may only write a whitelist of safe, per-request-relevant fields;
// index/chunking/model-body fields are intentionally NOT user-writable because
// the index is shared across all users on a single instance.
// Storage is file-based (under ~/.config/qmd) to stay dependency-free and avoid
// an import cycle with the DB layer.
// =============================================================================

/** Settings a user is allowed to override for themselves. */
export const USER_WRITABLE_SETTINGS = new Set<string>([
  // Retrieval numeric params (safe, read-time only)
  "queryLimit", "minScore", "candidateLimit",
  "strongSignalMinScore", "strongSignalMinGap",
  "intentWeightSnippet", "intentWeightChunk", "rrfK",
  // Answer-generation LLM (user brings their own key)
  "llmBaseUrl", "llmApiKey", "llmModel",
  // Toggles (per-request skip; note enabling loads the global model)
  "enableRerank", "enableQueryExpansion",
]);

function readJson<T>(p: string, fallback: T): T {
  try {
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(p: string, obj: unknown): void {
  if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}
function getUserFile(uid: string): string {
  return join(USERS_DIR, `${uid}.json`);
}
function readTokens(): Record<string, string> {
  return readJson<Record<string, string>>(TOKENS_PATH, {});
}
function writeTokens(t: Record<string, string>): void {
  writeJson(TOKENS_PATH, t);
}

/** Map a bearer token to its userId, or undefined if invalid. */
export function resolveUser(token: string | undefined): string | undefined {
  if (!token) return undefined;
  return readTokens()[token];
}

/** Create a user (random userId + random token) and persist both mappings.
 *  Optionally attach a login username/password so the account can authenticate
 *  via the username/password login endpoint (as opposed to a bare bearer token). */
export function createUser(
  name?: string,
  username?: string,
  password?: string,
): { userId: string; token: string; name: string; username?: string } {
  const cleanName = name || "user";
  if (username && findUserByUsername(username)) {
    throw new Error(`用户名已存在: ${username}`);
  }
  const userId = randomUUID();
  const token = issueToken(userId);
  const uf = getUserFile(userId);
  if (!existsSync(uf)) {
    writeJson(uf, {
      name: cleanName,
      username: username || undefined,
      passwordHash: password ? hashPassword(password) : undefined,
      createdAt: Date.now(),
      settings: {},
    });
  }
  return { userId, token, name: cleanName, username };
}

/** Hash a plaintext password with scrypt + random salt. Returns `scrypt$salt$hash`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/** Constant-time verify a plaintext password against a hash from hashPassword(). */
export function verifyPassword(storedHash: string, password: string): boolean {
  const parts = storedHash.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const saltHex = parts[1];
  const expectedHex = parts[2];
  if (!saltHex || !expectedHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(expectedHex, "hex");
  const actual = scryptSync(password, salt, expected.length);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** Find a userId by its unique login username, or undefined if not found. */
export function findUserByUsername(username: string): string | undefined {
  try {
    if (!existsSync(USERS_DIR)) return undefined;
    for (const f of readdirSync(USERS_DIR)) {
      if (!f.endsWith(".json")) continue;
      const u = readJson<{ username?: string }>(join(USERS_DIR, f), {});
      if (u.username && u.username === username) return f.slice(0, -5); // strip ".json"
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/** Set (or replace) a user's password hash. */
export function setUserPassword(userId: string, password: string): void {
  const uf = getUserFile(userId);
  const u = readJson<Record<string, unknown>>(uf, {});
  u.passwordHash = hashPassword(password);
  writeJson(uf, u);
}

/** Verify username/password against the file-based user store. Returns userId or null. */
export function fileVerifyCredentials(username: string, password: string): string | null {
  const userId = findUserByUsername(username);
  if (!userId) return null;
  const u = readJson<{ passwordHash?: string }>(getUserFile(userId), {});
  if (!u.passwordHash) return null; // account has no password set (token-only)
  if (!verifyPassword(u.passwordHash, password)) return null;
  return userId;
}

/** Issue a new bearer token for an existing userId and persist it to tokens.json. */
export function issueToken(userId: string): string {
  const token = randomBytes(24).toString("hex");
  const tokens = readTokens();
  tokens[token] = userId;
  writeTokens(tokens);
  return token;
}

/** Revoke a token (does not delete the user's override layer). */
export function revokeToken(token: string): boolean {
  const tokens = readTokens();
  if (tokens[token]) {
    delete tokens[token];
    writeTokens(tokens);
    return true;
  }
  return false;
}

/** List all users (token, userId, name, createdAt). */
export function listUsers(): Array<{ token: string; userId: string; name: string; createdAt?: number }> {
  const tokens = readTokens();
  return Object.entries(tokens).map(([token, userId]) => {
    const u = readJson<{ name?: string; createdAt?: number }>(getUserFile(userId), {});
    return { token, userId, name: u.name || "user", createdAt: u.createdAt };
  });
}

/** Read a user's raw record (or null if missing). */
export function getUserRecord(userId: string): Record<string, unknown> | null {
  const uf = getUserFile(userId);
  return existsSync(uf) ? readJson<Record<string, unknown>>(uf, {}) : null;
}

function getUserOverlay(uid: string): Partial<QmdSettings> {
  const u = readJson<{ settings?: Partial<QmdSettings> }>(getUserFile(uid), {});
  return u.settings ?? {};
}

/** Get the fully-merged settings for a user (default layer + their overlay). */
export function getUserSettings(uid: string | undefined): QmdSettings {
  const base = cache ?? loadSettings();
  const overlay = uid ? getUserOverlay(uid) : {};
  return QmdSettingsSchema.parse({ ...base, ...overlay });
}

/**
 * Write a user's override layer. Only whitelisted fields are accepted; the rest
 * are returned in `rejected` so the caller can warn the user.
 * When uid is undefined (anonymous / admin), falls back to the global update.
 */
export function setUserSettings(
  uid: string | undefined,
  partial: Partial<QmdSettings>,
): { settings: QmdSettings; accepted: string[]; rejected: string[] } {
  if (!uid) {
    const merged = updateSettings(partial);
    return { settings: merged, accepted: Object.keys(partial), rejected: [] };
  }
  const u = readJson<{ name?: string; createdAt?: number; settings?: Partial<QmdSettings> }>(
    getUserFile(uid),
    { name: "user", createdAt: Date.now(), settings: {} },
  );
  const accepted: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const [k, v] of Object.entries(partial ?? {})) {
    if (USER_WRITABLE_SETTINGS.has(k)) accepted[k] = v;
    else rejected.push(k);
  }
  u.settings = { ...(u.settings || {}), ...accepted };
  writeJson(getUserFile(uid), u);
  const merged = QmdSettingsSchema.parse({ ...(cache ?? loadSettings()), ...u.settings });
  return { settings: merged, accepted: Object.keys(accepted), rejected };
}

/** Delete a user's override layer (revert to global defaults). */
export function deleteUserSettings(uid: string | undefined): QmdSettings {
  if (!uid) return resetSettings();
  const u = readJson<{ name?: string; createdAt?: number; settings?: Partial<QmdSettings> } | null>(
    getUserFile(uid),
    null,
  );
  if (u) {
    u.settings = {};
    writeJson(getUserFile(uid), u);
  }
  return cache ?? loadSettings();
}
