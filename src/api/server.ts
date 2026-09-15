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
 *   POST /api/query             -> { query, collections?, limit?, minScore?, topK?, intent? }
 *                                    -> { answer, model, error?, sources, rawResults }
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
import { generateAnswer, type RagSearchResult } from "../rag.js";
import { withLLMSession } from "../llm.js";
import {
  DEFAULT_EMBED_MODEL,
  type SearchHooks,
  reindexCollection,
} from "../store.js";

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
  const defaultCollections = await store.getDefaultCollectionNames();
  const startTime = Date.now();
  // Static frontend assets live in dist/web (copied from src/web by build-dist.js).
  const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");

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
        send("done", {
          query,
          model: rag.model,
          answer: rag.answer,
          error: rag.error,
          sources: rag.sources,
          rawResults: results.map((r) => {
            const chunks = (r as any).chunks as { text: string }[] | undefined;
            return {
              file: r.displayPath,
              title: r.title,
              score: Math.round((r.score ?? 0) * 100) / 100,
              bestChunk: r.bestChunk || r.body || "",
              chunks: Array.isArray(chunks)
                ? chunks.map((c) => (c.text || "").slice(0, 800))
                : undefined,
            };
          }),
        });
        res.end();
        return;
      }

      // ---- Collections list (for the upload UI dropdown) ----
      if (pathname === "/api/collections" && method === "GET") {
        try {
          const cols = (await store.listCollections()).map((c) => ({
            name: c.name,
            path: c.pwd,
            pattern: c.glob_pattern,
          }));
          json(res, 200, { collections: cols });
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
          const file = files.find((f) => f.name === "file") || files[0];
          if (!file) {
            json(res, 400, { error: "未收到上传文件（表单字段名应为 file）" });
            return;
          }
          const ext = path.extname(file.filename).toLowerCase();
          const SUPPORTED = [".md", ".markdown", ".txt", ".pdf", ".docx", ".doc", ".pptx", ".ppt"];
          if (!SUPPORTED.includes(ext)) {
            json(res, 400, { error: `不支持的文件类型：${ext || "(无扩展名)"}` });
            return;
          }
          const safeName = path.basename(file.filename).replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, "_");
          if (!safeName || safeName === ".." || safeName.includes("/") || safeName.includes("\\")) {
            json(res, 400, { error: "非法文件名" });
            return;
          }

          // Resolve the target collection directory (auto-create if missing).
          // `store.internal` is the low-level Store used by reindexCollection.
          let coll = store.internal.getCollectionByName(collectionName);
          let collPath: string;
          if (coll) {
            collPath = path.resolve(coll.pwd);
          } else {
            const base = path.join(path.dirname(store.dbPath), "uploads", collectionName);
            fs.mkdirSync(base, { recursive: true });
            await store.addCollection(collectionName, {
              path: base,
              pattern: "**/*.{md,markdown,txt,pdf,docx,doc,pptx,ppt}",
              type: "raw",
            });
            collPath = base;
          }

          fs.mkdirSync(collPath, { recursive: true });
          const dest = path.join(collPath, safeName);
          fs.writeFileSync(dest, file.data);

          const autoIndex = fields.autoIndex !== "false" && fields.autoIndex !== "0";
          let reindex: unknown = null;
          let embed: unknown = null;
          if (autoIndex) {
            // Re-index just the uploaded file so its type is picked up regardless
            // of the collection's configured pattern.
            reindex = await reindexCollection(
              store.internal,
              collPath,
              `**/${safeName}`,
              collectionName,
              {},
            );
            const emb = await store.embed({ collections: [collectionName], force: false });
            embed = {
              docsProcessed: emb.docsProcessed,
              chunksEmbedded: emb.chunksEmbedded,
              errors: emb.errors,
              durationMs: emb.durationMs,
            };
          }

          json(res, 200, {
            status: "ok",
            file: safeName,
            collection: collectionName,
            path: dest,
            autoIndex,
            reindex,
            embed,
          });
        } catch (e) {
          json(res, 500, { error: (e as Error).message });
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
