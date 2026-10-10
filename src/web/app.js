// QMD frontend — zero-dependency, talks to the co-located API server (same origin).
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- auth: auto-attach bearer token to every request ----------
// All fetch calls below (query / config / warm / embed / health) will
// transparently carry the saved token once the user pastes it in the config panel.
(function installTokenFetch() {
  const _orig = window.fetch.bind(window);
  window.fetch = async (url, opts = {}) => {
    const t = localStorage.getItem("qmd_token");
    if (t) {
      opts.headers = { ...(opts.headers || {}), Authorization: "Bearer " + t };
    }
    const res = await _orig(url, opts);
    // 全局令牌失效：任何 /api 请求返回 401 都视为需要重新登录，
    // 避免列表/详情/重命名/删除等操作在令牌过期后「静默无反应、看不到效果」。
    if (res.status === 401 && typeof url === "string" && !url.includes("/api/auth/login")) {
      if (localStorage.getItem("qmd_token")) {
        localStorage.removeItem("qmd_token");
        try { setLoggedInUI(""); showLogin(true); } catch { /* 初始化期异常忽略 */ }
      }
    }
    return res;
  };
})();

// ---------- health ----------
async function checkHealth() {
  const el = $("#healthStatus");
  try {
    const r = await fetch("/health");
    if (!r.ok) throw new Error();
    el.textContent = "已连接";
    el.className = "status ok";
  } catch {
    el.textContent = " 未连接";
    el.className = "status err";
  }
}

// ---------- collections cache (for mode hint) ----------
let _collectionCache = null;
let selectedCollections = []; // 当前侧边栏选中的索引集合（支持多选，用于自动判断问答模式）
async function loadCollectionCache() {
  try {
    const r = await fetch("/api/collections");
    if (!r.ok) return;
    const d = await r.json();
    _collectionCache = Array.isArray(d.collections) ? d.collections : [];
  } catch {
    _collectionCache = [];
  }
}
// 按「当前选中的集合类型」自动判断问答模式：
//   仅选中文档集(raw)   → raw（原始）
//   仅选中知识库(wiki)  → wiki
//   两者同时选中        → hybrid（混合）
function derivedMode() {
  // 以 selectedCollections 为唯一数据源：避免依赖 .active 类的渲染时序
  const types = new Set(selectedCollections.map(collectionTypeOf).filter(Boolean));
  if (!types.size) return "";
  if (types.has("wiki") && types.has("raw")) return "hybrid";
  return types.has("wiki") ? "wiki" : "raw";
}
// 按名称查集合类型（只看静态 data-type，不受 .active 同步时机影响）
function collectionTypeOf(name) {
  const rows = [...document.querySelectorAll("#idxList .idx-row")];
  const row = rows.find((r) => r.dataset.name === name);
  return row ? row.dataset.type : "";
}
loadCollectionCache();

// ---------- 页面切换 ----------
function switchTab(t) {
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  $("#tab-" + t).classList.add("active");
  if (t === "config") loadConfig();
  if (t === "query") { loadCollections(); loadIndexList(); }
}
// 顶部「配置导航」按钮：跳转配置页
$("#cfgNavBtn").addEventListener("click", () => switchTab("config"));
// 配置页「返回问答」按钮
$("#cfgBack").addEventListener("click", () => switchTab("query"));

// ---------- query ----------
let queryAbort = null;
let loadingTimerId = null;
let lastQueryText = "";
let lastQueryStart = 0;
let lastResult = null; // 最近一次问答的完整结果（供「存为 Wiki 页」使用）
let currentSessionId = null; // 当前对话会话 ID（持久化用）
let historyViewActive = false; // 是否处于「历史会话」视图（即在该会话中继续交流）
const DEFAULT_QRESULT = $("#qResult") ? $("#qResult").innerHTML : "";
function resetQResult() {
  const root = $("#qResult");
  const hist = $("#qHistory");
  // 在历史会话中继续交流时保留历史视图，避免新问答另开一个结果页
  if (hist && !historyViewActive) hist.hidden = true;
  if (!root) return;
  root.innerHTML = DEFAULT_QRESULT;
  root.hidden = true;
}

async function sendQuery() {
  const query = $("#qInput").value.trim();
  if (!query) {
    showError("请输入问题");
    return;
  }
  lastQueryText = query;
  resetQResult();
  await ensureSession(); // 自动建会话并持久化本次对话
  const body = { query, sessionId: currentSessionId };
  if (selectedCollections.length) {
    body.collections = selectedCollections;
    const mode = derivedMode();
    if (mode) body.mode = mode;
  } else {
    // 未选择任何集合（既没选 wiki 也没选文档集）→ 通用问答：后端跳过检索，直接由大模型作答
    body.direct = true;
  }

  $("#qError").hidden = true;
  $("#qResult").hidden = true;
  $("#qLoading").hidden = false;
  $("#qSend").disabled = true;
  $("#qCancel").hidden = false;

  // 通用问答（未选择任何集合）没有检索环节：隐藏「查询扩展/嵌入/重排」阶段条，
  // 否则会闪现 RAG 的阶段显示随后立刻消失。
  const isDirect = body.direct === true;
  const stagesEl = $("#loadingStages");
  if (stagesEl) stagesEl.style.display = isDirect ? "none" : "flex";
  // 通用问答：只保留转圈与「取消」，隐藏「已等待 N 秒」和提示文字
  const metaEl = $("#loadingMeta");
  if (metaEl) metaEl.hidden = isDirect;

  // 重置阶段与计时显示
  const start = Date.now();
  lastQueryStart = start;
  updateLoadingStage(0);
  $("#loadingTimer").textContent = "已等待 0 秒";
  $("#loadingHint").textContent = isDirect
    ? "通用问答（未选择集合，不检索知识库），正在生成答案…"
    : "首次可能需加载本地模型，请稍候";

  queryAbort = new AbortController();
  loadingTimerId = setInterval(() => {
    const secs = Math.floor((Date.now() - start) / 1000);
    $("#loadingTimer").textContent = `已等待 ${secs} 秒`;
    if (secs >= LOADING_TIMEOUT_HINT) {
      $("#loadingHint").textContent =
        "加载较慢，请耐心等待；若长时间无响应，请检查服务端日志或重启服务。";
    }
  }, 1000);

  try {
    // 重置流式阶段输出
    $("#stageOutput").textContent = "";
    const la = $("#liveAnswer");
    la.hidden = true;
    la.textContent = "";
    document.querySelectorAll("#loadingStages .stage").forEach((el) =>
      el.classList.remove("active", "done")
    );
    if (!isDirect) markStageActive("expand");

    const r = await fetch("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: queryAbort.signal,
    });
    if (!r.ok) {
      let msg = "请求失败";
      try { const d = await r.json(); msg = d.error || msg; } catch {}
      if (r.status === 401 && localStorage.getItem("qmd_token")) {
        // token 失效/无权限，回到登录态
        localStorage.removeItem("qmd_token");
        setLoggedInUI("");
        showLogin(true);
        return;
      }
      showError(msg);
      return;
    }

    // Read the SSE stream and render each stage's output as it arrives.
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let finalData = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() || "";
      for (const part of parts) {
        const lines = part.split("\n");
        let event = "message";
        let dataStr = "";
        for (const line of lines) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
        }
        if (!dataStr) continue;
        let data;
        try { data = JSON.parse(dataStr); } catch { continue; }
        handleStreamEvent(event, data, (d) => { finalData = d; });
      }
    }
    if (finalData) {
      if (historyViewActive && currentSessionId) {
        // 在已有会话中继续交流：把新问答追加进原会话记录，不新开结果页
        lastResult = finalData;
        await appendToCurrentSession(finalData);
      } else {
        renderResult(finalData);
      }
    }
    loadChatSessions();
  } catch (e) {
    if (e.name === "AbortError") return; // 用户主动取消
    showError("网络错误：" + e.message);
  } finally {
    clearInterval(loadingTimerId);
    loadingTimerId = null;
    queryAbort = null;
    $("#qLoading").hidden = true;
    $("#qSend").disabled = false;
    $("#qCancel").hidden = true;
  }
}

// ---------- chat history (per-user persistent sessions) ----------
const chatNewBtn = $("#chatNewBtn");
if (chatNewBtn) chatNewBtn.addEventListener("click", startNewChat);

function safeParseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function renderSourcesHtml(sources) {
  if (!Array.isArray(sources) || !sources.length) return "";
  return sources
    .map((s) => {
      if (s && s.type === "review") {
        return `<li class="src-review">风险审查分析记录${s.analysisId != null ? ` #${esc(String(s.analysisId))}` : ""}</li>`;
      }
      const label = s.title ? s.title : (s.file || "来源");
      const idx = s.index != null ? `[${s.index}] ` : "";
      const score = s.score != null ? ` <span class="muted">(相关度 ${s.score})</span>` : "";
      return `<li>${idx}${esc(label)}${score}</li>`;
    })
    .join("");
}

function buildQACard(question, ans) {
  const card = document.createElement("div");
  card.className = "qa-result";
  const ansText = ans && ans.content ? ans.content : "（无回答）";
  const sources = ans && ans.sources ? safeParseJson(ans.sources) : null;
  // 以 sources 的 review 标记为主；同时按内容兜底识别，确保历史快照即使缺标记也走报告渲染（表格/样式不丢失）
  const isReview =
    (Array.isArray(sources) && sources.some((s) => s && s.type === "review")) ||
    /^\s*#\s+运营类合同风险分析报告/.test(ansText);
  const sourcesHtml = renderSourcesHtml(sources);
  const model = ans && ans.model ? esc(ans.model) : "";
  const reviewSrc = isReview ? sources.find((s) => s && s.type === "review") : null;
  const bodyHtml = isReview
    ? `<div class="report-md">${renderReportMd(ansText, { analysisId: reviewSrc ? reviewSrc.analysisId : undefined })}</div>`
    : esc(ansText);
  card.innerHTML = `
    <div class="qa-result-ans">
      <div class="answer card">
        <div class="answer-head"><span class="ah-title">回答</span>${model ? `<span class="muted" style="font-size:12px">${model}</span>` : ""}</div>
        <div class="answer-body">${bodyHtml}</div>
      </div>
      ${sourcesHtml ? `<div class="qa-extra"><div class="sources"><div class="sources-head">参考来源</div><ol>${sourcesHtml}</ol></div></div>` : ""}
    </div>
    <div class="qa-result-q">
      <div class="question card">
        <div class="question-head">你的问题</div>
        <div class="question-body">${esc(question)}</div>
      </div>
    </div>`;
  return card;
}

function renderHistory(messages, opts) {
  const hist = $("#qHistory");
  const live = $("#qResult");
  if (!hist) return;
  // 历史视图与结果视图（含 #qAnswer）互斥显隐：渲染历史时隐藏结果区，
  // 不再覆盖 #qResult，从根上避免 #qAnswer 被销毁后渲染报 null 的问题
  if (live) live.hidden = true;
  hist.hidden = false;
  historyViewActive = true; // 进入「在该会话中继续交流」模式
  hist.innerHTML = `<div class="chat-history"></div>`;
  const wrap = hist.querySelector(".chat-history");
  let pendingUser = null;
  for (const m of messages) {
    if (m.role === "user") { pendingUser = m.content; continue; }
    if (m.role === "assistant") {
      wrap.appendChild(buildQACard(pendingUser || "", m));
      pendingUser = null;
    }
  }
  if (pendingUser) wrap.appendChild(buildQACard(pendingUser, null));
  // 继续交流（追加新问答）时滚到底部显示最新内容；打开会话时仍从顶部开始
  wrap.scrollTop = opts && opts.toBottom ? wrap.scrollHeight : 0;
}

// 把刚完成的问答追加进当前会话的历史记录（而不是新开一个结果页）
async function appendToCurrentSession(fallbackData) {
  try {
    const d = await fetch(`/api/chat/sessions/${encodeURIComponent(currentSessionId)}`).then((r) => r.json());
    renderHistory(d.messages || [], { toBottom: true });
  } catch {
    // 兜底：拿不到会话时退回结果视图
    if (fallbackData) renderResult(fallbackData);
  }
}

async function loadChatSessions() {
  try {
    const d = await fetch("/api/chat/sessions").then((r) => r.json());
    renderChatSessions(Array.isArray(d.sessions) ? d.sessions : []);
  } catch {
    /* 离线/未授权时静默 */
  }
}

function renderChatSessions(sessions) {
  const box = $("#chatSessions");
  if (!box) return;
  box.innerHTML = "";
  if (!sessions.length) {
    box.innerHTML = `<div class="chat-empty muted">暂无历史对话。发送问题后将自动保存。</div>`;
    return;
  }
  for (const s of sessions) {
    const item = document.createElement("div");
    item.className = "chat-session-item" + (s.id === currentSessionId ? " active" : "");
    item.dataset.id = s.id;
    const title = document.createElement("div");
    title.className = "csi-title";
    title.textContent = s.title || "(未命名会话)";
    item.appendChild(title);

    const del = document.createElement("button");
    del.className = "csi-del";
    del.type = "button";
    del.textContent = "×";
    del.title = "删除该对话";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("确定删除该对话历史？此操作不可恢复。")) return;
      try {
        await fetch(`/api/chat/sessions/${encodeURIComponent(s.id)}`, { method: "DELETE" }).then((r) => r.json());
        if (currentSessionId === s.id) { currentSessionId = null; resetQResult(); }
        await loadChatSessions();
        toast("已删除对话", "ok");
      } catch { toast("删除失败", "err"); }
    });
    item.appendChild(del);

    item.addEventListener("click", () => openChatSession(s.id));
    box.appendChild(item);
  }
}

function setActiveChatItem(id) {
  document.querySelectorAll("#chatSessions .chat-session-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.id === id);
  });
}

async function startNewChat() {
  currentSessionId = null;
  historyViewActive = false; // 新对话退出「会话继续」模式
  resetQResult();
  setActiveChatItem(null);
  $("#qInput")?.focus();
}

async function ensureSession() {
  if (currentSessionId) return currentSessionId;
  try {
    const d = await fetch("/api/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ collections: selectedCollections, mode: derivedMode() || "raw" }),
    }).then((r) => r.json());
    currentSessionId = d.id || null;
    if (currentSessionId) { setActiveChatItem(currentSessionId); await loadChatSessions(); }
  } catch {
    currentSessionId = null; // 匿名/失败则保持无状态
  }
  return currentSessionId;
}

async function openChatSession(id) {
  currentSessionId = id;
  setActiveChatItem(id);
  try {
    const d = await fetch(`/api/chat/sessions/${encodeURIComponent(id)}`).then((r) => r.json());
    renderHistory(d.messages || []);
  } catch {
    toast("加载对话失败", "err");
  }
}

// ---------- loading stage ticker ----------
// 阶段时间轴按本地模型典型冷加载顺序与耗时占比划分（纯前端推测，用于反馈，
// 非后端真实进度）。后端若后续推送 SSE 进度可替换此处。
const LOADING_STAGES = [
  { id: "expand", at: 0 },
  { id: "embed", at: 15 },
  { id: "rerank", at: 70 },
  { id: "generate", at: 90 },
];
const LOADING_TIMEOUT_HINT = 150;

function updateLoadingStage(secs) {
  let activeId = "embed";
  for (const s of LOADING_STAGES) if (secs >= s.at) activeId = s.id;
  document.querySelectorAll("#loadingStages .stage").forEach((el) => {
    const id = el.dataset.stage;
    el.classList.remove("active", "done");
    const stage = LOADING_STAGES.find((s) => s.id === id);
    if (id === activeId) el.classList.add("active");
    else if (secs >= stage.at) el.classList.add("done");
  });
}

