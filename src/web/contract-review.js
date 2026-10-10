// QMD 合同风险审查前端 — 独立页面，复用主应用的 token 注入逻辑。
(function installTokenFetch() {
  const _orig = window.fetch.bind(window);
  window.fetch = (url, opts = {}) => {
    const t = localStorage.getItem("qmd_token");
    if (t) opts.headers = { ...(opts.headers || {}), Authorization: "Bearer " + t };
    return _orig(url, opts);
  };
})();

const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => "")}`);
  return r.json();
}

async function checkHealth() {
  try {
    const r = await fetch("/health");
    $("#health").textContent = r.ok ? "● 已连接" : "● 未连接";
    $("#health").style.color = r.ok ? "#e8f5e9" : "#ffe0e0";
  } catch {
    $("#health").textContent = "● 未连接";
    $("#health").style.color = "#ffe0e0";
  }
}

async function loadCollections() {
  try {
    const d = await api("/api/collections");
    const cols = (d.collections || []).map((c) => c.name);
    $("#collSel").innerHTML = cols.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
    if (cols.length) await loadDocuments(cols[0]);
  } catch (e) {
    $("#msg").className = "msg err";
    $("#msg").textContent = "加载集合失败：" + e.message;
  }
}

async function loadDocuments(coll) {
  if (!coll) return;
  try {
    const d = await api(`/api/collections/${encodeURIComponent(coll)}/documents`);
    const docs = d.documents || [];
    $("#docSel").innerHTML = docs
      .map((doc) => `<option value="${esc(doc.path)}">${esc(doc.title || doc.path)}</option>`)
      .join("");
  } catch {
    $("#docSel").innerHTML = "";
  }
}

async function upload() {
  const coll = $("#upColl").value.trim();
  const file = $("#upFile").files[0];
  const msg = $("#upMsg");
  if (!coll || !file) {
    msg.className = "msg err";
    msg.textContent = "请填写集合名称并选择文件";
    return;
  }
  msg.className = "msg";
  msg.textContent = "上传中…";
  const fd = new FormData();
  fd.append("collection", coll);
  fd.append("file", file);
  fd.append("autoIndex", "1");
  try {
    await fetch("/api/documents", { method: "POST", body: fd });
    msg.className = "msg ok";
    msg.textContent = "上传并建索引成功，请到②选择合同。";
    await loadCollections();
    $("#collSel").value = coll;
    await loadDocuments(coll);
  } catch (e) {
    msg.className = "msg err";
    msg.textContent = "上传失败：" + e.message;
  }
}

function selectedTags() {
  return [...document.querySelectorAll(".tags input:checked")].map((c) => c.value);
}

async function runReview() {
  const coll = $("#collSel").value;
  const path = $("#docSel").value;
  const tags = selectedTags();
  const btn = $("#reviewBtn");
  const msg = $("#msg");
  const prog = $("#progress");
  if (!coll || !path) {
    msg.className = "msg err";
    msg.textContent = "请先选择集合与文档";
    return;
  }
  btn.disabled = true;
  msg.className = "msg";
  msg.textContent = "";
  prog.textContent = "审查中（正在逐条比对风险清单）…";
  try {
    const d = await api("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ collection: coll, path, tags }),
    });
    $("#report").className = "";
    $("#report").innerHTML = '<div class="report-md">' + renderReportMd(d.reportMarkdown || "（无报告内容）", { analysisId: d.analysisId }) + "</div>";
    prog.textContent = `完成 · 分析ID ${d.analysisId} · 命中 ${d.findings?.filter((f) => f.status === "triggered").length || 0} 项风险`;
    msg.className = "msg ok";
    msg.textContent = `报告已生成：${d.reportPath || ""}`;
  } catch (e) {
    prog.textContent = "";
    msg.className = "msg err";
    msg.textContent = "审查失败：" + e.message;
  } finally {
    btn.disabled = false;
  }
}

// Minimal markdown renderer for the structured report.
function bold(s) {
  return s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}
function renderMd(md) {
  const lines = esc(md).split("\n");
  let html = "";
  let inList = false;
  const closeList = () => {
    if (inList) {
      html += "</ul>";
      inList = false;
    }
  };
  for (const raw of lines) {
    const line = raw;
    if (/^\s*#\s/.test(line)) {
      closeList();
      html += `<h2>${line.replace(/^#\s/, "")}</h2>`;
    } else if (/^\s*##\s/.test(line)) {
      closeList();
      html += `<h3>${line.replace(/^##\s/, "")}</h3>`;
    } else if (/^\s*###\s/.test(line)) {
      closeList();
      html += `<h4>${line.replace(/^###\s/, "")}</h4>`;
    } else if (/^\s*[-*]\s/.test(line)) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${bold(line.replace(/^\s*[-*]\s/, ""))}</li>`;
    } else if (/^\s*\d+\.\s/.test(line)) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${bold(line.replace(/^\s*\d+\.\s/, ""))}</li>`;
    } else if (line.trim() === "") {
      closeList();
    } else {
      closeList();
      html += `<p>${bold(line)}</p>`;
    }
  }
  closeList();
  return html;
}

