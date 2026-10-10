/**
 * Demo: validate the contract-review pipeline end-to-end on a real document
 * (济南高新区空港新城幼儿园 供热运维服务合同).
 *
 * The LLM evaluation step is performed by the reviewer offline; this script feeds
 * the resulting findings into the REAL report composer + persistence layer to prove
 * the data/report stages of the flow work (migration v5 already validated on import).
 */
import { createStore } from "../src/store.js";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { importRiskRules, upsertContractMeta, insertAnalysisRecord } from "../src/contract-review/db.js";
import { composeReport, type RuleFinding } from "../src/contract-review/review.js";
import { activeSpecialChecks } from "../src/contract-review/prompt.js";

const DB = "C:\\Users\\wuzhu\\.cache\\qmd\\index.sqlite";
const COLLECTION = "kindergarten-heating";
const DOCID = "KGT-HEAT-2026";

const projectInfo: Record<string, string> = {
  projectName: "济南高新区空港新城幼儿园（临港小镇幼儿园）供热运维服务合同",
  projectNameLoc: "合同标题/首部",
  parties: "甲方：济南高新区空港新城幼儿园（临港小镇幼儿园）；乙方：中建八局（济南）城市建设有限公司",
  partiesLoc: "合同首部/签署页",
  term: "运营期限15年，自2026年11月01日至2041年03月25日",
  termLoc: "第3.1条",
  model: "供热系统运维服务（含能源站建设、运行、维护、检修、技术改造），甲方按面积付费",
  modelLoc: "第一条 服务内容",
  investment: "乙方承担能源站建设、设备更新改造及运维全部费用（1.1/1.4/2.2）；甲方承担非乙方原因损坏及超120天水电费（2.1/3.2）",
  investmentLoc: "第1.1/1.4/2.1/2.2/3.2条",
  revenue: "供暖单价26.7元/㎡，面积4140.43㎡，每供暖季110549.48元；甲方每年供暖季前15日内支付",
  revenueLoc: "第4.1/4.2条",
  exit: "运营期满移交；连续10日室温<20℃或教职工代表大会评价不达标甲方可终止（5.1/12.2）；不可抗力持续90日可解除（9.5）",
  exitLoc: "第5.1/9.5/12.2条",
  breach: "一方未履约，对方有权解除合同并要求赔偿损失（11.1/11.2）",
  breachLoc: "第十一条 违约责任",
  insurance: "未在合同中找到相关约定",
  insuranceLoc: "",
  dispute: "协商不成，向有管辖权的人民法院提起诉讼",
  disputeLoc: "第12.1条",
};