// ---------- streaming stage output (driven by SSE events) ----------
function markStageActive(id) {
  const el = document.querySelector(`#loadingStages .stage[data-stage="${id}"]`);
  if (el) el.classList.add("active");
}
function markStageDone(id) {
  const el = document.querySelector(`#loadingStages .stage[data-stage="${id}"]`);
  if (el) { el.classList.add("done"); el.classList.remove("active"); }
}
function appendStageOutput(stage, text, done = false) {
  const box = $("#stageOutput");
  const item = document.createElement("div");
  item.className = "so-item" + (done ? " done" : "");
  item.dataset.stage = stage;
  const s = document.createElement("span");
  s.className = "so-stage";
  s.textContent = stage;
  const b = document.createElement("span");
  b.className = "so-body";
  b.textContent = text;
  item.appendChild(s);
  item.appendChild(b);
  box.appendChild(item);
  box.scrollTop = box.scrollHeight;
}
function updateStageOutput(stage, text, done = true) {
  const item = document.querySelector(`#stageOutput .so-item[data-stage="${stage}"]`);
  if (item) {
    item.querySelector(".so-body").textContent = text;
    if (done) item.classList.add("done");
  } else {
    appendStageOutput(stage, text, done);
  }
}
function handleStreamEvent(event, data, captureDone) {
  switch (event) {
    case "expand": {
      markStageDone("expand");
      const expanded = (data.expanded || [])
        .map((q) => `[${q.type}] ${q.query}`)
        .join("\n");
      appendStageOutput(
        "扩展模型",
        `原始：${data.original}\n${expanded || "(强信号命中，跳过扩展)"}`,
        true
      );
      break;
    }
    case "embed": {
      if (data.phase === "start") {
        markStageActive("embed");
        appendStageOutput("嵌入模型", `正在向量化 ${data.count ?? "?"} 条查询…`);
      } else {
        markStageDone("embed");
        updateStageOutput("嵌入模型", `已向量化查询（${data.ms ?? "?"} ms）`, true);
      }
      break;
    }
    case "rerank": {
      if (data.phase === "start") {
        markStageActive("rerank");
        appendStageOutput("重排", `正在重排 ${data.chunkCount ?? "?"} 个候选片段…`);
      } else {
        markStageDone("rerank");
        updateStageOutput("重排", `重排完成（${data.ms ?? "?"} ms）`, true);
      }
      break;
    }
    case "generate": {
      markStageActive("generate");
      // 不再在此时就显示流式答案框：那时还没有任何文字，会闪出一个空白白色框。
      break;
    }
    case "token": {
      const live = $("#liveAnswer");
      live.textContent += data.text;
      // 有内容后再显示，避免出现空框（通用问答与 RAG 均适用）
      if (live.textContent.trim()) live.hidden = false;
      live.scrollTop = live.scrollHeight;
      break;
    }
    case "error": {
      showError(data.message || "处理出错");
      break;
    }
    case "done": {
      markStageDone("generate");
      captureDone(data);
      break;
    }
  }
}

function showError(msg) {
  const el = $("#qError");
  el.textContent = msg;
  el.hidden = false;
}

// ---------- toast ----------
function toast(msg, kind) {
  const wrap = document.getElementById("toastWrap");
  if (!wrap) return;
  const el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "");
  const ico = kind === "ok" ? "✓" : kind === "err" ? "⚠" : "•";
  el.innerHTML = `<span class="t-ico">${ico}</span><span>${msg}</span>`;
  wrap.appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 250);
  }, 2200);
}

function setExtraOpen(open) {
  const body = $("#qaExtraBody");
  const toggle = $("#qaExtraToggle");
  if (!body || !toggle) return;
  body.hidden = !open;
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  toggle.querySelector(".qa-extra-toggle-ico").textContent = open ? "▴" : "▾";
}

function renderResult(data) {
  const hist = $("#qHistory");
  if (hist) hist.hidden = true; // 显示结果时隐藏历史视图
  $("#qResult").hidden = false;
  lastResult = data;
  // 刷新「存为 Wiki 页」的目标集合下拉（没有 wiki 集合时禁用该操作）
  refreshWikiTargets();

  // 问题内容展示在右侧
  $("#qQuestion").textContent = lastQueryText || "（无问题内容）";

  // 元数据汇总（模型 / 用时 / 索引），折叠于详情区
  const elapsed = ((Date.now() - lastQueryStart) / 1000).toFixed(1);
  const metaParts = [];
  if (data.model) metaParts.push("回答模型：" + data.model);
  else metaParts.push("仅检索模式");
  metaParts.push("用时 " + elapsed + " 秒");
  if (selectedCollections.length) metaParts.push("索引：" + selectedCollections.join("、"));
  $("#qMeta").textContent = metaParts.join(" · ");

  // 每次渲染默认折叠“详情”
  setExtraOpen(false);

  // 通用问答（未选择集合、不检索知识库）没有参考来源与元数据，隐藏整个「展开详情」折叠区
  const extraWrap = $("#qaExtra");
  if (extraWrap) extraWrap.hidden = data.direct === true;

  // wire "expand all / collapse all" for retrieval results
  const expandAllBtn = document.getElementById("qExpandAll");
  if (expandAllBtn) {
    expandAllBtn.onclick = () => {
      const wantExpand = expandAllBtn.dataset.state !== "expanded";
      document.querySelectorAll("#qRaw .src-chunk").forEach((el) => {
        (el).style.display = wantExpand ? "block" : "none";
      });
      document.querySelectorAll("#qRaw .src-toggle").forEach((el) => {
        const cur = el.textContent || "";
        el.textContent = cur.replace(/▸|▾/g, (m) => (m === "▸" ? "▾" : "▸"));
      });
      expandAllBtn.textContent = wantExpand ? "收起全部" : "展开全部";
      expandAllBtn.dataset.state = wantExpand ? "expanded" : "collapsed";
    };
  }

  // answer with clickable [n] citations
  const ans = $("#qAnswer");
  ans.textContent = "";
  // Prefer the answer from the done payload; fall back to the streamed live-answer text.
  const liveText = ($("#liveAnswer")?.textContent || "").trim();
  const text = data.answer || liveText || "（无回答）";
  const re = /\[(\d+)\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) ans.appendChild(document.createTextNode(text.slice(last, m.index)));
    const num = m[1];
    const link = document.createElement("a");
    link.className = "cite";
    link.textContent = `[${num}]`;
    link.href = "#";
    link.addEventListener("click", (ev) => {
      ev.preventDefault();
      const t = document.getElementById("source-" + num);
      if (t) {
        t.scrollIntoView({ behavior: "smooth", block: "center" });
        t.classList.remove("flash");
        void t.offsetWidth;
        t.classList.add("flash");
      }
    });
    ans.appendChild(link);
    last = re.lastIndex;
  }
  if (last < text.length) ans.appendChild(document.createTextNode(text.slice(last)));

  if (data.error) {
    const errNote = document.createElement("div");
    errNote.style.color = "var(--err)";
    errNote.style.marginTop = "8px";
    errNote.style.fontSize = "13px";
    errNote.textContent = "⚠ " + data.error;
    ans.appendChild(errNote);
  }

  // cited source indexes
  const cited = new Set((data.sources || []).map((s) => s.index));

  // answer-referenced sources list
  const srcList = $("#qSources");
  srcList.textContent = "";
  (data.sources || []).forEach((s) => {
    const li = document.createElement("li");
    const t = document.createElement("span");
    t.className = "src-title";
    t.textContent = s.title || "(无标题)";
    const meta = document.createElement("div");
    meta.className = "src-meta";
    meta.textContent = `[${s.index}] ${s.file} · 相似度 ${s.score}`;
    li.appendChild(t);
    li.appendChild(meta);
    srcList.appendChild(li);
  });

  if (!(data.sources || []).length) {
    const hli = document.createElement("li");
    const hbox = document.createElement("div");
    hbox.style.cssText = "margin-top:4px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:rgba(127,127,127,0.05);font-size:13px;line-height:1.65;white-space:pre-wrap;color:var(--text);";
    hbox.textContent = data.retrievalHint || "本次未检索到任何相关片段，参考来源为空。常见原因：① 当前未选中任何集合；② 该集合未上传文档或未建索引；③ 相似度低于阈值 minScore。可切换/勾选集合，或在「配置 → 检索」中调低 minScore 后重试。";
    hli.appendChild(hbox);
    srcList.appendChild(hli);
  }

  // full retrieval results — chunk-level granular view
  const raw = $("#qRaw");
  raw.textContent = "";
  (data.rawResults || []).forEach((r, i) => {
    const idx = i + 1;
    const li = document.createElement("li");
    li.id = "source-" + idx;

    const head = document.createElement("div");
    const t = document.createElement("span");
    t.className = "src-title";
    t.textContent = r.title || "(无标题)";
    head.appendChild(t);
    if (cited.has(idx)) {
      const badge = document.createElement("span");
      badge.className = "src-cited";
      badge.textContent = "被引用 [" + idx + "]";
      head.appendChild(badge);
    }
    if (r.kind === "wiki" || r.kind === "raw") {
      const kindBadge = document.createElement("span");
      kindBadge.className = "src-kind src-kind-" + r.kind;
      kindBadge.textContent = r.kind === "wiki" ? "wiki" : "原始";
      head.appendChild(kindBadge);
    }
    const meta = document.createElement("div");
    meta.className = "src-meta";
    meta.textContent = `${r.file} · 相似度 ${r.score}`;

    // ★ best chunk — the single chunk actually sent to the model (always visible)
    const bestWrap = document.createElement("div");
    bestWrap.style.cssText = "margin-top:8px;";
    const bestLabel = document.createElement("div");
    bestLabel.style.cssText = "font-size:12px;font-weight:600;color:var(--primary);margin-bottom:4px;";
    bestLabel.textContent = "★ 最佳块（已送入模型）";
    const bestBody = document.createElement("div");
    bestBody.style.cssText = "white-space:pre-wrap;background:rgba(127,127,127,0.07);padding:8px 10px;border-radius:6px;font-size:13px;line-height:1.5;max-height:240px;overflow:auto;";
    bestBody.textContent = r.bestChunk || "(无片段)";
    bestWrap.appendChild(bestLabel);
    bestWrap.appendChild(bestBody);

    // chunk-level detail (collapsible) — each block as its own granular entry
    const chunkCount = Array.isArray(r.chunks) ? r.chunks.length : 0;
    const detailToggle = document.createElement("span");
    detailToggle.className = "src-meta src-toggle";
    detailToggle.style.cssText = "cursor:pointer;color:var(--primary);margin-top:8px;display:inline-block;";
    detailToggle.textContent = chunkCount
      ? `▸ 分块明细（共 ${chunkCount} 块，按相关度排序）`
      : "▸ 分块明细（无）";
    const detail = document.createElement("div");
    detail.className = "src-chunk";
    detail.style.cssText = "margin-top:6px;";
    detail.style.display = "none";
    if (chunkCount) {
      r.chunks.forEach((c, ci) => {
        const cwrap = document.createElement("div");
        cwrap.style.cssText = "margin:6px 0 6px 12px;padding-left:10px;border-left:2px solid var(--border);";
        const chead = document.createElement("div");
        chead.style.cssText = "font-size:12px;color:var(--muted);margin-bottom:2px;";
        chead.textContent = ci === 0 ? `块 #${ci + 1}（＝最佳块）` : `块 #${ci + 1}`;
        const cbody = document.createElement("div");
        cbody.style.cssText = "white-space:pre-wrap;font-size:12.5px;line-height:1.5;";
        cbody.textContent = c;
        cwrap.appendChild(chead);
        cwrap.appendChild(cbody);
        detail.appendChild(cwrap);
      });
    }
    detailToggle.addEventListener("click", () => {
      const open = detail.style.display !== "none";
      detail.style.display = open ? "none" : "block";
      detailToggle.textContent = open
        ? `▸ 分块明细（共 ${chunkCount} 块，按相关度排序）`
        : `▾ 收起分块明细（共 ${chunkCount} 块）`;
    });

    li.appendChild(head);
    li.appendChild(meta);
    li.appendChild(bestWrap);
    li.appendChild(detailToggle);
    li.appendChild(detail);
    raw.appendChild(li);
  });

  if (!(data.rawResults || []).length) {
    const hli = document.createElement("li");
    const hbox = document.createElement("div");
    hbox.style.cssText = "margin-top:4px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:rgba(127,127,127,0.05);font-size:13px;line-height:1.65;white-space:pre-wrap;color:var(--text);";
    hbox.textContent = data.retrievalHint || "本次检索未返回任何片段。可在左侧切换/勾选集合，或到「配置 → 检索」调低 minScore 后重试。";
    hli.appendChild(hbox);
    raw.appendChild(hli);
  }
}

$("#qSend").addEventListener("click", handleSend);
$("#qCancel").addEventListener("click", () => {
  if (queryAbort) queryAbort.abort();
  if (reviewAbort) reviewAbort.abort();
});
// ---------- 存为 Wiki 页（问答 → wiki 沉淀 + 来源血缘） ----------
async function refreshWikiTargets() {
  const sel = $("#qaWikiColl");
  const btn = $("#qaWikiSave");
  if (!sel || !btn) return;
  await loadCollectionCache();
  const cols = Array.isArray(_collectionCache) ? _collectionCache : [];
  const wiki = cols.filter((c) => c.type === "wiki");
  const prev = sel.value;
  sel.textContent = "";
  if (wiki.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "（无 wiki 集合）";
    sel.appendChild(opt);
    sel.disabled = true;
    btn.disabled = true;
    btn.title = "还没有 wiki 集合，请先创建：qmd collection add <path> --name <name> --type wiki";
    return;
  }
  for (const c of wiki) {
    const opt = document.createElement("option");
    opt.value = c.name;
    opt.textContent = `${c.name}（${c.activeCount ?? 0} 页）`;
    sel.appendChild(opt);
  }
  sel.disabled = false;
  btn.disabled = false;
  btn.title = "把本次问答沉淀为 wiki 页，并记录所引用文档的血缘关系";
  sel.value =
    [prev, ...selectedCollections, wiki[0].name].find((n) => n && wiki.some((c) => c.name === n)) || wiki[0].name;
}

/**
 * 提取本次回答真正引用到的来源：优先取答案中 [n] 标注引用的文档，
 * 若答案没有任何 [n] 标注则退回全部参考来源。
 */
function referencedSources(answer, allSources) {
  const cited = new Set();
  let m;
  const re = /\[(\d+)\]/g;
  while ((m = re.exec(answer))) cited.add(Number(m[1]));
  const list = Array.isArray(allSources) ? allSources : [];
  const used = cited.size ? list.filter((s) => cited.has(s.index)) : list;
  return used.map((s) => s.file).filter(Boolean);
}

