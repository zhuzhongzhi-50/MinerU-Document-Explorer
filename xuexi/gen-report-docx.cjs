const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, LevelFormat, TableOfContents,
  HeadingLevel, BorderStyle, WidthType, ShadingType, PageNumber, PageBreak,
} = require("docx");

const FONT = "Microsoft YaHei";
const MONO = "Consolas";
const CW = 9026; // A4 content width with 1" margins

const border = { style: BorderStyle.SINGLE, size: 1, color: "BFBFBF" };
const borders = { top: border, bottom: border, left: border, right: border };
const cellMargins = { top: 80, bottom: 80, left: 120, right: 120 };

function h1(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(text)] });
}
function h2(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(text)] });
}
function p(text, opts = {}) {
  return new Paragraph({
    spacing: { after: 120, line: 300 },
    children: [new TextRun({ text, ...opts })],
  });
}
function rich(runs) {
  return new Paragraph({ spacing: { after: 120, line: 300 }, children: runs.map(r => new TextRun(r)) });
}
function bullet(text) {
  return new Paragraph({
    numbering: { reference: "bullets", level: 0 },
    spacing: { after: 80, line: 300 },
    children: [new TextRun(text)],
  });
}
function num(text) {
  return new Paragraph({
    numbering: { reference: "numbers", level: 0 },
    spacing: { after: 80, line: 300 },
    children: [new TextRun(text)],
  });
}
function code(text) {
  return new Paragraph({
    spacing: { after: 120, line: 260 },
    shading: { fill: "F5F5F5", type: ShadingType.CLEAR },
    indent: { left: 240, right: 240 },
    children: [new TextRun({ text, font: MONO, size: 18 })],
  });
}
function table(headers, rows, widths) {
  const headRow = new TableRow({
    tableHeader: true,
    children: headers.map((h, i) => new TableCell({
      borders, width: { size: widths[i], type: WidthType.DXA }, margins: cellMargins,
      shading: { fill: "DCE6F1", type: ShadingType.CLEAR },
      children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, size: 20 })] })],
    })),
  });
  const bodyRows = rows.map(r => new TableRow({
    children: r.map((c, i) => new TableCell({
      borders, width: { size: widths[i], type: WidthType.DXA }, margins: cellMargins,
      children: [new Paragraph({ spacing: { line: 280 }, children: [new TextRun({ text: c, size: 20 })] })],
    })),
  }));
  return new Table({ width: { size: CW, type: WidthType.DXA }, columnWidths: widths, rows: [headRow, ...bodyRows] });
}
const spacer = (size = 160) => new Paragraph({ spacing: { after: size }, children: [new TextRun("")] });