const findings: RuleFinding[] = [
  // ---- 项目准入风险 ----
  { ruleId: "OPS-001", name: "业主资信风险", category: "项目准入风险", status: "triggered", severity: "中",
    excerpt: "合同未约定甲方主体合法存续、无重大违法违规的“陈述与保证”条款，亦未约定甲方被列为失信被执行人/破产时我方单方解除权与赔偿。", excerptLocation: "全文",
    analysis: "甲方为公立幼儿园（事业单位），虽信用等级较高，但合同未设置任何资信承诺与退出赔偿机制，长效回收缺乏保护。",
    suggestion: "增加业主“陈述与保证”条款；约定甲方出现失信/破产等情形时我方有权单方解除并按未完成年限预期收益索赔。" },
  { ruleId: "OPS-002", name: "我方经营资质合规风险", category: "项目准入风险", status: "triggered", severity: "中",
    excerpt: "合同未约定乙方从事供热运维、特种设备作业等所需行政许可资质。", excerptLocation: "全文",
    analysis: "供热运维涉及锅炉/压力容器等特种设备作业，若乙方不具备相应资质，存在无证经营与行政处罚风险。",
    suggestion: "增列乙方资质承诺条款，并约定甲方配合办理经营所需全部证照。" },
  { ruleId: "OPS-003", name: "政府采购程序合规风险", category: "项目准入风险", status: "triggered", severity: "中",
    excerpt: "合同未附中标通知书或任何法定采购程序文件。", excerptLocation: "全文",
    analysis: "公立幼儿园属政府采购主体，若采用直接委托规避招标，合同效力存疑。",
    suggestion: "核查项目是否履行公开招标等法定程序，并将中标通知书作为合同附件。" },
  { ruleId: "OPS-004", name: "项目合法性手续不齐全风险", category: "项目准入风险", status: "not_found", severity: "不适用",
    excerpt: "未在合同中找到新建工程审批/指标批复等条款（本合同为运维服务，不含新建）。", excerptLocation: "",
    analysis: "1.1提及“能源站建设”，但属乙方既有设施改造，不触发省级能源指标批复类手续。",
    suggestion: "如能源站涉及新建立项，另行核查立项/规划/施工许可。" },
  { ruleId: "OPS-005", name: "资产权属与合规性风险", category: "项目准入风险", status: "triggered", severity: "中",
    excerpt: "第7.3条“甲方应向乙方无偿提供托管所需管理用房”；第1.1条“乙方负责能源站建设”；第2.1条“甲方现有设备…由甲方负责”；第4.3条水费收款账户为“济南高新区稼轩小学”而非甲方。", excerptLocation: "第1.1/2.1/7.3/4.3条",
    analysis: "存量与增量资产权属不清，移交后能源站设备归属未定；水费付至“稼轩小学”暗示甲方可能非产权人，存在权属瑕疵。",
    suggestion: "进场前明确存量/增量资产权属与移交清单；核实甲方是否为产权人，若否须取得产权人书面授权。" },
  { ruleId: "OPS-006", name: "一房多租/抵押查封风险", category: "项目准入风险", status: "not_found", severity: "不适用",
    excerpt: "未在合同中找到相关约定（经全文检索未发现对应条款）。", excerptLocation: "",
    analysis: "管理用房由甲方提供，但合同未披露其抵押/查封状态。",
    suggestion: "建议签约前查询甲方提供用房的抵押查封信息。" },
  { ruleId: "OPS-007", name: "违法建筑/临时建筑风险", category: "项目准入风险", status: "not_found", severity: "不适用",
    excerpt: "未在合同中找到相关约定（经全文检索未发现对应条款）。", excerptLocation: "",
    analysis: "合同未涉及房屋合法性，但供暖设施依附于园所建筑。",
    suggestion: "建议核验园所建设工程规划许可与竣工验收资料。" },
  { ruleId: "OPS-008", name: "房屋结构安全风险", category: "项目准入风险", status: "not_found", severity: "不适用",
    excerpt: "未在合同中找到相关约定（经全文检索未发现对应条款）。", excerptLocation: "",
    analysis: "运维合同不涉及房屋结构，本项不触发。",
    suggestion: "不适用。" },
  { ruleId: "OPS-009", name: "内部决策程序风险", category: "项目准入风险", status: "triggered", severity: "中",
    excerpt: "合同未体现乙方就能源站建设及改造投入所履行的立项、可研、决策批复。", excerptLocation: "全文",
    analysis: "乙方承担能源站建设及改造费用，构成长期投入，应按投资履行二级单位至局（股份公司）的决策流程，合同未见。",
    suggestion: "签约前完成《运营项目立项建议书》《可研报告》编制与审批，取得书面批复。" },
  { ruleId: "OPS-010", name: "业主搬迁、变更风险", category: "项目准入风险", status: "triggered", severity: "低",
    excerpt: "合同未约定甲方（幼儿园）搬迁、合并时的运营处理机制。", excerptLocation: "全文",
    analysis: "幼儿园运营期内存在搬迁/合并可能，影响15年收益回收。",
    suggestion: "约定业主变更/搬迁时签订补充协议，明确运营管理及补偿事宜。" },

  // ---- 建设与改造期风险 ----
  { ruleId: "OPS-011", name: "工期延误风险", category: "建设与改造期风险", status: "triggered", severity: "中",
    excerpt: "第1.1条“乙方负责能源站建设”；第2.2条“由乙方一次处理完成，使供暖达到要求”；无改造工期及延误责任约定。", excerptLocation: "第1.1/2.2条",
    analysis: "改造无明确日历工期，亦无非乙方原因（场地移交、审批滞后）导致延误的顺延机制。",
    suggestion: "明确改造工期及非乙方原因延误的运营期起算顺延机制。" },
  { ruleId: "OPS-012", name: "装修改造审批可行性风险", category: "建设与改造期风险", status: "triggered", severity: "中",
    excerpt: "第1.1/2.2条涉及能源站建设及升级改造，但未约定施工许可、消防设计审查与验收的责任主体。", excerptLocation: "第1.1/2.2条",
    analysis: "既有建筑改造需施工许可与消防验收，若因非乙方原因无法办理，项目面临无法合法运营。",
    suggestion: "明确“如非乙方原因导致无法办理施工许可或消防验收，甲方赔偿乙方全部损失”。" },
  { ruleId: "OPS-013", name: "成本超支风险", category: "建设与改造期风险", status: "triggered", severity: "中",
    excerpt: "第2.2条“由乙方一次处理完成，使供暖达到要求”；第1.4条“相关费用由乙方承担”；无总投资上限与变更签证机制。", excerptLocation: "第1.4/2.2条",
    analysis: "缺乏限额设计与变更签证，甲方提出的改造变更致投资超批复部分将全部由乙方承担。",
    suggestion: "合同明确“限额设计”与总投资上限；业主变更导致投资增加的由业主承担或调增服务费。" },
  { ruleId: "OPS-014", name: "建设期环境合规风险", category: "建设与改造期风险", status: "not_found", severity: "不适用",
    excerpt: "未在合同中找到相关约定（经全文检索未发现对应条款）。", excerptLocation: "",
    analysis: "能源站改造规模小，环境合规风险低。",
    suggestion: "施工仍应遵守扬尘/噪声/废弃物处置法规。" },
  { ruleId: "OPS-015", name: "验收标准主观化风险", category: "建设与改造期风险", status: "triggered", severity: "中",
    excerpt: "第2.2条“使供暖达到要求”（主观）；第5.1条“室内温度不低于20℃”（客观）。", excerptLocation: "第2.2/5.1条",
    analysis: "改造验收以“达到要求”这一主观表述为准，易被甲方拖延验收、拒绝进入付费期。",
    suggestion: "将验收标准客观化并以第三方检测报告为依据；增设“视为验收合格”条款。" },

  // ---- 运营收益与收入风险 ----
  { ruleId: "OPS-016", name: "价格与成本锁定风险", category: "运营收益与收入风险", status: "triggered", severity: "高",
    excerpt: "第4.1条“供暖单价26.7元/㎡”固定；第3.1条期限15年；第4.3条电费由乙方承担；第4.4条仅水电费“因国家政策…双方协商据实调整”。", excerptLocation: "第3.1/4.1/4.3/4.4条",
    analysis: "15年固定服务费且缺乏调价机制，能源、人工等成本上涨全由乙方承担；调价仅覆盖水电费，服务费被完全锁定，严重侵蚀长期利润。",
    suggestion: "建立调价机制：CPI/能源基准价格累计变动超±5%时服务费按公式自动调整；协商不成由当地发改委核定；约定政策变更致项目无意义时我方退出并收回投资。" },
  { ruleId: "OPS-017", name: "支付延迟风险", category: "运营收益与收入风险", status: "triggered", severity: "中",
    excerpt: "第4.2条“每年供暖季（每年11月15日）开始前15天内…甲方向乙方缴纳”；未约定逾期付款违约责任。", excerptLocation: "第4.2条",
    analysis: "事业单位付款审批流程长，且无逾期违约金，乙方现金流承压。",
    suggestion: "约定逾期付款违约金（如每日万分之五）；逾期超60日我方有权暂停服务且不构成违约。" },
  { ruleId: "OPS-018", name: "最低收入保障缺失风险", category: "运营收益与收入风险", status: "triggered", severity: "中",
    excerpt: "第3.2条“乙方每供暖季服务总天数不得超过120天，若超过120天…由甲方自行承担”；第4.1条面积固定4140.43㎡。", excerptLocation: "第3.2/4.1条",
    analysis: "服务天数设上限但未约定保底消费，若实际供暖天数/用能不足，乙方收入不确定。",
    suggestion: "明确计费基数与保底供暖天数；用量连续多年低于预估时启动重新议价或退出补偿。" },
  { ruleId: "OPS-019", name: "合同条款与招标文件不一致风险", category: "运营收益与收入风险", status: "not_found", severity: "不适用",
    excerpt: "未在合同中找到相关约定（需比对招标文件）。", excerptLocation: "",
    analysis: "无法从合同文本判断是否与招标文件一致。",
    suggestion: "中标后逐条比对合同与招标文件，重点核查运营范围与付款条件。" },
  { ruleId: "OPS-020", name: "衍生权益归属风险", category: "运营收益与收入风险", status: "triggered", severity: "低",
    excerpt: "第2.3/2.5条乙方承担节能目标、建立节能管理体系，但未约定节能补贴/碳交易等衍生权益归属。", excerptLocation: "第2.3/2.5条",
    analysis: "乙方投入节能改造产生的节能补贴、碳交易权等权益未明确归属，可能丧失额外收益。",
    suggestion: "明确节能补贴、碳交易权等衍生权益归乙方所有或按比例分成。" },
  { ruleId: "OPS-021", name: "项目投资回报测算风险", category: "运营收益与收入风险", status: "not_found", severity: "不适用",
    excerpt: "未在合同中找到相关约定（属内部决策事项）。", excerptLocation: "",
    analysis: "需结合调价机制缺失（OPS-016）重测全投资内部收益率。",
    suggestion: "可研阶段做保守/中性/乐观三情景测算并敏感性分析。" },

  // ---- 合同终止与资产处置风险 ----
  { ruleId: "OPS-022", name: "服务考核标准苛刻/主观化风险", category: "合同终止与资产处置风险", status: "triggered", severity: "高",
    excerpt: "第12.2条“甲方有权召开教职工代表大会对实际供暖效果进行综合评价。如教职工代表大会评价供暖不达标，甲方有权终止合同”。", excerptLocation: "第12.2条",
    analysis: "“教职工代表大会综合评价”属主观考核，极易被甲方恶意利用作为终止合同、拒付服务费的借口，且无第三方评判机制。",
    suggestion: "以客观KPI（室温达标率、报修响应时间等）替代主观评价；设争议时第三方专家评审；明确考核扣款年度上限。" },
  { ruleId: "OPS-023", name: "备品备件供应风险", category: "合同终止与资产处置风险", status: "triggered", severity: "中",
    excerpt: "合同未约定核心设备备件供应年限或替代方案。", excerptLocation: "全文",
    analysis: "15年运营期内核心设备可能停产断供，导致无法维修、被迫整体更换。",
    suggestion: "约定核心设备最低备件供应年限；设备停产时我方有权用满足性能要求的替代产品维修/更换。" },
  { ruleId: "OPS-024", name: "维保范围无限扩大风险", category: "合同终止与资产处置风险", status: "triggered", severity: "高",
    excerpt: "第1.4条“乙方应负责供热设备的定期检查、维修、保养、更新，确保设备使用寿命达到附件要求，相关费用由乙方承担”；第2.4条“运维界面内的运行、值守、维保工作由乙方负责”。", excerptLocation: "第1.4/2.4条",
    analysis: "未区分甲方存量老旧设备与乙方增量资产，“设备”一词可能被解释为甲方全部存量资产，使乙方为年久失修的存量设备承担终生免费保修。",
    suggestion: "进场前双方共同盘点封存“甲方原有设备清单”并书面确认状态；明确乙方仅对所投增量资产承担维保，存量资产大修/更换费用由甲方承担。" },
  { ruleId: "OPS-025", name: "安全生产事故风险", category: "合同终止与资产处置风险", status: "triggered", severity: "中",
    excerpt: "第8.8条仅要求“衣着整齐、文明施工”，未约定安全生产责任与保险。", excerptLocation: "第8.8条",
    analysis: "供热运维涉及设备检修与校园施工，存在工伤、机械伤害等风险，缺安全责任与保险安排。",
    suggestion: "强制执行安全生产制度；购买安全生产责任险并归档保单；建立事故即时报告与应急流程。" },
  { ruleId: "OPS-026", name: "人员管理合规风险", category: "合同终止与资产处置风险", status: "triggered", severity: "低",
    excerpt: "第6条项目经理张伟；第8.2条“安排专业人员培训、督导”。", excerptLocation: "第6/8.2条",
    analysis: "未要求下游分包/作业人员签订劳动合同、缴纳社保及持证上岗。",
    suggestion: "要求分包商提供人员劳动合同、社保凭证并月度抽查；特种作业人证合一。" },
  { ruleId: "OPS-027", name: "舆情风险", category: "合同终止与资产处置风险", status: "not_found", severity: "不适用",
    excerpt: "未在合同中找到相关约定（经全文检索未发现对应条款）。", excerptLocation: "",
    analysis: "校园供暖涉及师生安全，舆情风险客观存在但合同未约定。",
    suggestion: "建立舆情应急预案，购买公众责任险。" },
  { ruleId: "OPS-028", name: "出租人擅自解约/干预运营风险", category: "合同终止与资产处置风险", status: "triggered", severity: "低",
    excerpt: "第11.1/11.2条可解除并要求赔偿；第13.4条期满顺延；无政策性解约补偿。", excerptLocation: "第11.1/11.2/13.4条",
    analysis: "未约定甲方因政策调整（事业单位改制、资产划转）单方终止时的补偿机制。",
    suggestion: "约定政策性解约的补偿标准，覆盖我方全部投入及预期收益。" },
  { ruleId: "OPS-029", name: "提前终止合同的补偿风险", category: "合同终止与资产处置风险", status: "triggered", severity: "高",
    excerpt: "第11.1/11.2条“要求乙方/甲方赔偿损失”，未明确补偿计算标准（已投入成本、未摊销成本、预期收益）。", excerptLocation: "第11.1/11.2条",
    analysis: "业主因自身原因提前终止时，无明确补偿标准，乙方无法收回全部投资与预期收益。",
    suggestion: "明确提前终止补偿标准，覆盖全部已投入成本、未摊销成本及预期收益损失，并约定支付时限与逾期违约金。" },
  { ruleId: "OPS-030", name: "移交后终身免费技术支持风险", category: "合同终止与资产处置风险", status: "not_found", severity: "不适用",
    excerpt: "第3.1条运营期结束全面检修、第8.10条移交时一次全面维护（均为一次性，非终身）。", excerptLocation: "第3.1/8.10条",
    analysis: "移交维护为一次性约定，未形成终身免费技术支持，本项未触发。",
    suggestion: "不适用。" },

  // ---- 联合体模式专项风险（非联合体项目，按自动触发规则跳过） ----
  ...["OPS-031","OPS-032","OPS-033","OPS-034","OPS-035","OPS-036","OPS-037","OPS-038","OPS-039"].map((id, i) => ({
    ruleId: id, name: "联合体相关风险", category: "联合体模式专项风险", status: "not_triggered" as const, severity: "不适用",
    excerpt: "本合同非联合体模式，未触发第31-39项专项核查。", excerptLocation: "",
    analysis: "自动触发开关判定：合同乙方为单一主体（中建八局（济南）城市建设有限公司），无联合体成员，故跳过联合体专项风险。",
    suggestion: "不适用（非联合体）。" })),

  // ---- 全周期风险 ----
  { ruleId: "OPS-040", name: "不可抗力与法律变更风险", category: "全周期风险", status: "triggered", severity: "中",
    excerpt: "第9.1-9.5条不可抗力约定较完整；第4.4条仅“因国家政策电价、水价调整，双方协商据实调整”（仅限水电费）。", excerptLocation: "第4.4/9.1-9.5条",
    analysis: "法律/政策变更仅覆盖水电费，服务费无对应调价或退出机制，电价改革等致成本大增时乙方单方承压。",
    suggestion: "增加“法律变更”条款：政策变动致新增成本双方协商分担或启动调价；项目继续履行无意义时我方退出并补偿。" },
  { ruleId: "OPS-041", name: "发票与税务合规风险", category: "全周期风险", status: "triggered", severity: "低",
    excerpt: "第4.2条“乙方收取费用后提供6%的增值税专用发票”。", excerptLocation: "第4.2条",
    analysis: "税率固定为6%，无国家税率调整时合同总价同步调整机制。",
    suggestion: "约定税率调整时合同总价同步调整；防范甲方以“开票不合规”为由顺延付款。" },
  { ruleId: "OPS-042", name: "数据安全与隐私保护风险", category: "全周期风险", status: "triggered", severity: "低",
    excerpt: "第5.1条温度传感器数据采集；第2.6条运行策略。", excerptLocation: "第2.6/5.1条",
    analysis: "合同采集用能、室温等数据，但未约定数据使用目的、保密与泄露责任。",
    suggestion: "增设数据安全保护条款，明确采集/使用/存储权限与目的，不向第三方泄露。" },
  { ruleId: "OPS-043", name: "保险覆盖不足风险", category: "全周期风险", status: "triggered", severity: "中",
    excerpt: "合同全文未约定任何保险投保义务。", excerptLocation: "全文",
    analysis: "未投保财产险、公众责任险、安全生产责任险，发生风险后损失由乙方自担。",
    suggestion: "制定保险方案，覆盖财产险、公众责任险、安责险，合理确定保额。" },
  { ruleId: "OPS-044", name: "运营合同续约风险", category: "全周期风险", status: "triggered", severity: "中",
    excerpt: "第13.4条“合同期满前两个月，甲、乙双方应就延长或续签本合同期限达成协议”。", excerptLocation: "第13.4条",
    analysis: "未约定我方同等条件下的优先续约权，期满重新招标时前期投入可能难以足额回收。",
    suggestion: "明确运营期满后我方在同等条件下享有优先续约权，细化续约启动节点与磋商流程。" },
];

