/**
 * Contract risk-review engine.
 *
 * Pipeline (retrieve-then-evaluate, reusing the existing hybrid search):
 *   1. Extract project basic info from the contract body.
 *   2. For each enabled operational risk rule: retrieve the most relevant
 *      contract passages via hybridQuery, then ask the LLM for a strict-JSON
 *      verdict (triggered / not_triggered / not_found + excerpt + severity + advice).
 *   3. Run the special-case checks that the contract's tags activate.
 *   4. Synthesize the three-part report (project info / per-rule review / overall).
 *   5. Persist report + analysis record + contract metadata.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Store } from "../store.js";
import type { Database } from "../db.js";
import { hybridQuery } from "../hybrid-search.js";
import { getSettings } from "../settings.js";
import { getDocid, getWikiCollections } from "../store.js";
import {
  REVIEW_SYSTEM_PROMPT,
  activeSpecialChecks,
  buildOverallPrompt,
  buildProjectInfoPrompt,
  buildRuleEvaluationPrompt,
  buildContractDrivenPrompt,
  type SpecialCheck,
} from "./prompt.js";
import {
  getCollectionContractType,
  getContractMeta,
  importRiskRules,
  insertAnalysisRecord,
  listRiskRules,
  listRiskRulesForContract,
  upsertContractMeta,
} from "./db.js";
import { ensureContractReviewSchema } from "./db-init.js";

export interface RuleFinding {
  ruleId: string;
  name: string;
  category: string;
  status: "triggered" | "not_triggered" | "not_found" | "error";
  excerpt: string;
  excerptLocation: string;
  /** 摘录在合同原文中的精确位置：文档 hash + 1-based 行号，供前端「定位原文」跳转 */
  excerptDocHash?: string;
  excerptLine?: number;
  analysis: string;
  severity: string; // 高/中/低/不适用
  suggestion: string;
  /** Titles of the wiki (yunyingwiki) pages matched as background 依据 for this rule. */
  wikiRefs: string[];
}

export interface ReviewOptions {
  collection: string;
  /** Single document to review. When omitted, ALL active documents in the
   *  collection are reviewed together (the contract package = the Q&A collection). */
  path?: string;
  /** contract tags that activate special-case checks (联合体/能源/学校医院/长周期) */
  tags?: string[];
  rulesetVersion?: string;
  /** called after each rule is evaluated: (done, total, finding) */
  onProgress?: (done: number, total: number, finding: RuleFinding) => void;
  /** override output directory for the markdown report */
  reportDir?: string;
}

export interface ReviewResult {
  docid: string;
  reportMarkdown: string;
  findings: RuleFinding[];
  projectInfo: Record<string, string>;
  overall: Record<string, unknown>;
  specialChecks: SpecialCheck[];
  reportPath: string;
  analysisId: number;
}

// ---------------------------------------------------------------------------
// LLM chat helper (OpenAI-compatible /chat/completions, mirrors rag.ts)
// ---------------------------------------------------------------------------
async function chatComplete(
  system: string,
  user: string,
  opts?: { temperature?: number; timeoutMs?: number },
): Promise<string> {
  const settings = getSettings();
  const baseUrl = (settings.llmBaseUrl || process.env.LLM_BASE_URL || "").replace(/\/+$/, "");
  const apiKey = settings.llmApiKey || process.env.LLM_API_KEY || "";
  const model = settings.llmModel || process.env.LLM_MODEL || "";
  if (!baseUrl || !model) {
    throw new Error(
      "未配置问答模型：请通过 qmd config set llmBaseUrl/llmModel/llmApiKey 或环境变量 LLM_BASE_URL/LLM_MODEL/LLM_API_KEY 配置 chat 模型。",
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 180_000);
  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: opts?.temperature ?? 0.2,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`问答 API 错误 ${resp.status}: ${text.slice(0, 500)}`);
    }
    const json = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

