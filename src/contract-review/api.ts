/**
 * Contract risk-review — HTTP 路由（场景自有）。
 *
 * 把原本内联在 src/api/server.ts 中的合同审查相关路由（/api/risk-rules、
 * /api/rule-scope/*、/api/contracts、/api/analysis*、/api/review）收敛到本模块，
 * 由 server.ts 通过 handleContractReviewRoutes 统一委派。底座不再内联任何场景路由，
 * 新增 / 删除场景不必改动 server.ts 的核心分发逻辑。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "../store.js";
import {
  importRiskRules,
  listRiskRules,
  listContracts,
  listAnalysisRecords,
  getAnalysisRecord,
  getCollectionTags,
} from "./db.js";
import { reviewContract, type ReviewOptions } from "./review.js";
import { getChatOwner, addChatMessage } from "../chat.js";

// 本模块只通过 store.internal（底层 Store）访问数据库与审查能力，
// 因此把 store 参数收窄为该结构，避免与 server.ts 实际传入的 QMDStore 类型冲突。
type StoreLike = { internal: Store };

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  store: StoreLike;
  uid: string | undefined;
  json: (res: ServerResponse, code: number, obj: unknown) => void;
  collectBody: (req: IncomingMessage) => Promise<string>;
  safeParse: (raw: string) => unknown | null;
}

export async function handleContractReviewRoutes(ctx: RouteContext): Promise<boolean> {
  const { req, res, store, uid, json, collectBody, safeParse } = ctx;
  const db = store.internal.db;
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;
  const method = req.method || "GET";

  // ---- 风险规则库 ----
  if (pathname === "/api/risk-rules" && method === "GET") {
    const enabledOnly = url.searchParams.get("enabledOnly") === "true";
    try {
      json(res, 200, { rules: listRiskRules(db, { enabledOnly }) });
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
    return true;
  }

  if (pathname === "/api/risk-rules/import" && method === "POST") {
    try {
      const count = importRiskRules(db);
      json(res, 200, { status: "ok", count, rulesetVersion: "1.0.0" });
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
    return true;
  }

  if (pathname === "/api/risk-rules" && method === "POST") {
    const body = (safeParse(await collectBody(req)) as Record<string, unknown> | null) ?? {};
    const name = String(body.name ?? "").trim();
    const category = String(body.category ?? "自定义").trim() || "自定义";
    if (!name) {
      json(res, 400, { error: "缺少规则名称 name" });
      return true;
    }
    try {
      const mx = db.prepare(`SELECT MAX(seq) AS m FROM risk_rules`).get() as { m: number | null };
      const seq = (mx?.m ?? 0) + 1;
      const ruleId = String(body.ruleId ?? "").trim() || `CUSTOM-${String(seq).padStart(3, "0")}`;
      db.prepare(
        `INSERT INTO risk_rules
           (rule_id, seq, category, name, description, basis, suggestion, match_type, severity_default, ruleset_version, enabled, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'llm_checklist', ?, '1.0.0', 1, 'manual')`,
      ).run(
        ruleId,
        seq,
        category,
        name,
        String(body.description ?? ""),
        body.basis ? String(body.basis) : null,
        String(body.suggestion ?? ""),
        body.severity_default ? String(body.severity_default) : null,
      );
      json(res, 200, { status: "ok", ruleId });
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
    return true;
  }

  if (pathname.startsWith("/api/risk-rules/") && method === "PUT") {
    const ruleId = decodeURIComponent(pathname.slice("/api/risk-rules/".length));
    const body = (safeParse(await collectBody(req)) as Record<string, unknown> | null) ?? {};
    const fields: string[] = [];
    const vals: unknown[] = [];
    for (const k of ["category", "name", "description", "basis", "suggestion", "severity_default"]) {
      if (body[k] !== undefined) {
        fields.push(`${k} = ?`);
        vals.push(body[k] === null ? null : String(body[k]));
      }
    }
    if (body.enabled !== undefined) {
      fields.push(`enabled = ?`);
      vals.push(Number(body.enabled) ? 1 : 0);
    }
    if (!fields.length) {
      json(res, 400, { error: "没有可更新字段" });
      return true;
    }
    try {
      vals.push(ruleId);
      db.prepare(`UPDATE risk_rules SET ${fields.join(", ")} WHERE rule_id = ?`).run(...(vals as never[]));
      json(res, 200, { status: "ok", ruleId });
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
    return true;
  }

  if (pathname.startsWith("/api/risk-rules/") && method === "DELETE") {
    const ruleId = decodeURIComponent(pathname.slice("/api/risk-rules/".length));
    try {
      db.prepare(`DELETE FROM risk_rules WHERE rule_id = ?`).run(ruleId);
      db.prepare(`DELETE FROM rule_contract_scope WHERE rule_id = ?`).run(ruleId);
      json(res, 200, { status: "ok", ruleId });
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
    return true;
  }

  // ---- 规则整理：合同类型 ↔ 风险规则 ----
  if (pathname === "/api/rule-scope/contract-types" && method === "GET") {
    try {
      const rows = db
        .prepare(`SELECT code, parent, label, grp, sort_order, enabled FROM contract_types ORDER BY sort_order`)
        .all() as { code: string; parent: string | null; label: string; grp: string; sort_order: number; enabled: number }[];
      const cnt = db
        .prepare(`SELECT contract_code AS code, COUNT(*) AS n FROM rule_contract_scope WHERE enabled = 1 GROUP BY contract_code`)
        .all() as { code: string; n: number }[];
      const map = new Map(cnt.map((c) => [c.code, c.n]));
      json(res, 200, { types: rows.map((r) => ({ ...r, ruleCount: map.get(r.code) ?? null })) });
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
    return true;
  }

  if (pathname === "/api/rule-scope/contract-types" && method === "POST") {
    const body = (safeParse(await collectBody(req)) as Record<string, unknown> | null) ?? {};
    const code = String(body.code ?? "").trim();
    const label = String(body.label ?? "").trim();
    const parent = body.parent ? String(body.parent).trim() : null;
    const grp = body.grp ? String(body.grp).trim() : "";
    if (!code || !label) {
      json(res, 400, { error: "缺少 code 或 label" });
      return true;
    }
    try {
      const mx = db.prepare(`SELECT MAX(sort_order) AS m FROM contract_types`).get() as { m: number | null };
      db.prepare(
        `INSERT INTO contract_types (code, parent, label, grp, sort_order) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET label = excluded.label, parent = excluded.parent, grp = excluded.grp`,
      ).run(code, parent, label, grp, (mx?.m ?? 0) + 1);
      json(res, 200, { status: "ok", code });
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
    return true;
  }

  if (pathname.startsWith("/api/rule-scope/contract-types/") && method === "DELETE") {
    const code = decodeURIComponent(pathname.slice("/api/rule-scope/contract-types/".length));
    try {
      db.prepare(`DELETE FROM contract_types WHERE code = ?`).run(code);
      db.prepare(`DELETE FROM rule_contract_scope WHERE contract_code = ?`).run(code);
      json(res, 200, { status: "ok" });
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
    return true;
  }

  if (pathname === "/api/rule-scope/rules" && method === "GET") {
    const contract = url.searchParams.get("contract") ?? "";
    try {
      const rules = listRiskRules(db, { enabledOnly: true });
      const scope = db
        .prepare(`SELECT rule_id, enabled, severity_override FROM rule_contract_scope WHERE contract_code = ?`)
        .all(contract) as { rule_id: string; enabled: number; severity_override: string | null }[];
      const sm = new Map(scope.map((s) => [s.rule_id, s]));
      json(res, 200, {
        contract,
        configured: scope.length > 0,
        rules: rules.map((r) => ({
          rule_id: r.rule_id,
          seq: r.seq,
          category: r.category,
          name: r.name,
          description: r.description,
          basis: r.basis,
          suggestion: r.suggestion,
          severity_default: r.severity_default,
          selected: sm.has(r.rule_id) ? sm.get(r.rule_id)!.enabled === 1 : false,
          severity_override: sm.get(r.rule_id)?.severity_override ?? null,
        })),
      });
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
    return true;
  }

  if (pathname === "/api/rule-scope/assign" && method === "POST") {
    const body = (safeParse(await collectBody(req)) as Record<string, unknown> | null) ?? {};
    const contract = String(body.contract ?? "").trim();
    const ruleIds = Array.isArray(body.ruleIds) ? body.ruleIds.map(String) : null;
    if (!contract || !ruleIds) {
      json(res, 400, { error: "缺少 contract 或 ruleIds" });
      return true;
    }
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`DELETE FROM rule_contract_scope WHERE contract_code = ?`).run(contract);
        const ins = db.prepare(
          `INSERT OR REPLACE INTO rule_contract_scope (rule_id, contract_code, enabled) VALUES (?, ?, 1)`,
        );
        for (const rid of ruleIds) ins.run(rid, contract);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      json(res, 200, { status: "ok", contract, count: ruleIds.length });
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
    return true;
  }

  if (pathname === "/api/rule-scope/reset" && method === "POST") {
    const body = (safeParse(await collectBody(req)) as Record<string, unknown> | null) ?? {};
    const contract = String(body.contract ?? "").trim();
    if (!contract) {
      json(res, 400, { error: "缺少 contract" });
      return true;
    }
    try {
      db.prepare(`DELETE FROM rule_contract_scope WHERE contract_code = ?`).run(contract);
      json(res, 200, { status: "ok", contract });
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
    return true;
  }

  if (pathname.startsWith("/api/rule-scope/rules/") && method === "GET") {
    const ruleId = decodeURIComponent(pathname.slice("/api/rule-scope/rules/".length));
    try {
      const rows = db
        .prepare(`SELECT contract_code FROM rule_contract_scope WHERE rule_id = ? AND enabled = 1`)
        .all(ruleId) as { contract_code: string }[];
      json(res, 200, { ruleId, contracts: rows.map((r) => r.contract_code) });
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
    return true;
  }

  if (pathname === "/api/rule-scope/rule-map" && method === "GET") {
    try {
      const rows = db
        .prepare(`SELECT rule_id, contract_code FROM rule_contract_scope WHERE enabled = 1`)
        .all() as { rule_id: string; contract_code: string }[];
      const map: Record<string, string[]> = {};
      for (const r of rows) (map[r.rule_id] || (map[r.rule_id] = [])).push(r.contract_code);
      json(res, 200, { map });
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
    return true;
  }

  // ---- 合同与分析记录 ----
  if (pathname === "/api/contracts" && method === "GET") {
    try {
      json(res, 200, { contracts: listContracts(db) });
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
    return true;
  }

  if (pathname === "/api/analysis" && method === "GET") {
    const docid = url.searchParams.get("docid") ?? undefined;
    try {
      json(res, 200, { records: listAnalysisRecords(db, docid) });
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
    return true;
  }

  if (pathname.startsWith("/api/analysis/") && method === "GET") {
    const id = parseInt(pathname.slice("/api/analysis/".length), 10);
    try {
      const rec = getAnalysisRecord(db, id);
      if (!rec) {
        json(res, 404, { error: "分析记录不存在" });
        return true;
      }
      json(res, 200, { record: rec });
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
    return true;
  }

  // ---- 运行一次审查 ----
  if (pathname === "/api/review" && method === "POST") {
    const body = (safeParse(await collectBody(req)) as Record<string, unknown> | null) ?? {};
    const collection = String(body.collection ?? "").trim();
    if (!collection) {
      json(res, 400, { error: "缺少合同集合名称 collection" });
      return true;
    }
    let tags = Array.isArray(body.tags) ? (body.tags as unknown[]).map(String) : [];
    if (tags.length === 0) {
      const stored = getCollectionTags(db, collection);
      if (stored.length) tags = stored;
    }
    const sid = body?.sessionId ? String(body.sessionId) : undefined;
    const opts: ReviewOptions = {
      collection,
      path: body.path ? String(body.path) : undefined,
      tags,
      rulesetVersion: body.rulesetVersion ? String(body.rulesetVersion) : undefined,
      onProgress: undefined,
    };
    try {
      const result = await reviewContract(store.internal, opts);
      try {
        if (sid && uid && getChatOwner(db, sid) === uid) {
          const userPrompt =
            `合同风险审查 · 集合：${collection}` + (tags.length ? ` · 特殊情形：${tags.join("、")}` : "");
          addChatMessage(db, sid, "user", userPrompt);
          addChatMessage(db, sid, "assistant", result.reportMarkdown ?? "", {
            sources: [{ type: "review", analysisId: result.analysisId, reportPath: result.reportPath }],
          });
        }
      } catch (pe) {
        console.warn("[chat] persist failed for /api/review:", pe);
      }
      json(res, 200, {
        docid: result.docid,
        analysisId: result.analysisId,
        reportPath: result.reportPath,
        projectInfo: result.projectInfo,
        overall: result.overall,
        specialChecks: result.specialChecks.map((c) => ({ id: c.id, label: c.label })),
        findings: result.findings,
        tags,
        reportMarkdown: result.reportMarkdown,
      });
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
    return true;
  }

  // 未匹配任何合同审查路由：交还 server.ts 继续处理（例如落到 404）。
  return false;
}