async function saveQaToWiki() {
  const btn = $("#qaWikiSave");
  const sel = $("#qaWikiColl");
  const collection = sel ? sel.value : "";
  if (!collection) {
    toast("没有可写入的 wiki 集合，请先创建", "err");
    return;
  }
  const data = lastResult || {};
  const answer = ($("#qAnswer")?.textContent || "").trim();
  if (!answer || answer === "（无回答）") {
    toast("当前没有可沉淀的回答", "err");
    return;
  }
  const question = lastQueryText || "";

  const fallbackTitle = (question.split("\n")[0] || "").slice(0, 40).trim() || "问答沉淀";
  const input = window.prompt("Wiki 页标题（决定页面标题与文件名）：", fallbackTitle);
  if (input === null) return; // 用户取消
  const title = input.trim() || fallbackTitle;

  const sources = referencedSources(answer, data.sources);

  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "保存中…";
  try {
    const r = await fetch("/api/wiki/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ collection, title, question, answer, sources }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      toast("保存失败：" + (d.error || r.status), "err");
      return;
    }
    toast(`${d.overwritten ? "已更新" : "已保存"} wiki 页：${d.file}`, "ok");
    loadIndexList();
  } catch (e) {
    toast("保存失败：" + ((e && e.message) || e), "err");
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

$("#qaWikiSave").addEventListener("click", saveQaToWiki);

$("#qCopy").addEventListener("click", async () => {
  const text = $("#qAnswer").textContent || "";
  if (!text.trim()) return;
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制回答到剪贴板", "ok");
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      toast("已复制回答到剪贴板", "ok");
    } catch {
      toast("复制失败，请手动选择文本", "err");
    }
    document.body.removeChild(ta);
  }
});

// 详情折叠/展开（参考来源、操作、元数据）
$("#qaExtraToggle").addEventListener("click", () => {
  const body = $("#qaExtraBody");
  if (!body) return;
  setExtraOpen(body.hidden);
});
$("#qInput").addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); handleSend(); }
});

// ---------- config ----------
// ---------- auth token UI (injected once into the config panel) ----------
(function setupTokenUI() {
  const form = $("#configForm");
  if (!form || form.parentNode.dataset.tokenUi) return;
  form.parentNode.dataset.tokenUi = "1";
  const wrap = document.createElement("div");
  wrap.className = "config-field";
  wrap.style.marginBottom = "14px";
  wrap.innerHTML =
    '<label>访问令牌 (Bearer Token)</label>' +
    '<div style="display:flex;gap:8px">' +
    '<input id="cfgToken" type="password" placeholder="粘贴 `qmd user add` 生成的 token" style="flex:1">' +
    '<button id="cfgTokenSave" type="button">保存令牌</button>' +
    '<button id="cfgTokenEye" type="button" title="显示/隐藏令牌内容" aria-label="显示或隐藏令牌" style="padding:0 10px;font-size:16px;line-height:1">👁</button></div>' +
    '<div id="cfgTokenMsg" class="msg"></div>';
  form.parentNode.insertBefore(wrap, form);
  const input = $("#cfgToken");
  input.value = localStorage.getItem("qmd_token") || "";
  $("#cfgTokenSave").addEventListener("click", () => {
    const v = input.value.trim();
    if (v) localStorage.setItem("qmd_token", v);
    else localStorage.removeItem("qmd_token");
    configLoaded = false; // reload config under the new identity next time
    const m = $("#cfgTokenMsg");
    m.textContent = v ? "已保存，后续请求将自动携带该令牌" : "已清除令牌";
    m.className = "msg ok";
  });
  // 小眼睛：切换令牌明文/掩码显示
  const eyeBtn = $("#cfgTokenEye");
  eyeBtn.addEventListener("click", () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    eyeBtn.textContent = show ? "🙈" : "👁";
  });
})();

const CONFIG_FIELDS = [
  // 分块参数（chunkSizeTokens / chunkOverlapRatio / chunkWindowTokens）已移至
  // 上传文档弹窗的「索引配置」区，避免与全局设置重复配置，此处不再暴露。
  { key: "queryLimit", label: "检索返回条数", group: "检索", type: "number", desc: "单次问答返回的最大参考片段数。" },
  { key: "minScore", label: "最低相似度", group: "检索", type: "number", step: "0.01", desc: "低于此分数的片段会被过滤掉。" },
  { key: "candidateLimit", label: "候选池大小", group: "检索", type: "number", desc: "召回阶段初步拉取的候选片段数量，越大覆盖越广。" },
  { key: "strongSignalMinScore", label: "强信号阈值", group: "检索", type: "number", step: "0.01", hidden: true },
  { key: "strongSignalMinGap", label: "强信号间隔", group: "检索", type: "number", step: "0.01", hidden: true },
  { key: "intentWeightSnippet", label: "意图·片段权重", group: "检索", type: "number", step: "0.01", hidden: true },
  { key: "intentWeightChunk", label: "意图·分块权重", group: "检索", type: "number", step: "0.01", hidden: true },
  { key: "rrfK", label: "RRF K 值", group: "检索", type: "number", desc: "多路召回融合时的平滑常数，平衡各路排序。" },
  { key: "enableRerank", label: "启用重排 (rerank)", group: "检索", type: "checkbox", desc: "用重排模型对候选片段二次精排，提升相关性。" },
  { key: "enableQueryExpansion", label: "启用查询扩展 (expansion)", group: "检索", type: "checkbox", desc: "将问题改写为多个子问题分别检索，扩大召回面。" },
  { key: "autoEmbedOnWrite", label: "写入时自动建向量", group: "索引", type: "checkbox", descBlock: true, desc: "通过 doc_write 工具或 wiki 索引写入文档时，自动为对应集合增量生成向量，写好的页面立即可被检索。仅处理尚未向量化的文档，重复写入开销很低；关闭，则适用于大批量写 wiki，会避免每写一页都触发一次向量化。" },
  { key: "embedBatchSize", label: "嵌入批大小", group: "模型", type: "number", readonly: true },
  { key: "embedModel", label: "嵌入模型", group: "模型", type: "text", readonly: true },
  { key: "rerankModel", label: "重排模型", group: "模型", type: "text", readonly: true },
  { key: "queryExpansionModel", label: "查询扩展模型", group: "模型", type: "text", readonly: true },
  { key: "modelCacheDir", label: "模型缓存目录", group: "模型", type: "text", readonly: true },
  { key: "llmBaseUrl", label: "问答 API 地址", group: "问答 LLM", type: "text" },
  { key: "llmApiKey", label: "问答 API Key", group: "问答 LLM", type: "password" },
  { key: "llmModel", label: "问答模型名", group: "问答 LLM", type: "text" },
];

// 分组在配置网格中的排布顺序：检索｜模型 一行，索引｜问答 LLM 一行
const GROUP_ORDER = { "检索": 1, "模型": 2, "索引": 3, "问答 LLM": 4 };

let configValues = {};
let configLoaded = false;

function buildConfigForm() {
  const form = $("#configForm");
  form.textContent = "";
  let curGroup = "";
  let box = null;
  let grid = null;
  CONFIG_FIELDS.forEach((f) => {
    if (f.hidden) return;
    if (f.group !== curGroup) {
      curGroup = f.group;
      box = document.createElement("div");
      box.className = "config-group-box";
      box.style.order = GROUP_ORDER[f.group] ?? "";
      const title = document.createElement("div");
      title.className = "config-group-title";
      title.textContent = curGroup;
      box.appendChild(title);
      grid = document.createElement("div");
      grid.className = "config-group-grid";
      box.appendChild(grid);
      form.appendChild(box);
    }
    const wrap = document.createElement("div");
    wrap.className = "config-field";
    const label = document.createElement("label");
    label.textContent = f.label;
    const input = document.createElement("input");
    input.id = "cfg-" + f.key;
    input.type = f.type;
    if (f.step) input.step = f.step;
    if (f.readonly) input.readOnly = true;
    if (f.type === "checkbox") {
      input.checked = !!configValues[f.key];
    } else if (configValues[f.key] !== undefined) {
      input.value = configValues[f.key];
    }
    wrap.appendChild(label);
    wrap.appendChild(input);
    if (f.desc) {
      if (f.descBlock) {
        const block = document.createElement("div");
        block.className = "config-desc-block";
        block.textContent = f.desc;
        grid.appendChild(block);
      } else {
        const desc = document.createElement("span");
        desc.className = "hint config-desc";
        desc.title = f.desc;
        const descText = document.createElement("span");
        descText.className = "config-desc-text";
        descText.textContent = f.desc;
        desc.appendChild(descText);
        wrap.appendChild(desc);
      }
    }
    grid.appendChild(wrap);
  });
}

async function loadConfig() {
  if (configLoaded) return;
  try {
    const r = await fetch("/api/config");
    configValues = await r.json();
    buildConfigForm();
    configLoaded = true;
  } catch (e) {
    setMsg("加载配置失败：" + e.message, "err");
  }
}

function setMsg(text, kind) {
  const el = $("#cfgMsg");
  el.textContent = text;
  el.className = "msg" + (kind ? " " + kind : "");
}

$("#cfgSave").addEventListener("click", async () => {
  const patch = {};
  CONFIG_FIELDS.forEach((f) => {
    if (f.readonly || f.hidden) return;
    const el = $("#cfg-" + f.key);
    if (f.type === "checkbox") patch[f.key] = el.checked;
    else if (f.type === "number") patch[f.key] = Number(el.value);
    else patch[f.key] = el.value;
  });
  try {
    const r = await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = await r.json();
    if (!r.ok) {
      setMsg("保存失败：" + (data.error || ""), "err");
      return;
    }
    configValues = data;
    if (Array.isArray(data.rejected) && data.rejected.length) {
      setMsg("已保存（以下字段仅管理员可改，已忽略：" + data.rejected.join(", ") + "）", "ok");
    } else {
      setMsg("已保存", "ok");
    }
  } catch (e) {
    setMsg("保存失败：" + e.message, "err");
  }
});

$("#cfgReset").addEventListener("click", async () => {
  try {
    const r = await fetch("/api/config/reset", { method: "POST" });
    configValues = await r.json();
    buildConfigForm();
    setMsg("已恢复默认", "ok");
  } catch (e) {
    setMsg("重置失败：" + e.message, "err");
  }
});

// 打开「查询扩展」开关时，主动预热扩展模型并提示加载进度
document.addEventListener("change", (e) => {
  const t = e.target;
  if (t && t.id === "cfg-enableQueryExpansion" && t.checked) {
    warmExpansionModel();
  }
});

async function warmExpansionModel() {
  const status = document.getElementById("modelWarmStatus");
  if (!status) return;
  status.hidden = false;
  status.textContent = "正在加载查询扩展模型…（首次可能需下载，请稍候）";
  status.className = "msg";
  try {
    // 先确保配置开关已开启
    await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enableQueryExpansion: true }),
    });
    const r = await fetch("/api/models/warm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "expand" }),
    });
    const data = await r.json().catch(() => ({}));
    if (data.ok) {
      status.textContent = `查询扩展模型已就绪（加载耗时 ${data.ms}ms）`;
      status.className = "msg ok";
    } else {
      status.textContent = "加载失败：" + (data.error || "未知错误");
      status.className = "msg err";
    }
  } catch (e) {
    status.textContent = "加载出错：" + e.message;
    status.className = "msg err";
  }
}

// ---------- index / upload document ----------
async function loadCollections() {
  try {
    const r = await fetch("/api/collections");
    if (!r.ok) return;
    const d = await r.json();
    const list = $("#uCollList");
    if (!list || !Array.isArray(d.collections)) return;
    list.innerHTML = "";
    for (const c of d.collections) {
      const o = document.createElement("option");
      o.value = c.name;
      list.appendChild(o);
    }
  } catch {
    /* dropdown is optional; ignore errors */
  }
}

// ---------- index / built indexes list ----------
async function loadIndexList() {
  const box = $("#idxList");
  if (!box) return;
  try {
    const r = await fetch("/api/collections");
    if (r.status === 401) {
      box.innerHTML = '<div class="muted" style="padding:8px 0">登录已失效，请重新登录后查看索引。</div>';
      return;
    }
    if (!r.ok) {
      box.innerHTML = '<div class="muted" style="padding:8px 0">索引列表加载失败（HTTP ' + r.status + "）。</div>";
      return;
    }
    const d = await r.json();
    const cols = Array.isArray(d.collections) ? d.collections : [];
    if (cols.length === 0) {
      box.innerHTML = '<div class="muted" style="padding:8px 0">暂无已建立的索引。上传文档并建索引后，将在此显示。</div>';
      selectedCollections = [];
      renderActiveCollection();
      return;
    }
    box.innerHTML = "";
    for (const c of cols) {
      const row = document.createElement("div");
      row.className = "idx-row";
      row.dataset.name = c.name;
      const typeLabel = c.type === "wiki" ? "知识库" : "文档集";
      row.dataset.type = c.type === "wiki" ? "wiki" : "raw";
      row.innerHTML =
        '<div class="idx-main">' +
          '<div class="idx-info">' +
            '<div class="idx-title">' +
              '<span class="idx-name">' + esc(c.name) + "</span>" +
              '<span class="badge ' + esc(c.type === "wiki" ? "wiki" : "raw") + '">' + esc(typeLabel) + "</span>" +
              '<span class="idx-check" aria-label="已选中" title="已选中">✓</span>' +
            "</div>" +
            '<div class="idx-sub">' +
              '<span class="stat">文档 ' + (c.docCount ?? 0) + "</span>" +
              '<span class="stat">活跃 ' + (c.activeCount ?? 0) + "</span>" +
            "</div>" +
          "</div>" +
          '<button class="idx-del" type="button" data-act="delete" data-name="' + esc(c.name) + '" aria-label="删除" title="删除该索引">' +
            '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6m3 5v6m4-6v6"/></svg>' +
          "</button>" +
        "</div>" +
        '<div class="idx-docs" hidden></div>';
      box.appendChild(row);
    }
    renderActiveCollection();
  } catch {
    /* ignore */
  }
}

// 「已建立的索引」标题右侧按钮：收起/展开 索引列表（默认展开）
const idxToggleBtn = $("#idxRefresh");
const idxListBox = $("#idxList");
if (idxToggleBtn && idxListBox) {
  idxToggleBtn.addEventListener("click", () => {
    idxListBox.hidden = !idxListBox.hidden;
    idxToggleBtn.textContent = idxListBox.hidden ? "展开" : "收起";
  });
}

// 双击文档行直接打开原文（不再使用「查看原文」按钮）；双击集合卡片 → 展开/收起其文档详情
let idxClickTimer = null;
$("#idxList").addEventListener("dblclick", (e) => {
  // 双击会连带触发两次 click，取消待执行的单击选中，避免选中被切换两次而相互抵消
  if (idxClickTimer) { clearTimeout(idxClickTimer); idxClickTimer = null; }
  const item = e.target.closest(".doc-item");
  if (item) {
    const hash = item.dataset.hash;
    if (hash) openDocModal(hash);
    else toast("该文档暂无原文可预览", "err");
    return;
  }
  if (e.target.closest(".idx-docs")) return;
  const rowEl = e.target.closest(".idx-row");
  if (rowEl) showDetails(rowEl);
});

$("#idxList").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (btn) {
    const name = btn.dataset.name;
    const act = btn.dataset.act;
    if (act === "delete") {
      if (!confirm(`确定要删除索引「${name}」吗？该集合的全部文档与向量将被移除（不可恢复）。`)) return;
      try {
        const r = await fetch(`/api/collections/${encodeURIComponent(name)}`, { method: "DELETE" });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) toast("删除失败：" + (d.error || ""), "err");
        else { toast(`已删除「${name}」（移除 ${d.deletedDocs || 0} 篇文档）`, "ok"); loadIndexList(); loadCollections(); }
      } catch (err) {
        toast("错误：" + err.message, "err");
      }
    } else if (act === "viewdoc") {
      const hash = btn.dataset.hash;
      if (hash) openDocModal(hash);
    }
    return;
  }
  // 单击索引卡片本身（非删除按钮、非展开文档区）→ 仅「选中」该索引；打开详情改为双击
  if (e.target.closest(".idx-docs")) return;
  const rowEl = e.target.closest(".idx-row");
  if (!rowEl) return;
  const name = rowEl.dataset.name;
  if (!name) return;
  // 延后执行：双击时常连发两次 click，若不取消会导致选中被来回切换
  if (idxClickTimer) clearTimeout(idxClickTimer);
  idxClickTimer = setTimeout(() => {
    idxClickTimer = null;
    selectCollection(name);
  }, 220);
});