function extractJsonObject(text: string): Record<string, unknown> {
  // Strip markdown code fences if present, then parse the first balanced JSON object.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) return {};
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------
/**
 * Retrieve contract passages (from the review collection) AND knowledge-base
 * references (from every wiki collection) for one rule. The two scopes are
 * queried separately so provenance stays clear — the contract is the object
 * under review, the wiki is only background/reference. No search-core change:
 * this just issues a second hybridQuery with a different `collections` scope.
 */
export async function retrieveForRule(
  store: Store,
  collection: string,
  wikiCols: string[],
  ruleName: string,
  ruleDesc: string,
): Promise<{ retrieved: string; kbRetrieved: string; wikiRefs: string[] }> {
  try {
    const query = `${ruleName} ${ruleDesc}`;
    const contractRes = await hybridQuery(store, query, {
      collection,
      limit: 4,
      skipRerank: true,
      minScore: 0,
    });
    let wikiRes: Awaited<ReturnType<typeof hybridQuery>> = [];
    if (wikiCols.length) {
      wikiRes = await hybridQuery(store, query, {
        collections: wikiCols,
        limit: 4,
        skipRerank: true,
        minScore: 0,
      });
    }
    const retrieved = contractRes.length
      ? contractRes
          .map((r, i) => `【片段${i + 1}】(${r.displayPath})\n${(r.bestChunk || r.body || "").slice(0, 1500)}`)
          .join("\n\n")
      : "（未在合同中检索到相关片段）";
    const kbRetrieved = wikiRes.length
      ? wikiRes
          .map((r, i) => `【片段${i + 1}】(${r.displayPath})\n${(r.bestChunk || r.body || "").slice(0, 1500)}`)
          .join("\n\n")
      : "";
    const wikiRefs = wikiRes.length
      ? Array.from(new Set(wikiRes.map((r) => r.title).filter((t): t is string => !!t)))
      : [];
    return { retrieved, kbRetrieved, wikiRefs };
  } catch {
    return { retrieved: "（检索失败）", kbRetrieved: "", wikiRefs: [] };
  }
}

async function getDocumentBody(db: Database, collection: string, path?: string): Promise<string> {
  let row: { doc: string } | undefined;
  if (path) {
    row = db
      .prepare(
        `SELECT c.doc FROM content c JOIN documents d ON d.hash = c.hash
         WHERE d.collection = ? AND d.path = ? AND d.active = 1 LIMIT 1`,
      )
      .get(collection, path) as { doc: string } | undefined;
  }
  if (!row) {
    // Fallback: any active document in the collection.
    row = db
      .prepare(
        `SELECT c.doc FROM content c JOIN documents d ON d.hash = c.hash
         WHERE d.collection = ? AND d.active = 1 ORDER BY d.id DESC LIMIT 1`,
      )
      .get(collection) as { doc: string } | undefined;
  }
  return row?.doc ?? "";
}

/**
 * Gather every active document's content in a collection — used when the review
 * is scoped to the whole collection (the contract package) rather than one file.
 * Each document is capped so the project-info prompt stays bounded.
 */
async function getCollectionBodies(
  db: Database,
  collection: string,
): Promise<{ paths: string[]; combined: string }> {
  const rows = db
    .prepare(
      `SELECT d.path AS path, c.doc AS content FROM content c
       JOIN documents d ON d.hash = c.hash
       WHERE d.collection = ? AND d.active = 1 ORDER BY d.id`,
    )
    .all(collection) as { path: string; content: string }[];
  const paths = rows.map((r) => r.path);
  const combined = rows
    .map((r, i) => `\n\n===== 文档 ${i + 1}：${r.path} =====\n${(r.content || "").slice(0, 12000)}`)
    .join("");
  return { paths, combined };
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------
export async function reviewContract(store: Store, opts: ReviewOptions): Promise<ReviewResult> {
  // 确保合同审查场景所需的表与种子已就绪（替代原 db-schema v5/v7/v8 中央迁移）。
  // 幂等，CLI 脚本直调 reviewContract 时也能兜底建表。
  ensureContractReviewSchema(store.db);
  const db = store.db;
  const tags = opts.tags ?? [];
  // 规则库为空时自动播种内置《运营类风险要素清单》（幂等），避免静默产出
  // 出"第二部分：对照风险清单逐项评审"为空的报告。
  if (listRiskRules(db, { enabledOnly: true }).length === 0) {
    importRiskRules(db);
  }
  // 按当前集合的合同类型取规则集：
  // 「规则整理」页面为该类型配置过映射则用配置，未配置则沿用默认全集（向后兼容）。
  const collType = getCollectionContractType(db, opts.collection ?? "");
  const scoped = listRiskRulesForContract(db, collType.contractType, collType.contractSubtype);
  let rules = scoped.rules;
  if (rules.length === 0) {
    throw new Error(
      "风险规则库为空：已尝试自动导入内置清单但仍为空。请确认程序已内置 RISK_RULES_SEED，或手动调用 POST /api/risk-rules/import 后重试。",
    );
  }
  const specialChecks = activeSpecialChecks(tags);
  const specialNote = specialChecks.length
    ? specialChecks.map((c) => c.prompt).join("\n")
    : undefined;

  // Knowledge-base (wiki) collections become background references during the
  // per-rule evaluation — they are NOT the object under review (that is the
  // contract collection above). If no wiki collection exists, this is empty.
  const wikiCols = getWikiCollections(db).map((c) => c.name);

  // 1) Project basic info
  const isCollectionScope = !opts.path;
  let body = "";
  if (isCollectionScope) {
    const { combined } = await getCollectionBodies(db, opts.collection);
    body = combined;
  } else {
    body = await getDocumentBody(db, opts.collection, opts.path);
  }
  let projectInfo: Record<string, string> = {};
  try {
    const piText = await chatComplete(REVIEW_SYSTEM_PROMPT, buildProjectInfoPrompt(body), { temperature: 0.1 });
    projectInfo = extractJsonObject(piText) as Record<string, string>;
  } catch {
    projectInfo = { _error: "项目信息抽取失败（未配置 chat 模型或调用异常）" };
  }

  // 2) Per-rule evaluation
  const findings: RuleFinding[] = [];
  let done = 0;
  for (const rule of rules) {
    const { retrieved, kbRetrieved, wikiRefs } = await retrieveForRule(
      store,
      opts.collection,
      wikiCols,
      rule.name,
      rule.description,
    );
    const prompt = buildRuleEvaluationPrompt({
      ruleId: rule.rule_id,
      ruleName: rule.name,
      ruleDescription: rule.description,
      basis: rule.basis,
      suggestion: rule.suggestion,
      retrieved,
      kbRetrieved,
      wikiRefs,
      specialNote: specialChecks.some((c) => rule.category === "联合体模式专项风险" && c.id === "consortium")
        ? specialNote
        : undefined,
    });
    let finding: RuleFinding = {
      ruleId: rule.rule_id,
      name: rule.name,
      category: rule.category,
      status: "error",
      excerpt: "",
      excerptLocation: "",
      analysis: "",
      severity: "不适用",
      suggestion: "",
      wikiRefs: [],
    };
    try {
      const raw = await chatComplete(REVIEW_SYSTEM_PROMPT, prompt, { temperature: 0.2 });
      const j = extractJsonObject(raw);
      finding = {
        ruleId: rule.rule_id,
        name: rule.name,
        category: rule.category,
        status: (j.status as RuleFinding["status"]) ?? "error",
        excerpt: (j.excerpt as string) ?? "",
        excerptLocation: (j.excerptLocation as string) ?? "",
        analysis: (j.analysis as string) ?? "",
        severity: (j.severity as string) ?? "不适用",
        suggestion: (j.suggestion as string) ?? "",
        wikiRefs,
      };
    } catch {
      // keep error finding
    }
    findings.push(finding);
    done += 1;
    opts.onProgress?.(done, rules.length, finding);
  }

  // 2.5) 解析每条摘录在合同原文中的精确定位（文档 hash + 行号），供前端「定位原文」跳转
  const reviewDocHashes: string[] = isCollectionScope
    ? (db.prepare(`SELECT hash FROM documents WHERE collection = ? AND active = 1`).all(opts.collection) as { hash: string }[]).map((r) => r.hash)
    : (() => {
        const hr = db.prepare(`SELECT hash FROM documents WHERE collection = ? AND path = ? AND active = 1 LIMIT 1`).get(opts.collection, opts.path) as { hash: string } | undefined;
        return hr ? [hr.hash] : [];
      })();
  resolveExcerptLocations(db, reviewDocHashes, findings);

  // 3) Overall evaluation
  let overall: Record<string, unknown> = {};
  try {
    const overallText = await chatComplete(
      REVIEW_SYSTEM_PROMPT,
      buildOverallPrompt({
        projectInfo: JSON.stringify(projectInfo, null, 2),
        findingsJson: JSON.stringify(
          findings.map((f) => ({ ruleId: f.ruleId, name: f.name, status: f.status, severity: f.severity })),
          null,
          2,
        ),
        specialNotes: specialChecks.map((c) => `${c.label}：${c.prompt}`).join("\n"),
      }),
      { temperature: 0.2 },
    );
    overall = extractJsonObject(overallText);
  } catch {
    overall = { _error: "总体评价生成失败" };
  }

  // 4) Compose report
  const reportMarkdown = composeReport({ projectInfo, findings, overall, specialChecks, collection: opts.collection });

  // 5) Persist
  // Resolve the contract docid first — a stable id per collection when reviewing
  // the whole package, or per-document hash otherwise.
  let docid: string;
  if (opts.path) {
    const hashRow = db
      .prepare(`SELECT hash FROM documents WHERE collection = ? AND path = ? AND active = 1 LIMIT 1`)
      .get(opts.collection, opts.path) as { hash: string } | undefined;
    docid = hashRow ? getDocid(hashRow.hash) : `contract-${Date.now()}`;
  } else {
    // Collection-wide review: a stable docid per collection.
    const slug = opts.collection.replace(/[^a-zA-Z0-9_-]/g, "_");
    docid = `coll-${slug}`;
  }

  const reportDir = opts.reportDir ?? join(dirname(store.dbPath ?? join(process.cwd(), "index.sqlite")), "reports");
  if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `${docid}-${Date.now()}.md`);
  writeFileSync(reportPath, reportMarkdown, "utf-8");

  // contract metadata (versioned)
  const existing = getContractMeta(db, docid);
  upsertContractMeta(db, {
    docid,
    title: projectInfo.projectName || existing?.title || (isCollectionScope ? `集合 ${opts.collection} 合同包` : opts.path) || opts.collection,
    collection: opts.collection,
    tags,
  });

  const analysisId = insertAnalysisRecord(db, {
    docid,
    rulesetVersion: opts.rulesetVersion ?? "1.0.0",
    reportPath,
    summaryJson: JSON.stringify({ overall, counts: summarize(findings) }),
  });

  return { docid, reportMarkdown, findings, projectInfo, overall, specialChecks, reportPath, analysisId };
}

// 在合同原文中定位摘录：逐文档检索，记录命中行的 1-based 行号，供前端精确跳转。
function resolveExcerptLocations(db: Database, docHashes: string[], findings: RuleFinding[]): void {
  const textCache = new Map<string, string>();
  const getText = (hash: string): string => {
    if (!textCache.has(hash)) {
      const row = db.prepare(`SELECT doc FROM content WHERE hash = ?`).get(hash) as { doc: string } | null;
      textCache.set(hash, row?.doc ?? "");
    }
    return textCache.get(hash)!;
  };
  for (const f of findings) {
    const excerpt = (f.excerpt || "").replace(/\s+/g, "");
    if (excerpt.length < 6) continue; // 过短无法稳定定位
    const needle = excerpt.slice(0, 60);
    for (const hash of docHashes) {
      const text = getText(hash);
      if (!text) continue;
      const lines = text.split("\n");
      let li = 0;
      for (const line of lines) {
        li += 1;
        if (line.replace(/\s+/g, "").includes(needle)) {
          f.excerptDocHash = hash;
          f.excerptLine = li;
          break;
        }
      }
      if (f.excerptDocHash) break;
    }
  }
}

function summarize(findings: RuleFinding[]) {
  const counts = { triggered: 0, not_triggered: 0, not_found: 0, error: 0 };
  for (const f of findings) counts[f.status] = (counts[f.status] ?? 0) + 1;
  return { total: findings.length, ...counts };
}

// ---------------------------------------------------------------------------
// Report composer (three-part, itemized — matches V1.1 output format)
// ---------------------------------------------------------------------------
export function composeReport(args: {
  projectInfo: Record<string, string>;
  findings: RuleFinding[];
  overall: Record<string, unknown>;
  specialChecks: SpecialCheck[];
  collection: string;
}): string {
  const { projectInfo, findings, overall, specialChecks, collection } = args;
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");

  const piFields: [string, string, string][] = [
    ["项目名称与类型", "projectName", "projectNameLoc"],
    ["合同主体", "parties", "partiesLoc"],
    ["合作期限", "term", "termLoc"],
    ["合作模式", "model", "modelLoc"],
    ["投资责任", "investment", "investmentLoc"],
    ["收益分配", "revenue", "revenueLoc"],
    ["退出机制", "exit", "exitLoc"],
    ["违约责任", "breach", "breachLoc"],
    ["保险要求", "insurance", "insuranceLoc"],
    ["争议解决", "dispute", "disputeLoc"],
  ];
  const part1 = piFields
    .map(([label, k, lk], i) => {
      const v = (projectInfo[k] || "（未提取）").trim();
      const loc = (projectInfo[lk] || "").trim();
      return `${i + 1}. 第${i + 1}项｜${label}：【${v}】${loc ? `（出处：${loc}）` : ""}`;
    })
    .join("\n");

  // Group findings by category (the six phases)
  const byCat = new Map<string, RuleFinding[]>();
  for (const f of findings) {
    if (!byCat.has(f.category)) byCat.set(f.category, []);
    byCat.get(f.category)!.push(f);
  }
  let idx = 0;
  const part2 = [...byCat.entries()]
    .map(([cat, fs]) => {
      const lines = fs
        .map((f) => {
          idx += 1;
          const statusText =
            f.status === "triggered"
              ? "已触发"
              : f.status === "not_triggered"
                ? "未触发"
                : f.status === "not_found"
                  ? "合同中未找到相关约定"
                  : "评审异常";
          return [
            `${idx}. 第${idx}项｜${f.name}（${f.ruleId}）`,
            `   - 合同映射情况：${statusText}`,
            `   - 风险条款原文摘录：${f.excerpt || "（无）"}${f.excerptLocation ? `（出处：${f.excerptLocation}）` : ""}${f.excerptDocHash ? ` ⟦LOC:${f.excerptDocHash}:${f.excerptLine}⟧` : ""}`,
            `   - 风险解析：${f.analysis || "（无）"}`,
            `   - 风险等级：${f.severity || "不适用"}`,
            `   - 修改建议：${f.suggestion || "（无）"}`,
            `   - 制度/模板依据（来自运营知识库 wiki）：${f.wikiRefs?.length ? f.wikiRefs.join("、") : "（无）"}`,
          ].join("\n");
        })
        .join("\n");
      return `## ${cat}\n${lines}`;
    })
    .join("\n\n");

  const overallText = (() => {
    const o = overall as any;
    if (!o || o._error) return o?._error ? `> ${o._error}` : "（未生成总体评价）";

    const rating = o.overallRating || "未评定";
    const tops: any[] = Array.isArray(o.top5) ? o.top5 : [];
    const bottoms: any[] = Array.isArray(o.bottomLines) ? o.bottomLines : [];
    const p = o.negotiationPriority || {};
    const p1: any[] = Array.isArray(p.p1) ? p.p1 : [];
    const p2: any[] = Array.isArray(p.p2) ? p.p2 : [];
    const p3: any[] = Array.isArray(p.p3) ? p.p3 : [];
    const approvals: any[] = Array.isArray(o.internalApproval) ? o.internalApproval : [];

    const ratingLine = `### 总体风险评级\n**${rating}**`;

    // 评价模型说明：输入 / 输出 / 关键参数（与第二部分口径一致）
    const modelNote = [
      `### 评价模型说明（输入 / 输出 / 关键参数）`,
      `- **输入**：第二部分逐条评审结果（触发风险清单）+ 项目基本信息 + 44 项风险清单。`,
      `- **输出**：总体风险评级、TOP5 核心风险、必须修改的底线条款、三档谈判优先级、内部审批提示。`,
      `- **关键参数**：等级口径（高/中/低，与第二部分一致）；存在任一「已触发+高」即判高风险；底线条款为「不改不签」一票否决；优先级按「是否触及底线 → 风险等级 → 审批层级」三维排序。`,
    ].join("\n");

    // 一、核心风险清单 TOP5：对比表 + 逐条（沿用第二部分条目式标签）
    const topTable = [
      `### 一、核心风险清单（TOP5，按暴露程度排序）`,
      `| 排名 | 风险点（规则ID） | 关联条款 | 风险等级 | 核心矛盾（一句话） |`,
      `| --- | --- | --- | --- | --- |`,
      ...tops.map(
        (t, i) =>
          `| ${i + 1} | ${t.name}（${t.ruleId}） | ${t.excerptLocation || "—"} | ${t.severity || "高"} | ${t.analysis || "—"} |`,
      ),
    ].join("\n");
    const topItems = tops
      .map((t, i) =>
        [
          `${i + 1}. 第${i + 1}项｜${t.name}（${t.ruleId}）`,
          `   - 合同映射情况：已触发`,
          `   - 风险条款原文摘录：${t.excerpt || "（无）"}${t.excerptLocation ? `（出处：${t.excerptLocation}）` : ""}`,
          `   - 风险解析：${t.analysis || "（无）"}`,
          `   - 风险等级：${t.severity || "高"}`,
          `   - 修改建议（谈判要点）：${t.suggestion || "（无）"}`,
          `   - 制度/模板依据（来自运营知识库 wiki）：${t.wikiRefs || "（无）"}`,
        ].join("\n"),
      )
      .join("\n");

    // 二、必须修改的底线条款（不改不签）
    const bottomItems = bottoms
      .map((b, i) =>
        [
          `底线条款${i + 1}：【${b.ruleId} ${b.clause}】`,
          `   - 合同映射情况：已触发`,
          `   - 风险解析：${b.analysis || "（无）"}`,
          `   - 修改要求（输出）：${b.requirement || "（无）"}`,
          `   - 关键参数：${b.keyParams || `关联条款 ${b.location || "—"}；风险等级 高；处置层级 谈判底线（一票否决）`}`,
          `   - 制度/模板依据（来自运营知识库 wiki）：${b.wikiRefs || "（无）"}`,
        ].join("\n"),
      )
      .join("\n");

    // 三、谈判优先级建议：三档矩阵表（编号 / 关联条款 / 输出 / 输入）
    const tierTable = (title: string, arr: any[]) => {
      if (!arr.length) return "";
      return [
        `**${title}**`,
        `| 编号 | 关联条款 | 谈判目标（输出） | 输入（触发风险） |`,
        `| --- | --- | --- | --- |`,
        ...arr.map((x) => `| ${x.id} | ${x.clauses || "—"} | ${x.output || "—"} | ${x.input || "—"} |`),
      ].join("\n");
    };

    // 四、内部审批提示
    const approvalItems = approvals
      .map((a, i) =>
        [
          `提示${i + 1}：【${a.matter}】`,
          `   - 制度依据：${a.basis || "（无）"}`,
          `   - 审批层级（关键参数）：${a.level || "（无）"}${a.keyParams ? ` · ${a.keyParams}` : ""}`,
        ].join("\n"),
      )
      .join("\n");

    return [
      ratingLine,
      "",
      modelNote,
      "",
      topTable,
      "",
      topItems || "（无）",
      "",
      "### 二、必须修改的底线条款（不改不签）",
      bottomItems || "（无）",
      "",
      "### 三、谈判优先级建议",
      "> 模型输入：第二部分触发的各项风险 + 本合同特征；模型输出：分三档的谈判行动清单；关键参数：风险等级、是否触及底线、审批层级。",
      tierTable("第一优先级（底线条款，不改不签）", p1),
      "",
      tierTable("第二优先级（核心风险，重点争取）", p2),
      "",
      tierTable("第三优先级（重要但可适度让步）", p3),
      "",
      "### 四、内部审批提示",
      approvalItems || "（无）",
    ].join("\n");
  })();

  const special = specialChecks.length
    ? `## 特殊情形强制检查\n${specialChecks.map((c) => `- ${c.label}：${c.prompt}`).join("\n")}`
    : "";

  return `# 运营类合同风险分析报告

> 生成时间：${now}　|　合同集合：${collection}　|　规则集版本：1.0.0

## 第一部分：项目基本信息提取（条目式）
${part1 || "（未提取）"}

## 第二部分：对照风险清单逐项评审（条目式）
${part2}

${special}

## 第三部分：总体评价与谈判优先级（条目式）
${overallText}
`;
}

// ---------------------------------------------------------------------------
// Contract-driven (reverse) review: slice the contract into clauses, then for
// each clause retrieve wiki background + ask the LLM to surface ALL risks —
// especially "unexpected" ones the 44-rule checklist does not cover.
// ---------------------------------------------------------------------------
export interface ContractDrivenRisk {
  type: "expected" | "unexpected";
  matchedRule: string;
  description: string;
  severity: string;
  suggestion: string;
}

export interface ContractDrivenFinding {
  location: string;
  clause: string;
  risks: ContractDrivenRisk[];
  wikiRefs: string[];
}

export interface ContractDrivenOptions {
  collection: string;
  /** Single document to review. When omitted, the whole collection is reviewed. */
  path?: string;
  tags?: string[];
  /** Upper bound on how many contract clauses are analysed (bounds LLM calls). */
  maxFragments?: number;
  reportDir?: string;
  onProgress?: (done: number, total: number, finding: ContractDrivenFinding) => void;
}

export interface ContractDrivenResult {
  docid: string;
  reportMarkdown: string;
  findings: ContractDrivenFinding[];
  unexpectedCount: number;
  totalRisks: number;
  reportPath: string;
}

/** Split a contract body into clause-level fragments (paragraph/article granularity). */
function splitClauses(text: string): { location: string; text: string }[] {
  const paras = text.split(/\n{1,}/).map((s) => s.trim()).filter(Boolean);
  const out: { location: string; text: string }[] = [];
  paras.forEach((p, i) => {
    const m = p.match(/^第[一二三四五六七八九十百零0-9]+(\.\d+)*条/);
    const location = m ? m[0]! : `段落${i + 1}`;
    if (p.length >= 24) out.push({ location, text: p });
  });
  return out;
}

/** Parse the first JSON array from an LLM response (tolerant of code fences). */
function extractJsonArray(text: string): unknown[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start === -1 || end === -1) return [];
  try {
    const v = JSON.parse(candidate.slice(start, end + 1));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export async function contractDrivenReview(
  store: Store,
  opts: ContractDrivenOptions,
): Promise<ContractDrivenResult> {
  const db = store.db;
  const wikiCols = getWikiCollections(db).map((c) => c.name);
  const rules = listRiskRules(db, { enabledOnly: true });
  const ruleIndex = rules.map((r) => `${r.rule_id} ${r.name}`).join("；");

  let body = "";
  if (opts.path) {
    body = await getDocumentBody(db, opts.collection, opts.path);
  } else {
    const { combined } = await getCollectionBodies(db, opts.collection);
    body = combined;
  }
  const clauses = splitClauses(body).slice(0, opts.maxFragments ?? 40);

  const findings: ContractDrivenFinding[] = [];
  let done = 0;
  for (const c of clauses) {
    let kbRetrieved = "";
    let wikiRefs: string[] = [];
    try {
      if (wikiCols.length) {
        const wikiRes = await hybridQuery(store, `${c.location} ${c.text.slice(0, 200)}`, {
          collections: wikiCols,
          limit: 3,
          skipRerank: true,
          minScore: 0,
        });
        kbRetrieved = wikiRes.length
          ? wikiRes
              .map((r, i) => `【片段${i + 1}】(${r.displayPath})\n${(r.bestChunk || r.body || "").slice(0, 1200)}`)
              .join("\n\n")
          : "";
        wikiRefs = wikiRes.length
          ? Array.from(new Set(wikiRes.map((r) => r.title).filter((t): t is string => !!t)))
          : [];
      }
    } catch {
      // wiki retrieval is best-effort; continue without it
    }

    let risks: ContractDrivenRisk[] = [];
    try {
      const raw = await chatComplete(
        REVIEW_SYSTEM_PROMPT,
        buildContractDrivenPrompt({
          clauseLocation: c.location,
          clauseText: c.text,
          kbRetrieved,
          wikiRefs,
          ruleIndex,
        }),
        { temperature: 0.3 },
      );
      const arr = extractJsonArray(raw);
      risks = arr.map((x) => {
        const o = x as Record<string, unknown>;
        return {
          type: o.type === "unexpected" ? "unexpected" : "expected",
          matchedRule: (o.matchedRule as string) || "",
          description: (o.description as string) || "",
          severity: (o.severity as string) || "不适用",
          suggestion: (o.suggestion as string) || "",
        };
      });
    } catch {
      // LLM unavailable: leave risks empty, the clause is still listed
    }

    const finding: ContractDrivenFinding = { location: c.location, clause: c.text, risks, wikiRefs };
    findings.push(finding);
    done += 1;
    opts.onProgress?.(done, clauses.length, finding);

    // Incremental persist: a long run may be interrupted by a timeout, so write a
    // usable (partial) report after every clause instead of only at the very end.
    try {
      const partialUnexpected = findings.reduce(
        (n, f) => n + f.risks.filter((r) => r.type === "unexpected").length,
        0,
      );
      const partialTotal = findings.reduce((n, f) => n + f.risks.length, 0);
      const slug = (opts.path || opts.collection).replace(/[^a-zA-Z0-9_-]/g, "_");
      const docid = opts.path ? `cd-${slug}` : `cd-coll-${slug}`;
      const reportDir =
        opts.reportDir ?? join(dirname(store.dbPath ?? join(process.cwd(), "index.sqlite")), "reports");
      if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
      writeFileSync(
        join(reportDir, `${docid}-partial.md`),
        composeContractDrivenReport({ collection: opts.collection, findings, unexpectedCount: partialUnexpected, totalRisks: partialTotal }),
        "utf-8",
      );
    } catch {
      // best-effort
    }
  }

  const totalRisks = findings.reduce((n, f) => n + f.risks.length, 0);
  const unexpectedCount = findings.reduce(
    (n, f) => n + f.risks.filter((r) => r.type === "unexpected").length,
    0,
  );
  const reportMarkdown = composeContractDrivenReport({
    collection: opts.collection,
    findings,
    unexpectedCount,
    totalRisks,
  });

  const slug = (opts.path || opts.collection).replace(/[^a-zA-Z0-9_-]/g, "_");
  const docid = opts.path ? `cd-${slug}` : `cd-coll-${slug}`;
  const reportDir = opts.reportDir ?? join(dirname(store.dbPath ?? join(process.cwd(), "index.sqlite")), "reports");
  if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `${docid}-${Date.now()}.md`);
  writeFileSync(reportPath, reportMarkdown, "utf-8");

  return { docid, reportMarkdown, findings, unexpectedCount, totalRisks, reportPath };
}

export function composeContractDrivenReport(args: {
  collection: string;
  findings: ContractDrivenFinding[];
  unexpectedCount: number;
  totalRisks: number;
}): string {
  const { collection, findings, unexpectedCount, totalRisks } = args;
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const expectedCount = totalRisks - unexpectedCount;

  const sections = findings
    .filter((f) => f.risks.length)
    .map((f, fi) => {
      const risks = f.risks
        .map((r, ri) => {
          const tag = r.type === "unexpected" ? "【预料外】" : "【预料内】";
          const rule = r.matchedRule ? `（命中 ${r.matchedRule}）` : "";
          return [
            `${ri + 1}. ${tag} ${r.description}${rule}`,
            `   - 风险等级：${r.severity}`,
            `   - 修改/补充建议：${r.suggestion || "（无）"}`,
          ].join("\n");
        })
        .join("\n");
      const refs = f.wikiRefs.length ? f.wikiRefs.join("、") : "（无）";
      return `### 片段 ${fi + 1}（${f.location}）\n${f.clause.slice(0, 320)}${f.clause.length > 320 ? "…" : ""}\n\n${risks}\n\n- 知识库依据（wiki）：${refs}`;
    })
    .join("\n\n");

  return `# 合同驱动·预料外风险发现报告

> 生成时间：${now}　|　合同集合：${collection}
> 视角：从合同片段出发反查规则与知识库，重点捕捉标准风险清单（44 项）未覆盖的预料外问题。

## 概览
- 分析合同片段数：${findings.length}
- 识别风险点总数：${totalRisks}（预料内 ${expectedCount} / 预料外 ${unexpectedCount}）
- 预料外问题占比：${totalRisks ? Math.round((unexpectedCount / totalRisks) * 100) : 0}%

## 逐片段风险发现
${sections || "（未识别到风险）"}
`;
}
