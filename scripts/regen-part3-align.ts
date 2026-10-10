/**
 * 把「重新提问」等仍为旧版 Format B 的第三部分消息，用当前最新 composeReport（Format A）
 * 重新审查并覆盖，使其与「幼儿园供热合同风险」的第三部分样式（### 子标题 + 表格 + 评价模型说明）完全一致。
 *
 * 前端渲染层早已支持 Format A（幼儿园 [2] 即正确显示），故覆盖后硬性刷新即可看到美化效果。
 *
 * 用法：bun scripts/regen-part3-align.ts
 */
import { createStore, enableProductionMode } from "../src/store.js";
import { importRiskRules } from "../src/contract-review/db.js";
import { reviewContract } from "../src/contract-review/review.js";

enableProductionMode();

const DB_PATH = "C:\\Users\\wuzhu\\.cache\\qmd\\index.sqlite";
const CONTRACT_COLL = "kindergarten-heating";
const CONTRACT_PATH = "济南高新区空港新城幼儿园-临港小镇幼儿园.docx";
const TAGS = ["学校医院", "长周期", "能源"];

// 需要覆盖为 Format A 的（会话, 消息seq）列表。均为当前库中仍为旧版 Format B 的消息。
const TARGETS = [
  { sid: "161f2829-e7a7-44ff-90f2-0ab046a34e23", seq: 2 }, // 9-21 ceshi 原始
  { sid: "4044f1e5-be9f-44c1-ad73-8d1154d4aedb", seq: 2 }, // 9-21 ceshi 原始
  { sid: "4044f1e5-be9f-44c1-ad73-8d1154d4aedb", seq: 4 }, // 4044 重新提问
  { sid: "d53358a5-c0c3-42e0-9091-0315fa852d0c", seq: 4 }, // 幼儿园 重新提问
];

async function main() {
  const store = createStore(DB_PATH);
  const db = store.db;

  for (const t of TARGETS) {
    const msg = db.prepare(`SELECT id FROM chat_messages WHERE session_id=? AND seq=? AND role='assistant'`).get(t.sid, t.seq);
    if (!msg) console.log(`⚠ 跳过（无消息）${t.sid}#${t.seq}`);
  }

  importRiskRules(db);

  console.log(`\n=== 用当前最新 composeReport 重新审查（产出 Format A）===\n`);
  const res = await reviewContract(store, {
    collection: CONTRACT_COLL,
    path: CONTRACT_PATH,
    tags: TAGS,
    reportDir: undefined,
  });
  console.log(`✓ docid=${res.docid} · analysisId=${res.analysisId} · markdown长度=${(res.reportMarkdown || "").length}`);
  console.log(`✓ 报告文件：${res.reportPath}`);

  const sources = JSON.stringify([{ type: "review", analysisId: res.analysisId, reportPath: res.reportPath }]);
  let ok = 0;
  for (const t of TARGETS) {
    const msg = db.prepare(`SELECT id FROM chat_messages WHERE session_id=? AND seq=? AND role='assistant'`).get(t.sid, t.seq);
    if (!msg) continue;
    db.prepare(`UPDATE chat_messages SET content=?, sources=? WHERE id=?`).run(res.reportMarkdown ?? "", sources, msg.id);
    console.log(`✓ 已覆盖 ${t.sid}#${t.seq}（analysisId=${res.analysisId}）`);
    ok++;
  }
  console.log(`\n完成：已覆盖 ${ok} 条消息为 Format A，与幼儿园供热合同风险第三部分样式一致。`);
  store.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
