/**
 * 合同驱动（反向）审查：拿合同片段反查规则/wiki，捕捉 44 条标准清单未覆盖的
 * 「预料外」风险。
 *
 * 与 run-review-kindergarten.ts（规则驱动正向）对称：正向保证清单覆盖度，
 * 反向负责挖掘清单之外的隐患。两者报告互补。
 *
 * 用法：bun scripts/run-contract-driven.ts
 */
import { createStore, getDefaultDbPath, enableProductionMode } from "../src/store.js";
import { join } from "node:path";
import { importRiskRules } from "../src/contract-review/db.js";
import { contractDrivenReview } from "../src/contract-review/review.js";

enableProductionMode();

const CONTRACT_COLL = "kindergarten-heating"; // 复用正向审查的专用集合
const CONTRACT_PATH = "济南高新区空港新城幼儿园-临港小镇幼儿园.docx";

async function main() {
  const store = createStore(getDefaultDbPath());
  const db = store.db;

  importRiskRules(db);
  const ruleCount = db
    .prepare(`SELECT COUNT(*) AS n FROM risk_rules WHERE enabled=1`)
    .get() as { n: number };
  console.log(`✓ 风险规则（enabled）：${ruleCount.n} 条`);

  console.log(`\n=== 合同驱动审查（反查规则/wiki，捕捉预料外问题）===\n`);
  const maxFragments = process.env.MAX_FRAGMENTS ? Number(process.env.MAX_FRAGMENTS) : undefined;
  const res = await contractDrivenReview(store, {
    collection: CONTRACT_COLL,
    path: CONTRACT_PATH,
    maxFragments,
    reportDir: join(process.cwd(), "reports-kindergarten"),
    onProgress: (done, total, f) => {
      const unexp = f.risks.filter((r) => r.type === "unexpected").length;
      const tag = f.risks.length ? `${f.risks.length} 风险（预料外 ${unexp}）` : "无风险";
      console.log(
        `  [${done}/${total}] ${f.location} => ${tag}${f.wikiRefs.length ? ` | wiki: ${f.wikiRefs.join("、")}` : ""}`,
      );
    },
  });

  console.log(`\n✓ docid=${res.docid}`);
  console.log(`✓ 报告已写入：${res.reportPath}`);
  console.log(`✓ 识别风险点：${res.totalRisks}（预料外 ${res.unexpectedCount}）`);
  store.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
