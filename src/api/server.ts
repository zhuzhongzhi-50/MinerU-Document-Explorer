/**
 * QMD HTTP API server (Phase 2).
 *
 * A small JSON API layered on top of the existing Store, exposing the same
 * hybrid-search pipeline the CLI/MCP use, plus runtime config management and
 * RAG answer synthesis. Built on Node's built-in `http` module (no new deps),
 * mirroring the transport style of ../mcp/server.ts.
 *
 * Routes:
 *   GET  /health
 *   GET  /api/config            -> current (per-user merged) settings
 *   PUT  /api/config            -> write per-user override layer (whitelisted fields)
 *   POST /api/config/reset      -> clear caller's override layer
 *   GET  /api/users  (admin)    -> list users            [requires QMD_ADMIN_TOKEN]
 *   POST /api/users  (admin)    -> create user + token   [requires QMD_ADMIN_TOKEN]
 *   POST /api/query             -> { query, collections?, limit?, minScore?, topK?, intent?, mode?, hybrid? }
 *                                    -> SSE: token* + done { answer, model, error?, sources, rawResults[{...,kind}] }
 *                                       mode (default "hybrid"): "hybrid"=raw+wiki, "wiki"=wiki-only, "raw"=raw-only
 *                                       hybrid:false is accepted as a synonym for mode:"raw" (backward compat)
 *   POST /api/ask              -> { query, collections?, limit?, minScore?, topK?, intent?, mode?, hybrid? }
 *                                    -> { query, model, answer, error?, sources, rawResults[{...,kind}] } (JSON)
 *                                       mode (default "hybrid"): "hybrid"=raw+wiki, "wiki"=wiki-only, "raw"=raw-only
 *                                       hybrid:false is accepted as a synonym for mode:"raw" (backward compat)
 *   POST /api/retrieve         -> { query, collection?, collections?, top_k?, limit?, minScore?, intent?, mode? }
 *       -> { query, collections, retrievalHint?, rawResults[{file,title,kind,score,bestChunk,chunks}] } (JSON, NO LLM)
 *   GET  /api/chat/sessions    -> list current user's chat sessions (scoped by Bearer token)
 *   POST /api/chat/sessions     -> create session { title?, collections?, mode? } -> { id, title, ... }
 *   GET  /api/chat/sessions/:id -> session detail + messages (owner-checked)
 *   PATCH /api/chat/sessions/:id-> rename session { title }
 *   DELETE /api/chat/sessions/:id -> delete session (and its messages)
 *   (persistence) POST /api/query & POST /api/ask accept { sessionId } to append the
 *                 Q&A pair to that session; ownership is verified before writing.
 *   POST /api/embed             -> { collections?, force? } trigger (re)embedding
 *   GET  /api/collections       -> list collections (name/path/pattern)
 *   POST /api/documents         -> multipart { collection, file, autoIndex? } upload a
 *                                    document into a collection and optionally build index
 *   POST /api/models/warm       -> { kind?: "expand" | "rerank" } preload model, returns { ok, ms }
 *
 * Auth: all /api routes require `Authorization: Bearer <token>` unless
 * QMD_ALLOW_ANONYMOUS=true (local dev). CORS is allowlist-based via
 * QMD_ALLOWED_ORIGINS (falls back to "*" when unset, for local dev).
 * Per-user config relies on AsyncLocalStorage; see ../settings.ts.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDefaultDbPath } from "../index.js";
import { getConfigPath, configExists } from "../collections.js";
import {
  getSettings,
  runWithUserAsync,
  resolveUser,
  getUserSettings,
  setUserSettings,
  deleteUserSettings,
  createUser,
  listUsers,
  issueToken,
  revokeToken,
  getUserRecord,
  type QmdSettings,
} from "../settings.js";
import { getCredentialVerifier } from "../auth.js";
import { generateAnswer, generateDirectAnswer, type RagSearchResult } from "../rag.js";
import { withLLMSession } from "../llm.js";
import {
  DEFAULT_EMBED_MODEL,
  type SearchHooks,
  reindexCollection,
  listCollections,
  removeCollection,
  renameCollection,
  isWikiCollection,
  handelize,
} from "../store.js";
import { removeCollection as removeCollectionFromConfig } from "../collections.js";
import { updateSettings } from "../settings.js";
import {
  createIntakeSession,
  listIntakeSessions,
  getIntakeSession,
  getIntakeRecords,
  addIntakeRecord,
  setIntakeSessionStatus,
  generateNextQuestion,
  formatSummary,
} from "../intake.js";
import {
  createChatSession,
  listChatSessions,
  getChatSession,
  getChatOwner,
  getChatMessages,
  addChatMessage,
  renameChatSession,
  deleteChatSession,
} from "../chat.js";
import { appendLog } from "../wiki/log.js";
import { ensureContractReviewSchema } from "../contract-review/db-init.js";
import { handleContractReviewRoutes } from "../contract-review/api.js";
import {
  ensureScenarioManifestSchema,
  registerScenarioManifest,
  listScenarioManifests,
  getScenarioManifest,
} from "../scenario-manifest.js";
import {
  getContractMeta,
  upsertContractMeta,
  getCollectionTags,
} from "../contract-review/db.js";

export type ApiServerHandle = {
  httpServer: import("http").Server;
  port: number;
  stop: () => Promise<void>;
};

function json(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

async function collectBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

function safeParse(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

async function serveStatic(res: ServerResponse, root: string, pathname: string): Promise<void> {
  const rel = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const filePath = path.normalize(path.join(root, rel));
  const relPath = path.relative(root, filePath);
  if (relPath.startsWith("..") || path.isAbsolute(relPath)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }
  try {
    const data = await fs.promises.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": STATIC_MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

/**
 * Parse a multipart/form-data request body (used by the document upload route).
 * Node 22 ships the Web `Request`/`FormData` globals, so we wrap the raw
 * IncomingMessage stream and let the built-in parser handle boundaries — no new
 * dependency required (this project deliberately avoids adding one).
 */
async function parseMultipart(req: IncomingMessage): Promise<{
  fields: Record<string, string>;
  files: { name: string; filename: string; data: Buffer }[];
}> {
  const init: any = {
    method: req.method,
    headers: req.headers,
    body: req,
    duplex: "half",
  };
  const webReq = new Request(`http://localhost${req.url ?? "/"}`, init);
  const form = await webReq.formData();
  const fields: Record<string, string> = {};
  const files: { name: string; filename: string; data: Buffer }[] = [];
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") {
      fields[key] = value;
    } else {
      const f = value as File;
      files.push({ name: key, filename: f.name, data: Buffer.from(await f.arrayBuffer()) });
    }
  }
  return { fields, files };
}

