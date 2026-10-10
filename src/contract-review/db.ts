/**
 * Contract risk-review — persistence layer.
 *
 * Tables are created & seeded by src/contract-review/db-init.ts
 * (ensureContractReviewSchema); this module provides the thin CRUD the engine,
 * import script, server and CLI need.
 */
import type { Database } from "../db.js";
import { registerScenarioManifest } from "../scenario-manifest.js";
import { RISK_RULES_SEED, type RiskRuleSeed } from "./risk-rules-seed.js";

export interface RiskRuleRow {
  rule_id: string;
  seq: number;
  category: string;
  name: string;
  description: string;
  basis: string | null;
  suggestion: string;
  match_type: string;
  severity_default: string | null;
  ruleset_version: string;
  enabled: number;
  source: string | null;
}

export interface ContractMetaRow {
  docid: string;
  title: string | null;
  ctype: string | null;
  collection: string | null;
  version: number;
  content_hash: string | null;
  tags: string | null; // JSON array
  contract_type: string | null; // general / subcontract / other
  contract_subtype: string | null; // 其他类合同的具体类别
  created_at: string;
}

export interface AnalysisRecordRow {
  id: number;
  docid: string;
  ruleset_version: string;
  report_path: string | null;
  report_docid: string | null;
  summary_json: string | null;
  status: string;
  created_at: string;
}

const RULESET_VERSION = "1.0.0";
const RULE_SOURCE = "xlsx:中建八局二公司运营类风险要素清单";

/** Idempotent seed/import of the operational risk rule library. */
export function importRiskRules(db: Database, rules?: RiskRuleSeed[]): number {
  const data = rules ?? RISK_RULES_SEED;
  const del = db.prepare(`DELETE FROM risk_rules WHERE source = ? AND ruleset_version = ?`);
  del.run(RULE_SOURCE, RULESET_VERSION);
  const ins = db.prepare(`
    INSERT INTO risk_rules
      (rule_id, seq, category, name, description, basis, suggestion, match_type, severity_default, ruleset_version, enabled, source)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, 'llm_checklist', NULL, ?, 1, ?)
  `);
  const tx = db.transaction((rows: RiskRuleSeed[]) => {
    for (const r of rows) {
      ins.run(
        r.ruleId,
        r.seq,
        r.category,
        r.name,
        r.description,
        r.basis,
        r.suggestion,
        RULESET_VERSION,
        RULE_SOURCE,
      );
    }
  });
  tx(data);

  // 把当前规则集登记为 checklist manifest（设计 §3.4）：底座只存头信息，
  // payload 仍以 risk_rules 表承载，payloadRef 指向 ruleset_version 快照。
  // 幂等：重复导入仅维持 active 不变，不污染历史版本。
  try {
    registerScenarioManifest(db, {
      manifestId: `contract-checklist@${RULESET_VERSION}`,
      scenario: "contract",
      kind: "checklist",
      version: RULESET_VERSION,
      name: "运营类合同风险要素清单",
      description: "中建八局二公司运营类风险要素清单（6 大类 / 44 项），逐条核验产出 findings。",
      status: "active",
      payloadRef: `risk_rules@${RULESET_VERSION}`,
    });
  } catch (e) {
    console.warn("[contract-review] 登记 checklist manifest 失败（不影响规则导入）:", e);
  }

  return data.length;
}

export function listRiskRules(db: Database, opts?: { enabledOnly?: boolean }): RiskRuleRow[] {
  const sql = opts?.enabledOnly
    ? `SELECT * FROM risk_rules WHERE enabled = 1 ORDER BY seq`
    : `SELECT * FROM risk_rules ORDER BY seq`;
  return db.prepare(sql).all() as RiskRuleRow[];
}

/**
 * 组装合同类型编码：一级为 general / subcontract / other；
 * 「其他类合同」带具体类别时为 `other:<类别>`（与 contract_types 种子保持一致）。
 */
export function contractTypeCode(
  contractType?: string | null,
  contractSubtype?: string | null,
): string {
  const t = (contractType || "").trim();
  if (!t) return "";
  if (t !== "other") return t;
  const sub = (contractSubtype || "").trim();
  return sub ? `other:${sub}` : "other";
}

/**
 * 按合同类型取本次审查应使用的规则集（规则整理页面的产物在此生效）。
 *
 * 兼容策略：该类型在 rule_contract_scope 中**没有任何记录**（未配置）时，
 * 返回全部启用规则——与接入「规则整理」之前的行为完全一致，因此可灰度配置、零迁移。
 * 一旦为某类型配置过映射，则只返回配置中启用的规则。
 */
export function listRiskRulesForContract(
  db: Database,
  contractType?: string | null,
  contractSubtype?: string | null,
): { rules: RiskRuleRow[]; configured: boolean; code: string } {
  const all = listRiskRules(db, { enabledOnly: true });
  const code = contractTypeCode(contractType, contractSubtype);
  if (!code) return { rules: all, configured: false, code: "" };

  const rows = db
    .prepare(`SELECT rule_id FROM rule_contract_scope WHERE contract_code = ? AND enabled = 1`)
    .all(code) as { rule_id: string }[];
  if (!rows.length) return { rules: all, configured: false, code }; // 未配置 → 沿用默认全集

  const set = new Set(rows.map((r) => r.rule_id));
  const rules = all.filter((r) => set.has(r.rule_id)).sort((a, b) => a.seq - b.seq);
  return { rules, configured: true, code };
}

