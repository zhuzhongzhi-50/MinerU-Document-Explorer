// QMD frontend — zero-dependency, talks to the co-located API server (same origin).
const $ = (sel) => document.querySelector(sel);

// ---------- auth: auto-attach bearer token to every request ----------
// All fetch calls below (query / config / warm / embed / health) will
// transparently carry the saved token once the user pastes it in the config panel.
(function installTokenFetch() {
  const _orig = window.fetch.bind(window);
  window.fetch = (url, opts = {}) => {
    const t = localStorage.getItem("qmd_token");
    if (t) {
      opts.headers = { ...(opts.headers || {}), Authorization: "Bearer " + t };
    }
    return _orig(url, opts);
  };
})();

// ---------- health ----------
async function checkHealth() {
  const el = $("#healthStatus");
  try {
    const r = await fetch("/health");
    if (!r.ok) throw new Error();
    el.textContent = "● 已连接";
    el.className = "status ok";
  } catch {
    el.textContent = "● 未连接";
    el.className = "status err";
  }
}

// ---------- tabs ----------
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $("#tab-" + tab.dataset.tab).classList.add("active");
    if (tab.dataset.tab === "config") loadConfig();
    if (tab.dataset.tab === "index") loadCollections();
  });
});

// ---------- query ----------
$("#advToggle").addEventListener("change", (e) => {
  $("#advBox").hidden = !e.target.checked;
});

$("#qClear").addEventListener("click", () => {
  $("#qInput").value = "";
  $("#qResult").hidden = true;
  $("#qError").hidden = true;
  $("#qEmpty").hidden = false;
});

let queryAbort = null;
let loadingTimerId = null;

async function sendQuery() {
  const query = $("#qInput").value.trim();
  if (!query) {
    showError("请输入问题");
    return;
  }
  const body = { query };
  const cols = $("#qCollections").value.trim();
  if (cols) body.collections = cols.split(",").map((s) => s.trim()).filter(Boolean);
  body.limit = Number($("#qLimit").value) || 10;
  body.topK = Number($("#qTopK").value) || 10;
  body.minScore = Number($("#qMinScore").value) || 0;
  const candLimitVal = Number($("#qCandidateLimit").value);
  body.candidateLimit = Number.isFinite(candLimitVal) && candLimitVal > 0 ? candLimitVal : body.limit;
  const intent = $("#qIntent").value.trim();
  if (intent) body.intent = intent;

  $("#qError").hidden = true;
  $("#qResult").hidden = true;
  $("#qEmpty").hidden = true;
  $("#qLoading").hidden = false;
  $("#qSend").disabled = true;
  $("#qCancel").hidden = false;

  // 重置阶段与计时显示
  const start = Date.now();
  updateLoadingStage(0);
  $("#loadingTimer").textContent = "已等待 0 秒";
  $("#loadingHint").textContent = "首次可能需加载本地模型，请稍候";

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
    markStageActive("expand");

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
    if (finalData) renderResult(finalData);
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
      $("#liveAnswer").hidden = false;
      break;
    }
    case "token": {
      const live = $("#liveAnswer");
      live.hidden = false;
      live.textContent += data.text;
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

function renderResult(data) {
  $("#qResult").hidden = false;
  const model = $("#qModel");
  model.textContent = data.model ? data.model : "仅检索模式";

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
}

$("#qSend").addEventListener("click", sendQuery);
$("#qCancel").addEventListener("click", () => {
  if (queryAbort) queryAbort.abort();
});
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
$("#qInput").addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") sendQuery();
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
  { key: "chunkSizeTokens", label: "分块大小 (tokens)", group: "分块", type: "number" },
  { key: "chunkOverlapRatio", label: "重叠比例", group: "分块", type: "number", step: "0.01" },
  { key: "chunkWindowTokens", label: "窗口 tokens", group: "分块", type: "number" },
  { key: "queryLimit", label: "检索返回条数", group: "检索", type: "number" },
  { key: "minScore", label: "最低相似度", group: "检索", type: "number", step: "0.01" },
  { key: "candidateLimit", label: "候选池大小", group: "检索", type: "number" },
  { key: "strongSignalMinScore", label: "强信号阈值", group: "检索", type: "number", step: "0.01" },
  { key: "strongSignalMinGap", label: "强信号间隔", group: "检索", type: "number", step: "0.01" },
  { key: "intentWeightSnippet", label: "意图·片段权重", group: "检索", type: "number", step: "0.01" },
  { key: "intentWeightChunk", label: "意图·分块权重", group: "检索", type: "number", step: "0.01" },
  { key: "rrfK", label: "RRF K 值", group: "检索", type: "number" },
  { key: "enableRerank", label: "启用重排 (rerank)", group: "检索", type: "checkbox" },
  { key: "enableQueryExpansion", label: "启用查询扩展 (expansion)", group: "检索", type: "checkbox" },
  { key: "embedBatchSize", label: "嵌入批大小", group: "模型", type: "number" },
  { key: "embedModel", label: "嵌入模型", group: "模型", type: "text" },
  { key: "rerankModel", label: "重排模型", group: "模型", type: "text" },
  { key: "queryExpansionModel", label: "查询扩展模型", group: "模型", type: "text" },
  { key: "modelCacheDir", label: "模型缓存目录", group: "模型", type: "text" },
  { key: "llmBaseUrl", label: "问答 API 地址", group: "问答 LLM", type: "text" },
  { key: "llmApiKey", label: "问答 API Key", group: "问答 LLM", type: "password" },
  { key: "llmModel", label: "问答模型名", group: "问答 LLM", type: "text" },
];

