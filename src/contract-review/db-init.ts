/**
 * Contract risk-review — scenario-owned schema bootstrap.
 *
 * 设计意图：合同审查是一个「场景模块」，其专属表结构
 * （risk_rules / contracts_meta / analysis_records / contract_types /
 * rule_contract_scope）与种子数据不再写在底座中央迁移 db-schema.ts 中，而是随场景
 * 模块自持。这样底座的 schema 不再感知任何具体场景，新增 / 删除场景不必改动底座核心。
 *
 * 本模块幂等（CREATE TABLE IF NOT EXISTS + INSERT OR IGNORE + ALTER 容错），
 * 可在服务启动或 reviewContract 入口安全重复调用：已部署实例中这些表已由历史迁移
 * v5/v7/v8 创建，此处不会再重建，仅兜底新建库或脚本直调场景的场景。
 */
import type { Database } from "../db.js";
import { importRiskRules, listRiskRules } from "./db.js";

export interface EnsureResult {
  rulesSeeded: number;
}

export function ensureContractReviewSchema(db: Database): EnsureResult {
  // ---- 表结构（原 db-schema v5） ----
  db.exec(`
    CREATE TABLE IF NOT EXISTS risk_rules (
      rule_id          TEXT PRIMARY KEY,
      seq              INTEGER NOT NULL,
      category         TEXT NOT NULL,
      name             TEXT NOT NULL,
      description      TEXT NOT NULL,
      basis            TEXT,
      suggestion       TEXT NOT NULL,
      match_type       TEXT NOT NULL DEFAULT 'llm_checklist',
      severity_default TEXT,
      ruleset_version  TEXT NOT NULL,
      enabled          INTEGER NOT NULL DEFAULT 1,
      source           TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_risk_rules_category ON risk_rules(category)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_risk_rules_enabled ON risk_rules(enabled)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS contracts_meta (
      docid        TEXT PRIMARY KEY,
      title        TEXT,
      ctype        TEXT,
      collection   TEXT,
      version      INTEGER NOT NULL DEFAULT 1,
      content_hash TEXT,
      tags         TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS analysis_records (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      docid           TEXT NOT NULL,
      ruleset_version TEXT NOT NULL,
      report_path     TEXT,
      report_docid    TEXT,
      summary_json    TEXT,
      status          TEXT NOT NULL DEFAULT 'done',
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_analysis_records_docid ON analysis_records(docid)`);

  // ---- 表结构（原 db-schema v7：合同类型维度） ----
  try {
    db.exec(`ALTER TABLE contracts_meta ADD COLUMN contract_type TEXT`);
  } catch {
    /* 列已存在 */
  }
  try {
    db.exec(`ALTER TABLE contracts_meta ADD COLUMN contract_subtype TEXT`);
  } catch {
    /* 列已存在 */
  }

  // ---- 表结构（原 db-schema v8：合同类型主数据 + 多对多关联） ----
  db.exec(`
    CREATE TABLE IF NOT EXISTS contract_types (
      code       TEXT PRIMARY KEY,
      parent     TEXT,
      label      TEXT NOT NULL,
      grp        TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      enabled    INTEGER NOT NULL DEFAULT 1
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS rule_contract_scope (
      rule_id           TEXT NOT NULL,
      contract_code     TEXT NOT NULL,
      enabled           INTEGER NOT NULL DEFAULT 1,
      severity_override TEXT,
      PRIMARY KEY (rule_id, contract_code)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_rule_scope_contract ON rule_contract_scope(contract_code)`);

  // ---- 种子：合同类型主数据（idempotent） ----
  const groups: [string, string[]][] = [
    ["金融财税类", ["融资合同", "担保合同", "保险合同", "保理合同", "常年税务顾问合同", "财税相关服务合同", "评估合同", "债权转让协议", "还款协议"]],
    ["债务处置类", ["以房/物抵债协议"]],
    ["战略合作与联合体类", ["战略合作协议", "标前联合体协议", "标后施工联合体协议", "标后EPC联合体协议"]],
    ["法律事务类", ["常年法律顾问聘用合同", "律师代理合同", "专项法律服务合同", "涉诉和解协议"]],
    ["办公与后勤类", ["房屋租赁合同", "车辆租赁合同", "物业服务", "印控设备采购", "办公家具采购", "食堂采购", "总部办公驻地修缮美化"]],
    ["投资与股权类", ["投资类合同（含内部经济责任书）", "股权收购合同", "股权转让合同"]],
    ["技术与知识产权类", ["技术服务合同", "专利相关协议"]],
    ["人力与校企合作类", ["校企合作协议", "劳务派遣协议", "培训合同", "招聘合同", "劳动合同"]],
    ["信息化与科研类", ["信息化建设", "信息化咨询", "软件（插件）服务合同", "课题研究、科技研发等事项需签订的各类合同"]],
    ["宣传与品牌类", ["宣传视频制作合同（视频动画、画册、宣传册、折页等）"]],
  ];
  const ins = db.prepare(
    `INSERT OR IGNORE INTO contract_types (code, parent, label, grp, sort_order) VALUES (?, ?, ?, ?, ?)`
  );
  let order = 0;
  ins.run("general", null, "总包合同", "", order++);
  ins.run("subcontract", null, "分包分供合同", "", order++);
  ins.run("other", null, "其他类合同", "", order++);
  for (const [grp, items] of groups) {
    for (const label of items) ins.run(`other:${label}`, "other", label, grp, order++);
  }

  // ---- 种子：运营类风险规则库（仅当为空时，避免覆盖用户启用/禁用改动） ----
  let rulesSeeded = 0;
  try {
    if (listRiskRules(db, { enabledOnly: false }).length === 0) {
      rulesSeeded = importRiskRules(db);
    }
  } catch {
    /* 规则种子失败不阻断；reviewContract 会在首次审查时重试 */
  }

  return { rulesSeeded };
}
