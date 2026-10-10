/**
 * 场景约束 manifest 注册 / 版本约定（底座层）。
 *
 * 设计依据：xuexi/场景差异分析与底座统一方案.md §3.4。
 * 两类场景约束（合同 checklist、语音 output-structure）本质都是"给 LLM 的约束上下文"，
 * 但**约束逻辑由场景层实现，底座只做登记 + 版本 + 分发**。本模块即"约定"的落地：
 *   - 定义统一的 ScenarioConstraintManifest 头（kind 判别 + semver 版本）；
 *   - 提供注册 / 列表 / 解析 active 版本的纯元数据操作；
 *   - payload（规则行 / 模板 JSON）对底座**不透明**（仅以 payloadRef 指针引用），
 *     因此底座不解析、不耦合任何场景语义，符合 §3.6（B 类数据不进底座 SQLite 的"语义层"）。
 *
 * 适用：A 类进程内模块经进程内 API 使用；B 类独立服务经 HTTP /api/scenario-manifests 使用。
 */
import type { Database } from "./db.js";

export type ManifestKind = "checklist" | "output-structure" | (string & {});
export type ManifestStatus = "active" | "deprecated";

export interface ScenarioConstraintManifest {
  manifestId: string;
  scenario: string;
  kind: ManifestKind;
  version: string;
  name: string;
  description: string;
  status: ManifestStatus;
  /** 不透明指针：底座不解析，场景层据此定位真实约束内容。例：risk_rules@1.0.0 / voice-service:/templates/site_log@1.2.0 */
  payloadRef: string;
  createdAt: string;
}

export interface RegisterInput {
  manifestId: string;
  scenario: string;
  kind: string;
  version: string;
  name?: string;
  description?: string;
  status?: ManifestStatus;
  payloadRef?: string;
}

const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** 幂等确保表存在（与 db-schema 迁移 v9 互补，避免脚本未跑迁移时缺失）。 */
export function ensureScenarioManifestSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scenario_manifests (
      manifest_id  TEXT PRIMARY KEY,
      scenario     TEXT NOT NULL,
      kind         TEXT NOT NULL,
      version      TEXT NOT NULL,
      name         TEXT NOT NULL DEFAULT '',
      description  TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'active',
      payload_ref  TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_scenario_manifests_scenario_kind ON scenario_manifests(scenario, kind, status)`,
  );
}

function rowToManifest(row: Record<string, unknown>): ScenarioConstraintManifest {
  return {
    manifestId: String(row.manifest_id),
    scenario: String(row.scenario),
    kind: row.kind as ManifestKind,
    version: String(row.version),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    status: (row.status === "deprecated" ? "deprecated" : "active") as ManifestStatus,
    payloadRef: String(row.payload_ref ?? ""),
    createdAt: String(row.created_at ?? ""),
  };
}

/**
 * 注册一个场景约束 manifest（版本不可变）。
 * - 版本号必须为 semver (x.y.z)，否则抛错；
 * - manifest_id 已存在则视为不可变，跳过插入（但 status=active 时仍会把同 (scenario,kind) 其它版本降级为 deprecated，保证唯一 active）；
 * - status=active 时，同 (scenario, kind) 下的其它 active 行降级为 deprecated。
 */
export function registerScenarioManifest(db: Database, input: RegisterInput): ScenarioConstraintManifest {
  if (!VERSION_RE.test(input.version)) {
    throw new Error(`非法版本号: ${input.version}，需为 semver (x.y.z)`);
  }
  if (!input.scenario || !input.kind) {
    throw new Error("scenario 与 kind 均为必填");
  }
  ensureScenarioManifestSchema(db);
  const status = input.status ?? "active";

  const tx = db.transaction((m: RegisterInput, st: ManifestStatus) => {
    if (st === "active") {
      db.prepare(
        `UPDATE scenario_manifests SET status = 'deprecated' WHERE scenario = ? AND kind = ? AND status = 'active' AND manifest_id <> ?`,
      ).run(m.scenario, m.kind, m.manifestId);
    }
    db.prepare(
      `INSERT OR IGNORE INTO scenario_manifests
         (manifest_id, scenario, kind, version, name, description, status, payload_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      m.manifestId,
      m.scenario,
      m.kind,
      m.version,
      m.name ?? "",
      m.description ?? "",
      st,
      m.payloadRef ?? "",
    );
  });
  tx(input, status);

  const row = db.prepare(`SELECT * FROM scenario_manifests WHERE manifest_id = ?`).get(input.manifestId) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new Error("注册后未能读取 manifest，请检查数据库");
  return rowToManifest(row);
}

export function getScenarioManifest(db: Database, manifestId: string): ScenarioConstraintManifest | null {
  ensureScenarioManifestSchema(db);
  const row = db.prepare(`SELECT * FROM scenario_manifests WHERE manifest_id = ?`).get(manifestId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToManifest(row) : null;
}

export function listScenarioManifests(
  db: Database,
  opts?: { scenario?: string; kind?: string },
): ScenarioConstraintManifest[] {
  ensureScenarioManifestSchema(db);
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (opts?.scenario) {
    clauses.push("scenario = ?");
    args.push(opts.scenario);
  }
  if (opts?.kind) {
    clauses.push("kind = ?");
    args.push(opts.kind);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM scenario_manifests ${where} ORDER BY scenario, kind, created_at DESC`)
    .all(...args) as Record<string, unknown>[];
  return rows.map(rowToManifest);
}

/** 解析某 (scenario, kind) 的当前 active 版本；无则 null。 */
export function resolveActiveScenarioManifest(
  db: Database,
  scenario: string,
  kind: string,
): ScenarioConstraintManifest | null {
  ensureScenarioManifestSchema(db);
  const row = db
    .prepare(
      `SELECT * FROM scenario_manifests WHERE scenario = ? AND kind = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
    )
    .get(scenario, kind) as Record<string, unknown> | undefined;
  return row ? rowToManifest(row) : null;
}