const overall = {
  overallRating: "高风险",
  top5: [
    { ruleId: "OPS-016", name: "价格与成本锁定风险", reason: "15年固定单价且无调价机制，成本上涨全由乙方承担" },
    { ruleId: "OPS-024", name: "维保范围无限扩大风险", reason: "“设备”未区分存量/增量，乙方或承担甲方全部老旧设备终生维保" },
    { ruleId: "OPS-022", name: "服务考核标准主观化风险", reason: "教职工代表大会主观评价即可终止合同，易被恶意利用" },
    { ruleId: "OPS-029", name: "提前终止补偿缺失", reason: "仅泛称“赔偿损失”，未覆盖全部投入+预期收益" },
    { ruleId: "OPS-005", name: "资产权属/业主产权不清", reason: "水费付至稼轩小学，甲方可能非产权人，权属存疑" },
  ],
  bottomLines: [
    { ruleId: "OPS-016", clause: "第4.1/4.4条 服务费单价", location: "第4.1/4.4条", requirement: "增设CPI/能源价格±5%自动调价及协商不成由发改委核定的终结机制" },
    { ruleId: "OPS-024", clause: "第1.4/2.4条 维保范围", location: "第1.4/2.4条", requirement: "明确仅乙方增量资产维保，进场盘点封存甲方存量设备清单" },
    { ruleId: "OPS-029", clause: "第11.1/11.2条 终止赔偿", location: "第11.1/11.2条", requirement: "量化提前终止补偿=已投入+未摊销成本+预期收益，并设支付时限" },
    { ruleId: "OPS-022", clause: "第12.2条 考核终止", location: "第12.2条", requirement: "以客观KPI替代教职工代表大会主观评价，设第三方评审与扣款上限" },
    { ruleId: "OPS-005", clause: "第7.3/4.3条 权属", location: "第7.3/4.3条", requirement: "核实甲方产权人身份，非产权人时取得书面授权" },
  ],
  negotiationPriority: {
    p1: [
      "1-1：第4.1/4.4条——建立服务费调价机制（底线性，不改不签）",
      "2-1：第1.4/2.4条——限定维保范围为乙方增量资产",
      "3-1：第11.1/11.2条——量化提前终止补偿标准",
      "4-1：第12.2条——考核标准客观化+第三方评审",
      "5-1：第7.3/4.3条——确认产权人身份并取得授权",
    ],
    p2: [
      "2-1：第4.2条——逾期付款违约金+暂停服务权",
      "2-2：第2.2条——改造验收客观化+视为验收合格",
      "2-3：第4.4/9条——法律变更调价与退出机制",
      "2-4：第2.2/1.4条——限额设计+变更签证由甲方承担",
    ],
    p3: [
      "3-1：第1条——乙方资质承诺+甲方配合办理",
      "3-2：第3.2条——保底供暖天数",
      "3-3：第13.4条——优先续约权",
      "3-4：第2.3/2.5条——节能衍生权益归属乙方",
    ],
  },
  internalApproval: [
    { matter: "能源站建设及改造投入立项决策", basis: "《运营项目立项与决策管理办法》权限划分", level: "二级单位→局（股份公司）决策" },
    { matter: "合同评审与签署授权", basis: "合同管理相关制度", level: "按金额权限审批" },
    { matter: "保险方案采购", basis: "风险管控要求", level: "运营/财务条线审批" },
    { matter: "调价机制等核心条款谈判", basis: "商务授权", level: "需取得书面授权后方可承诺" },
  ],
};