// ----- 合同审查报告结构化渲染（与主问答界面一致：可追溯 + 静默过滤） -----
let reportRenderSeq = 0;
function renderMarkdownSimple(md) {
  const lines = esc(md).split("\n");
  let html = "";
  let inList = false;
  const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };
  const bold = (s) => s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  for (const raw of lines) {
    if (/^\s*#\s/.test(raw)) { closeList(); html += `<h2>${raw.replace(/^#\s/, "")}</h2>`; }
    else if (/^\s*##\s/.test(raw)) { closeList(); html += `<h3>${raw.replace(/^##\s/, "")}</h3>`; }
    else if (/^\s*###\s/.test(raw)) { closeList(); html += `<h4>${raw.replace(/^###\s/, "")}</h4>`; }
    else if (/^\s*>\s?/.test(raw)) { closeList(); html += `<blockquote>${bold(raw.replace(/^\s*>\s?/, ""))}</blockquote>`; }
    else if (/^\s*[-*]\s/.test(raw)) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${bold(raw.replace(/^\s*[-*]\s/, ""))}</li>`; }
    else if (/^\s*\d+\.\s/.test(raw)) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${bold(raw.replace(/^\s*\d+\.\s/, ""))}</li>`; }
    else if (raw.trim() === "") { closeList(); }
    else { closeList(); html += `<p>${bold(raw)}</p>`; }
  }
  closeList();
  return html;
}

// 第一部分「项目基本信息提取」：将固定格式（第N项｜标签：【内容】（出处：…））
// 解析为结构化卡片；某行不符合格式时回退为普通段落，保证鲁棒性。
function renderProjectInfo(text) {
  // 兼容两种写法：行首可能带「1. 」序号、末尾「出处」可能缺失
  const itemRe = /^(?:\d+\.\s*)?第(\d+)项[｜|]\s*(.+?)\s*[:：]\s*【(.*?)】(?:\s*[（(]出处[:：]\s*(.+?)\s*[)）])?\s*$/;
  // 固定 10 项：每项配一个语义图标，强化「固定条目」的视觉辨识度
  const iconMap = {
    "项目名称与类型": "🏷️", "合同主体": "🏢", "合作期限": "📅", "合作模式": "🤝",
    "投资责任": "💰", "收益分配": "📊", "退出机制": "🚪", "违约责任": "⚠️",
    "保险要求": "🛡️", "争议解决": "⚖️"
  };
  const lines = String(text || "").split("\n").map((s) => s.trim()).filter(Boolean);
  // 固定 10 项里「未在合同中找到 / 未提及」等缺失标记，单独高亮提示
  const missingRe = /^(未在合同中找到|未提及|未约定|无|（无）|\(无\)|—|－)$|未在合同中找到|未提及相关|未明确约定/;
  const out = [];
  for (const ln of lines) {
    const m = ln.match(itemRe);
    if (!m) { out.push(`<p class="proj-raw">${esc(ln)}</p>`); continue; }
    const no = m[1], label = m[2], content = m[3], src = m[4];
    const missing = missingRe.test(content);
    const icon = iconMap[label] || "•";
    const srcHtml = src ? `<div class="proj-src">${esc(src)}</div>` : "";
    out.push(
      `<div class="proj-item" data-no="${esc(no)}">` +
        `<span class="proj-no">第${esc(no)}项</span>` +
        `<div class="proj-label"><span class="proj-icon">${icon}</span>${esc(label)}</div>` +
        `<div class="proj-body">` +
          `<div class="proj-content${missing ? " is-missing" : ""}">${esc(content)}</div>` +
          srcHtml +
        `</div>` +
      `</div>`
    );
  }
  return out.join("");
}

function renderReportMd(md, opts) {
  const analysisId = opts && opts.analysisId;
  const safe = String(md == null ? "" : md);
  const lines = safe.split("\n");
  if (!lines.some((l) => l.startsWith("# 运营类合同风险分析报告"))) {
    return renderMarkdownSimple(safe);
  }
  reportRenderSeq += 1;
  const prefix = "rpt" + reportRenderSeq;
  const e = (s) => esc(String(s == null ? "" : s));

  let meta = "";
  const findings = [];
  let curCat = "";
  let cur = null;
  const buckets = { project: [], special: [], overall: [] };
  let bucket = "project";
  const pushFinding = () => { if (cur) { findings.push(cur); cur = null; } };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.startsWith("# ")) continue;
    if (/^>\s?/.test(line)) { meta = line.replace(/^>\s?/, ""); continue; }
    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) {
      const t = h2[1];
      pushFinding();
      if (t.includes("第一部分")) { bucket = "project"; continue; }
      if (t.includes("第二部分")) { bucket = "findings"; continue; }
      if (t.includes("特殊情形")) { bucket = "special"; continue; }
      if (t.includes("第三部分")) { bucket = "overall"; continue; }
      if (bucket === "findings") { curCat = t; continue; }
      buckets[bucket].push(`<h3>${e(t)}</h3>`);
      continue;
    }
    if (bucket === "findings") {
      const mItem = line.match(/^(\d+)\.\s*第\d+项｜(.+?)（(.+?)）\s*$/);
      if (mItem) {
        pushFinding();
        cur = { idx: mItem[1], name: mItem[2], ruleId: mItem[3], category: curCat, status: "", excerpt: "", excerptLoc: "", excerptDocHash: "", excerptLine: 0, analysis: "", severity: "", suggestion: "", wikiRefs: "" };
        continue;
      }
      const mDet = line.match(/^\s*-\s*(.+?)：(.*)$/);
      if (mDet && cur) {
        const k = mDet[1].trim();
        const v = mDet[2].trim();
        if (k.includes("合同映射情况")) cur.status = v;
        else if (k.includes("风险条款原文摘录")) {
          let val = v;
          const sl = val.match(/⟦LOC:([^⟧]+)⟧/);
          if (sl) {
            const parts = sl[1].split(":");
            cur.excerptDocHash = parts[0] ?? "";
            cur.excerptLine = parseInt(parts[1] || "0", 10) || 0;
          }
          val = val.replace(/⟦LOC:[^⟧]*⟧/g, "");
          const loc = val.match(/（出处：(.*?)）/);
          if (loc) { cur.excerpt = val.replace(/（出处：.*?）/,"").trim(); cur.excerptLoc = loc[1]; }
          else cur.excerpt = val.trim();
        } else if (k.includes("风险解析")) cur.analysis = v;
        else if (k.includes("风险等级")) cur.severity = v;
        else if (k.includes("修改建议")) cur.suggestion = v;
        else if (k.includes("依据")) cur.wikiRefs = v;
        continue;
      }
      continue;
    }
    buckets[bucket].push(line);
  }
  pushFinding();

  const isSilent = (f) =>
    f.status === "not_found" || String(f.status || "").includes("未找到") || f.severity === "不适用";
  const visibleFindings = findings.filter((f) => !isSilent(f));

  const sevClass = (s) => ({ 高: "high", 中: "mid", 低: "low" }[s] || "na");
  const statusClass = (s) =>
    s === "已触发" ? "triggered" : s === "未触发" ? "notrigger" : s.includes("未找到") ? "notfound" : s === "评审异常" ? "error" : "na";
  const triggeredCount = visibleFindings.filter((f) => f.status === "已触发").length;

  let html = "";
  html += `<div class="report-title">运营类合同风险分析报告</div>`;
  if (meta) html += `<div class="report-meta">${e(meta)}</div>`;

  if (visibleFindings.length) {
    const ordered = [...visibleFindings].sort(
      (a, b) => (a.status === "已触发" ? 0 : 1) - (b.status === "已触发" ? 0 : 1),
    );
    html += `<div class="risk-overview"><div class="ro-head">主要风险点概览 · 已触发 ${triggeredCount} / 共 ${visibleFindings.length} 项</div><div class="ro-chips">`;
    for (const f of ordered) {
      const active = f.status === "已触发" ? " ro-active" : "";
      html += `<a class="ro-chip${active}" href="#${prefix}-risk-${f.idx}"><span class="sev-badge sev-${sevClass(f.severity)}">${e(f.severity)}</span>${e(f.name)}</a>`;
    }
    html += `</div></div>`;
  }

  html += `<div class="risk-cards">`;
  for (const f of visibleFindings) {
    const trig = f.status === "已触发" ? " rc-triggered" : f.status === "未触发" ? " rc-notrigger" : "";
    html += `<div class="risk-card${trig}" id="${prefix}-risk-${f.idx}">`;
    html += `<div class="rc-head"><span class="rc-idx">第${e(f.idx)}项</span><span class="rc-name">${e(f.name)}</span><span class="sev-badge sev-${sevClass(f.severity)}">${e(f.severity)}</span><span class="rc-status s-${statusClass(f.status)}">${e(f.status)}</span><span class="rc-rule">清单 ${e(f.ruleId)}</span></div>`;
    const locBtn = f.excerptDocHash
      ? `<button type="button" class="rc-locate" data-doc="${e(f.excerptDocHash)}" data-line="${f.excerptLine || 0}" data-excerpt="${e(f.excerpt)}">📍 定位原文</button>`
      : "";
    html += `<div class="rc-evidence"><div class="rc-ev-title">📌 风险条款原文摘录（可追溯）</div><div class="rc-excerpt">${e(f.excerpt || "（无）")}</div>${f.excerptLoc ? `<div class="rc-loc">出处：${e(f.excerptLoc)}</div>` : ""}${locBtn}</div>`;
    html += `<details class="rc-details"><summary>展开风险解析 · 修改建议 · 制度依据</summary><div class="rc-body">`;
    html += `<div class="rc-row"><b>风险解析：</b>${e(f.analysis || "（无）")}</div>`;
    html += `<div class="rc-row"><b>修改建议：</b>${e(f.suggestion || "（无）")}</div>`;
    html += `<div class="rc-row"><b>制度/模板依据：</b>${e(f.wikiRefs || "（无）")}</div>`;
    html += `</div></details>`;
    html += `</div>`;
  }
  html += `</div>`;

  if (buckets.project.length) html += `<section class="report-part part-first"><h2>第一部分：项目基本信息提取</h2>` + renderProjectInfo(buckets.project.join("\n")) + `</section>`;
  if (buckets.special.length) html += `<h2>特殊情形强制检查</h2>` + renderMarkdownSimple(buckets.special.join("\n"));
  if (buckets.overall.length) html += `<h2>第三部分：总体评价与谈判优先级</h2>` + renderMarkdownSimple(buckets.overall.join("\n"));

  if (analysisId != null) {
    html += `<div class="report-foot">分析记录 ID：#${e(analysisId)} · 每条风险点均可回溯至合同原文与 44 项风险清单</div>`;
  }
  return html;
}