// ---- Auth & CORS ----
const ALLOWED_ORIGINS = (process.env.QMD_ALLOWED_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const ALLOW_ANONYMOUS = process.env.QMD_ALLOW_ANONYMOUS === "true";
const ADMIN_TOKEN = process.env.QMD_ADMIN_TOKEN || "";

function applyCors(res: ServerResponse, req: IncomingMessage): void {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.length === 0) {
    res.setHeader("Access-Control-Allow-Origin", "*"); // local-dev convenience
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS,DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function extractToken(req: IncomingMessage): string | undefined {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return undefined;
}

function isPublicRoute(pathname: string, method: string): boolean {
  if (pathname === "/health") return true;
  if (method === "OPTIONS") return true;
  if (pathname === "/api/auth/login") return true; // public login endpoint
  if (!pathname.startsWith("/api/")) return true; // static frontend assets
  return false;
}

// ---- Login hardening: per-IP rate limiting + failure logging ----
const LOGIN_RATE_LIMIT = 5; // max attempts
const LOGIN_RATE_WINDOW_MS = 60_000; // within a 1-minute sliding window
const loginAttempts = new Map<string, number[]>();

function getClientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return (fwd.split(",")[0] || "").trim();
  return req.socket.remoteAddress || "unknown";
}

/** Record a failed login attempt for the given IP. */
function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const arr = (loginAttempts.get(ip) || []).filter((t) => now - t < LOGIN_RATE_WINDOW_MS);
  arr.push(now);
  loginAttempts.set(ip, arr);
}

/** True if the IP has exhausted its login attempts for the current window. */
function isLoginRateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (loginAttempts.get(ip) || []).filter((t) => now - t < LOGIN_RATE_WINDOW_MS);
  loginAttempts.set(ip, arr);
  return arr.length >= LOGIN_RATE_LIMIT;
}

function logAuthFailure(ip: string, username: string): void {
  process.stderr.write(
    `[auth] login failed ip=${ip} user=${username || "?"} ${new Date().toISOString()}\n`,
  );
}