export function getRiskRule(db: Database, ruleId: string): RiskRuleRow | null {
  return (db.prepare(`SELECT * FROM risk_rules WHERE rule_id = ?`).get(ruleId) as RiskRuleRow) ?? null;
}

export function setRuleEnabled(db: Database, ruleId: string, enabled: boolean): void {
  db.prepare(`UPDATE risk_rules SET enabled = ? WHERE rule_id = ?`).run(enabled ? 1 : 0, ruleId);
}

export function setRuleSeverityDefault(db: Database, ruleId: string, severity: string | null): void {
  db.prepare(`UPDATE risk_rules SET severity_default = ? WHERE rule_id = ?`).run(severity, ruleId);
}

/** Insert or bump version for a contract's metadata record. */
export function upsertContractMeta(
  db: Database,
  meta: {
    docid: string;
    title?: string | null;
    ctype?: string | null;
    collection?: string | null;
    contentHash?: string | null;
    tags?: string[];
    contractType?: string | null;
    contractSubtype?: string | null;
  },
): void {
  const existing = db.prepare(`SELECT version FROM contracts_meta WHERE docid = ?`).get(meta.docid) as
    | { version: number }
    | undefined;
  const version = (existing?.version ?? 0) + 1;
  db.prepare(`
    INSERT INTO contracts_meta (docid, title, ctype, collection, version, content_hash, tags, contract_type, contract_subtype)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(docid) DO UPDATE SET
      title = excluded.title,
      ctype = excluded.ctype,
      collection = excluded.collection,
      version = excluded.version,
      content_hash = excluded.content_hash,
      tags = excluded.tags,
      contract_type = excluded.contract_type,
      contract_subtype = excluded.contract_subtype
  `).run(
    meta.docid,
    meta.title ?? null,
    meta.ctype ?? null,
    meta.collection ?? null,
    version,
    meta.contentHash ?? null,
    meta.tags ? JSON.stringify(meta.tags) : null,
    meta.contractType ?? null,
    meta.contractSubtype ?? null,
  );
}

export function getContractMeta(db: Database, docid: string): ContractMetaRow | null {
  return (db.prepare(`SELECT * FROM contracts_meta WHERE docid = ?`).get(docid) as ContractMetaRow) ?? null;
}

export function listContracts(db: Database): ContractMetaRow[] {
  // 排除「集合维度」的标签占位行（docid 形如 collection:<集合名>），避免污染合同列表
  return db.prepare(`SELECT * FROM contracts_meta WHERE docid NOT LIKE 'collection:%' ORDER BY created_at DESC`).all() as ContractMetaRow[];
}

/** 读取某集合在上传时记录的特殊情形标签（按集合维度存于 contracts_meta 的占位行）。 */
export function getCollectionTags(db: Database, collection: string): string[] {
  const row = db
    .prepare(`SELECT tags FROM contracts_meta WHERE docid = ?`)
    .get(`collection:${collection}`) as { tags: string | null } | undefined;
  if (!row || !row.tags) return [];
  try {
    const a = JSON.parse(row.tags);
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

/** 读取某集合在上传时记录的合同类型（按集合维度存于 contracts_meta 的占位行）。 */
export function getCollectionContractType(
  db: Database,
  collection: string,
): { contractType: string | null; contractSubtype: string | null } {
  const row = db
    .prepare(`SELECT contract_type, contract_subtype FROM contracts_meta WHERE docid = ?`)
    .get(`collection:${collection}`) as
    | { contract_type: string | null; contract_subtype: string | null }
    | undefined;
  return { contractType: row?.contract_type ?? null, contractSubtype: row?.contract_subtype ?? null };
}

export function insertAnalysisRecord(
  db: Database,
  rec: { docid: string; rulesetVersion: string; reportPath?: string | null; reportDocid?: string | null; summaryJson?: string | null; status?: string },
): number {
  const res = db
    .prepare(`
      INSERT INTO analysis_records (docid, ruleset_version, report_path, report_docid, summary_json, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(rec.docid, rec.rulesetVersion, rec.reportPath ?? null, rec.reportDocid ?? null, rec.summaryJson ?? null, rec.status ?? "done");
  return Number(res.lastInsertRowid);
}

export function getAnalysisRecord(db: Database, id: number): AnalysisRecordRow | null {
  return (db.prepare(`SELECT * FROM analysis_records WHERE id = ?`).get(id) as AnalysisRecordRow) ?? null;
}

export function listAnalysisRecords(db: Database, docid?: string): AnalysisRecordRow[] {
  const sql = docid
    ? `SELECT * FROM analysis_records WHERE docid = ? ORDER BY created_at DESC`
    : `SELECT * FROM analysis_records ORDER BY created_at DESC`;
  return db.prepare(sql).all(...(docid ? [docid] : [])) as AnalysisRecordRow[];
}
