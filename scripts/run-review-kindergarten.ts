/**
 * 真实端到端合同审查：用「济南高新区空港新城幼儿园供热运维服务合同」跑完整管线
 * （真实 wiki 检索 + LLM 逐条评审 + 报告逐条引用 wiki 依据）。
 *
 * 用法：bun scripts/run-review-kindergarten.ts
 */
import { createStore, getDefaultDbPath, enableProductionMode } from "../src/store.js";
import { join } from "node:path";
import { importRiskRules } from "../src/contract-review/db.js";
import { reviewContract } from "../src/contract-review/review.js";

enableProductionMode();

const CONTRACT_COLL = "kindergarten-heating"; // 专用审查集合（仅含该合同，避免检索串味）
const CONTRACT_PATH = "济南高新区空港新城幼儿园-临港小镇幼儿园.docx";
const TAGS = ["学校医院", "长周期", "能源"];

async function main() {
  const store = createStore(getDefaultDbPath());
  const db = store.db;

  // 1) 建专用审查集合，把幼儿园合同（复用已有 content hash）挂进来
  db.prepare(
    `INSERT OR IGNORE INTO store_collections (name, path, pattern, type, include_by_default)
     VALUES (?, ?, '**/*', 'contract', 1)`,
  ).run(CONTRACT_COLL, `./${CONTRACT_COLL}`);
  const src = db
    .prepare(`SELECT hash, title FROM documents WHERE collection='yunying' AND path=? LIMIT 1`)
    .get(CONTRACT_PATH) as { hash: string; title: string } | undefined;
  if (!src) throw new Error("未在 yunying 集合中找到幼儿园合同");
  db.prepare(
    `INSERT OR IGNORE INTO documents (collection, path, title, hash, created_at, modified_at, active)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), 1)`,
  ).run(CONTRACT_COLL, CONTRACT_PATH, src.title, src.hash);
  console.log(`✓ 专用审查集合 ${CONTRACT_COLL} 就绪（合同 hash=${src.hash.slice(0, 12)}）`);

  // 2) 确保风险规则已导入
  importRiskRules(db);
  const ruleCount = db.prepare(`SELECT COUNT(*) AS n FROM risk_rules WHERE enabled=1`).get() as { n: number };
  console.log(`✓ 风险规则（enabled）：${ruleCount.n} 条`);

  // 3) 真实端到端审查
  console.log(`\n=== 开始端到端审查（44 条规则 × 真实 wiki 检索 + LLM）===\n`);
  const res = await reviewContract(store, {
    collection: CONTRACT_COLL,
    path: CONTRACT_PATH,
    tags: TAGS,
    reportDir: join(process.cwd(), "reports-kindergarten"),
    onProgress: (done, total, f) => {
      const refs = f.wikiRefs?.length ? f.wikiRefs.join("、") : "（无）";
      console.log(`  [${done}/${total}] ${f.ruleId} ${f.name} => ${f.status}/${f.severity} | wiki依据: ${refs}`);
    },
  });

  // 4) 汇总
  const withRefs = res.findings.filter((f) => f.wikiRefs?.length).length;
  console.log(`\n✓ docid=${res.docid}`);
  console.log(`✓ analysisId=${res.analysisId}`);
  console.log(`✓ 报告已写入：${res.reportPath}`);
  console.log(`✓ 命中 wiki 依据的发现条数：${withRefs}/${res.findings.length}`);
  console.log(`✓ 触发风险：${res.findings.filter((f) => f.status === "triggered").length} 条`);

  store.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