export async function startApiServer(
  port: number,
  options?: { host?: string; dbPath?: string; quiet?: boolean },
): Promise<ApiServerHandle> {
  const { createStore } = await import("../index.js");
  const configPath = configExists() ? getConfigPath() : undefined;
  const store = await createStore({
    dbPath: options?.dbPath ?? getDefaultDbPath(),
    ...(configPath ? { configPath } : {}),
  });

  // 启动时确保合同审查场景所需的表与种子已就绪（表结构 + 合同类型主数据 +
  // 运营类风险规则库）。仅在 risk_rules 为空时导入规则，避免覆盖用户在界面上的
  // 启用/禁用改动。失败不阻断启动，reviewContract 内部会在首次审查时再次尝试。
  try {
    const seeded = ensureContractReviewSchema(store.internal.db);
    if (seeded.rulesSeeded > 0 && !options?.quiet) {
      console.log(`[review] 已自动导入运营类风险规则库：${seeded.rulesSeeded} 条`);
    }
  } catch (e) {
    if (!options?.quiet) console.warn("[review] 合同审查场景初始化失败（首次审查时将重试）：", e);
  }

  const defaultCollections = await store.getDefaultCollectionNames();
  const startTime = Date.now();
  // Static frontend assets live in dist/web (copied from src/web by build-dist.js).
  const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");

  // Resolve which collections to query given an explicit request (if any) and
  // the retrieval mode:
  //   mode:"hybrid" (default) -> raw collections (if any) + all "wiki" collections
  //   mode:"raw"              -> raw collections only (wiki never consulted)
  //   mode:"wiki"             -> wiki collections only (raw collections ignored)
  // `hybrid:false` is accepted as a synonym for mode:"raw" (backward compat).
  // Returns the final collection list plus the set of wiki collection names,
  // which callers use to tag each result's provenance ("raw" vs "wiki").
  async function resolveHybridCollections(
    body: Record<string, unknown>,
    base: string[] | undefined,
  ): Promise<{ collections: string[] | undefined; wikiSet: Set<string> | null }> {
    const mode: "hybrid" | "raw" | "wiki" =
      body.mode === "wiki" || body.mode === "raw"
        ? (body.mode as "wiki" | "raw")
        : body.hybrid === false
          ? "raw"
          : "hybrid";
    if (mode === "raw") {
      return { collections: base, wikiSet: null };
    }
    let wikiNames: string[] = [];
    try {
      const all = await store.listCollections();
      wikiNames = all.filter((c: any) => c.type === "wiki").map((c: any) => c.name);
    } catch {
      wikiNames = [];
    }
    if (wikiNames.length === 0) {
      return { collections: base, wikiSet: null };
    }
    const wikiSet = new Set(wikiNames);
    if (mode === "wiki") {
      return { collections: wikiNames, wikiSet }; // wiki-only: ignore raw
    }
    return { collections: Array.from(new Set([...(base ?? []), ...wikiNames])), wikiSet };
  }

  // Build a human-readable explanation of WHY retrieval returned nothing, so the
  // UI can render an actionable empty-state instead of silent blank panels.
  function buildRetrievalHint(
    db: any,
    collections: string[] | undefined,
    wikiSet: Set<string> | null,
    minScore: number,
  ): string {
    if (!collections || collections.length === 0) {
      return "本次未检索到任何片段：未指定任何集合，且默认集合为空。请先在左侧选择或上传文档集合后再提问。";
    }
    const lines: string[] = [];
    for (const c of collections) {
      let docCount = 0;
      let embCount = 0;
      try {
        docCount = (db.prepare(
          "SELECT COUNT(*) c FROM documents WHERE collection=? AND active=1",
        ).get(c) as { c: number }).c;
        embCount = (db.prepare(
          "SELECT COUNT(DISTINCT d.hash) c FROM documents d JOIN content_vectors v ON d.hash=v.hash WHERE d.collection=? AND d.active=1",
        ).get(c) as { c: number }).c;
      } catch { /* tables may not exist yet */ }
      const isWiki = wikiSet?.has(c);
      if (docCount === 0) {
        lines.push(`• 集合「${c}」${isWiki ? "（wiki）" : ""}未注册任何文档 —— 请先上传文档或用 qmd embed 建立索引`);
      } else if (embCount === 0) {
        lines.push(`• 集合「${c}」有 ${docCount} 篇文档，但向量索引为空（0 个向量）—— 请运行 qmd embed ${c} 或在集合页点【嵌入】`);
      } else {
        lines.push(`• 集合「${c}」${isWiki ? "（wiki）" : ""}有 ${docCount} 篇文档、${embCount} 个向量，已正常索引`);
      }
    }
    if (minScore > 0) {
      lines.push(`• 当前最低相似度阈值 minScore = ${minScore}，可能把召回的片段全部过滤掉了 —— 可在「配置 → 检索」调低（如设为 0）后重试`);
    }
    lines.push("建议：换更具体的关键词、切换/勾选正确的集合，或确认目标文档已上传并建索引。");
    return "本次未检索到任何相关片段，可能原因：\n" + lines.join("\n");
  }

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const reqStart = Date.now();
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = url.pathname;
    const method = req.method || "GET";

    // CORS (allowlist-aware; falls back to "*" when no allowlist is set)
    applyCors(res, req);
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // Authenticate: resolve bearer token -> userId. Public routes (health,
      // pre-flight, static) bypass; everything under /api requires a token
      // unless QMD_ALLOW_ANONYMOUS=true (local dev only).
      const token = extractToken(req);
      const uid = token ? resolveUser(token) : undefined;
      if (!uid && !ALLOW_ANONYMOUS && !isPublicRoute(pathname, method)) {
        json(res, 401, { error: "Unauthorized: provide a valid Bearer token" });
        return;
      }
      await runWithUserAsync(uid, async () => {
      if (pathname === "/health" && method === "GET") {
        json(res, 200, { status: "ok", uptime: Math.floor((Date.now() - startTime) / 1000) });
        return;
      }

      // ---- Auth: login (public) ----
      if (pathname === "/api/auth/login" && method === "POST") {
        const ip = getClientIp(req);
        if (isLoginRateLimited(ip)) {
          json(res, 429, { error: "登录尝试过于频繁，请稍后再试" });
          return;
        }
        const body = safeParse(await collectBody(req)) as
          | { username?: string; password?: string }
          | null;
        const username = (body?.username || "").trim();
        const password = body?.password || "";
        const userId = await getCredentialVerifier().verify(username, password);
        if (!userId) {
          recordLoginFailure(ip);
          logAuthFailure(ip, username);
          // Uniform 401 — never reveal whether the user exists (anti-enumeration).
          json(res, 401, { error: "用户名或密码错误" });
          return;
        }
        const token = issueToken(userId);
        const rec = getUserRecord(userId);
        json(res, 200, {
          token,
          userId,
          name: (rec?.name as string) || "user",
          username,
        });
        return;
      }

      // ---- Auth: logout (requires a valid bearer token) ----
      if (pathname === "/api/auth/logout" && method === "POST") {
        if (!token) {
          json(res, 401, { error: "未登录" });
          return;
        }
        revokeToken(token);
        json(res, 200, { ok: true });
        return;
      }

      // ---- User management (admin) ----
      if (pathname === "/api/users" && method === "GET") {
        if (!ADMIN_TOKEN || extractToken(req) !== ADMIN_TOKEN) {
          json(res, 401, { error: "Admin token required" });
          return;
        }
        json(res, 200, { users: listUsers() });
        return;
      }
      if (pathname === "/api/users" && method === "POST") {
        if (!ADMIN_TOKEN) {
          json(res, 501, { error: "Admin token not configured (set QMD_ADMIN_TOKEN)" });
          return;
        }
        if (extractToken(req) !== ADMIN_TOKEN) {
          json(res, 401, { error: "Admin token required" });
          return;
        }
        const bodyU = safeParse(await collectBody(req)) as { name?: string } | null;
        const created = createUser(bodyU?.name);
        json(res, 200, { userId: created.userId, token: created.token, name: created.name });
        return;
      }

      // ---- Config (per-user) ----
      if (pathname === "/api/config" && method === "GET") {
        // getSettings() already reflects the current user's merged config.
        json(res, 200, getSettings());
        return;
      }

      if (pathname === "/api/config" && method === "PUT") {
        const body = safeParse(await collectBody(req));
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          json(res, 400, { error: "Body must be a JSON object of settings to merge" });
          return;
        }
        try {
          const updated = setUserSettings(uid, body as Partial<QmdSettings>);
          json(res, 200, updated);
        } catch (e) {
          json(res, 400, { error: (e as Error).message });
        }
        return;
      }

      if (pathname === "/api/config/reset" && method === "POST") {
        json(res, 200, deleteUserSettings(uid));
        return;
      }

      // ---- Model warm-up (preload a model so the UI can show load progress) ----
      if (pathname === "/api/models/warm" && method === "POST") {
        const body = safeParse(await collectBody(req)) as { kind?: string } | null;
        const kind = body?.kind ?? "expand";
        const t0 = Date.now();
        try {
          await withLLMSession(async (session) => {
            if (kind === "rerank") {
              await session.rerank("__warmup__", [{ file: "", text: "warmup" }]);
            } else {
              await session.expandQuery("__warmup__");
            }
          });
          json(res, 200, { ok: true, kind, ms: Date.now() - t0 });
        } catch (e) {
          json(res, 200, { ok: false, kind, ms: Date.now() - t0, error: (e as Error).message });
        }
        return;
      }

      // ---- Query + RAG ----
      if (pathname === "/api/query" && method === "POST") {
        const body = safeParse(await collectBody(req)) as Record<string, unknown> | null;
        if (body === null) {
          json(res, 400, { error: "Invalid JSON body" });
          return;
        }
        const query = String(body.query ?? "").trim();
        if (!query) {
          json(res, 400, { error: "Missing required field: query" });
          return;
        }

        const settings = getSettings();
        const limit = Number.isFinite(Number(body.limit)) ? Number(body.limit) : settings.queryLimit;
        const minScore = Number.isFinite(Number(body.minScore)) ? Number(body.minScore) : settings.minScore;
        const topK = Number.isFinite(Number(body.topK)) ? Number(body.topK) : limit;
        const candidateLimit = Number.isFinite(Number(body.candidateLimit)) ? Number(body.candidateLimit) : limit;
        const intent = body.intent ? String(body.intent) : undefined;

        let collections: string[] | undefined;
        if (Array.isArray(body.collections)) collections = body.collections.map(String);
        else if (body.collection) collections = [String(body.collection)];
        else if (defaultCollections.length > 0) collections = defaultCollections;

        // Hybrid / wiki-only / raw-only mode. Default "hybrid": retrieve raw
        // collections (if any) plus all "wiki" collections. Pass mode:"wiki" for
        // wiki-only, mode:"raw" (or hybrid:false) for raw-only.
        const _resolved = await resolveHybridCollections(body, collections);
        collections = _resolved.collections;
        const wikiCollections = _resolved.wikiSet;

        // Stream progress + final answer via Server-Sent Events.
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        });
        let clientGone = false;
        req.on("close", () => { clientGone = true; });
        const send = (event: string, data: unknown) => {
          if (clientGone) return;
          try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
          catch { clientGone = true; }
        };
        res.write(": connected\n\n");

        const hooks: SearchHooks = {
          onExpand: (original, expanded, ms) => send("expand", { original, expanded, ms }),
          onEmbedStart: (count) => send("embed", { phase: "start", count }),
          onEmbedDone: (ms) => send("embed", { phase: "done", ms }),
          onRerankStart: (chunkCount) => send("rerank", { phase: "start", chunkCount }),
          onRerankDone: (ms) => send("rerank", { phase: "done", ms }),
        };

        // 通用问答：用户未选择任何集合（既没选 wiki 也没选文档集）时，
        // 跳过检索（不跑嵌入 / BM25 / 重排），直接由大模型作答。
        if (body.direct === true) {
          send("generate", { phase: "start" });
          const rag = await generateDirectAnswer(query, {
            onToken: (chunk) => send("token", { text: chunk }),
          });
          send("done", {
            query,
            model: rag.model,
            answer: rag.answer,
            error: rag.error,
            sources: [],
            rawResults: [],
            direct: true,
          });
          try {
            const sid = body?.sessionId ? String(body.sessionId) : undefined;
            if (sid && uid && getChatOwner(store.internal.db, sid) === uid) {
              addChatMessage(store.internal.db, sid, "user", query);
              addChatMessage(store.internal.db, sid, "assistant", rag.answer ?? "", {
                model: rag.model,
                sources: [],
                rawResults: [],
                error: rag.error ?? undefined,
              });
            }
          } catch (e) {
            console.warn("[chat] persist failed for /api/query (direct):", e);
          }
          res.end();
          return;
        }

        let results: RagSearchResult[];
        try {
          results = (await withLLMSession(async () => {
            return await store.search({
              query,
              collections,
              limit,
              minScore,
              candidateLimit,
              intent,
              hooks,
            });
          })) as unknown as RagSearchResult[];
        } catch (e) {
          send("error", { message: `检索失败: ${(e as Error).message}` });
          res.end();
          return;
        }

        // Stage 4 (generate): streamed token-by-token.
        send("generate", { phase: "start" });
        const rag = await generateAnswer(query, results, {
          topK,
          intent,
          onToken: (chunk) => send("token", { text: chunk }),
        });
        const db = store.internal.db;
        const rawResultsPayload = results.map((r) => {
          const chunks = (r as any).chunks as { text: string }[] | undefined;
          const coll = String(r.displayPath).split("/")[0] ?? "";
          const kind = wikiCollections && wikiCollections.has(coll) ? "wiki" : "raw";
          return {
            file: r.displayPath,
            title: r.title,
            kind,
            score: Math.round((r.score ?? 0) * 100) / 100,
            bestChunk: r.bestChunk || r.body || "",
            chunks: Array.isArray(chunks)
              ? chunks.map((c) => (c.text || "").slice(0, 800))
              : undefined,
          };
        });
        send("done", {
          query,
          model: rag.model,
          answer: rag.answer,
          error: rag.error,
          sources: rag.sources,
          retrievalHint: results.length === 0 ? buildRetrievalHint(db, collections, wikiCollections, minScore) : undefined,
          rawResults: rawResultsPayload,
        });

        // Best-effort persistence: never let a DB write break the streamed answer.
        try {
          const sid = body?.sessionId ? String(body.sessionId) : undefined;
          if (sid && uid && getChatOwner(db, sid) === uid) {
            addChatMessage(db, sid, "user", query);
            addChatMessage(db, sid, "assistant", rag.answer ?? "", {
              model: rag.model,
              sources: rag.sources,
              rawResults: rawResultsPayload,
              error: rag.error ?? undefined,
            });
          }
        } catch (e) {
          console.warn("[chat] persist failed for /api/query:", e);
        }
        res.end();
        return;
      }

      // ---- Ask (non-streaming JSON query API) ----
      // Same server-side pipeline as /api/query (retrieve over the server's
      // indexed collections + generate via the server's configured LLM), but
      // returns a single JSON object instead of an SSE stream — convenient for
      // external callers that just want the final answer. Defaults to the
      // "ceshi" collection when none is specified.
      if (pathname === "/api/ask" && method === "POST") {
        const body = safeParse(await collectBody(req)) as Record<string, unknown> | null;
        if (body === null) {
          json(res, 400, { error: "Invalid JSON body" });
          return;
        }
        const query = String(body.query ?? "").trim();
        if (!query) {
          json(res, 400, { error: "Missing required field: query" });
          return;
        }

        // 与 /api/query 保持一致：未选择任何集合时为通用问答，跳过检索。
        if (body.direct === true) {
          const rag = await generateDirectAnswer(query);
          json(res, 200, {
            query,
            model: rag.model,
            answer: rag.answer,
            error: rag.error,
            sources: [],
            rawResults: [],
            direct: true,
          });
          return;
        }

        const settings = getSettings();
        const limit = Number.isFinite(Number(body.limit)) ? Number(body.limit) : settings.queryLimit;
        const minScore = Number.isFinite(Number(body.minScore)) ? Number(body.minScore) : settings.minScore;
        const topK = Number.isFinite(Number(body.topK)) ? Number(body.topK) : limit;
        const candidateLimit = Number.isFinite(Number(body.candidateLimit)) ? Number(body.candidateLimit) : limit;
        const intent = body.intent ? String(body.intent) : undefined;

        let collections: string[] | undefined;
        if (Array.isArray(body.collections)) collections = body.collections.map(String);
        else if (body.collection) collections = [String(body.collection)];
        else if (defaultCollections.length > 0) collections = defaultCollections;
        else collections = ["ceshi"];

        // Hybrid / wiki-only / raw-only mode. Default "hybrid": retrieve raw
        // collections (if any) plus all "wiki" collections. Pass mode:"wiki" for
        // wiki-only, mode:"raw" (or hybrid:false) for raw-only.
        const _resolved = await resolveHybridCollections(body, collections);
        collections = _resolved.collections;
        const wikiCollections = _resolved.wikiSet;

        let results: RagSearchResult[];
        try {
          results = (await withLLMSession(async () => {
            return await store.search({
              query,
              collections,
              limit,
              minScore,
              candidateLimit,
              intent,
            });
          })) as unknown as RagSearchResult[];
        } catch (e) {
          json(res, 500, { error: `检索失败: ${(e as Error).message}`, answer: null });
          return;
        }

        const rag = await generateAnswer(query, results, { topK, intent });
        const db = store.internal.db;
        const rawResultsPayload = results.map((r) => {
          const chunks = (r as any).chunks as { text: string }[] | undefined;
          const coll = String(r.displayPath).split("/")[0] ?? "";
          const kind = wikiCollections && wikiCollections.has(coll) ? "wiki" : "raw";
          return {
            file: r.displayPath,
            title: r.title,
            kind,
            score: Math.round((r.score ?? 0) * 100) / 100,
            bestChunk: r.bestChunk || r.body || "",
            chunks: Array.isArray(chunks)
              ? chunks.map((c) => (c.text || "").slice(0, 800))
              : undefined,
          };
        });

        // Best-effort persistence: never let a DB write break the JSON answer.
        try {
          const sid = body?.sessionId ? String(body.sessionId) : undefined;
          if (sid && uid && getChatOwner(db, sid) === uid) {
            addChatMessage(db, sid, "user", query);
            addChatMessage(db, sid, "assistant", rag.answer ?? "", {
              model: rag.model,
              sources: rag.sources,
              rawResults: rawResultsPayload,
              error: rag.error ?? undefined,
            });
          }
        } catch (e) {
          console.warn("[chat] persist failed for /api/ask:", e);
        }

        json(res, 200, {
          query,
          model: rag.model,
          answer: rag.answer,
          error: rag.error,
          sources: rag.sources,
          retrievalHint: results.length === 0 ? buildRetrievalHint(db, collections, wikiCollections, minScore) : undefined,
          rawResults: rawResultsPayload,
        });
        return;
      }

      // ---- Retrieve (pure retrieval, no LLM synthesis) ----
      // 供外部场景（如语音收集与文本生成）复用底座的混合检索，而不触发答案生成。
      if (pathname === "/api/retrieve" && method === "POST") {
        const body = safeParse(await collectBody(req)) as Record<string, unknown> | null;
        if (body === null) {
          json(res, 400, { error: "Invalid JSON body" });
          return;
        }
        const query = String(body.query ?? "").trim();
        if (!query) {
          json(res, 400, { error: "Missing required field: query" });
          return;
        }
        const settings = getSettings();
        const limit =
          Number.isFinite(Number(body.limit)) ? Number(body.limit)
          : Number.isFinite(Number(body.top_k)) ? Number(body.top_k)
          : settings.queryLimit;
        const minScore = Number.isFinite(Number(body.minScore)) ? Number(body.minScore) : settings.minScore;
        const candidateLimit = Number.isFinite(Number(body.candidateLimit)) ? Number(body.candidateLimit) : limit;
        const intent = body.intent ? String(body.intent) : undefined;

        let collections: string[] | undefined;
        if (Array.isArray(body.collections)) collections = body.collections.map(String);
        else if (body.collection) collections = [String(body.collection)];
        else if (defaultCollections.length > 0) collections = defaultCollections;
        else collections = ["ceshi"];

        const _resolved = await resolveHybridCollections(body, collections);
        collections = _resolved.collections;
        const wikiCollections = _resolved.wikiSet;

        let results: RagSearchResult[];
        try {
          results = (await withLLMSession(async () => {
            return await store.search({
              query, collections, limit, minScore, candidateLimit, intent,
            });
          })) as unknown as RagSearchResult[];
        } catch (e) {
          json(res, 500, { error: `检索失败: ${(e as Error).message}` });
          return;
        }

        const rawResultsPayload = results.map((r) => {
          const chunks = (r as any).chunks as { text: string }[] | undefined;
          const coll = String(r.displayPath).split("/")[0] ?? "";
          const kind = wikiCollections && wikiCollections.has(coll) ? "wiki" : "raw";
          return {
            file: r.displayPath,
            title: r.title,
            kind,
            score: Math.round((r.score ?? 0) * 100) / 100,
            bestChunk: r.bestChunk || r.body || "",
            chunks: Array.isArray(chunks)
              ? chunks.map((c) => (c.text || "").slice(0, 800))
              : undefined,
          };
        });

        json(res, 200, {
          query,
          collections,
          retrievalHint: results.length === 0
            ? buildRetrievalHint(store.internal.db, collections, wikiCollections, minScore)
            : undefined,
          rawResults: rawResultsPayload,
        });
        return;
      }

      // ---- Collections list (for the upload UI dropdown) ----
      if (pathname === "/api/collections" && method === "GET") {
        try {
          const cols = listCollections(store.internal.db).map((c) => ({
            name: c.name,
            path: c.pwd,
            pattern: c.glob_pattern,
            type: c.type,
            docCount: c.doc_count,
            activeCount: c.active_count,
            lastModified: c.last_modified,
            includeByDefault: c.includeByDefault,
          }));
          json(res, 200, { collections: cols });
        } catch (e) {
          json(res, 500, { error: (e as Error).message });
        }
        return;
      }

      // ---- Per-collection document list + raw content read ----
      if (pathname.startsWith("/api/collections/") && method === "GET") {
        const rest = pathname.slice("/api/collections/".length);
        const [cname, sub] = rest.split("/");
        if (sub === "documents") {
          if (!cname || !/^[a-zA-Z0-9_-]+$/.test(cname)) {
            json(res, 400, { error: "非法集合名称" });
            return;
          }
          try {
            const rows = store.internal.db.prepare(`
              SELECT d.path, d.title, d.hash, d.modified_at,
                     (SELECT COUNT(*) FROM content_vectors WHERE hash = d.hash) AS chunks
              FROM documents d
              WHERE d.collection = ? AND d.active = 1
              ORDER BY d.path
            `).all(cname) as { path: string; title: string; hash: string; modified_at: string; chunks: number }[];
            json(res, 200, {
              documents: rows.map((r) => ({
                path: r.path,
                title: r.title,
                docid: r.hash.slice(0, 6),
                hash: r.hash,
                chunks: r.chunks ?? 0,
                modifiedAt: r.modified_at,
              })),
            });
          } catch (e) {
            json(res, 500, { error: (e as Error).message });
          }
          return;
        }
      }
      if (pathname.startsWith("/api/content/") && method === "GET") {
        const hash = pathname.slice("/api/content/".length);
        try {
          const row = store.internal.db.prepare(`SELECT doc FROM content WHERE hash = ?`).get(hash) as { doc: string } | null;
          if (!row) { json(res, 404, { error: "未找到内容" }); return; }
          json(res, 200, { hash, text: row.doc });
        } catch (e) {
          json(res, 500, { error: (e as Error).message });
        }
        return;
      }

      // ---- Document upload + optional auto-index ----
      if (pathname === "/api/documents" && method === "POST") {
        try {
          const { fields, files } = await parseMultipart(req);
          const collectionName = (fields.collection || "").trim();
          if (!collectionName) {
            json(res, 400, { error: "缺少集合名称 collection" });
            return;
          }
          if (!/^[a-zA-Z0-9_-]+$/.test(collectionName)) {
            json(res, 400, { error: "集合名称仅允许字母、数字、- 和 _" });
            return;
          }
          // Collect uploaded files (field name "file"; supports multiple).
          const incoming = files.filter((f) => f.name === "file");
          const fileList = incoming.length ? incoming : files;
          if (fileList.length === 0) {
            json(res, 400, { error: "未收到上传文件（表单字段名应为 file）" });
            return;
          }

          const SUPPORTED = [".md", ".markdown", ".txt", ".pdf", ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls"];

          // Resolve the target collection directory (auto-create if missing).
          // `store.internal` is the low-level Store used by reindexCollection.
          let coll = store.internal.getCollectionByName(collectionName);
          let collPath: string;
          if (coll) {
            collPath = path.resolve(coll.pwd);
          } else {
            const base = path.join(path.dirname(store.dbPath), "uploads", collectionName);
            fs.mkdirSync(base, { recursive: true });
            collPath = base;
          }
          fs.mkdirSync(collPath, { recursive: true });

          // 确保集合类型与用户在弹窗中选择的一致：新建集合直接创建为所选类型；
          // 已存在的集合也按所选类型更新（沿用其原有 path/pattern，不会改写）。
          const targetType = fields.indexType === "wiki" ? "wiki" : "raw";
          const existingRow = (
            store.internal.db
              .prepare(`SELECT name, type FROM store_collections WHERE name = ?`)
              .get(collectionName) as { name: string; type: string | null } | undefined
          );
          // 关键修复：新建集合（store_collections 中尚未登记）必须登记，否则文档虽已
          // 入库建索引，却因缺集合行而无法在 /api/collections 中列出、前端不显示。
          // 原来的条件 `(existingType ?? "raw") !== targetType` 在「新建 + 默认 raw」时
          // 恰好为 false，导致跳过登记。
          const isRegistered = !!existingRow;
          if (!isRegistered || (existingRow?.type ?? "raw") !== targetType) {
            await store.addCollection(collectionName, {
              path: coll ? coll.pwd : collPath,
              pattern: coll ? coll.glob_pattern : "**/*.{md,markdown,txt,pdf,docx,doc,pptx,ppt,xlsx,xls}",
              type: targetType,
            });
          }

          const autoIndex = fields.autoIndex !== "false" && fields.autoIndex !== "0";

          // 上传时用户可配置的分块参数（全局生效：本实例索引共享，分块设置不按用户隔离）。
          const toNum = (v: string | undefined, min?: number, max?: number): number | undefined => {
            if (v === undefined || v === "") return undefined;
            const n = Number(v);
            if (!Number.isFinite(n)) return undefined;
            if (min !== undefined && n < min) return undefined;
            if (max !== undefined && n > max) return undefined;
            return n;
          };
          const cSize = toNum(fields.chunkSizeTokens, 100);
          const cOverlap = toNum(fields.chunkOverlapRatio, 0, 0.9);
          const cWindow = toNum(fields.chunkWindowTokens, 1);
          const chunkPatch: Record<string, number> = {};
          if (cSize !== undefined) chunkPatch.chunkSizeTokens = cSize;
          if (cOverlap !== undefined) chunkPatch.chunkOverlapRatio = cOverlap;
          if (cWindow !== undefined) chunkPatch.chunkWindowTokens = cWindow;
          if (Object.keys(chunkPatch).length) updateSettings(chunkPatch as Parameters<typeof updateSettings>[0]);

          const fileResults: Array<{ file: string; reindex?: unknown; error?: string }> = [];

          for (const file of fileList) {
            const ext = path.extname(file.filename).toLowerCase();
            if (!SUPPORTED.includes(ext)) {
              fileResults.push({ file: file.filename, error: `不支持的文件类型：${ext || "(无扩展名)"}` });
              continue;
            }
            const safeName = path.basename(file.filename).replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, "_");
            if (!safeName || safeName === ".." || safeName.includes("/") || safeName.includes("\\")) {
              fileResults.push({ file: file.filename, error: "非法文件名" });
              continue;
            }
            const dest = path.join(collPath, safeName);
            fs.writeFileSync(dest, file.data);

            if (autoIndex) {
              // Re-index just the uploaded file so its type is picked up regardless
              // of the collection's configured pattern.
              const reindex = await reindexCollection(
                store.internal,
                collPath,
                `**/${safeName}`,
                collectionName,
                // Incremental per-file reindex: keep sibling documents active
                // (don't deactivate files this single-file scan didn't match).
                { preserveUnseen: true },
              );
              // Surface silent extraction failures: if the file was written but
              // nothing got indexed (extraction returned null), report it instead
              // of letting the UI show a false "success".
              const didIndex = (reindex.indexed ?? 0) + (reindex.updated ?? 0) + (reindex.unchanged ?? 0);
              if (didIndex === 0) {
                fileResults.push({
                  file: safeName,
                  error: "文件已保存，但内容抽取失败（依赖缺失或文件无法解析），未建立索引",
                });
              } else {
                fileResults.push({ file: safeName, reindex });
              }
            } else {
              fileResults.push({ file: safeName });
            }
          }

          // 将上传时勾选的特殊情形标签、合同类型落到集合维度
          // （contracts_meta 占位行，不进入合同列表）
          const rawTags = String(fields.tags || "").split(",").map((s) => s.trim()).filter(Boolean);
          const contractType = String(fields.contractType || "").trim();
          const contractSubtype = String(fields.contractSubtype || "").trim();
          if (rawTags.length || contractType) {
            // 与已有占位行合并，避免本次未提交的维度被写成 null
            const prev = getContractMeta(store.internal.db, `collection:${collectionName}`);
            let prevTags: string[] = [];
            try {
              const a = prev?.tags ? JSON.parse(prev.tags) : [];
              prevTags = Array.isArray(a) ? a.map(String) : [];
            } catch {
              prevTags = [];
            }
            upsertContractMeta(store.internal.db, {
              docid: `collection:${collectionName}`,
              collection: collectionName,
              tags: rawTags.length ? rawTags : prevTags,
              contractType: contractType || prev?.contract_type || null,
              contractSubtype: contractSubtype || prev?.contract_subtype || null,
            });
          }

          // Embed once for the whole collection after all files are indexed.
          let embed: unknown = null;
          if (autoIndex) {
            const emb = await store.embed({ collections: [collectionName], force: false });
            embed = {
              docsProcessed: emb.docsProcessed,
              chunksEmbedded: emb.chunksEmbedded,
              errors: emb.errors,
              durationMs: emb.durationMs,
            };
          }

          const eff = getSettings();
          json(res, 200, {
            status: "ok",
            collection: collectionName,
            autoIndex,
            config: {
              embedModel: eff.embedModel,
              chunkSizeTokens: cSize ?? eff.chunkSizeTokens,
              chunkOverlapRatio: cOverlap ?? eff.chunkOverlapRatio,
              chunkWindowTokens: cWindow ?? eff.chunkWindowTokens,
            },
            files: fileResults,
            embed,
          });
        } catch (e) {
          json(res, 500, { error: (e as Error).message });
        }
        return;
      }

      // ---- Contract risk-review scenario (owned by src/contract-review/api.ts) ----
      // 路由不再内联在 server.ts，改由场景模块统一委派，降低底座与场景的耦合。
      if (
        pathname.startsWith("/api/risk-rules") ||
        pathname.startsWith("/api/rule-scope") ||
        pathname.startsWith("/api/contracts") ||
        pathname.startsWith("/api/analysis") ||
        pathname === "/api/review"
      ) {
        const handled = await handleContractReviewRoutes({
          req,
          res,
          store,
          uid,
          json,
          collectBody,
          safeParse,
        });
        if (handled) return;
      }

      // ---- 场景约束 manifest 注册 / 版本约定（底座层，设计 §3.4） ----
      // 元数据登记 + 版本分发；约束语义不进底座（payload_ref 不透明）。
      // 鉴权复用全局 Bearer 门禁（行 389）。GET 供 B 类独立进程消费，POST 供场景注册。
      if (pathname === "/api/scenario-manifests" && method === "GET") {
        const scenario = url.searchParams.get("scenario") ?? undefined;
        const kind = url.searchParams.get("kind") ?? undefined;
        try {
          ensureScenarioManifestSchema(store.internal.db);
          json(res, 200, { manifests: listScenarioManifests(store.internal.db, { scenario, kind }) });
        } catch (e) {
          json(res, 500, { error: String(e) });
        }
        return;
      }

      // 单 manifest 查询：/api/scenario-manifests/:id
      if (pathname.startsWith("/api/scenario-manifests/") && method === "GET") {
        const id = decodeURIComponent(pathname.slice("/api/scenario-manifests/".length));
        try {
          const m = getScenarioManifest(store.internal.db, id);
          if (!m) {
            json(res, 404, { error: "manifest 不存在" });
            return;
          }
          json(res, 200, { manifest: m });
        } catch (e) {
          json(res, 500, { error: String(e) });
        }
        return;
      }

      // 注册 / 更新某 manifest（声明式：场景层调用，底座只登记元数据）
      if (pathname === "/api/scenario-manifests" && method === "POST") {
        const body = (safeParse(await collectBody(req)) as Record<string, unknown> | null) ?? {};
        const manifestId = String(body.manifestId ?? "").trim();
        const scenario = String(body.scenario ?? "").trim();
        const kind = String(body.kind ?? "").trim();
        const version = String(body.version ?? "").trim();
        if (!manifestId || !scenario || !kind || !version) {
          json(res, 400, { error: "缺少 manifestId / scenario / kind / version" });
          return;
        }
        try {
          const m = registerScenarioManifest(store.internal.db, {
            manifestId,
            scenario,
            kind,
            version,
            name: body.name ? String(body.name) : undefined,
            description: body.description ? String(body.description) : undefined,
            status: body.status === "deprecated" ? "deprecated" : "active",
            payloadRef: body.payloadRef ? String(body.payloadRef) : undefined,
          });
          json(res, 200, { status: "ok", manifest: m });
        } catch (e) {
          json(res, 400, { error: String(e) });
        }
        return;
      }

      // ---- Embed ----
      if (pathname === "/api/embed" && method === "POST") {
        const body = (safeParse(await collectBody(req)) as Record<string, unknown> | null) ?? {};
        let collections: string[] | undefined;
        if (Array.isArray(body.collections)) collections = body.collections.map(String);
        else if (body.collection) collections = [String(body.collection)];
        const force = body.force === true || body.force === "true";
        try {
          await store.embed({
            force,
            model: DEFAULT_EMBED_MODEL,
            collections,
          });
          json(res, 200, { status: "ok", message: "embedding complete" });
        } catch (e) {
          json(res, 500, { error: (e as Error).message });
        }
        return;
      }

      // ---- Wiki:沉淀问答为 wiki 页（手动知识捕获 + 来源血缘） ----
      if (pathname === "/api/wiki/save" && method === "POST") {
        const body = (safeParse(await collectBody(req)) as Record<string, unknown> | null) ?? {};
        const collection = String(body.collection ?? "").trim();
        const question = String(body.question ?? "").trim();
        const answer = String(body.answer ?? "").trim();
        const titleInput = typeof body.title === "string" ? body.title.trim() : "";
        const pathInput = typeof body.path === "string" ? body.path.trim() : "";
        const rawSources = Array.isArray(body.sources) ? body.sources.map(String) : [];

        if (!collection || !/^[a-zA-Z0-9_-]+$/.test(collection)) {
          json(res, 400, { error: "缺少或非法的集合名称 collection" });
          return;
        }
        if (!answer) {
          json(res, 400, { error: "缺少回答内容 answer" });
          return;
        }

        const wikiDb = store.internal.db;
        const collRow = wikiDb
          .prepare(`SELECT name FROM store_collections WHERE name = ?`)
          .get(collection);
        if (!collRow) {
          json(res, 404, { error: `集合不存在：${collection}` });
          return;
        }
        // raw 集合的语义是"不可变的事实来源"，这里直接拒绝，避免静默污染原文库。
        if (!isWikiCollection(wikiDb, collection)) {
          json(res, 400, {
            error: `集合「${collection}」不是 wiki 类型，无法沉淀。请改用 wiki 集合（qmd wiki init ${collection}）`,
          });
          return;
        }

        const title = titleInput || question.split("\n")[0]?.slice(0, 60).trim() || "问答沉淀";
        const slug = title
          .toLowerCase()
          .replace(/[^\p{L}\p{N}$]+/gu, "-")
          .replace(/^-+|-+$/g, "") || "qa-note";
        // 统一分隔符：保证这里校验/探测的路径与 writeDocument 实际落库的路径完全一致。
        const relPath = (pathInput || `pages/${slug}.md`).replace(/\\/g, "/");
        if (!/\.(md|markdown)$/i.test(relPath) || relPath.startsWith("/") || relPath.includes("..")) {
          json(res, 400, { error: "非法路径 path（必须是集合内的 .md 相对路径）" });
          return;
        }

        // 只把"真实存在且 active"的文档记为来源，否则 wiki_lint 的
        // source-stale 检测无法用 collection/path 关联到它们。
        const referenced: { file: string; title: string }[] = [];
        const skippedSources: string[] = [];
        const findSource = wikiDb.prepare(
          `SELECT title FROM documents WHERE collection || '/' || path = ? AND active = 1`
        );
        for (const raw of rawSources) {
          const key = raw.trim().replace(/^qmd:\/\//, "");
          if (!key || referenced.some((r) => r.file === key)) continue;
          const row = findSource.get(key) as { title: string } | undefined;
          if (!row) {
            skippedSources.push(key);
            continue;
          }
          referenced.push({ file: key, title: row.title });
        }

        const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
        const md: string[] = [`# ${title}`, "", `> 由 QMD 问答手动沉淀 · ${stamp}`, ""];
        if (question) md.push("## 问题", "", question, "");
        md.push("## 结论", "", answer, "");
        if (referenced.length > 0) {
          md.push("## 引用来源", "");
          for (const s of referenced) md.push(`- \`${s.file}\`${s.title ? ` — ${s.title}` : ""}`);
          md.push("");
        }
        md.push("---", "", "_本页由「问答 → 存为 Wiki 页」生成，引用来源即本次回答实际参考的文档。_", "");

        // 预先用与 writeDocument 相同的规范化函数推导落盘路径，用于判断是新建还是覆盖。
        let normalizedPath: string;
        try {
          normalizedPath = handelize(relPath);
        } catch (e) {
          json(res, 400, { error: `非法路径 path：${(e as Error).message}` });
          return;
        }
        const existed = !!wikiDb
          .prepare(`SELECT id FROM documents WHERE collection = ? AND path = ? AND active = 1`)
          .get(collection, normalizedPath);

        let written: { file: string; docid: string };
        try {
          written = await store.writeDocument(collection, relPath, md.join("\n"), title);
        } catch (e) {
          json(res, 500, { error: `写入失败：${(e as Error).message}` });
          return;
        }

        // 血缘：整体重建该页的来源行，避免重复保存后残留旧的来源。
        try {
          wikiDb.prepare(`DELETE FROM wiki_sources WHERE wiki_file = ?`).run(written.file);
          const insertProv = wikiDb.prepare(
            `INSERT OR REPLACE INTO wiki_sources (wiki_file, source_file, wiki_collection, created_at)
             VALUES (?, ?, ?, datetime('now'))`
          );
          for (const s of referenced) insertProv.run(written.file, s.file, collection);
        } catch {
          // 血缘写入失败不影响页面本身
        }

        try {
          appendLog(wikiDb, {
            operation: "update",
            wiki_files: [written.file],
            details: {
              action: "save-qa",
              title,
              docid: written.docid,
              overwritten: existed,
              sources: referenced.map((s) => s.file),
              question: question.slice(0, 200),
            },
          });
        } catch {
          // 日志失败不影响页面本身
        }

        json(res, 200, {
          status: "ok",
          collection,
          file: written.file,
          path: normalizedPath,
          docid: written.docid,
          title,
          overwritten: existed,
          sources: referenced.map((s) => s.file),
          skippedSources,
        });
        return;
      }

      // ---- Intake: iterative, context-preserving info collection ----
      if (pathname.startsWith("/api/intake")) {
        const db = store.internal.db;

        // Create a new session + first question
        if (pathname === "/api/intake/sessions" && method === "POST") {
          const body = (safeParse(await collectBody(req)) as Record<string, unknown> | null) ?? {};
          const goal = String(body.goal ?? "").trim();
          if (!goal) {
            json(res, 400, { error: "缺少采集目标 goal" });
            return;
          }
          const session = createIntakeSession(db, goal);
          const q = await generateNextQuestion(goal, [], true);
          const rec = addIntakeRecord(db, session.id, "question", q.text, q.refs);
          json(res, 200, {
            id: session.id,
            goal: session.goal,
            status: session.status,
            firstQuestion: rec.content,
            records: getIntakeRecords(db, session.id),
          });
          return;
        }

        // List sessions
        if (pathname === "/api/intake/sessions" && method === "GET") {
          json(res, 200, { sessions: listIntakeSessions(db) });
          return;
        }

        // /api/intake/sessions/:id  or  /api/intake/sessions/:id/(answer|finish)
        const m = pathname.match(/^\/api\/intake\/sessions\/([^/]+)(?:\/(answer|finish))?$/);
        if (m) {
          const id = m[1]!;
          const sub = m[2] as "answer" | "finish" | undefined;
          const session = getIntakeSession(db, id);
          if (!session) {
            json(res, 404, { error: "会话不存在" });
            return;
          }

          // Get full session (records) — used to resume
          if (method === "GET" && !sub) {
            json(res, 200, { ...session, records: getIntakeRecords(db, id) });
            return;
          }

          // Submit an answer -> append, generate next question
          if (method === "POST" && sub === "answer") {
            if (session.status !== "active") {
              json(res, 400, { error: "该采集会话已结束" });
              return;
            }
            const body = (safeParse(await collectBody(req)) as Record<string, unknown> | null) ?? {};
            const answer = String(body.answer ?? "").trim();
            if (!answer) {
              json(res, 400, { error: "缺少回答内容 answer" });
              return;
            }
            addIntakeRecord(db, id, "answer", answer, []);
            const records = getIntakeRecords(db, id);
            const q = await generateNextQuestion(session.goal, records, false);
            let nextQuestion: string | null = null;
            if (q.done) {
              setIntakeSessionStatus(db, id, "done");
            } else {
              nextQuestion = addIntakeRecord(db, id, "question", q.text, q.refs).content;
            }
            json(res, 200, {
              status: q.done ? "done" : "active",
              nextQuestion,
              done: q.done,
              records: getIntakeRecords(db, id),
            });
            return;
          }

          // Finish session and return a plain-text summary
          if (method === "POST" && sub === "finish") {
            setIntakeSessionStatus(db, id, "done");
            const records = getIntakeRecords(db, id);
            json(res, 200, {
              status: "done",
              summary: formatSummary(session.goal, records),
              records,
            });
            return;
          }
        }

        json(res, 404, { error: "未知的信息采集路由" });
        return;
      }

      // ---- Chat history (per-user persistent Q&A) ----
      if (pathname.startsWith("/api/chat")) {
        const db = store.internal.db;
        if (!uid) {
          json(res, 401, { error: "Unauthorized" });
          return;
        }

        // Create a new chat session
        if (pathname === "/api/chat/sessions" && method === "POST") {
          const body = (safeParse(await collectBody(req)) as Record<string, unknown> | null) ?? {};
          const collections = body.collections
            ? Array.isArray(body.collections)
              ? body.collections.map(String).join(",")
              : String(body.collections)
            : undefined;
          const session = createChatSession(db, uid, {
            title: body.title ? String(body.title) : undefined,
            collections,
            mode: body.mode ? String(body.mode) : "query",
          });
          json(res, 200, {
            id: session.id,
            title: session.title,
            collections: session.collections,
            mode: session.mode,
            status: session.status,
          });
          return;
        }

        // List the current user's chat sessions
        if (pathname === "/api/chat/sessions" && method === "GET") {
          json(res, 200, { sessions: listChatSessions(db, uid) });
          return;
        }

        // /api/chat/sessions/:id  -> GET detail / PATCH rename / DELETE
        const cm = pathname.match(/^\/api\/chat\/sessions\/([^/]+)$/);
        if (cm) {
          const id = cm[1]!;
          const owner = getChatOwner(db, id);
          if (!owner || owner !== uid) {
            json(res, 404, { error: "会话不存在" });
            return;
          }
          if (method === "GET") {
            json(res, 200, { ...getChatSession(db, id), messages: getChatMessages(db, id) });
            return;
          }
          if (method === "PATCH") {
            const body = (safeParse(await collectBody(req)) as Record<string, unknown> | null) ?? {};
            const title = body.title ? String(body.title).trim() : "";
            if (title) renameChatSession(db, id, title.slice(0, 200));
            json(res, 200, { ok: true });
            return;
          }
          if (method === "DELETE") {
            deleteChatSession(db, id);
            json(res, 200, { ok: true });
            return;
          }
        }

        json(res, 404, { error: "未知的聊天路由" });
        return;
      }

      // ---- Collection management: delete / rename / rebuild (dynamic route) ----
      if (pathname.startsWith("/api/collections/") && method !== "GET") {
        const rest = pathname.slice("/api/collections/".length);
        const [cname, sub] = rest.split("/");
        if (!cname || !/^[a-zA-Z0-9_-]+$/.test(cname)) {
          json(res, 400, { error: "非法集合名称" });
          return;
        }
        if (method === "DELETE") {
          try {
            const r = removeCollection(store.internal.db, cname);
            // Also strip the collection from the external YAML config so it is not
            // re-created by syncConfigToDb on the next server restart.
            if (configExists()) {
              try {
                removeCollectionFromConfig(cname);
              } catch (yamlErr) {
                console.warn(`[collections] failed to update YAML config for ${cname}:`, yamlErr);
              }
            }
            json(res, 200, { status: "ok", deletedDocs: r.deletedDocs, cleanedHashes: r.cleanedHashes });
          } catch (e) {
            json(res, 500, { error: (e as Error).message });
          }
          return;
        }
        if (method === "PUT") {
          const body = safeParse(await collectBody(req)) as { name?: string } | null;
          const newName = (body?.name || "").trim();
          if (!newName) { json(res, 400, { error: "缺少新名称 name" }); return; }
          if (!/^[a-zA-Z0-9_-]+$/.test(newName)) { json(res, 400, { error: "新名称仅允许字母、数字、- 和 _" }); return; }
          try {
            renameCollection(store.internal.db, cname, newName);
            json(res, 200, { status: "ok", name: newName });
          } catch (e) {
            json(res, 500, { error: (e as Error).message });
          }
          return;
        }
        if (method === "POST" && sub === "rebuild") {
          try {
            const coll = store.internal.getCollectionByName(cname);
            if (!coll) { json(res, 404, { error: "集合不存在" }); return; }
            // 1) 从源文件重新解析（拾取已变更的内容）
            await reindexCollection(store.internal, coll.pwd, coll.glob_pattern || "**/*", cname, {});
            // 2) 强制覆盖重新生成全部向量
            const embed = await store.embed({ collections: [cname], force: true });
            json(res, 200, { status: "ok", embed });
          } catch (e) {
            json(res, 500, { error: (e as Error).message });
          }
          return;
        }
        json(res, 405, { error: "Method not allowed" });
        return;
      }

      // ---- Static assets (frontend) ----
      if (method === "GET" && !pathname.startsWith("/api/") && pathname !== "/health") {
        await serveStatic(res, webRoot, pathname);
        return;
      }

      json(res, 404, { error: `Not found: ${method} ${pathname}` });
      });
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    } finally {
      if (!options?.quiet) {
        process.stderr.write(`${new Date().toISOString().slice(11, 23)} ${method} ${pathname} (${Date.now() - reqStart}ms)\n`);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.on("error", reject);
    httpServer.listen(port, options?.host || "127.0.0.1", () => resolve());
  });

  // 语音场景（B 类·独立服务）已迁出为独立进程，经 HTTP 调底座 /api/retrieve 与
  // /api/scenario-manifests，不再在底座内挂 WebSocket（设计 §3.2 / §3.7）。

  return {
    httpServer,
    port,
    stop: async () => {
      httpServer.close();
      try {
        await store.close();
      } catch {
        /* ignore */
      }
    },
  };
}
