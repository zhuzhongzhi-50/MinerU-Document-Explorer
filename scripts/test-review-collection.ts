/**
 * Runtime validation of the collection-wide contract-review path (no LLM needed):
 * inserts two contract docs into a temp collection, runs reviewContract without a
 * `path` (=> collection scope), and asserts the pipeline produces a report.
 */
import { createStore } from "../src/store.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importRiskRules, listRiskRules } from "../src/contract-review/db.js";
import { reviewContract } from "../src/contract-review/review.js";

const dir = mkdtempSync(join(tmpdir(), "cr-"));
const dbPath = join(dir, "test.sqlite");
const store = createStore(dbPath);
importRiskRules(store.db);

const coll = "testproj";
const now = new Date().toISOString();
const docs = [
  "甲方：测试幼儿园。乙方：测试公司。供热运维服务合同，期限15年。供暖单价26.7元/㎡固定，服务费不随成本调整。",
  "第12.2条 教职工代表大会综合评价不达标甲方可终止合同。第4.2条 每年供暖季前15日内缴费，无逾期违约金。",
];
docs.forEach((d, i) => {
  const hash = `h${i}-${coll}`;
  store.db.prepare(`INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)`).run(hash, d, now);
  store.db
    .prepare(
      `INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(coll, `doc${i}.txt`, `doc${i}`, hash, now, now);
});

const ruleCount = listRiskRules(store.db, { enabledOnly: true }).length;
console.log(`seeded ${ruleCount} rules, 2 docs in collection "${coll}"`);

const res = await reviewContract(store, {
  collection: coll,
  tags: ["学校医院", "长周期", "能源"],
});

const ok =
  res.reportMarkdown.includes("运营类合同风险分析报告") &&
  res.findings.length === ruleCount &&
  res.docid === `coll-${coll}` &&
  res.specialChecks.length === 3 &&
  !res.specialChecks.some((c) => c.id === "consortium");

console.log("docid:", res.docid);
console.log("specialChecks:", res.specialChecks.map((c) => c.id).join(","));
console.log("findings:", res.findings.length, "analysisId:", res.analysisId);
console.log("report bytes:", res.reportMarkdown.length);
console.log(ok ? "✅ collection-wide review path OK" : "❌ FAILED");
process.exit(ok ? 0 : 1);