// ---------- 合同原文面板：点击「定位原文」跳转到原文段落 ----------
let contractHash = null;
async function loadContractText(hash) {
  const box = $("#contractText");
  if (!box) return;
  if (contractHash === hash && box.dataset.loaded === "1") return;
  box.dataset.loaded = "0";
  box.innerHTML = '<div class="ct-line"><span class="ct-txt muted">加载原文中…</span></div>';
  try {
    const r = await fetch(`/api/content/${encodeURIComponent(hash)}`);
    const d = await r.json().catch(() => ({}));
    const lines = (d.text || "").split("\n");
    box.innerHTML = lines
      .map((ln, i) => `<div class="ct-line" data-line="${i + 1}"><span class="ct-no">${i + 1}</span><span class="ct-txt">${esc(ln)}</span></div>`)
      .join("");
    box.dataset.loaded = "1";
    contractHash = hash;
  } catch (err) {
    box.innerHTML = `<div class="ct-line"><span class="ct-txt" style="color:var(--err)">原文加载失败：${esc(err.message)}</span></div>`;
  }
}
async function locateExcerpt(doc, line, excerpt) {
  const panel = $("#contractPanel");
  if (panel) panel.hidden = false;
  await loadContractText(doc);
  const box = $("#contractText");
  if (!box) return;
  let el = null;
  if (line) el = box.querySelector(`.ct-line[data-line="${line}"]`);
  if (!el && excerpt) {
    const need = String(excerpt).replace(/\s+/g, "").slice(0, 40);
    if (need) el = [...box.querySelectorAll(".ct-line")].find((l) => (l.querySelector(".ct-txt").textContent || "").replace(/\s+/g, "").includes(need)) || null;
  }
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ct-flash");
    setTimeout(() => el && el.classList.remove("ct-flash"), 1700);
  }
}
document.addEventListener("click", (ev) => {
  const t = ev.target.closest(".rc-locate");
  if (!t) return;
  ev.preventDefault();
  const el = t;
  const doc = el.dataset.doc;
  const line = parseInt(el.dataset.line || "0", 10) || 0;
  const excerpt = el.dataset.excerpt || "";
  if (doc) locateExcerpt(doc, line, excerpt);
});
const contractClose = $("#contractClose");
if (contractClose) contractClose.addEventListener("click", () => { const p = $("#contractPanel"); if (p) p.hidden = true; });

$("#upBtn").addEventListener("click", upload);
$("#collSel").addEventListener("change", (e) => loadDocuments(e.target.value));
$("#reviewBtn").addEventListener("click", runReview);
checkHealth();
loadCollections();