let configValues = {};
let configLoaded = false;

function buildConfigForm() {
  const form = $("#configForm");
  form.textContent = "";
  let curGroup = "";
  CONFIG_FIELDS.forEach((f) => {
    if (f.group !== curGroup) {
      curGroup = f.group;
      const g = document.createElement("div");
      g.className = "config-group";
      g.textContent = curGroup;
      form.appendChild(g);
    }
    const wrap = document.createElement("div");
    wrap.className = "config-field";
    const label = document.createElement("label");
    label.textContent = f.label;
    const input = document.createElement("input");
    input.id = "cfg-" + f.key;
    input.type = f.type;
    if (f.step) input.step = f.step;
    if (f.type === "checkbox") {
      input.checked = !!configValues[f.key];
    } else if (configValues[f.key] !== undefined) {
      input.value = configValues[f.key];
    }
    wrap.appendChild(label);
    wrap.appendChild(input);
    form.appendChild(wrap);
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

// ---------- index / embed ----------
$("#eBtn").addEventListener("click", async () => {
  const cols = $("#eCollections").value.trim();
  const force = $("#eForce").checked;
  const body = {};
  if (cols) body.collections = cols.split(",").map((s) => s.trim()).filter(Boolean);
  if (force) body.force = true;
  const msg = $("#eResult");
  msg.hidden = false;
  msg.className = "msg";
  msg.textContent = "重建中…（首次加载模型可能较久）";
  $("#eBtn").disabled = true;
  // Show elapsed time so a genuinely slow CPU embedding run doesn't look frozen
  const startedAt = Date.now();
  const tick = setInterval(() => {
    const s = Math.round((Date.now() - startedAt) / 1000);
    msg.textContent = `重建中… 已用时 ${s}s（本地 CPU 推理，每条约 10 秒，请耐心等待）`;
  }, 1000);
  try {
    const r = await fetch("/api/embed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) {
      msg.className = "msg err";
      msg.textContent = "失败：" + (data.error || "");
    } else {
      msg.className = "msg ok";
      msg.textContent = "✓ " + (data.message || "完成");
    }
  } catch (e) {
    msg.className = "msg err";
    msg.textContent = "错误：" + e.message;
  } finally {
    clearInterval(tick);
    $("#eBtn").disabled = false;
  }
});

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

$("#uBtn").addEventListener("click", async () => {
  const fileEl = $("#uFile");
  const collection = $("#uCollection").value.trim();
  const auto = $("#uAuto").checked;
  const msg = $("#uResult");
  const prog = $("#uProgress");
  if (!fileEl.files || fileEl.files.length === 0) {
    msg.hidden = false; msg.className = "msg err"; msg.textContent = "请先选择一个文档";
    return;
  }
  if (!collection) {
    msg.hidden = false; msg.className = "msg err"; msg.textContent = "请填写集合名称";
    return;
  }
  const fd = new FormData();
  fd.append("file", fileEl.files[0]);
  fd.append("collection", collection);
  fd.append("autoIndex", auto ? "true" : "false");

  msg.hidden = false; msg.className = "msg"; msg.textContent = "上传中…";
  prog.hidden = false;
  $("#uBtn").disabled = true;
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
      msg.className = "msg ok";
      const idx = d.autoIndex
        ? `，已索引 ${d.reindex?.indexed ?? 0} 篇、生成向量 ${d.embed?.chunksEmbedded ?? 0} 块`
        : "（未自动建索引，请到上方手动「开始重建」）";
      msg.textContent = `已保存到集合「${d.collection}」：${d.file}${idx}`;
    }
  } catch (e) {
    msg.className = "msg err";
    msg.textContent = "错误：" + e.message;
  } finally {
    clearInterval(tick);
    prog.hidden = true;
    $("#uBtn").disabled = false;
  }
});

// ---------- init ----------
checkHealth();
setInterval(checkHealth, 15000);

// ---------- auth: login screen + logout ----------
const loginOverlay = $("#loginOverlay");
const loginErr = $("#loginErr");
const loginUser = $("#loginUser");
const loginPass = $("#loginPass");
const loginBtn = $("#loginBtn");
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

if (loginBtn) {
  loginBtn.addEventListener("click", () => {
    doLogin(loginUser.value.trim(), loginPass.value);
  });
  loginPass.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loginBtn.click();
  });
  loginUser.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loginPass.focus();
  });
}

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
  } else {
    showLogin(true);
  }
})();