// 展开/收起某个索引集合的文档详情（点击 ⋮→详情 或 点击索引卡片均可触发）
async function showDetails(rowEl) {
  const panel = rowEl && rowEl.querySelector(".idx-docs");
  if (!panel) return;
  if (!panel.hidden) { panel.hidden = true; panel.innerHTML = ""; return; }
  const name = rowEl.dataset.name;
  if (!name) return;
  panel.hidden = false;
  panel.innerHTML = '<div class="muted">加载中…</div>';
  try {
    // 超时保护：15s 内未响应视为网络异常
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let r;
    try {
      r = await fetch(`/api/collections/${encodeURIComponent(name)}/documents`, { signal: ctrl.signal });
    } catch (netErr) {
      clearTimeout(timer);
      const isTimeout = netErr && netErr.name === "AbortError";
      panel.innerHTML = '<div class="msg err">' + (isTimeout ? "请求超时，请检查网络或稍后重试" : esc((netErr && netErr.message) || "网络请求失败")) + "</div>";
      return;
    }
    clearTimeout(timer);
    // 权限/令牌失效：提示并回到登录态
    if (r.status === 401) {
      localStorage.removeItem("qmd_token");
      setLoggedInUI("");
      showLogin(true);
      panel.innerHTML = '<div class="msg err">无权限查看该索引详情，请重新登录。</div>';
      return;
    }
    if (!r.ok) {
      let msg = "详情加载失败（HTTP " + r.status + "）";
      try { const d = await r.json(); if (d && d.error) msg = d.error; } catch {}
      panel.innerHTML = '<div class="msg err">' + esc(msg) + "</div>";
      return;
    }
    const d = await r.json().catch(() => ({}));
    const docs = Array.isArray(d.documents) ? d.documents : [];
    if (docs.length === 0) {
      panel.innerHTML = '<div class="muted">该集合暂无已建索引的文档（可能文档尚未完成索引）。</div>';
      return;
    }
    panel.innerHTML = "";
    for (const doc of docs) {
      const el = document.createElement("div");
      el.className = "doc-item";
      const mt = doc.modifiedAt ? new Date(doc.modifiedAt).toLocaleString() : "—";
      const baseName = (doc.path || "").split("/").pop() || doc.path || "（未命名）";
      const baseNoExt = baseName.replace(/\.[^./\\]+$/, "");
      const norm = (s) => (s || "").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
      const tN = norm(doc.title), fN = norm(baseNoExt);
      const sameName = !!doc.title && tN !== "" && fN !== "" && (tN === fN || fN.includes(tN) || tN.includes(fN));
      const hash = doc.hash || "";
      el.dataset.hash = hash;
      el.innerHTML =
        '<div class="doc-meta">' +
          '<span class="doc-title">' + esc(baseName) + "</span>" +
          (sameName ? "" : '<span class="muted">' + esc(doc.title || "") + "</span>") +
          '<span class="muted">分块 ' + (doc.chunks ?? 0) + " · " + esc(mt) + "</span>" +
        "</div>" +
        (hash ? "" : '<span class="muted">（无原文）</span>');
      panel.appendChild(el);
    }
  } catch (err) {
    panel.innerHTML = '<div class="msg err">' + esc((err && err.message) || "未知错误") + "</div>";
  }
}

// 选中某个已建索引后，右侧问答即针对该索引；支持多选（可同时选中文档集与知识库）
function selectCollection(name) {
  const i = selectedCollections.indexOf(name);
  if (i >= 0) selectedCollections.splice(i, 1); // 再次点击取消选中
  else selectedCollections.push(name);
  renderActiveCollection();
  if (selectedCollections.length) {
    const q = $("#qInput");
    if (q) q.focus();
  }
}
// 把已选集合渲染为带类型说明的文案：文档集(raw)→「raw文档集xxx」，知识库(wiki)→「wiki知识库xxx」
function activeCollectionLabel() {
  // 返回带类型色彩的 chip（与集合列表徽标同色）：wiki=紫、文档集=灰
  // 以 selectedCollections 为唯一数据源，保证与最新选中状态一致（不再依赖 .active 类）
  return selectedCollections
    .map((n) => {
      const isWiki = collectionTypeOf(n) === "wiki";
      const text = isWiki ? `wiki知识库${n}` : `raw文档集${n}`;
      return `<span class="qa-ah-chip ${isWiki ? "wiki" : "raw"}">${esc(text)}</span>`;
    })
    .join("");
}
// 选中问答索引后，在输入框内显示「当前问答索引 {名称} ✕」（✕ 为灰色小叉，点击清除）
// 快捷提问：仅在「同时选中 wiki 知识库 + raw 文档集」（混合模式）时出现
function updateQuickPrompts() {
  const box = $("#qaQuick");
  if (!box) return;
  box.hidden = derivedMode() !== "hybrid";
}
if ($("#qaQuickReview")) {
  $("#qaQuickReview").addEventListener("click", () => {
    const el = $("#qInput");
    if (!el) return;
    el.value = "帮我审查一下这个合同。";
    el.focus();
    updateReviewIntentUi(); // 立即把发送按钮切换为「开始风险审查」形态
  });
}

function renderActiveCollection() {
  // 先同步卡片选中态，再生成提示文案，确保两者基于同一次选中结果
  document.querySelectorAll("#idxList .idx-row").forEach((r) => {
    r.classList.toggle("active", selectedCollections.includes(r.dataset.name));
  });
  const hint = $("#qaActiveHint");
  const nm = $("#qaActiveName");
  if (selectedCollections.length) {
    if (nm) nm.innerHTML = activeCollectionLabel();
    if (hint) hint.hidden = false;
  } else {
    if (nm) nm.textContent = "";
    if (hint) hint.hidden = true;
  }
  updateQuickPrompts(); // 选中变化后刷新快捷提问的显隐
}
// 输入框内灰色小叉：清除当前问答索引，并提示已清除
$("#qaActiveClear").addEventListener("click", () => {
  const cleared = selectedCollections.join("、");
  selectedCollections = [];
  renderActiveCollection();
  if (cleared) toast("已清除问答索引 " + cleared, "ok");
});

async function openDocModal(hash) {
  const modal = $("#docModal");
  const title = $("#docModalTitle");
  const body = $("#docModalBody");
  if (!modal || !title || !body) return;
  title.textContent = "原文";
  body.textContent = "加载中…";
  modal.hidden = false;
  try {
    const r = await fetch(`/api/content/${encodeURIComponent(hash)}`);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) body.textContent = "加载失败：" + (d.error || r.status);
    else body.textContent = d.text || "（空）";
  } catch (err) {
    body.textContent = "错误：" + err.message;
  }
}

$("#docModalClose").addEventListener("click", () => { const m = $("#docModal"); if (m) m.hidden = true; });
if ($("#docModal")) {
  $("#docModal").addEventListener("click", (e) => { if (e.target === $("#docModal")) $("#docModal").hidden = true; });
}

// 上传文档弹窗：点「上传文档」按钮弹出，里面是上传前配置（集合 + 文件 + 自动建索引）
const uploadModal = $("#uploadModal");
const uploadOpenBtn = $("#uploadOpenBtn");
const uploadModalClose = $("#uploadModalClose");
let uConfirmed = false;   // 已对冲突做过选择，避免重复弹确认
let uNameTouched = false; // 用户是否手动改过集合名（决定选文件时是否覆盖建议名）
if (uploadOpenBtn) uploadOpenBtn.addEventListener("click", () => {
  uConfirmed = false;
  uNameTouched = false;
  resetContractType(); // 每次打开弹窗回到默认合同类型（总包合同）
  const warn = $("#uWarn"); if (warn) warn.hidden = true;
  const btn = $("#uBtn"); if (btn) btn.hidden = false;
  if (uploadModal) {
    uploadModal.hidden = false;
    const m = document.getElementById("uResult"); if (m) m.hidden = true;
    const p = document.getElementById("uProgress"); if (p) p.hidden = true;
    const b = document.getElementById("uBtn"); if (b) b.disabled = false;
  }
});
if (uploadModalClose) uploadModalClose.addEventListener("click", () => { if (uploadModal) uploadModal.hidden = true; });
if (uploadModal) {
  uploadModal.addEventListener("click", (e) => { if (e.target === uploadModal) uploadModal.hidden = true; });
}

// ---------- 合同类型（高级配置）：总包合同 / 分包分供合同 / 其他类合同 ----------
// 「其他类合同」必须二级明确到具体合同类别；清单与《合同类别》对照表保持一致，
// 用于后续按合同类型匹配各自的审查规则集（当前统一使用默认规则集）。
const OTHER_CONTRACT_TYPE_GROUPS = [
  { group: "金融财税类", items: ["融资合同", "担保合同", "保险合同", "保理合同", "常年税务顾问合同", "财税相关服务合同", "评估合同", "债权转让协议", "还款协议"] },
  { group: "债务处置类", items: ["以房/物抵债协议"] },
  { group: "战略合作与联合体类", items: ["战略合作协议", "标前联合体协议", "标后施工联合体协议", "标后EPC联合体协议"] },
  { group: "法律事务类", items: ["常年法律顾问聘用合同", "律师代理合同", "专项法律服务合同", "涉诉和解协议"] },
  { group: "办公与后勤类", items: ["房屋租赁合同", "车辆租赁合同", "物业服务", "印控设备采购", "办公家具采购", "食堂采购", "总部办公驻地修缮美化"] },
  { group: "投资与股权类", items: ["投资类合同（含内部经济责任书）", "股权收购合同", "股权转让合同"] },
  { group: "技术与知识产权类", items: ["技术服务合同", "专利相关协议"] },
  { group: "人力与校企合作类", items: ["校企合作协议", "劳务派遣协议", "培训合同", "招聘合同", "劳动合同"] },
  { group: "信息化与科研类", items: ["信息化建设", "信息化咨询", "软件（插件）服务合同", "课题研究、科技研发等事项需签订的各类合同"] },
  { group: "宣传与品牌类", items: ["宣传视频制作合同（视频动画、画册、宣传册、折页等）"] },
];

let uContractType = "general";      // 已确认的合同类型：general / subcontract / other
let uOtherContractType = "";        // 「其他类合同」下已确认的具体类别

const uploadOtherType = $("#uploadOtherType");

function contractTypeRadio() {
  return document.querySelector('input[name="uContractType"]:checked');
}
function selectContractTypeRadio(value) {
  const el = document.querySelector(`input[name="uContractType"][value="${value}"]`);
  if (el) el.checked = true;
}
function updateContractTypeDesc() {
  const desc = $("#uOtherTypeDesc");
  if (desc) desc.textContent = uOtherContractType ? `已选：${uOtherContractType}` : "选择后请在下拉框中明确具体类别";
}
function updateUploadOtherCurrent() {
  const el = $("#uploadOtherTypeCurrent");
  if (el) el.textContent = uOtherContractType ? uOtherContractType : "尚未选择";
}
function setUploadOtherError(text) {
  const err = $("#uploadOtherTypeError");
  if (!err) return;
  err.hidden = !text;
  err.textContent = text || "";
}
function showUploadOtherType(show) {
  if (uploadOtherType) uploadOtherType.hidden = !show;
  if (!show) setUploadOtherError("");
}
// 「其他类合同」选中后，用下拉选择框（按 optgroup 分组）明确具体类别
function renderUploadOtherTypeSelect() {
  const sel = $("#uploadOtherTypeSelect");
  if (!sel) return;
  const html = ['<option value="">请选择具体类别…</option>']
    .concat(
      OTHER_CONTRACT_TYPE_GROUPS.map(
        (g) =>
          `<optgroup label="${esc(g.group)}">${g.items
            .map(
              (it) =>
                `<option value="${esc(it)}"${it === uOtherContractType ? " selected" : ""}>${esc(it)}</option>`
            )
            .join("")}</optgroup>`
      )
    )
    .join("");
  sel.innerHTML = html;
  sel.value = uOtherContractType || "";
  updateUploadOtherCurrent();
}
function resetContractType() {
  uContractType = "general";
  uOtherContractType = "";
  selectContractTypeRadio("general");
  updateContractTypeDesc();
  showUploadOtherType(false);
}

document.querySelectorAll('input[name="uContractType"]').forEach((el) => {
  el.addEventListener("change", () => {
    if (el.value === "other") {
      uContractType = "other";
      updateContractTypeDesc();
      showUploadOtherType(true);
      renderUploadOtherTypeSelect();
      const sel = $("#uploadOtherTypeSelect");
      if (sel) sel.focus();
      return;
    }
    uContractType = el.value;
    uOtherContractType = "";
    updateContractTypeDesc();
    showUploadOtherType(false);
  });
});
// 在下拉框中选择具体类别
if ($("#uploadOtherTypeSelect")) {
  $("#uploadOtherTypeSelect").addEventListener("change", (e) => {
    uOtherContractType = (e.target && e.target.value) || "";
    updateContractTypeDesc();
    updateUploadOtherCurrent();
    setUploadOtherError("");
  });
}

// 用户手动改集合名 / 选文件时：重置"已确认"状态，并在未手改时自动建议集合名
if ($("#uCollection")) {
  $("#uCollection").addEventListener("input", () => { uNameTouched = true; uConfirmed = false; });
}
if ($("#uFile")) {
  $("#uFile").addEventListener("change", () => {
    uConfirmed = false;
    const el = $("#uCollection");
    if (el && !uNameTouched) {
      const sug = ruSuggestedName($("#uFile"));
      if (sug) el.value = sug;
    }
  });
}

