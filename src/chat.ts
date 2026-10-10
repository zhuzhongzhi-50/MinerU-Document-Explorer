/**
 * chat.ts — Per-user persistent chat (Q&A) history.
 *
 * Mirrors the intake session pattern (src/intake.ts) but is scoped to a single
 * user via `user_id`, so each account recovers only its own history after login.
 * All tables live in the same SQLite store as the rest of QMD.
 *
 * Data model:
 *   chat_sessions  (id, user_id, title, collections, mode, status, timestamps)
 *   chat_messages  (id, session_id, seq, role, content, model, sources,
 *                  raw_results, tokens_used, elapsed_ms, error, timestamp)
 */

import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";

export interface ChatSession {
  id: string;
  user_id: string;
  title: string;
  collections: string;
  mode: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: number;
  session_id: string;
  seq: number;
  role: "user" | "assistant" | "system";
  content: string;
  model: string | null;
  sources: string | null;
  raw_results: string | null;
  tokens_used: number | null;
  elapsed_ms: number | null;
  error: string | null;
  created_at: string;
}

export interface ChatMessageInput {
  model?: string;
  sources?: unknown;
  rawResults?: unknown;
  tokensUsed?: number;
  elapsedMs?: number;
  error?: string;
}

// =============================================================================
// Session / message persistence
// =============================================================================

export function createChatSession(
  db: Database,
  userId: string,
  opts?: { title?: string; collections?: string; mode?: string },
): ChatSession {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO chat_sessions (id, user_id, title, collections, mode) VALUES (?, ?, ?, ?, ?)`
  ).run(
    id,
    userId,
    (opts?.title ?? "").slice(0, 200),
    opts?.collections ?? "",
    opts?.mode ?? "query",
  );
  const session = getChatSession(db, id);
  if (!session) throw new Error("Failed to create chat session");
  return session;
}

export function listChatSessions(
  db: Database,
  userId: string
): Array<ChatSession & { count: number }> {
  return db
    .prepare(
      `SELECT s.id, s.user_id, s.title, s.collections, s.mode, s.status, s.created_at, s.updated_at,
              (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS count
       FROM chat_sessions s
       WHERE s.user_id = ?
       ORDER BY s.updated_at DESC`
    )
    .all(userId) as Array<ChatSession & { count: number }>;
}

export function getChatSession(db: Database, id: string): ChatSession | null {
  return (
    (db.prepare(`SELECT * FROM chat_sessions WHERE id = ?`).get(id) as ChatSession | null) ??
    null
  );
}

/** Returns the owning user_id for a session, or null if the session doesn't exist. */
export function getChatOwner(db: Database, id: string): string | null {
  const row = db.prepare(`SELECT user_id FROM chat_sessions WHERE id = ?`).get(id) as
    | { user_id: string }
    | null;
  return row?.user_id ?? null;
}

export function getChatMessages(db: Database, sessionId: string): ChatMessage[] {
  const rows = db
    .prepare(`SELECT * FROM chat_messages WHERE session_id = ? ORDER BY seq ASC`)
    .all(sessionId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id),
    session_id: r.session_id as string,
    seq: r.seq as number,
    role: r.role as ChatMessage["role"],
    content: r.content as string,
    model: (r.model as string | null) ?? null,
    sources: (r.sources as string | null) ?? null,
    raw_results: (r.raw_results as string | null) ?? null,
    tokens_used: (r.tokens_used as number | null) ?? null,
    elapsed_ms: (r.elapsed_ms as number | null) ?? null,
    error: (r.error as string | null) ?? null,
    created_at: (r.created_at as string) ?? "",
  }));
}

export function addChatMessage(
  db: Database,
  sessionId: string,
  role: ChatMessage["role"],
  content: string,
  opts?: ChatMessageInput
): ChatMessage {
  const maxRow = db
    .prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM chat_messages WHERE session_id = ?`)
    .get(sessionId) as { m: number };
  const seq = maxRow.m + 1;
  const info = db
    .prepare(
      `INSERT INTO chat_messages
        (session_id, seq, role, content, model, sources, raw_results, tokens_used, elapsed_ms, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      sessionId,
      seq,
      role,
      content,
      opts?.model ?? null,
      opts?.sources === undefined ? null : JSON.stringify(opts.sources ?? null),
      opts?.rawResults === undefined ? null : JSON.stringify(opts.rawResults ?? null),
      opts?.tokensUsed ?? null,
      opts?.elapsedMs ?? null,
      opts?.error ?? null
    );

  // Bump session activity; auto-title from the first user message if still empty.
  if (role === "user") {
    const s = getChatSession(db, sessionId);
    if (s && !s.title) {
      const t = content.trim().slice(0, 40);
      db.prepare(
        `UPDATE chat_sessions SET title = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(t || "(未命名会话)", sessionId);
    } else {
      db.prepare(`UPDATE chat_sessions SET updated_at = datetime('now') WHERE id = ?`).run(
        sessionId
      );
    }
  } else {
    db.prepare(`UPDATE chat_sessions SET updated_at = datetime('now') WHERE id = ?`).run(
      sessionId
    );
  }

  const id = Number(info.lastInsertRowid);
  const row = db.prepare(`SELECT * FROM chat_messages WHERE id = ?`).get(id) as Record<
    string,
    unknown
  >;
  return {
    id,
    session_id: row.session_id as string,
    seq: row.seq as number,
    role: row.role as ChatMessage["role"],
    content: row.content as string,
    model: (row.model as string | null) ?? null,
    sources: (row.sources as string | null) ?? null,
    raw_results: (row.raw_results as string | null) ?? null,
    tokens_used: (row.tokens_used as number | null) ?? null,
    elapsed_ms: (row.elapsed_ms as number | null) ?? null,
    error: (row.error as string | null) ?? null,
    created_at: (row.created_at as string) ?? "",
  };
}

export function renameChatSession(db: Database, id: string, title: string): void {
  db.prepare(`UPDATE chat_sessions SET title = ?, updated_at = datetime('now') WHERE id = ?`).run(
    title,
    id
  );
}

export function deleteChatSession(db: Database, id: string): void {
  // Manual cleanup so deletion works even if FK enforcement is disabled.
  db.prepare(`DELETE FROM chat_messages WHERE session_id = ?`).run(id);
  db.prepare(`DELETE FROM chat_sessions WHERE id = ?`).run(id);
}