const tags = ["学校医院", "长周期", "能源"];
const specialChecks = activeSpecialChecks(tags);

const store = createStore(DB);
importRiskRules(store.db);

const markdown = composeReport({ projectInfo, findings, overall, specialChecks, collection: COLLECTION });

const reportDir = join(dirname(DB), "reports");
if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
const reportPath = join(reportDir, `${DOCID}-risk-report.md`);
writeFileSync(reportPath, markdown, "utf-8");

upsertContractMeta(store.db, { docid: DOCID, title: projectInfo.projectName, collection: COLLECTION, tags });
const id = insertAnalysisRecord(store.db, {
  docid: DOCID,
  rulesetVersion: "1.0.0",
  reportPath,
  summaryJson: JSON.stringify({
    overall: overall.overallRating,
    counts: {
      total: findings.length,
      triggered: findings.filter((f) => f.status === "triggered").length,
      not_triggered: findings.filter((f) => f.status === "not_triggered").length,
      not_found: findings.filter((f) => f.status === "not_found").length,
    },
  }),
});

console.log(`✓ Report written: ${reportPath}`);
console.log(`✓ Analysis record id=${id}, docid=${DOCID}`);
console.log(`✓ Special checks activated: ${specialChecks.map((c) => c.label).join("、")}`);
console.log(`✓ Triggered risks: ${findings.filter((f) => f.status === "triggered").length}/${findings.length}`);