async function doUploadDocuments(collection, auto, indexType, fileEl) {
  const msg = $("#uResult"); const prog = $("#uProgress");
  const fd = new FormData();
  for (const f of fileEl.files) fd.append("file", f);
  fd.append("collection", collection);
  fd.append("autoIndex", auto ? "true" : "false");
  fd.append("indexType", indexType);
  const upTags = [...document.querySelectorAll("#uploadTags input:checked")].map((c) => c.value);
  if (upTags.length) fd.append("tags", upTags.join(","));
  // 合同类型（高级配置）；「其他类合同」同时提交二级明确的具体类别
  const ctEl = contractTypeRadio();
  const ctValue = (ctEl && ctEl.value) || uContractType;
  fd.append("contractType", ctValue);
  if (ctValue === "other" && uOtherContractType) fd.append("contractSubtype", uOtherContractType);
  const cSize = parseInt($("#uChunkSize").value, 10);
  const cOverlap = parseFloat($("#uChunkOverlap").value);
  const cWindow = parseInt($("#uChunkWindow").value, 10);
  if (!Number.isNaN(cSize)) fd.append("chunkSizeTokens", String(cSize));
  if (!Number.isNaN(cOverlap)) fd.append("chunkOverlapRatio", String(cOverlap));
  if (!Number.isNaN(cWindow)) fd.append("chunkWindowTokens", String(cWindow));
  msg.hidden = false; msg.className = "msg"; msg.textContent = "上传中…";
  prog.hidden = false; $("#uBtn").disabled = true;
  const startedAt = Date.now();
  const tick = setInterval(() => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    prog.textContent = `已等待 ${s} 秒（首次会下载/加载嵌入模型，可能较久）`;
  }, 1000);
  try {
    const r = await fetch("/api/documents", { method: "POST", body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      msg.className = "msg err";
      msg.textContent = "上传失败：" + (d.error || r.status);
    } else {
      const fileList = Array.isArray(d.files) ? d.files : [];
      const failed = fileList.filter((f) => f.error || f.warning);
      if (failed.length) {
        msg.className = "msg err";
        msg.textContent = "部分文件未建索引：" + failed.map((f) => `${f.file}（${f.error || f.warning}）`).join("；");
        if (uploadModal) uploadModal.hidden = true;
      } else {
        const names = fileList.map((f) => f.file).join("、");
        const verb = d.autoIndex ? "已上传并建索引" : "已上传（未建索引）";
        toast(`${verb} →「${d.collection}」：${names}`, "ok");
        msg.hidden = true;
        if (uploadModal) uploadModal.hidden = true;
      }
    }
  } catch (e) {
    msg.className = "msg err";
    msg.textContent = "错误：" + e.message;
  } finally {
    clearInterval(tick);
    prog.hidden = true;
    $("#uBtn").disabled = false;
    loadIndexList();
  }
}

$("#uBtn").addEventListener("click", async () => {
  const fileEl = $("#uFile");
  const collection = $("#uCollection").value.trim();
  const auto = $("#uAuto").checked;
  const indexTypeEl = document.querySelector('input[name="uIndexType"]:checked');
  const indexType = (indexTypeEl && indexTypeEl.value) || "raw";
  const msg = $("#uResult");

  // 集合名前端预校验（规则与后端一致），避免提交后才收到服务端报错
  if (collection && !/^[a-zA-Z0-9_-]+$/.test(collection)) {
    msg.hidden = false;
    msg.className = "msg err";
    msg.textContent = `集合名称仅支持字母、数字、- 和 _（当前：${collection}）；请选择文件自动生成，或改用合规名称`;
    return;
  }

  // 合同类型：选了「其他类合同」却没在下拉框里明确具体类别 → 提示并定位到下拉框
  const ctEl = contractTypeRadio();
  const ctValue = (ctEl && ctEl.value) || uContractType;
  if (ctValue === "other" && !uOtherContractType) {
    showUploadOtherType(true);
    renderUploadOtherTypeSelect();
    setUploadOtherError("请先为「其他类合同」明确具体的合同类别（必选）");
    msg.hidden = false; msg.className = "msg err"; msg.textContent = "请先为「其他类合同」明确具体的合同类别（见下方下拉框）";
    const sel = $("#uploadOtherTypeSelect");
    if (sel) sel.focus();
    return;
  }

  // 读取索引配置（分块参数）
  const cSize = parseInt($("#uChunkSize").value, 10);
  const cOverlap = parseFloat($("#uChunkOverlap").value);
  const cWindow = parseInt($("#uChunkWindow").value, 10);
  if (Number.isNaN(cSize) || cSize < 100) {
    msg.hidden = false; msg.className = "msg err"; msg.textContent = "分块大小必须为不小于 100 的整数";
    return;
  }
  if (Number.isNaN(cOverlap) || cOverlap < 0 || cOverlap > 0.9) {
    msg.hidden = false; msg.className = "msg err"; msg.textContent = "分块重叠需为 0~0.9 之间的数值";
    return;
  }
  if (Number.isNaN(cWindow) || cWindow < 1) {
    msg.hidden = false; msg.className = "msg err"; msg.textContent = "断点窗口必须为不小于 1 的整数";
    return;
  }
  if (!fileEl.files || fileEl.files.length === 0) {
    msg.hidden = false; msg.className = "msg err"; msg.textContent = "请先选择一个文档";
    return;
  }
  if (!collection) {
    msg.hidden = false; msg.className = "msg err"; msg.textContent = "请填写集合名称（或先选择文件以自动建议）";
    return;
  }
  // 已确认过（点了警告里的某个按钮）则直接上传
  if (uConfirmed) { await doUploadDocuments(collection, auto, indexType, fileEl); return; }

  const meta = await ruCollectionMeta(collection);
  // 1) wiki 拦截：目标是 wiki 知识库集合，却以 raw 类型上传 → 会把它翻成 raw 并污染知识库
  if (meta && meta.type === "wiki" && indexType !== "wiki") {
    msg.hidden = false; msg.className = "msg err";
    msg.textContent = `「${collection}」是 wiki 知识库集合。若以 raw 类型上传，会把它改成 raw 并污染知识库。如需往里加 wiki 页，请把"集合类型"选为 wiki；否则换一个集合名。`;
    return;
  }
  // 2) 冲突确认：目标集合已有文档 → 弹确认，避免与已有内容合并检索
  const existing = (meta?.activeCount ?? meta?.docCount ?? 0);
  if (existing > 0) {
    const warn = $("#uWarn"); const warnText = $("#uWarnText");
    if (warn && warnText) {
      warnText.textContent = `集合「${collection}」已有 ${existing} 份文档。新文档会与它们合并在同一集合里被检索/审查，可能影响结果隔离。建议新建独立集合。`;
      warn.hidden = false;
      const btn = $("#uBtn"); if (btn) btn.hidden = true;
    } else {
      await doUploadDocuments(collection, auto, indexType, fileEl); // 兜底：无警告 UI 时直接上传
    }
    return;
  }
  await doUploadDocuments(collection, auto, indexType, fileEl);
});

// 冲突确认：仍要加入
if ($("#uWarnJoin")) {
  $("#uWarnJoin").addEventListener("click", async () => {
    const warn = $("#uWarn"); if (warn) warn.hidden = true;
    const btn = $("#uBtn"); if (btn) btn.hidden = false;
    uConfirmed = true;
    const auto = $("#uAuto").checked;
    const indexTypeEl = document.querySelector('input[name="uIndexType"]:checked');
    const indexType = (indexTypeEl && indexTypeEl.value) || "raw";
    await doUploadDocuments(($("#uCollection").value || "").trim(), auto, indexType, $("#uFile"));
  });
}
// 冲突确认：新建独立集合后上传
if ($("#uWarnNew")) {
  $("#uWarnNew").addEventListener("click", async () => {
    const warn = $("#uWarn"); if (warn) warn.hidden = true;
    const btn = $("#uBtn"); if (btn) btn.hidden = false;
    const el = $("#uCollection");
    let name = ruSuggestedName($("#uFile")) || ((sanitizeCollectionName($("#uCollection").value) || "collection") + "-new");
    const names = (await ruCollections()).map((c) => c.name);
    let cand = name, i = 2;
    while (names.includes(cand)) cand = `${name}-${i++}`;
    if (el) el.value = cand;
    uConfirmed = true;
    const auto = $("#uAuto").checked;
    const indexTypeEl = document.querySelector('input[name="uIndexType"]:checked');
    const indexType = (indexTypeEl && indexTypeEl.value) || "raw";
    await doUploadDocuments(cand, auto, indexType, $("#uFile"));
  });
}

// ---------- 合同审查（集成到问答区，替代独立的合同审查页面） ----------
let reviewAbort = null;

// 极简 markdown 渲染器（兜底 / 报告的非风险卡部分），支持标题/列表/引用/表格
function renderMarkdownSimple(md) {
  const lines = esc(md).split("\n");
  let html = "";
  let i = 0;
  let inList = false;
  const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };
  const bold = (s) => s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  const isTableRow = (s) => /^\s*\|.*\|\s*$/.test(s);
  const isTableSep = (s) => /^\s*\|[\s:|-]+\|\s*$/.test(s);
  while (i < lines.length) {
    const raw = lines[i];
    if (isTableRow(raw) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      closeList();
      const header = raw.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
      i += 2; // 跳过表头与分隔行
      let rows = "";
      while (i < lines.length && isTableRow(lines[i])) {
        const cells = lines[i].replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
        rows += "<tr>" + cells.map((c) => `<td>${bold(c)}</td>`).join("") + "</tr>";
        i++;
      }
      html += `<table class="md-table"><thead><tr>${header.map((c) => `<th>${bold(c)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>`;
      continue;
    }
    if (/^\s*#\s/.test(raw)) { closeList(); html += `<h2>${raw.replace(/^#\s/, "")}</h2>`; }
    else if (/^\s*##\s/.test(raw)) { closeList(); html += `<h3>${raw.replace(/^##\s/, "")}</h3>`; }
    else if (/^\s*###\s/.test(raw)) { closeList(); html += `<h4>${raw.replace(/^###\s/, "")}</h4>`; }
    else if (/^\s*>\s?/.test(raw)) { closeList(); html += `<blockquote>${bold(raw.replace(/^\s*>\s?/, ""))}</blockquote>`; }
    else if (/^\s*[-*]\s/.test(raw)) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${bold(raw.replace(/^\s*[-*]\s/, ""))}</li>`; }
    else if (/^\s*\d+\.\s/.test(raw)) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${bold(raw.replace(/^\s*\d+\.\s/, ""))}</li>`; }
    else if (raw.trim() === "") { closeList(); }
    else { closeList(); html += `<p>${bold(raw)}</p>`; }
    i++;
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

// ===== 第三部分「总体评价与谈判优先级」专用美化渲染（参照第一/第二部分卡片与徽章风格）=====
const ovSevClass = (s) => ({ 高: "high", 中: "mid", 低: "low" }[s] || "na");
const mdBold = (s) => String(s == null ? "" : s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

// 渲染一组 markdown 表格行（表头 + 分隔行 + 数据行），可选把某列渲染为风险等级徽章
function renderMdTableLines(tableLines, opts) {
  const rows = tableLines
    .filter((l) => /^\s*\|/.test(l))
    .map((l) => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim()));
  if (rows.length < 3) return "";
  const header = rows[0];
  const body = rows.slice(2);
  const sevCol = opts && opts.severityCol;
  const bodyHtml = body
    .map((r) => "<tr>" + r.map((c, ci) => {
      if (sevCol != null && ci === sevCol) return `<td><span class="sev-badge sev-${ovSevClass(c)}">${esc(c)}</span></td>`;
      return `<td>${mdBold(esc(c))}</td>`;
    }).join("") + "</tr>")
    .join("");
  return `<table class="md-table"><thead><tr>${header.map((c) => `<th>${mdBold(esc(c))}</th>`).join("")}</tr></thead><tbody>${bodyHtml}</tbody></table>`;
}

// 解析「标题 + 缩进 - key：value」的定义式条目（如底线条款 / 审批提示 / TOP5 详情）
function parseDefItems(lines) {
  const items = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const sub = line.match(/^\s*[-*]\s+(.+?)\s*[：:]\s*(.*)$/);
    if (sub && cur) { cur.details.push({ k: sub[1].trim(), v: sub[2].trim() }); continue; }
    if (!/^\s*[-*]\s/.test(line)) {
      const m = line.match(/^\s*(?:\d+\.\s+)?(.+)$/);
      if (m) { cur = { title: m[1].trim(), details: [] }; items.push(cur); }
    }
  }
  return items;
}

function renderDefItems(lines, opts) {
  const items = parseDefItems(lines);
  const accent = opts && opts.accent === "red" ? " ov-card--red" : opts && opts.accent === "approval" ? " ov-card--appr" : opts && opts.accent === "trig" ? " ov-card--trig" : "";
  let html = "";
  for (const it of items) {
    const sev = (it.details.find((d) => d.k.includes("风险等级")) || {}).v || "";
    html += `<div class="ov-def${accent}">`;
    html += `<div class="ov-def-head"><span class="ov-def-title">${mdBold(esc(it.title))}</span>${sev ? `<span class="sev-badge sev-${ovSevClass(sev)}">${esc(sev)}</span>` : ""}</div>`;
    if (it.details.length) {
      html += `<details class="ov-def-details"><summary>展开明细</summary><div class="ov-def-body">`;
      for (const d of it.details) html += `<div class="ov-def-row"><b>${esc(d.k)}：</b>${mdBold(esc(d.v))}</div>`;
      html += `</div></details>`;
    }
    html += `</div>`;
  }
  return html;
}

// 谈判优先级三档：每档一个标题（**...**）+ 一张矩阵表
function renderPriority(lines) {
  let html = "";
  const blocks = [];
  let curTitle = null, curTable = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim().startsWith(">")) { html += `<div class="ov-callout">${mdBold(esc(line.replace(/^>\s?/, "")))}</div>`; continue; }
    const t = line.match(/^\*\*(.+?)\*\*$/);
    if (t) { if (curTitle) blocks.push({ title: curTitle, table: curTable }); curTitle = t[1]; curTable = []; }
    else if (/^\s*\|/.test(line) && curTitle) curTable.push(line);
  }
  if (curTitle) blocks.push({ title: curTitle, table: curTable });
  const tierClass = (title) => (title.includes("第一") ? "1" : title.includes("第二") ? "2" : title.includes("第三") ? "3" : "x");
  for (const b of blocks) {
    const tc = tierClass(b.title);
    const badge = tc === "1" ? "P1" : tc === "2" ? "P2" : tc === "3" ? "P3" : "";
    html += `<div class="ov-tier ov-tier--${tc}"><div class="ov-tier-head"><span class="ov-tier-badge">${badge}</span><span>${esc(b.title)}</span></div><div class="ov-tier-body">${b.table.length ? renderMdTableLines(b.table) : ""}</div></div>`;
  }
  return html;
}

// ===== 兼容旧版「条目式」Part 3（无 ### 子标题，用普通文本行区分区块）=====
// 旧版核心风险清单： 1. 【name】——高风险：text
function renderOldTopItems(lines) {
  const items = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const m = line.match(/^\d+\.\s*【(.+?)】\s*——\s*(?:(高|中|低)风险[：:]\s*)?([\s\S]+)$/);
    if (m) items.push({ name: m[1].trim(), sev: m[2] ? m[2] + "风险" : "", text: m[3].trim() });
  }
  if (!items.length) return "";
  return `<div class="ov-card ov-top5"><div class="ov-card-title">📊 TOP5 核心风险</div>` +
    items.map((it) => `<div class="ov-def ov-card--trig"><div class="ov-def-head"><span class="ov-def-title">【${esc(it.name)}】</span><span class="sev-badge sev-${ovSevClass(it.sev)}">${esc(it.sev)}</span></div><div class="ov-def-text">${mdBold(esc(it.text))}</div></div>`).join("") +
    `</div>`;
}

// 旧版底线条款 / 审批提示： 底线条款N：【name】——text  /  提示N：【name】——text
function renderOldBulletCards(lines, kind) {
  const re = kind === "bottom" ? /^底线条款\d+\s*：【(.*)】\s*——\s*([\s\S]+)$/ : /^提示\d+\s*：【(.*)】\s*——\s*([\s\S]+)$/;
  const items = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const m = line.match(re);
    if (m) {
      const head = (line.match(/^.*?【/)?.[0] || "").replace(/【$/, "");
      items.push({ head, name: m[1].trim(), text: m[2].trim() });
    }
  }
  if (!items.length) return "";
  const accent = kind === "bottom" ? " ov-card--red" : " ov-card--appr";
  return items.map((it) => `<div class="ov-def${accent}"><div class="ov-def-head"><span class="ov-def-title">${esc(it.head)}【${esc(it.name)}】</span></div><div class="ov-def-text">${mdBold(esc(it.text))}</div></div>`).join("");
}

// 旧版谈判优先级： 第一/二/三优先级 分档 + 编号条目 M-N：text
function renderOldPriority(lines) {
  const tiers = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const tm = line.match(/^(第一|第二|第三)优先级[（(](.+?)[)）][：:]?$/);
    if (tm) { if (cur) tiers.push(cur); cur = { label: tm[0].replace(/[：:]$/, ""), items: [] }; continue; }
    const im = line.match(/^\d+-\d+\s*[：:]\s*([\s\S]+)$/);
    if (im && cur) cur.items.push(im[1].trim());
  }
  if (cur) tiers.push(cur);
  const tierClass = (label) => (label.includes("第一") ? "1" : label.includes("第二") ? "2" : label.includes("第三") ? "3" : "x");
  let html = "";
  for (const t of tiers) {
    const tc = tierClass(t.label);
    const badge = tc === "1" ? "P1" : tc === "2" ? "P2" : tc === "3" ? "P3" : "";
    html += `<div class="ov-tier ov-tier--${tc}"><div class="ov-tier-head"><span class="ov-tier-badge">${badge}</span><span>${esc(t.label)}</span></div><div class="ov-tier-body"><ul class="ov-tier-list">${t.items.map((i) => `<li>${mdBold(esc(i))}</li>`).join("")}</ul></div></div>`;
  }
  return html;
}

