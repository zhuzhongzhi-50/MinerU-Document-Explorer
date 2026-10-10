/**
 * 重跑「幼儿园供热合同」审查，并把带优化后第三部分（含对比表/输入-输出/关键参数）
 * 的完整报告作为一条新会话写回对话历史，使对话历史里的第三部分也呈现优化样式。
 *
 * 用法：bun scripts/regen-chat-history-kindergarten.ts
 */
import { createStore, getDefaultDbPath, enableProductionMode } from "../src/store.js";
import { importRiskRules } from "../src/contract-review/db.js";
import { reviewContract } from "../src/contract-review/review.js";
import { createChatSession, addChatMessage } from "../src/chat.js";

enableProductionMode();

const CONTRACT_COLL = "kindergarten-heating";
const CONTRACT_PATH = "济南高新区空港新城幼儿园-临港小镇幼儿园.docx";
const TAGS = ["学校医院", "长周期", "能源"];

async function main() {
  const DB_PATH = "C:\\Users\\wuzhu\\.cache\\qmd\\index.sqlite";
  const store = createStore(DB_PATH);
  const db = store.db;

  // 沿用已有会话的 user_id，保证新会话出现在同一用户的对话历史里
  const ownerRow = db
    .prepare(`SELECT user_id FROM chat_sessions ORDER BY updated_at DESC LIMIT 1`)
    .get() as { user_id: string } | undefined;
  const userId = ownerRow?.user_id ?? "default";
  console.log(`✓ 目标 user_id=${userId}`);

  // 1) 确认专用审查集合与合同已存在（本库合同直接挂在 kindergarten-heating）
  db.prepare(
    `INSERT OR IGNORE INTO store_collections (name, path, pattern, type, include_by_default)
     VALUES (?, ?, '**/*', 'contract', 1)`,
  ).run(CONTRACT_COLL, `./${CONTRACT_COLL}`);
  const doc = db
    .prepare(`SELECT hash, title FROM documents WHERE collection=? AND path=? LIMIT 1`)
    .get(CONTRACT_COLL, CONTRACT_PATH) as { hash: string; title: string } | undefined;
  if (!doc) throw new Error(`未在 ${CONTRACT_COLL} 集合中找到合同 ${CONTRACT_PATH}`);
  console.log(`✓ 专用审查集合 ${CONTRACT_COLL} 就绪（合同 hash=${doc.hash.slice(0, 12)}）`);

  // 2) 确保风险规则已导入
  importRiskRules(db);

  // 3) 真实端到端审查（会重新生成优化后的报告 markdown，含新第三部分）
  console.log(`\n=== 重新审查（生成优化后第三部分）===\n`);
  const res = await reviewContract(store, {
    collection: CONTRACT_COLL,
    path: CONTRACT_PATH,
    tags: TAGS,
    reportDir: undefined,
  });
  console.log(`✓ docid=${res.docid} · analysisId=${res.analysisId}`);
  console.log(`✓ 报告 markdown 长度：${(res.reportMarkdown || "").length}`);

  // 4) 写回对话历史：新建会话 + 用户提问 + 助手报告
  const session = createChatSession(db, userId, {
    title: `幼儿园供热合同风险审查（重跑·优化第三部分）`,
    collections: CONTRACT_COLL,
    mode: "review",
  });
  const userPrompt =
    `合同风险审查 · 集合：${CONTRACT_COLL}` + (TAGS.length ? ` · 特殊情形：${TAGS.join("、")}` : "");
  addChatMessage(db, session.id, "user", userPrompt);
  addChatMessage(db, session.id, "assistant", res.reportMarkdown ?? "", {
    sources: [{ type: "review", analysisId: res.analysisId, reportPath: res.reportPath }],
  });
  console.log(`✓ 已写入对话历史会话：${session.id}`);
  console.log(`✓ 在「对话历史」中打开该会话即可看到优化后的第三部分`);

  store.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
