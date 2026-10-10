/**
 * intake.ts — Iterative, context-preserving information collection.
 *
 * The system asks the user one question at a time. After every question/answer
 * exchange, the full Q&A transcript is retained as the running context, so each
 * subsequent question can build on and explicitly reference earlier answers.
 * Everything is persisted in SQLite (see db-schema migration v4) so a session
 * can be reviewed or resumed at any point.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import { getDefaultLlamaCpp } from "./llm.js";

// =============================================================================
// Types
// =============================================================================

export interface IntakeSession {
  id: string;
  goal: string;
  status: "active" | "done";
  created_at: string;
  updated_at: string;
}

export interface IntakeRecord {
  id: number;
  session_id: string;
  seq: number;
  role: "question" | "answer";
  content: string;
  /** seq numbers of prior records this entry references (for traceability). */
  refs: number[];
  created_at: string;
}

export interface IntakeSessionListItem {
  id: string;
  goal: string;
  status: string;
  updated_at: string;
  count: number;
}

export interface NextQuestion {
  text: string;
  refs: number[];
  done: boolean;
}

// =============================================================================
// Session / record persistence
// =============================================================================

export function createIntakeSession(db: Database, goal: string): IntakeSession {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO intake_sessions (id, goal, status) VALUES (?, ?, 'active')`
  ).run(id, goal);
  const session = getIntakeSession(db, id);
  if (!session) throw new Error("Failed to create intake session");
  return session;
}

export function listIntakeSessions(db: Database): IntakeSessionListItem[] {
  return db
    .prepare(
      `SELECT s.id, s.goal, s.status, s.updated_at,
              (SELECT COUNT(*) FROM intake_records r WHERE r.session_id = s.id) AS count
       FROM intake_sessions s
       ORDER BY s.updated_at DESC`
    )
    .all() as IntakeSessionListItem[];
}

export function getIntakeSession(db: Database, id: string): IntakeSession | null {
  return (
    (db.prepare(`SELECT * FROM intake_sessions WHERE id = ?`).get(id) as IntakeSession | null) ??
    null
  );
}

function parseRefs(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((n) => typeof n === "number") : [];
  } catch {
    return [];
  }
}

export function getIntakeRecords(db: Database, sessionId: string): IntakeRecord[] {
  const rows = db
    .prepare(`SELECT * FROM intake_records WHERE session_id = ? ORDER BY seq ASC`)
    .all(sessionId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id),
    session_id: r.session_id as string,
    seq: r.seq as number,
    role: r.role as "question" | "answer",
    content: r.content as string,
    refs: parseRefs((r.refs as string | null) ?? null),
    created_at: (r.created_at as string) ?? "",
  }));
}

export function addIntakeRecord(
  db: Database,
  sessionId: string,
  role: "question" | "answer",
  content: string,
  refs: number[]
): IntakeRecord {
  const maxRow = db
    .prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM intake_records WHERE session_id = ?`)
    .get(sessionId) as { m: number };
  const seq = maxRow.m + 1;
  const info = db
    .prepare(
      `INSERT INTO intake_records (session_id, seq, role, content, refs) VALUES (?, ?, ?, ?, ?)`
    )
    .run(sessionId, seq, role, content, JSON.stringify(refs));
  db.prepare(`UPDATE intake_sessions SET updated_at = datetime('now') WHERE id = ?`).run(sessionId);
  return {
    id: Number(info.lastInsertRowid),
    session_id: sessionId,
    seq,
    role,
    content,
    refs,
    created_at: "",
  };
}

export function setIntakeSessionStatus(
  db: Database,
  id: string,
  status: "active" | "done"
): void {
  db.prepare(`UPDATE intake_sessions SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(
    status,
    id
  );
}

// =============================================================================
// Context-aware next-question generation
// =============================================================================

/**
 * Produce the next question for an intake session.
 *
 * Uses the local LLM with the full transcript as context so follow-ups can
 * reference earlier answers. If the model is unavailable or returns nothing,
 * a deterministic fallback referencing the previous answer is used so the
 * collection flow never stalls.
 */
export async function generateNextQuestion(
  goal: string,
  records: IntakeRecord[],
  isFirst: boolean
): Promise<NextQuestion> {
  const lastAnswer = [...records].reverse().find((r) => r.role === "answer");
  const transcript = records
    .map((r) => `${r.role === "question" ? "采集方" : "用户"}：${r.content}`)
    .join("\n");

  const instruction = isFirst
    ? `你正在围绕目标「${goal}」收集信息。请提出第 1 个、也是唯一一个需要向用户询问的问题。不要寒暄、不要解释，只输出问题本身。`
    : `你正在围绕目标「${goal}」逐步收集信息。已收集内容：\n${transcript}\n\n请基于已收集内容，提出下一个需要向用户询问的单一问题；如果合适，请直接引用用户之前回答中的具体信息（例如“你刚才提到…”）以体现上下文关联。不要寒暄、不要解释。若信息已足够、无需再问，请只输出 <done>。`;

  let text: string | null = null;
  try {
    const res = await getDefaultLlamaCpp().generate(instruction, {
      maxTokens: 140,
      temperature: 0.6,
    });
    text = res?.text?.trim() || null;
  } catch {
    text = null;
  }

  // Model signaled completion.
  if (text && /<done>|信息已足够|无需再问|已收集完整|可以结束了/i.test(text)) {
    return { text: "", refs: lastAnswer ? [lastAnswer.seq] : [], done: true };
  }

  // Take the first non-empty line; strip wrapping quotes and a "question:" label.
  let questionText =
    (text || "")
      .split("\n")
      .map((s) => s.trim())
      .find((s) => s.length > 0) || "";
  questionText = questionText
    .replace(/^["'「『]/, "")
    .replace(/["'」』]$/, "")
    .replace(/^(问题|问|q)\s*[:：]\s*/i, "");

  if (!questionText) {
    if (lastAnswer) {
      const snippet =
        lastAnswer.content.length > 40
          ? lastAnswer.content.slice(0, 40) + "…"
          : lastAnswer.content;
      questionText = `你刚才提到「${snippet}」，能否再补充一些相关细节？`;
    } else {
      questionText = isFirst
        ? `为了达成「${goal}」，请先告诉我你的核心需求是什么？`
        : `关于「${goal}」，还有哪些信息需要补充？`;
    }
  }

  return { text: questionText, refs: lastAnswer ? [lastAnswer.seq] : [], done: false };
}

/**
 * Render the full collected transcript as plain text for review / export.
 */
export function formatSummary(goal: string, records: IntakeRecord[]): string {
  const lines: string[] = [`目标：${goal}`, ""];
  for (const r of records) {
    lines.push(`${r.role === "question" ? "Q" : "A"}${r.seq}. ${r.content}`);
  }
  return lines.join("\n");
}