// 第三部分总渲染：同时兼容「新版（### 子标题 + 表格）」与「旧版（纯文本行分区）」两种结构
const OV_SECTION_RE = /^(###\s+.*|总体风险评级.*|核心风险清单.*|必须修改的底线条款.*|谈判优先级[^。]*|内部审批提示.*)$/;
function renderOverall(md) {
  const safe = String(md == null ? "" : md);
  const lines = safe.split("\n");
  const sections = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (OV_SECTION_RE.test(line.trim())) {
      if (cur) sections.push(cur);
      cur = { title: line.trim().replace(/^###\s+/, ""), lines: [] };
      continue;
    }
    if (cur) cur.lines.push(line); else sections.push({ title: "", lines: [line] });
  }
  if (cur) sections.push(cur);

  const hasDefItems = (b) => b.some((l) => /^\s+[-*]\s/.test(l));
  const out = [];
  for (const sec of sections) {
    const t = sec.title;
    const body = sec.lines;
    if (!t) { out.push(renderMarkdownSimple(body.join("\n"))); continue; }
    if (t.includes("总体风险评级")) {
      let rating = "";
      const ownLine = body.find((l) => /^\*\*.+\*\*$/.test(l.trim()));
      if (ownLine) rating = ownLine.replace(/^\*\*/, "").replace(/\*\*$/, "").trim();
      else {
        const full = t + "\n" + body.join("\n");
        const inline = full.match(/\*\*(.+?)\*\*/);
        if (inline) rating = inline[1].trim();
        else if (/高风险/.test(full)) rating = "高风险";
        else if (/中风险/.test(full)) rating = "中风险";
        else if (/低风险/.test(full)) rating = "低风险";
      }
      const rc = /高/.test(rating) ? "high" : /中/.test(rating) ? "mid" : /低/.test(rating) ? "low" : "na";
      out.push(`<div class="ov-rating ov-rating--${rc}"><span class="ov-rating-label">总体风险评级</span><span class="ov-rating-level">${esc(rating || "未评定")}</span></div>`);
      continue;
    }
    if (t.includes("评价模型说明")) {
      const items = [];
      for (const l of body) { const m = l.match(/^\s*[-*]\s+\*\*(.+?)\*\*[：:]\s*(.*)$/); if (m) items.push({ k: m[1], v: m[2] }); }
      const icon = { "输入": "📥", "输出": "📤", "关键参数": "⚙️" };
      out.push(`<div class="ov-model">` + items.map((it) => `<div class="ov-model-cell"><div class="ov-model-icon">${icon[it.k] || "•"}</div><div class="ov-model-k">${esc(it.k)}</div><div class="ov-model-v">${mdBold(esc(it.v))}</div></div>`).join("") + `</div>`);
      continue;
    }
    if (t.includes("核心风险清单")) {
      const table = body.filter((l) => /^\s*\|/.test(l));
      if (table.length) {
        out.push(`<div class="ov-card ov-top5"><div class="ov-card-title">📊 TOP5 核心风险对比</div>${renderMdTableLines(table, { severityCol: 3 })}</div>` + renderDefItems(body.filter((l) => !/^\s*\|/.test(l)), { accent: "trig" }));
      } else {
        const r = renderOldTopItems(body);
        out.push(r || renderMarkdownSimple(body.join("\n")));
      }
      continue;
    }
    if (t.includes("底线条款")) {
      if (hasDefItems(body)) out.push(`<div class="ov-section-head ov-head-red">🚫 必须修改的底线条款（不改不签）</div>` + renderDefItems(body, { accent: "red" }));
      else { const r = renderOldBulletCards(body, "bottom"); out.push(`<div class="ov-section-head ov-head-red">🚫 必须修改的底线条款（不改不签）</div>` + (r || renderMarkdownSimple(body.join("\n")))); }
      continue;
    }
    if (t.includes("谈判优先级")) {
      const table = body.filter((l) => /^\s*\|/.test(l));
      out.push(table.length ? renderPriority(body) : (renderOldPriority(body) || renderMarkdownSimple(body.join("\n"))));
      continue;
    }
    if (t.includes("内部审批")) {
      if (hasDefItems(body)) out.push(`<div class="ov-section-head">📋 内部审批提示</div>` + renderDefItems(body, { accent: "approval" }));
      else { const r = renderOldBulletCards(body, "approval"); out.push(`<div class="ov-section-head">📋 内部审批提示</div>` + (r || renderMarkdownSimple(body.join("\n")))); }
      continue;
    }
    out.push(`<h3>${esc(t)}</h3>` + renderMarkdownSimple(body.join("\n")));
  }
  return out.join("");
}

// 合同审查报告渲染：把程序化生成的 markdown 转换为
// 「主要风险点突出 + 每条可追溯 + 其它分析/根源信息默认折叠」的呈现。
// composeReport 输出结构确定，可稳定解析；非标准 markdown 走极简渲染兜底。
let reportRenderSeq = 0;
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
    if (line.startsWith("# ")) continue; // 报告总标题单独渲染
    if (/^>\s?/.test(line)) { meta = line.replace(/^>\s?/, ""); continue; }
    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) {
      const t = h2[1];
      pushFinding();
      if (t.includes("第一部分")) { bucket = "project"; continue; }
      if (t.includes("第二部分")) { bucket = "findings"; continue; }
      if (t.includes("特殊情形")) { bucket = "special"; continue; }
      if (t.includes("第三部分")) { bucket = "overall"; continue; }
      if (bucket === "findings") { curCat = t; continue; } // 分类标题
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
      continue; // findings 区域内其它行忽略
    }
    buckets[bucket].push(line);
  }
  pushFinding();

  // 不适用 / 未在合同中找到相关约定：主聊天框保持静默，仅后台记录（分析记录中仍保留完整信息）
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

  // 第一部分：项目基本信息提取（条目式）—— 前置呈现
  if (buckets.project.length) {
    html += `<section class="report-part part-first"><h2>第一部分：项目基本信息提取</h2>` + renderProjectInfo(buckets.project.join("\n")) + `</section>`;
  }

  // 第二部分：主要风险点概览 + 逐项风险卡
  let part2 = "";
  if (visibleFindings.length) {
    const ordered = [...visibleFindings].sort(
      (a, b) => (a.status === "已触发" ? 0 : 1) - (b.status === "已触发" ? 0 : 1),
    );
    part2 += `<div class="risk-overview"><div class="ro-head">主要风险点概览 · 已触发 ${triggeredCount} / 共 ${visibleFindings.length} 项</div><div class="ro-chips">`;
    for (const f of ordered) {
      const active = f.status === "已触发" ? " ro-active" : "";
      part2 += `<a class="ro-chip${active}" href="#${prefix}-risk-${f.idx}"><span class="sev-badge sev-${sevClass(f.severity)}">${e(f.severity)}</span>${e(f.name)}</a>`;
    }
    part2 += `</div></div>`;

    // 逐项风险卡：原文摘录常显（可追溯），风险解析/修改建议/依据默认折叠
    part2 += `<div class="risk-cards">`;
    for (const f of visibleFindings) {
      const trig = f.status === "已触发" ? " rc-triggered" : f.status === "未触发" ? " rc-notrigger" : "";
      part2 += `<div class="risk-card${trig}" id="${prefix}-risk-${f.idx}">`;
      part2 += `<div class="rc-head"><span class="rc-idx">第${e(f.idx)}项</span><span class="rc-name">${e(f.name)}</span><span class="sev-badge sev-${sevClass(f.severity)}">${e(f.severity)}</span><span class="rc-status s-${statusClass(f.status)}">${e(f.status)}</span><span class="rc-rule">清单 ${e(f.ruleId)}</span></div>`;
      const locBtn = f.excerptDocHash
        ? `<button type="button" class="rc-locate" data-doc="${e(f.excerptDocHash)}" data-line="${f.excerptLine || 0}" data-excerpt="${e(f.excerpt)}">📍 定位原文</button>`
        : "";
      part2 += `<div class="rc-evidence"><div class="rc-ev-title">📌 风险条款原文摘录（可追溯）</div><div class="rc-excerpt">${e(f.excerpt || "（无）")}</div>${f.excerptLoc ? `<div class="rc-loc">出处：${e(f.excerptLoc)}</div>` : ""}${locBtn}</div>`;
      part2 += `<details class="rc-details"><summary>展开风险解析 · 修改建议 · 制度依据</summary><div class="rc-body">`;
      part2 += `<div class="rc-row"><b>风险解析：</b>${e(f.analysis || "（无）")}</div>`;
      part2 += `<div class="rc-row"><b>修改建议：</b>${e(f.suggestion || "（无）")}</div>`;
      part2 += `<div class="rc-row"><b>制度/模板依据：</b>${e(f.wikiRefs || "（无）")}</div>`;
      part2 += `</div></details>`;
      part2 += `</div>`;
    }
    part2 += `</div>`;
  }
  if (part2) html += `<section class="report-part part-second"><h2>第二部分：对照风险清单逐项评审</h2>${part2}</section>`;

  // 特殊情形 / 第三部分
  if (buckets.special.length) html += `<h2>特殊情形强制检查</h2>` + renderMarkdownSimple(buckets.special.join("\n"));
  if (buckets.overall.length) html += `<section class="report-part part-third"><h2>第三部分：总体评价与谈判优先级</h2>` + renderOverall(buckets.overall.join("\n")) + `</section>`;

  if (analysisId != null) {
    html += `<div class="report-foot">分析记录 ID：#${e(analysisId)} · 每条风险点均可回溯至合同原文与 44 项风险清单</div>`;
  }
  return html;
}

// ---------- 合同原文面板：点击「定位原文」跳转到左侧原文段落 ----------
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
    box.innerHTML = `<div class="ct-line"><span class="ct-txt" style="color:var(--err)">原文加载失败：${err.message}</span></div>`;
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
    if (need) el = [...box.querySelectorAll(".ct-line")].find((l) => (l.querySelector(".ct-txt")?.textContent || "").replace(/\s+/g, "").includes(need)) || null;
  }
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ct-flash");
    setTimeout(() => el && el.classList.remove("ct-flash"), 1700);
  }
}
document.addEventListener("click", (ev) => {
  const t = ev.target?.closest(".rc-locate");
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

// 集合名需符合后端规则 /^[a-zA-Z0-9_-]+$/（后端以其作为 uploads/<名称> 目录名）。
// 保留该规则，仅把自动建议/自动生成的名字「合规化」：非字母数字的字符统一转为 -。
function sanitizeCollectionName(s) {
  return String(s || "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-") // 中文、空格等 → -
    .replace(/-{2,}/g, "-")           // 合并连续 -
    .replace(/^-+|-+$/g, "");         // 去首尾 -
}
function ruSuggestedName(fileEl) {
  const f = fileEl && fileEl.files && fileEl.files[0];
  if (!f) return "";
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const base = sanitizeCollectionName(f.name.replace(/\.[^.]+$/, ""));
  return base ? `${base}-${ymd}` : `collection-${ymd}`;
}

async function ruCollections() {
  try {
    const r = await fetch("/api/collections");
    const d = await r.json().catch(() => ({}));
    return Array.isArray(d.collections) ? d.collections : [];
  } catch { return []; }
}
async function ruCollectionMeta(name) {
  return (await ruCollections()).find((c) => c.name === name) || null;
}

// 对当前问答集合内全部合同文档进行风险审查，报告直接渲染进问答内容区
// （主发送按钮 #qSend 在识别到审查意图时即承担此动作）
async function runContractReview() {
  if (!selectedCollections.length) { toast("请先在左侧选择问答集合（合同集合＝问答集合）", "err"); return; }
  // 与问答按钮互斥：问答进行中时不允许开始审查，避免共用结果区冲突
  if ($("#qSend") && $("#qSend").disabled) { toast("请等待当前问答完成后再开始风险审查", "err"); return; }
  await ensureSession(); // 自动建会话并持久化本次风险审查
  resetQResult(); // 切回结果视图并隐藏历史视图（历史视图现已独立容器，不会销毁 #qAnswer），确保最终结果渲染时 #qAnswer 存在
  // 输入框下方的特殊情形勾选已移除；特殊情形改为在上传时「高级配置」中设定，由后端按集合回退套用
  const tags = [];
  const btn = $("#qSend");
  btn.disabled = true;
  $("#qError").hidden = true;
  $("#qResult").hidden = true;
  const cp = $("#contractPanel"); if (cp) { cp.hidden = true; contractHash = null; }
  $("#qLoading").hidden = false;
  $("#qCancel").hidden = false;
  const stages = $("#loadingStages"); if (stages) stages.style.display = "none";
  $("#stageOutput").textContent = "";
  const la = $("#liveAnswer"); if (la) la.hidden = true;
  $("#loadingHint").textContent = `正在对集合「${selectedCollections.join("、")}」内的全部合同文档逐条比对 44 项风险清单…（耗时取决于模型与条款数量）`;
  $("#loadingTimer").textContent = "已等待 0 秒";
  const start = Date.now();
  const timer = setInterval(() => { $("#loadingTimer").textContent = `已等待 ${Math.floor((Date.now() - start) / 1000)} 秒`; }, 1000);
  reviewAbort = new AbortController();
  try {
    const r = await fetch("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ collection: selectedCollections[0], scope: "collection", tags, sessionId: currentSessionId }),
      signal: reviewAbort.signal,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || String(r.status));
    let qa = $("#qAnswer");
    if (!qa) { resetQResult(); qa = $("#qAnswer"); }
    if (!qa) throw new Error("结果区域初始化失败，请刷新页面后重试");
    qa.innerHTML = '<div class="report-md">' + renderReportMd(d.reportMarkdown || "（无报告内容）", { analysisId: d.analysisId }) + "</div>";
    const appliedTags = Array.isArray(d.tags) ? d.tags : [];
    $("#qQuestion").textContent =
      `合同风险审查 · 集合：${selectedCollections.join("、")}` + (appliedTags.length ? ` · 特殊情形：${appliedTags.join("、")}` : "");
    $("#qLoading").hidden = true;
    if (historyViewActive && currentSessionId) {
      // 在已有会话中继续交流：把本次审查报告追加进原会话记录，不新开结果页
      await appendToCurrentSession();
    } else {
      const extra = $("#qaExtraBody"); if (extra) extra.hidden = true;
      $("#qHistory").hidden = true; // 显示审查结果时隐藏历史视图
      $("#qResult").hidden = false;
    }
    const triggered = (d.findings || []).filter((f) => f.status === "triggered").length;
    toast(`审查完成 · 分析ID ${d.analysisId} · 命中 ${triggered} 项风险`, "ok");
    loadChatSessions();
  } catch (e) {
    $("#qLoading").hidden = true;
    const err = $("#qError");
    err.hidden = false;
    err.textContent = e && e.name === "AbortError" ? "已取消审查。" : "审查失败：" + (e.message || e);
  } finally {
    clearInterval(timer);
    btn.disabled = false;
    if (stages) stages.style.display = "";
  }
}

// ---------- 自然语言意图识别：输入中表达「审查合同」时自动等价于点击审查按钮 ----------
const REVIEW_INTENT = {
  hasReview: /(审查|审一下|复核|复审|风险|合规|隐患|漏洞|把关|体检|排查|风险点|审阅|潜在风险)/i,
  hasDoc: /(合同|协议|标书|招标|采购|投标|租约|租赁|框架协议|意向书|条款|这份|这个|该|本文|本文件|本(材料|文档)|当前)/i,
};
function detectReviewIntent(text) {
  const t = (text || "").trim();
  if (!t) return false;
  return REVIEW_INTENT.hasReview.test(t) && REVIEW_INTENT.hasDoc.test(t);
}
function isBusy() {
  return !!($("#qSend") && $("#qSend").disabled);
}
// 实时反馈：输入中命中审查意图时，主发送按钮自动切换为「开始风险审查」形态，并提示
function updateReviewIntentUi() {
  const el = $("#qInput");
  const btn = $("#qSend");
  const hint = $("#reviewIntentHint");
  const busy = !!(btn && btn.disabled);
  const on = !busy && detectReviewIntent(el ? el.value : "") && selectedCollections.length > 0;
  if (btn) {
    btn.classList.toggle("intent", on);
    btn.textContent = on ? "⚖" : "➤";
    btn.title = on ? "开始风险审查（已识别意图）" : "提交问题";
    btn.setAttribute("aria-label", on ? "开始风险审查" : "提交问题");
  }
  if (hint) hint.hidden = !on;
}
// 统一发送入口：识别意图 → 风险审查；否则走普通问答。避免重复触发/冲突。
async function handleSend() {
  const el = $("#qInput");
  const text = (el && el.value ? el.value : "").trim();
  if (!text) { showError("请输入问题"); return; }
  if (isBusy()) { toast("请等待当前任务完成后再发起", "err"); return; }
  if (detectReviewIntent(text)) {
    updateReviewIntentUi();
    runContractReview();
    return;
  }
  sendQuery();
}
if ($("#qInput")) $("#qInput").addEventListener("input", updateReviewIntentUi);
updateReviewIntentUi();

// ---------- 规则整理：合同类型 ↔ 风险规则 关联维护 ----------
let ruleTypes = [];        // 合同类型（扁平，含 parent / grp / ruleCount）
let ruleCurrentCode = "";  // 当前选中的合同类型编码
let ruleView = "contract"; // contract | library
let ruleScope = null;      // 当前合同类型的规则关联数据
let ruleMap = {};          // ruleId -> 适用的合同类型编码数组（行内角标用）

async function rulesApi(path, opts) {
  try {
    const r = await fetch(path, opts);
    return await r.json().catch(() => ({}));
  } catch {
    return {};
  }
}
const rulesJson = (body) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body || {}),
});

