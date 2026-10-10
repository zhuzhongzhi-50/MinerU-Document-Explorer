import Database from "better-sqlite3";
const DB = "C:\\Users\\wuzhu\\.cache\\qmd\\index.sqlite";
const db = new Database(DB, { readonly: true });

function dump(sessionId, seq, label) {
  const m = db.prepare(`SELECT content FROM chat_messages WHERE session_id=? AND seq=?`).get(sessionId, seq);
  if (!m) { console.log(`\n### ${label}: 未找到`); return; }
  const c = m.content || "";
  const lines = c.split("\n");
  const hasTitle = lines.some((l) => l.trim().startsWith("# 运营类合同风险分析报告"));
  // 找到 第三部分 行
  let start = lines.findIndex((l) => l.includes("第三部分"));
  console.log(`\n================= ${label} (seq=${seq}) =================`);
  console.log(`含报告标题: ${hasTitle}  第三部分行号: ${start}`);
  if (start < 0) { console.log("(无第三部分)"); return; }
  const tail = lines.slice(start, start + 130);
  tail.forEach((l, i) => console.log(`  ${String(start + i).padStart(3)}: ${l}`));
}

dump("d53358a5-c0c3-42e0-9091-0315fa852d0c", 4, "幼儿园[4] 重问");
dump("4044f1e5-be9f-44c1-ad73-8d1154d4aedb", 4, "4044[4] 重问");
dump("4044f1e5-be9f-44c1-ad73-8d1154d4aedb", 2, "4044[2]");
db.close();