const doc = new Document({
  styles: {
    default: { document: { run: { font: FONT, size: 22 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 32, bold: true, font: FONT, color: "1F3864" },
        paragraph: { spacing: { before: 320, after: 200 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 26, bold: true, font: FONT, color: "2E5395" },
        paragraph: { spacing: { before: 240, after: 160 }, outlineLevel: 1 } },
    ],
  },
  numbering: {
    config: [
      { reference: "bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "\u2022",
        alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 600, hanging: 300 } } } }] },
      { reference: "numbers", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.",
        alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 600, hanging: 300 } } } }] },
    ],
  },
  sections: [{
    properties: {
      page: {
        size: { width: 11906, height: 16838 }, // A4
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
      },
    },
    headers: {
      default: new Header({ children: [new Paragraph({
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "2E5395", space: 1 } },
        children: [new TextRun({ text: "重建向量索引问题复盘报告", size: 18, color: "666666" })],
      })] }),
    },
    footers: {
      default: new Footer({ children: [new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: "第 ", size: 18, color: "666666" }),
          new TextRun({ children: [PageNumber.CURRENT], size: 18, color: "666666" }),
          new TextRun({ text: " 页", size: 18, color: "666666" })],
      })] }),
    },
    children: [
      // ===== Title =====
      new Paragraph({
        alignment: AlignmentType.CENTER, spacing: { after: 120 },
        children: [new TextRun({ text: "重建向量索引（/api/embed）", bold: true, size: 44, font: FONT, color: "1F3864" })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER, spacing: { after: 240 },
        children: [new TextRun({ text: "问题排查与优化复盘报告", bold: true, size: 44, font: FONT, color: "1F3864" })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER, spacing: { after: 400 },
        children: [new TextRun({ text: "环境：Windows / node-llama-cpp 3.x / Intel UHD 集显 / 8 逻辑核（4 物理核）    日期：2026-09-10",
          size: 20, color: "666666" })],
      }),

      new TableOfContents("目录", { hyperlink: true, headingStyleRange: "1-2" }),
      new Paragraph({ children: [new PageBreak()] }),

      // ===== 1 =====
      h1("一、问题时间线"),
      table(
        ["阶段", "现象", "结论"],
        [
          ["1", "点击「开始重建」→ 失败：Cannot read properties of undefined (reading 'prepare')", "代码 Bug（传错 store 对象）"],
          ["2", "添加 token 后仍报同样错误", "鉴权在 handler 之前，掩盖了真实错误"],
          ["3", "修复后一直显示「重建中…」，762s / 1324s 无结果", "不是卡死，是 CPU 推理极慢"],
          ["4", "检查发现服务器进程已消失", "服务器中途崩溃，前端计时空转"],
          ["5", "建议启用 GPU 提速，用户指出「本机没有 GPU」", "是集显；经 A/B 实测集显反而更快"],
        ],
        [1100, 4600, 3326]
      ),
      spacer(),
      rich([{ text: "最终结果：", bold: true },
        { text: "exam 全量重建从约 30 分钟（CPU）降到 4.3 分钟（集显 Vulkan），提速约 7 倍。" }]),

      // ===== 2 =====
      h1("二、问题一：Cannot read properties of undefined (reading 'prepare')"),
      h2("2.1 根因：两层 store 混用"),
      p("项目存在两层 store，而服务器把「上层对象」传给了「底层函数」："),
      code([
        "index.ts  createStore()  →  QMDStore   （SDK 公开层）",
        "                             ├─ internal        ← 指向 InternalStore",
        "                             ├─ dbPath / search / embed / listCollections ...",
        "                             └─ ✗ 没有 db 属性",
        "",
        "store.ts  createStore()  →  InternalStore（底层）",
        "                             ├─ ✓ db",
        "                             ├─ ensureVecTable / getStatus / getIndexHealth ...",
        "                             └─ generateEmbeddings 操作的就是这一层",
      ].join("\n")),
      bullet("server.ts 第 142 行：import { createStore } from \"../index.js\" → 拿到的是 QMDStore"),
      bullet("server.ts 原第 360 行：直接调用底层函数 generateEmbeddings(store as any, {...})"),
      bullet("generateEmbeddings 第一行：const db = store.db → QMDStore 上不存在 → undefined"),
      bullet("紧接着 getHashesForEmbedding(undefined, ...) 内部 db.prepare(...) → 抛出该错误"),
      spacer(),
      rich([{ text: "关键：", bold: true },
        { text: "as any 让 TypeScript 失去保护，编译期完全没报错，问题被推迟到运行时。" }]),

      h2("2.2 为什么「加 token 之后才报错」"),
      p("鉴权发生在进入 handler 之前。未配置 token 时请求在 401 阶段就被拦截，从未执行到 generateEmbeddings；添加 token 后请求真正进入处理函数，这个一直存在的 Bug 才暴露出来。"),

      h2("2.3 修复"),
      p("改用 SDK 提供的正确入口（它内部会把真正的 InternalStore 传下去）："),
      code("// src/api/server.ts\nawait store.embed({\n  force,\n  model: DEFAULT_EMBED_MODEL,\n  collections,\n});"),
      p("QMDStore.embed() 的实现（src/index.ts:653）："),
      code("embed: async (embedOpts) => {\n  return generateEmbeddings(internal, { ... });   // ← 传的是 internal，正确\n},"),
      p("同时移除了不再使用的 generateEmbeddings 导入。"),

      h2("2.4 为什么 CLI 不受影响"),
      p("src/cli/qmd.ts 使用 getStore() 返回的是 InternalStore（qmd.ts:1587 直接访问 storeInstance.db），所以 qmd embed 命令一直是正常的。"),

      h2("2.5 验证"),
      code([
        "store.db (QMDStore)               = undefined   ← 原 Bug 来源",
        "store.internal.db (InternalStore)  = 有值",
        "store.embed({collections:['exam']}) → OK，不再崩溃",
      ].join("\n")),

      // ===== 3 =====
      h1("三、问题二：「一直显示重建中」，762s / 1324s 无结果"),
      h2("3.1 排除法定位"),
      table(
        ["假设", "验证方式", "结论"],
        [
          ["死循环（embedBatchSize=0）", "getSettings().embedBatchSize = 32，且 zod 有 .positive() 校验", "✗ 排除"],
          ["前端传参错误导致全库重建", "前端传的是数组 collections:[\"exam\"]，服务端正确解析", "✗ 排除"],
          ["模型下载 / 网络等待", "模型文件早已存在，无新下载", "✗ 排除"],
          ["从源码编译 llama.cpp", "getLlama 仅 2.1s（build:\"autoAttempt\" 未触发编译）", "✗ 排除"],
          ["多上下文并行导致病态", "本机走 CPU 分支，floor(4/4)=1，本来就是单上下文", "✗ 排除"],
          ["CPU 推理本身慢", "分步计时实测", "✓ 确认"],
        ],
        [3000, 4400, 1626]
      ),

      h2("3.2 实测数据（CPU，4 物理核）"),
      table(
        ["阶段", "耗时"],
        [
          ["getLlama", "2.1 s"],
          ["loadModel（embeddinggemma-300M-Q8）", "约 13 s"],
          ["createEmbeddingContext", "2.2 s"],
          ["首次 embed（预热）", "约 8 s"],
          ["短文本 embed", "0.34 s"],
          ["真实 chunk", "12 ~ 18 s / 条"],
        ],
        [6026, 3000]
      ),

      h2("3.3 关键误判：chunk 数量估错"),
      p("最初用数据库里已有的向量行数（32）反推 chunk 数，得出 ETA 6~7 分钟；实际直接调用分词函数测量："),
      code("考试题库.docx   30709 字符  →  73 个 chunk"),
      rich([{ text: "教训：", bold: true },
        { text: "数据库行数 ≠ 实际 chunk 数（见第七节数据一致性问题），导致 ETA 被低估一倍以上。" }]),

      h2("3.4 结论"),
      p("不是死锁、不是卡死，而是 CPU 算力受限：4 物理核跑 300M 模型，约 20ms/token。73 个 chunk × 12~18s ≈ 15~30 分钟，属于硬件算力下限。"),

      // ===== 4 =====
      h1("四、问题三：服务器崩溃 + 前端计时空转"),
      h2("4.1 现象"),
      p("前端显示「已用时 762s」，但检查发现："),
      code("qmd 进程不存在\n/health 无法连接"),
      h2("4.2 原因"),
      p("服务器在重建过程中崩溃 → HTTP 请求永远不会返回 → 前端的 setInterval 计时器继续空转，给用户「一直在进行中」的错觉。"),
      rich([{ text: "崩溃诱因：", bold: true },
        { text: "排查期间并发运行了多个诊断测试进程，同时加载模型，而当时系统仅剩约 4.5GB 可用内存，造成资源争抢导致进程被杀。" }]),
      h2("4.3 改进"),
      p("服务器启动改为带日志重定向，崩溃时留下证据："),
      code("Start-Process node -ArgumentList \"...bin/qmd\",\"serve\" `\n  -RedirectStandardOutput \"serve.out.log\" -RedirectStandardError \"serve.err.log\""),
      p("后续正是靠日志中的 POST /api/embed (2168856ms) 才确认：那次重建其实已经成功完成（36 分钟）。"),

      // ===== 5 =====
      h1("五、问题四：GPU 认知偏差（最重要的一次纠正）"),
      h2("5.1 我的误判"),
      p("检测到 llama.gpu = \"vulkan\"、VRAM 8GB，便认为是可用 GPU，建议启用。"),
      h2("5.2 用户纠正与核实"),
      p("用户指出「本机压根没有 GPU」。核实结果——用户是对的，只是概念不同："),
      code([
        "Win32_VideoController: Intel(R) UHD Graphics   ← 集成显卡，非独显",
        "qmd status:           Devices: Intel(R) UHD Graphics",
        "                      VRAM: 7.3 GB free / 8.0 GB total   ← 共享内存",
      ].join("\n")),
      h2("5.3 与代码注释的冲突"),
      p("src/llm.ts 注释明确警告："),
      code("在集成显卡（如 Intel UHD）上 Vulkan 卸载比多线程 CPU 推理慢得多——\n实测 rerank 批次 261s vs 单数字秒，所以 CPU 是默认值。"),
      h2("5.4 干净的 A/B 实测（决定性）"),
      p("同一任务（exam 全量 73 chunk）、同一调用链（服务器路径）、无任何并发干扰："),
      table(
        ["模式", "第一批 32/73", "全部完成", "结果"],
        [
          ["集显 Vulkan", "148 s", "257 s（4.3 分钟）", "73/73 全部成功，0 错误"],
          ["CPU（默认 4 核）", "790 s 仍未完成第一批", "预估约 30 分钟", "明显更慢"],
        ],
        [1800, 2200, 2200, 2826]
      ),
      h2("5.5 结论"),
      bullet("上游「集显更慢」的经验来自 rerank（Qwen3-Reranker-0.6B）基准，与 embedding（embeddinggemma-300M）的模型结构/算子/显存占用都不同"),
      bullet("本机器在 embedding 场景下，集显 Vulkan 比 CPU 快约 7 倍"),
      bullet("因此保留 QMD_GPU=vulkan（用户级环境变量，持久生效）"),
      spacer(),
      rich([{ text: "原则：", bold: true },
        { text: "上游注释里的性能结论不能跨模型、跨机器直接套用，必须以本机实测为准。" }]),

      // ===== 6 =====
      h1("六、最终改动汇总"),
      h2("6.1 代码改动（仅 2 处）"),
      table(
        ["文件", "改动", "说明"],
        [
          ["src/api/server.ts", "generateEmbeddings(store, …) → store.embed({…})", "修复 prepare 崩溃"],
          ["src/web/app.js", "重建时显示「已用时 Ns」", "让长任务可感知，避免误判为卡死"],
        ],
        [2800, 3600, 2626]
      ),
      spacer(),
      h2("6.2 环境变量"),
      code("[Environment]::SetEnvironmentVariable(\"QMD_GPU\",\"vulkan\",\"User\")"),
      spacer(),
      h2("6.3 主动撤回的改动（实测反而更慢，已还原）"),
      table(
        ["尝试", "结果", "处理"],
        [
          ["多上下文并行（computeParallelism）", "本机 CPU 分支本就返回 1，且 GPU 分支创建 8 上下文代价高", "撤回"],
          ["推理线程开满 8（cpuCoreCount）", "4 物理核+超线程，开 8 线程后单条从 12s 恶化到 48s", "撤回"],
        ],
        [3200, 4400, 1426]
      ),
      spacer(),
      rich([{ text: "src/llm.ts 最终未做任何修改。", bold: true }]),

      // ===== 7 =====
      h1("七、发现的遗留问题：exam 处于「部分嵌入」状态"),
      code([
        "数据库：exam 只有 32 条向量",
        "实际：  文档有 73 个 chunk",
        "needing embedding = 0     ← 检测不出来！",
      ].join("\n")),
      rich([{ text: "原因：", bold: true },
        { text: "getHashesNeedingEmbedding() 统计的是「完全没有向量的文档（hash）」，只要某个 hash 存在任意一条向量就不再计入。文档内容变多（重索引后 chunk 从 32 涨到 73）时，缺失的 41 个 chunk 不会被发现，会静默影响检索质量。" }]),
      spacer(),
      p("建议："),
      num("立即：重建一次 exam（现在约 4~5 分钟）补齐 73 条"),
      num("根治：把检测逻辑改为「按 chunk 数比对」，或将 chunk 数写入 content_vectors 后校验"),

      // ===== 8 =====
      h1("八、经验教训与思考"),
      h2("8.1 架构层面"),
      num("分层对象的边界必须显式：QMDStore（SDK 层）与 InternalStore（持久层）职责不同，底层函数只应接收 InternalStore。混用时应由类型系统强制，而不是靠记忆。"),
      num("as any 是 Bug 的温床：本次 Bug 完全可以被编译期拦下，却被 store as any 放行。"),
      num("鉴权顺序会掩盖真实错误：建议关键路径补充服务端 error 日志（含 stack）。"),
      h2("8.2 排查方法层面"),
      num("「卡住」必须量化，不能靠感觉：本次靠分步计时才把「疑似死锁」定位为「算力不足」。"),
      num("估算 ETA 要用真实输入规模：用数据库行数反推 chunk 数导致低估一倍以上，应直接调用分词函数测量。"),
      num("性能优化必须 A/B 实测：两次「想当然的优化」（多上下文、多线程）都变成了负优化。尤其超线程环境下，线程数 ≠ 物理核数。"),
      num("不要盲信上游默认值：代码默认禁用 GPU 是基于 rerank 的基准，在 embedding + 本机场景下结论完全相反。"),
      h2("8.3 可观测性层面"),
      num("长任务必须同时具备「进度反馈」和「服务端日志」：缺进度无法区分「慢」和「崩」；缺日志则崩溃后无线索。"),
      num("事务粒度过大：embedBatchSize=32 意味着 32 条算完才 COMMIT，中途崩溃则全部丢失。"),

      // ===== 9 =====
      h1("九、后续改进建议（TODO）"),
      table(
        ["优先级", "建议", "说明"],
        [
          ["高", "消除 store as any，为 embed 定义明确入参类型", "让编译期拦截同类 Bug"],
          ["高", "修复「部分嵌入」检测", "按 chunk 数比对，避免静默缺失"],
          ["高", "embed handler 输出 error stack 到日志", "崩溃 / 失败可追溯"],
          ["中", "缩小事务粒度（如每 8 条提交一次）", "崩溃时保留已完成部分"],
          ["中", "增加真实进度上报（SSE 或轮询状态接口）", "前端显示 12/73 而非只有计时"],
          ["中", "长任务超时保护与友好提示", "避免前端无限等待"],
          ["低", "文档中说明 QMD_GPU 的取舍依据与实测方法", "便于其他机器自行 benchmark"],
        ],
        [1200, 4200, 3626]
      ),

      // ===== 10 =====
      h1("十、一键复现 / 验证命令"),
      code([
        "# 查看设备与后端（确认是否走 GPU）",
        "$env:QMD_GPU=\"vulkan\"; node dist/cli/qmd.js status",
        "",
        "# 服务器（带日志）",
        "Start-Process node -ArgumentList \"F:\\nodejs\\node_modules\\mineru-document-explorer\\bin\\qmd\",\"serve\" `",
        "  -RedirectStandardOutput \"serve.out.log\" -RedirectStandardError \"serve.err.log\"",
        "",
        "# 确认本次重建是否完成（日志中出现该行即完成）",
        "Select-String -Path serve.err.log -Pattern \"api/embed\"",
        "# 例：POST /api/embed (2168856ms)",
      ].join("\n")),
    ],
  }],
});

Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync("重建向量索引问题复盘报告.docx", buffer);
  console.log("OK: 重建向量索引问题复盘报告.docx");
});