async function loadRuleTypes() {
  const d = await rulesApi("/api/rule-scope/contract-types");
  ruleTypes = d.types || [];
  renderRuleTree();
}

function renderRuleTree() {
  const box = $("#ruleContractTree");
  if (!box) return;
  box.textContent = "";
  const kidsOf = (code) => ruleTypes.filter((t) => t.parent === code);
  for (const t of ruleTypes.filter((x) => !x.parent)) {
    box.appendChild(ruleTreeItem(t, 0));
    const kids = kidsOf(t.code);
    for (const g of [...new Set(kids.map((k) => k.grp).filter(Boolean))]) {
      const gEl = document.createElement("div");
      gEl.className = "rt-group";
      gEl.textContent = g;
      box.appendChild(gEl);
      for (const k of kids.filter((x) => x.grp === g)) box.appendChild(ruleTreeItem(k, 1));
    }
    for (const k of kids.filter((x) => !x.grp)) box.appendChild(ruleTreeItem(k, 1));
  }
}

function ruleTreeItem(t, depth) {
  const el = document.createElement("div");
  el.className = "rt-item" + (depth ? " sub" : "") + (t.code === ruleCurrentCode ? " active" : "");
  const label = document.createElement("span");
  label.className = "rt-label";
  label.textContent = t.label;
  const badge = document.createElement("span");
  const unset = t.ruleCount == null;
  badge.className = "rt-badge" + (unset ? " unset" : "");
  badge.textContent = unset ? "默认" : `${t.ruleCount} 条`;
  badge.title = unset ? "未配置：审查时沿用默认全集（44 条）" : `已配置 ${t.ruleCount} 条规则`;
  el.appendChild(label);
  el.appendChild(badge);
  el.addEventListener("click", () => {
    ruleCurrentCode = t.code;
    renderRuleTree();
    if (ruleView !== "contract") setRuleView("contract");
    else renderRulePanel();
  });
  return el;
}

function setRuleView(v) {
  ruleView = v;
  document.querySelectorAll(".rv-btn").forEach((b) => b.classList.toggle("active", b.id === "rv" + v[0].toUpperCase() + v.slice(1)));
  renderRulePanel();
}

// 按关键字过滤当前面板中的规则行（合同视图的 .rule-item 与规则库的 .rule-lib-row 都参与）
function applyRuleFilter() {
  const el = $("#ruleSearch");
  const panel = $("#rulePanel");
  if (!panel) return;
  const kw = (el && el.value ? el.value : "").trim().toLowerCase();
  panel.querySelectorAll(".rule-item, .rule-lib-row").forEach((it) => {
    const txt = (it.textContent || "").toLowerCase();
    it.hidden = !!kw && !txt.includes(kw);
  });
  // 分类卡片内若已无可见行，整张卡片一起隐藏，避免留下空表头
  panel.querySelectorAll(".rule-cat").forEach((cat) => {
    const any = [...cat.querySelectorAll(".rule-item")].some((r) => !r.hidden);
    cat.hidden = !any;
  });
}

// 渲染后统一再应用一次过滤，避免重新渲染（切换类型/视图）后搜索结果丢失
async function renderRulePanel() {
  await renderRulePanelInner();
  applyRuleFilter();
}

async function renderRulePanelInner() {
  const panel = $("#rulePanel");
  const state = $("#ruleScopeState");
  if (!panel) return;
  panel.textContent = "";
  if (state) state.textContent = "";

  if (ruleView === "contract") {
    if (!ruleCurrentCode) {
      panel.innerHTML = '<div class="muted">请先在左侧选择一个合同类型。</div>';
      return;
    }
    const [d, m] = await Promise.all([
      rulesApi("/api/rule-scope/rules?contract=" + encodeURIComponent(ruleCurrentCode)),
      rulesApi("/api/rule-scope/rule-map"),
    ]);
    ruleScope = d;
    ruleMap = (m && m.map) || {};
    // 关键：未配置时界面把所有复选框显示为「已勾选」（表示沿用默认全集），
    // 必须把模型也同步为全选。否则用户只取消勾选少数几项就保存时，
    // 其余从未触发 change 的项仍为 selected=false，会误存成 0 条规则。
    if (!d.configured) (d.rules || []).forEach((r) => { r.selected = true; });
    const type = ruleTypes.find((t) => t.code === ruleCurrentCode);
    renderContractRulesView(panel, state, type, d);
    return;
  }

  // library：规则库（可增删改）
  const d = await rulesApi("/api/rule-scope/rules?contract=");
  renderRuleLibrary(panel, d.rules || []);
}

function ruleFilterMatch(r, kw) {
  if (!kw) return true;
  const k = kw.toLowerCase();
  return (
    String(r.rule_id).toLowerCase().includes(k) ||
    String(r.name || "").toLowerCase().includes(k) ||
    String(r.category || "").toLowerCase().includes(k)
  );
}

function renderContractRulesView(panel, state, type, d) {
  const rules = d.rules || [];
  const configured = !!d.configured;

  const head = document.createElement("div");
  head.className = "rule-panel-head";
  head.textContent = `合同类型：${type ? type.label : ruleCurrentCode}`;
  panel.appendChild(head);

  const banner = document.createElement("div");
  banner.className = "rule-banner" + (configured ? " ok" : " warn");
  banner.textContent = configured
    ? `已为该类型配置专属规则集（当前勾选 ${rules.filter((r) => r.selected).length} 条）`
    : "未配置：审查时沿用默认全集（全部启用规则）。勾选并保存后即生效。";
  panel.appendChild(banner);

  const bar = document.createElement("div");
  bar.className = "rule-actions";
  const mk = (text, cls, fn) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn " + cls + " small";
    b.textContent = text;
    b.addEventListener("click", fn);
    return b;
  };
  bar.appendChild(mk("保存", "primary", saveScope));
  bar.appendChild(mk("恢复默认", "ghost", resetScope));
  panel.appendChild(bar);

  const cats = [...new Set(rules.map((r) => r.category))];
  for (const c of cats) {
    const box = document.createElement("div");
    box.className = "rule-cat";
    const t = document.createElement("div");
    t.className = "rule-cat-title";
    const inCat = rules.filter((r) => r.category === c);
    t.textContent = `${c}（${inCat.length}）`;
    box.appendChild(t);
    for (const r of inCat) box.appendChild(ruleCheckRow(r, configured));
    panel.appendChild(box);
  }
  if (state) state.textContent = `共 ${rules.length} 条规则`;
}

// 规则行 = 勾选行 + 行内「适用于 N 个类型」角标（点击展开具体类型，即原「按规则看合同」视图）
function ruleCheckRow(r, configured) {
  const item = document.createElement("div");
  item.className = "rule-item";
  item.dataset.rid = r.rule_id;

  const row = document.createElement("label");
  row.className = "rule-row";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = configured ? !!r.selected : true; // 未配置 → 显示全选（实际行为）
  cb.addEventListener("change", () => {
    const rec = (ruleScope && ruleScope.rules || []).find((x) => x.rule_id === r.rule_id);
    if (rec) rec.selected = cb.checked;
  });
  const id = document.createElement("span");
  id.className = "rr-id";
  id.textContent = r.rule_id;
  const nm = document.createElement("span");
  nm.className = "rr-name";
  nm.textContent = r.name;

  // 「适用于 N 个类型」角标（合并自原「按规则看合同」视图）
  // 注意：计数必须包含「未单独配置 → 默认适用」的类型，否则会严重偏小。
  const codes = effectiveRuleCodes(r.rule_id);
  const explicit = ruleMap[r.rule_id] || [];
  const badge = document.createElement("span");
  badge.className = "rr-scope" + (explicit.length ? "" : " unset");
  badge.textContent = `适用于 ${codes.length} 个类型`;
  badge.title = codes.length
    ? "点击查看该规则适用于哪些合同类型（含默认适用的类型）"
    : "当前没有任何类型会使用该规则";
  badge.addEventListener("click", (e) => {
    e.preventDefault(); // 避免误触发整行的勾选
    e.stopPropagation();
    toggleRuleScopeDetail(item, r);
  });
  row.appendChild(cb);
  row.appendChild(id);
  row.appendChild(nm);
  row.appendChild(badge);

  const detail = document.createElement("div");
  detail.className = "rule-scope-detail";
  detail.hidden = true;
  item.appendChild(row);
  item.appendChild(detail);
  return item;
}

// 该规则实际适用的合同类型 = 显式配置的类型 + 未单独配置（默认适用全集）的类型
function effectiveRuleCodes(ruleId) {
  const explicit = ruleMap[ruleId] || [];
  const byDefault = ruleTypes.filter((t) => t.ruleCount == null).map((t) => t.code);
  return [...new Set([...explicit, ...byDefault])];
}

function toggleRuleScopeDetail(item, r) {
  const box = item.querySelector(".rule-scope-detail");
  if (!box) return;
  if (!box.hidden) {
    box.hidden = true;
    return;
  }
  box.textContent = "";
  const explicit = ruleMap[r.rule_id] || [];
  const byDefault = ruleTypes.filter((t) => t.ruleCount == null).map((t) => t.code);

  if (!explicit.length && byDefault.length === ruleTypes.length) {
    box.textContent = "所有合同类型都未单独配置，因此该规则默认适用于全部类型。";
  } else {
    if (explicit.length) box.appendChild(scopeSection(`显式配置（${explicit.length}）：`, explicit));
    if (byDefault.length) {
      box.appendChild(scopeSection(`默认适用（未单独配置，${byDefault.length}）：`, byDefault));
    }
    if (!explicit.length && !byDefault.length) box.textContent = "当前没有任何类型会使用该规则。";
  }
  box.hidden = false;
}

function scopeSection(title, codes) {
  const d = document.createElement("div");
  d.className = "rsd-sec";
  const t = document.createElement("span");
  t.className = "rsd-title";
  t.textContent = title;
  const v = document.createElement("span");
  v.textContent = codes.map((c) => (ruleTypes.find((x) => x.code === c) || {}).label || c).join("、");
  d.appendChild(t);
  d.appendChild(v);
  return d;
}

async function saveScope() {
  if (!ruleScope) return;
  const ids = (ruleScope.rules || []).filter((r) => r.selected).map((r) => r.rule_id);
  const d = await rulesApi("/api/rule-scope/assign", rulesJson({ contract: ruleCurrentCode, ruleIds: ids }));
  if (d.status === "ok") {
    toast(`已保存：${ruleCurrentCode} 关联 ${ids.length} 条规则`, "ok");
    await loadRuleTypes();
    renderRulePanel();
  } else {
    toast(
      `保存失败：${d.error || "接口无响应"}。若一直失败，请确认后端服务已重启（schema v8 与 /api/rule-scope 需重启后才可用）`,
      "err",
    );
  }
}

async function resetScope() {
  const d = await rulesApi("/api/rule-scope/reset", rulesJson({ contract: ruleCurrentCode }));
  if (d.status === "ok") {
    toast("已恢复为默认全集", "ok");
    await loadRuleTypes();
    renderRulePanel();
  } else toast("操作失败：" + (d.error || ""), "err");
}

function renderRuleLibrary(panel, rules) {
  const head = document.createElement("div");
  head.className = "rule-panel-head";
  head.textContent = `规则库 · 共 ${rules.length} 条`;
  panel.appendChild(head);

  const addBar = document.createElement("div");
  addBar.className = "rule-actions";
  const bAdd = document.createElement("button");
  bAdd.type = "button";
  bAdd.className = "btn primary small";
  bAdd.textContent = "+ 新增规则";
  bAdd.addEventListener("click", () => openRuleEditor(null, () => renderRulePanel()));
  addBar.appendChild(bAdd);
  panel.appendChild(addBar);

  for (const r of rules) {
    const row = document.createElement("div");
    row.className = "rule-lib-row";
    row.innerHTML =
      `<span class="rr-id">${esc(r.rule_id)}</span>` +
      `<span class="rr-name">${esc(r.name)}</span>` +
      `<span class="rr-cat muted">${esc(r.category || "")}</span>` +
      `<span class="rr-sev">${esc(r.severity_default || "—")}</span>`;
    const btns = document.createElement("span");
    btns.className = "rr-btns";
    const be = document.createElement("button");
    be.type = "button";
    be.className = "btn ghost small";
    be.textContent = "编辑";
    be.addEventListener("click", () => openRuleEditor(r, () => renderRulePanel()));
    const bd = document.createElement("button");
    bd.type = "button";
    bd.className = "btn danger small";
    bd.textContent = "删除";
    bd.addEventListener("click", async () => {
      if (!confirm(`确定删除规则「${r.rule_id} ${r.name}」？同时会移除它与各合同类型的关联。`)) return;
      const d = await rulesApi("/api/risk-rules/" + encodeURIComponent(r.rule_id), { method: "DELETE" });
      if (d.status === "ok") { toast("已删除规则", "ok"); await loadRuleTypes(); renderRulePanel(); }
      else toast("删除失败：" + (d.error || ""), "err");
    });
    btns.appendChild(be);
    btns.appendChild(bd);
    row.appendChild(btns);
    panel.appendChild(row);
  }
}

// 规则编辑弹窗（新增 / 修改）
function openRuleEditor(rule, onDone) {
  const wrap = document.createElement("div");
  wrap.className = "modal";
  const box = document.createElement("div");
  box.className = "modal-box";
  box.style.width = "min(640px, 94vw)";
  const isNew = !rule;
  box.innerHTML =
    `<div class="modal-head"><span>${isNew ? "新增规则" : "编辑规则 " + esc(rule.rule_id)}</span></div>` +
    `<div class="modal-body">` +
      `<div class="field"><label>规则名称</label><input id="reName" value="${esc(isNew ? "" : rule.name)}" /></div>` +
      `<div class="field"><label>分类</label><input id="reCat" value="${esc(isNew ? "自定义" : rule.category || "")}" /></div>` +
      `<div class="field"><label>默认严重等级（高/中/低）</label><input id="reSev" value="${esc(isNew ? "" : rule.severity_default || "")}" /></div>` +
      `<div class="field"><label>风险描述</label><textarea id="reDesc" rows="4">${esc(isNew ? "" : rule.description || "")}</textarea></div>` +
      `<div class="field"><label>修改/补充建议</label><textarea id="reSug" rows="3">${esc(isNew ? "" : rule.suggestion || "")}</textarea></div>` +
    `</div>` +
    `<div class="modal-foot"><button id="reSave" class="btn primary" type="button">保存</button></div>`;
  const close = () => wrap.remove();
  box.querySelector("#reSave").addEventListener("click", async () => {
    const payload = {
      name: box.querySelector("#reName").value.trim(),
      category: box.querySelector("#reCat").value.trim(),
      severity_default: box.querySelector("#reSev").value.trim() || null,
      description: box.querySelector("#reDesc").value,
      suggestion: box.querySelector("#reSug").value,
    };
    if (!payload.name) { toast("请填写规则名称", "err"); return; }
    const d = isNew
      ? await rulesApi("/api/risk-rules", rulesJson(payload))
      : await rulesApi("/api/risk-rules/" + encodeURIComponent(rule.rule_id), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
    if (d.status === "ok") { toast("已保存规则", "ok"); close(); onDone && onDone(); }
    else toast("保存失败：" + (d.error || ""), "err");
  });
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
  wrap.appendChild(box);
  document.body.appendChild(wrap);
}

if ($("#rulesNavBtn")) {
  $("#rulesNavBtn").addEventListener("click", () => {
    switchTab("rules");
    loadRuleTypes();
    renderRulePanel();
  });
}
if ($("#rulesBack")) $("#rulesBack").addEventListener("click", () => switchTab("query"));
// 「按合同看规则」为默认视图：点击左侧合同类型树即可显示，无需单独按钮。
// 此处只保留「规则库」入口；从规则库返回合同视图同样是点击左侧任意合同类型。
if ($("#rvLibrary")) {
  $("#rvLibrary").addEventListener("click", () => setRuleView("library"));
}
if ($("#ruleSearch")) {
  $("#ruleSearch").addEventListener("input", applyRuleFilter);
}

// ---------- 信息收集（迭代式提问，保留完整上下文） ----------
let intakeSessionId = null;
let intakeRecords = [];

async function intakeApi(path, opts) {
  try {
    const r = await fetch(path, opts);
    return await r.json().catch(() => ({}));
  } catch {
    return {};
  }
}

async function loadIntakeSessions() {
  try {
    const d = await intakeApi("/api/intake/sessions");
    const box = $("#intakeSessions");
    box.textContent = "";
    const sessions = d.sessions || [];
    if (!sessions.length) {
      box.innerHTML = '<div class="muted" style="font-size:12px;padding:6px 2px">暂无会话，先在右侧设定目标开始采集。</div>';
      return;
    }
    for (const s of sessions) {
      const el = document.createElement("div");
      el.className = "intake-session" + (s.id === intakeSessionId ? " active" : "");
      const goal = s.goal.length > 36 ? s.goal.slice(0, 36) + "…" : s.goal;
      el.innerHTML =
        `<div class="is-goal">${esc(goal)}</div>` +
        `<div class="is-meta"><span>${s.status === "done" ? "已完成" : "进行中"}</span> · ${s.count} 条 · ${esc(s.updated_at)}</div>`;
      el.addEventListener("click", () => resumeIntake(s.id));
      box.appendChild(el);
    }
  } catch {
    /* ignore */
  }
}

function renderTranscript(records) {
  const box = $("#intakeTranscript");
  box.textContent = "";
  (records || []).forEach((r) => {
    const item = document.createElement("div");
    item.className = "intake-row " + (r.role === "question" ? "is-q" : "is-a");
    const head = document.createElement("div");
    head.className = "ir-head";
    head.textContent = r.role === "question" ? "采集方" : "你";
    const body = document.createElement("div");
    body.className = "ir-body";
    body.textContent = r.content;
    item.appendChild(head);
    item.appendChild(body);
    if (r.role === "question" && Array.isArray(r.refs) && r.refs.length) {
      const refs = document.createElement("div");
      refs.className = "ir-refs";
      refs.textContent = "↩ 引用回答 #" + r.refs.join("、#");
      item.appendChild(refs);
    }
    box.appendChild(item);
  });
  box.scrollTop = box.scrollHeight;
}

function showIntakeSession(d) {
  intakeSessionId = d.id;
  intakeRecords = d.records || [];
  $("#intakeSetup").hidden = true;
  $("#intakeActive").hidden = false;
  $("#intakeGoalText").textContent = d.goal;
  renderTranscript(intakeRecords);
  const isDone = d.status === "done";
  $("#intakeComposer").hidden = isDone;
  if (isDone) finishIntake(true);
  else { $("#intakeDone").hidden = true; $("#intakeAnswer").focus(); }
  loadIntakeSessions();
}

async function startIntake() {
  const goal = $("#intakeGoal").value.trim();
  if (!goal) { toast("请先填写采集目标", "err"); return; }
  const d = await intakeApi("/api/intake/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal }),
  });
  if (!d.id) { toast("创建会话失败：" + (d.error || ""), "err"); return; }
  showIntakeSession(d);
  $("#intakeAnswer").value = "";
}

async function sendIntakeAnswer() {
  const answer = $("#intakeAnswer").value.trim();
  if (!answer) { toast("请先输入回答", "err"); return; }
  const btn = $("#intakeSend");
  btn.disabled = true;
  try {
    const d = await intakeApi(
      "/api/intake/sessions/" + encodeURIComponent(intakeSessionId) + "/answer",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer }),
      }
    );
    if (d.error) { toast("提交失败：" + d.error, "err"); return; }
    intakeRecords = d.records || [];
    renderTranscript(intakeRecords);
    $("#intakeAnswer").value = "";
    if (d.done) {
      $("#intakeComposer").hidden = true;
      finishIntake(true);
    } else {
      $("#intakeAnswer").focus();
    }
  } finally {
    btn.disabled = false;
  }
  loadIntakeSessions();
}

async function finishIntake(silent) {
  const d = await intakeApi(
    "/api/intake/sessions/" + encodeURIComponent(intakeSessionId) + "/finish",
    { method: "POST" }
  );
  if (d.summary) {
    $("#intakeSummary").textContent = d.summary;
    $("#intakeDone").hidden = false;
    $("#intakeComposer").hidden = true;
    refreshIntakeWikiTargets();
  }
  if (!silent) toast("已结束并生成摘要", "ok");
}

// ---------- 采集摘要 → 存为 Wiki 页（并入知识库，自动建索引） ----------
async function refreshIntakeWikiTargets() {
  const sel = $("#intakeWikiColl");
  const btn = $("#intakeWikiSave");
  if (!sel || !btn) return;
  await loadCollectionCache();
  const cols = Array.isArray(_collectionCache) ? _collectionCache : [];
  const wiki = cols.filter((c) => c.type === "wiki");
  sel.textContent = "";
  if (wiki.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "（无 wiki 集合）";
    sel.appendChild(opt);
    sel.disabled = true;
    btn.disabled = true;
    btn.title = "还没有 wiki 集合，请先创建：qmd collection add <path> --name <name> --type wiki";
    return;
  }
  for (const c of wiki) {
    const opt = document.createElement("option");
    opt.value = c.name;
    opt.textContent = `${c.name}（${c.activeCount ?? 0} 页）`;
    sel.appendChild(opt);
  }
  sel.disabled = false;
  btn.disabled = false;
  btn.title = "把本次采集摘要沉淀为 wiki 页，并入知识库（自动建索引，立即可检索）";
}

async function saveIntakeToWiki() {
  const btn = $("#intakeWikiSave");
  const sel = $("#intakeWikiColl");
  const collection = sel ? sel.value : "";
  if (!collection) {
    toast("没有可写入的 wiki 集合，请先创建", "err");
    return;
  }
  const summary = ($("#intakeSummary")?.textContent || "").trim();
  if (!summary) {
    toast("当前没有可沉淀的摘要", "err");
    return;
  }
  const goal = ($("#intakeGoalText")?.textContent || "").trim();
  const fallbackTitle = (goal.split("\n")[0] || "").slice(0, 40).trim() || "采集摘要";
  const input = window.prompt("Wiki 页标题（决定页面标题与文件名）：", fallbackTitle);
  if (input === null) return; // 用户取消
  const title = input.trim() || fallbackTitle;

  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "保存中…";
  try {
    const r = await fetch("/api/wiki/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ collection, title, question: goal, answer: summary, sources: [] }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      toast("保存失败：" + (d.error || r.status), "err");
      return;
    }
    toast(`${d.overwritten ? "已更新" : "已保存"} wiki 页：${d.file}（已并入知识库，可检索）`, "ok");
  } catch (e) {
    toast("保存失败：" + ((e && e.message) || e), "err");
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

async function resumeIntake(id) {
  const d = await intakeApi("/api/intake/sessions/" + encodeURIComponent(id));
  if (!d.id) return;
  showIntakeSession(d);
}

$("#intakeNavBtn").addEventListener("click", () => {
  switchTab("intake");
  loadIntakeSessions();
});
$("#intakeStart").addEventListener("click", startIntake);
$("#intakeSend").addEventListener("click", sendIntakeAnswer);
$("#intakeRefresh").addEventListener("click", loadIntakeSessions);
$("#intakeFinish").addEventListener("click", () => finishIntake(false));
$("#intakeWikiSave").addEventListener("click", saveIntakeToWiki);
$("#intakeSummaryCopy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("#intakeSummary").textContent || "");
    toast("摘要已复制", "ok");
  } catch {
    toast("复制失败，请手动选择", "err");
  }
});

// ---------- init ----------
checkHealth();
setInterval(checkHealth, 15000);
// 索引已并入问答页：上传弹窗的集合下拉、问答页左侧已建索引列表在加载即刷新
loadCollections();
loadIndexList();

// ---------- auth: login screen + logout ----------
const loginOverlay = $("#loginOverlay");
const loginErr = $("#loginErr");
const loginUser = $("#loginUser");
const loginPass = $("#loginPass");
const loginBtn = $("#loginBtn");
const loginForm = $("#loginForm");
const loginClose = $("#loginClose");
const logoutBtn = $("#logoutBtn");
const userBadge = $("#userBadge");

function setLoggedInUI(name) {
  if (name) {
    userBadge.textContent = name;
    userBadge.hidden = false;
    logoutBtn.hidden = false;
  } else {
    userBadge.hidden = true;
    logoutBtn.hidden = true;
  }
}

function showLogin(force) {
  if (!force && localStorage.getItem("qmd_token")) {
    loginOverlay.hidden = true;
    return;
  }
  loginOverlay.hidden = false;
  if (loginErr) loginErr.hidden = true;
  if (loginUser) {
    loginUser.focus();
    loginUser.select();
  }
}

async function doLogin(username, password) {
  if (loginErr) loginErr.hidden = true;
  try {
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (loginErr) {
        loginErr.textContent = d.error || "登录失败";
        loginErr.hidden = false;
      }
      return false;
    }
    localStorage.setItem("qmd_token", d.token);
    const ti = document.getElementById("cfgToken");
    if (ti) ti.value = d.token; // 登录成功后自动填入访问令牌框
    setLoggedInUI(d.name);
    loginOverlay.hidden = true;
    configLoaded = false; // 以新身份重新加载配置
    loadChatSessions(); // 加载该用户的对话历史
    toast("登录成功" + (d.name ? "：" + d.name : ""), "ok");
    return true;
  } catch (e) {
    if (loginErr) {
      loginErr.textContent = "网络错误：" + e.message;
      loginErr.hidden = false;
    }
    return false;
  }
}

if (loginForm) {
  loginForm.addEventListener("submit", (e) => {
    e.preventDefault();
    doLogin(loginUser.value.trim(), loginPass.value);
  });
} else if (loginBtn) {
  loginBtn.addEventListener("click", () => {
    doLogin(loginUser.value.trim(), loginPass.value);
  });
}

// 关闭登录框：点 × 按钮、点遮罩空白处、按 Esc 均可关闭（关闭后进入匿名模式）
function hideLogin() {
  if (loginOverlay) loginOverlay.hidden = true;
}
if (loginClose) loginClose.addEventListener("click", hideLogin);
if (loginOverlay) {
  loginOverlay.addEventListener("click", (e) => {
    if (e.target === loginOverlay) hideLogin();
  });
}
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (loginOverlay && !loginOverlay.hidden) hideLogin();
  else if (uploadModal && !uploadModal.hidden) uploadModal.hidden = true;
  else if ($("#docModal") && !$("#docModal").hidden) $("#docModal").hidden = true;
});

if (logoutBtn) {
  logoutBtn.addEventListener("click", async () => {
    const t = localStorage.getItem("qmd_token");
    if (t) {
      try {
        await fetch("/api/auth/logout", { method: "POST" });
      } catch {
        /* ignore network errors on logout */
      }
    }
    localStorage.removeItem("qmd_token");
    setLoggedInUI("");
    showLogin(true);
    toast("已退出登录", "ok");
  });
}

// 已存有 token 则直接进入；否则弹出登录
(function initAuth() {
  if (localStorage.getItem("qmd_token")) {
    setLoggedInUI("");
    loginOverlay.hidden = true;
    loadChatSessions(); // 已登录则直接加载对话历史
  } else {
    showLogin(true);
  }
})();
