/**
 * Contract risk-review — prompt templates (based on 运营类合同AI评审提示词 V1.1)
 * plus the special-case auto-trigger definitions.
 *
 * The engine feeds each operational risk rule + retrieved contract passages to the
 * LLM and asks for a strict JSON verdict, then compiles a three-part report.
 */

export const REVIEW_SYSTEM_PROMPT = `你是中建八局二公司合同评审专家，专门负责运营类合同的合规性、风险性评审。

核心原则（必须严格遵守）：
1. 绝对忠于原文：所有风险识别结论必须在合同中找到直接对应的原文条款作为证据，严禁任何推测、臆想或编造。
2. 强制原文映射：每识别出一个风险点，必须同时提供"风险条款原文摘录"＋"对应风险清单序号"＋"风险等级判定"。
3. 禁止缺失信息填充：若合同中未找到某项风险对应的条款，必须如实填写"未在合同中找到相关约定（经全文检索未发现对应条款）"。
4. 禁止矛盾裁决：若合同不同条款对同一事项存在矛盾约定，必须如实并列所有矛盾条款及出处，由用户裁决，不得自行选择"更合理"的一方。
5. 禁止模板套用：每次评审须基于本次提供的合同文件独立进行，严禁套用其他项目的评审结论。
6. 禁止模糊评价：严禁使用"合同约定较为合理"、"基本符合要求"等模糊评价，必须有原文支撑。
7. 强制条目化：所有输出一律采用条目式（编号列表），禁止表格、连续段落或大段叙述。

你将逐项对照《中建八局二公司运营类项目风险要素清单》进行映射核查，任何一项不得遗漏。`;

export interface SpecialCheck {
  id: string;
  label: string;
  /** tag that triggers this check when present on the contract */
  triggerTag: string;
  prompt: string;
}

export const SPECIAL_CHECKS: SpecialCheck[] = [
  {
    id: "consortium",
    label: "联合体项目",
    triggerTag: "联合体",
    prompt:
      "本合同涉及联合体，须额外逐项核查风险清单第31-39项（联合体模式专项风险），不得遗漏：内部权责、管理界面、责任传导、共管账户、管理费、成员退出与补位、分包/采购合规、连带责任、私自对外承诺。",
  },
  {
    id: "energy",
    label: "能管/能源类项目",
    triggerTag: "能源",
    prompt:
      "本合同涉及充电桩、光伏、能源托管等能源类业务，须额外核查：电费结算方式、电力接入责任、设备所有权归属等特殊条款。",
  },
  {
    id: "school_hospital",
    label: "学校/医院类项目",
    triggerTag: "学校医院",
    prompt:
      "本合同涉及教育或医疗场所，须额外核查：业主是否为产权人、场地是否有特殊用途限制。",
  },
  {
    id: "long_cycle",
    label: "15年以上长周期项目",
    triggerTag: "长周期",
    prompt:
      "本合同为15年以上长周期项目，须重点核查：价格调整机制、不可抗力条款、提前退出补偿条款是否完备。",
  },
];

/** Given a contract's tags, return the special checks that should be run. */
export function activeSpecialChecks(tags: string[]): SpecialCheck[] {
  const set = new Set(tags);
  return SPECIAL_CHECKS.filter((c) => set.has(c.triggerTag));
}

/** Prompt for evaluating ONE risk rule against retrieved contract passages,
 *  optionally augmented with wiki knowledge-base references as background. */
export function buildRuleEvaluationPrompt(opts: {
  ruleId: string;
  ruleName: string;
  ruleDescription: string;
  basis: string | null;
  suggestion: string;
  retrieved: string;
  kbRetrieved?: string;
  wikiRefs?: string[];
  specialNote?: string;
}): string {
  const special = opts.specialNote ? `\n【特殊情形提示】${opts.specialNote}\n` : "";
  const kbRefList = opts.wikiRefs && opts.wikiRefs.length
    ? opts.wikiRefs.map((t) => `- ${t}`).join("\n")
    : "";
  const kb = opts.kbRetrieved
    ? `以下是从【知识库（运营 wiki）】检索到的参考依据（仅供制度/模板对照，不得视为合同条款本身）：

命中的知识库页面（制度/模板来源）：
${kbRefList}

参考片段：
"""
${opts.kbRetrieved}
"""

`
    : "";
  return `请对照以下运营类风险清单条目，对提供的合同片段进行评审，并只输出一个 JSON 对象（不要任何额外说明文字）：

风险清单条目：
- 序号/编号：${opts.ruleId}
- 风险点：${opts.ruleName}
- 风险解析：${opts.ruleDescription}
- 制度依据：${opts.basis ?? "（无）"}
- 参考管控举措（修改建议方向）：${opts.suggestion}
${special}
以下是从【待审合同】中检索到的相关片段（作为判定对象，可能不完整，仅作参考）：
"""
${opts.retrieved}
"""

${kb}
输出 JSON 结构（status 取值：triggered=已触发 / not_triggered=未触发 / not_found=合同中未找到相关约定）：
{
  "ruleId": "${opts.ruleId}",
  "status": "triggered | not_triggered | not_found",
  "excerpt": "风险条款原文摘录（逐字摘录，不得概括删改；若 not_found 则固定填：未在合同中找到相关约定（经全文检索未发现对应条款））",
  "excerptLocation": "条款出处，如 合同第X条（not_found 时留空字符串）",
  "analysis": "基于合同原文说明该条款如何触发或未触发该风险",
  "severity": "高 | 中 | 低 | 不适用",
  "suggestion": "针对该条款的具体修改方案或需补充的条款（not_found 时填：建议补充/无需修改）"
}

约束：
- 判定必须以【待审合同】片段为准；【知识库】片段仅作制度/模板对照参考，不得视为合同条款本身，也不得作为 excerpt 来源。
- 必须绝对忠于原文，excerpt 须为待审合同原文逐字摘录。
- 若合同片段中无对应条款，status 必须为 not_found，并如实说明。
- severity 仅在 triggered 时使用 高/中/低；not_triggered/not_found 用 不适用。`;
}

/** Prompt for the overall evaluation (Part 3 of V1.1) given per-rule findings. */
export function buildOverallPrompt(opts: {
  projectInfo: string;
  findingsJson: string;
  specialNotes: string;
}): string {
  return `以下是本次合同评审的逐条发现（JSON 数组）与已提取的项目基本信息。请基于这些内容，输出整体评价，只输出一个 JSON 对象（不要额外说明文字）：

【项目基本信息】
${opts.projectInfo}

【逐条发现】
${opts.findingsJson}

【特殊情形核查结论】
${opts.specialNotes || "（无）"}

输出 JSON 结构（请严格遵循字段名，缺失字段填「（无）」）：
{
  "overallRating": "高风险 | 中高风险 | 中等风险 | 低风险",
  "top5": [
    {
      "ruleId": "OPS-XXX",
      "name": "风险点名称",
      "severity": "高 | 中 | 低",
      "excerpt": "风险条款原文摘录（关键句）",
      "excerptLocation": "出处，如 第4.1条",
      "analysis": "风险解析：为何构成风险、乙方处于何种不利地位",
      "suggestion": "修改建议 / 谈判要点",
      "wikiRefs": "制度或模板依据（来自运营知识库 wiki，多个用、分隔）"
    }
  ],
  "bottomLines": [
    {
      "ruleId": "OPS-XXX",
      "clause": "条款编号及名称",
      "location": "原文出处",
      "analysis": "风险解析：为何属于不可妥协的底线",
      "requirement": "修改要求（必须明确/删除/增设的具体内容）",
      "keyParams": "关键参数：关联条款、风险等级、处置层级（如 谈判底线·一票否决）",
      "wikiRefs": "制度或模板依据"
    }
  ],
  "negotiationPriority": {
    "p1": [ { "id": "1-1", "clauses": "关联条款，如 1.1/1.4/2.4/4.3", "input": "输入（触发风险，如 OPS-012）", "output": "输出（谈判目标）", "keyParams": "关键参数：风险等级/优先级" } ],
    "p2": [ { "id": "2-1", "clauses": "关联条款", "input": "输入（触发风险）", "output": "输出（谈判目标）", "keyParams": "关键参数" } ],
    "p3": [ { "id": "3-1", "clauses": "关联条款", "input": "输入（触发风险）", "output": "输出（谈判目标）", "keyParams": "关键参数" } ]
  },
  "internalApproval": [
    { "matter": "审批事项", "basis": "依据制度（如《运营管理手册》）", "level": "审批层级（如 公司执董会决策，报局审批或备案）", "keyParams": "关键参数：前置审批/报备要求" }
  ]
}

约束：
- top5 按严重程度从高到低排序，最多 5 项；severity 用 高/中/低。
- bottomLines 为不可妥协、必须删除或实质性修改的条款；keyParams 须标注「谈判底线·一票否决」。
- negotiationPriority 分三级：p1=底线条款不改不签，p2=核心风险重点争取，p3=重要但可适度让步；每条用 id 形如 1-1/2-1/3-1，并明确 input（触发风险）与 output（谈判目标），体现「模型输入→输出」逻辑。
- internalApproval 依据《运营管理手册》等公司制度提示前置审批、执董会决策、局审批等。
- 所有字段均须基于前述逐条发现与项目信息，不得臆造条款编号或制度名称；无法确定的字段填「（无）」。`;
}

/** Prompt to extract project basic info (Part 1 of V1.1) from the contract. */
export function buildProjectInfoPrompt(contractText: string): string {
  return `请从以下合同中提取项目基本信息，只输出一个 JSON 对象（不要额外说明文字）。

需提取字段（每条标注出处，如 合同第X条；未提及则填空字符串）：
{
  "projectName": "项目名称与类型（含项目定位、运营业态）",
  "projectNameLoc": "出处",
  "parties": "合同主体（甲方/乙方全称及性质描述）",
  "partiesLoc": "出处",
  "term": "合作期限（年限、起算日、续约条件）",
  "termLoc": "出处",
  "model": "合作模式（托管、租赁、分成等）",
  "modelLoc": "出处",
  "investment": "投资责任（我方承担的投资范围、金额、比例）",
  "investmentLoc": "出处",
  "revenue": "收益分配（分成比例、结算周期、付款条件）",
  "revenueLoc": "出处",
  "exit": "退出机制（终止、提前解约、资产处置）",
  "exitLoc": "出处",
  "breach": "违约责任（违约条款完整摘录）",
  "breachLoc": "出处",
  "insurance": "保险要求（未提及则填：未在合同中找到）",
  "insuranceLoc": "出处",
  "dispute": "争议解决（管辖法院或仲裁机构）",
  "disputeLoc": "出处"
}

合同文本：
"""
${contractText.slice(0, 12000)}
"""`;
}

/**
 * Contract-driven (reverse) review prompt.
 *
 * Unlike buildRuleEvaluationPrompt (which checks ONE known rule against the
 * contract), this starts from a contract clause and asks the LLM to surface ALL
 * risks in it — including ones NOT covered by the standard 44-rule checklist.
 * The `ruleIndex` is supplied only as reference so the model can flag whether a
 * risk is "expected" (already in the checklist) or "unexpected" (novel).
 */
export function buildContractDrivenPrompt(opts: {
  clauseLocation: string;
  clauseText: string;
  kbRetrieved: string;
  wikiRefs: string[];
  ruleIndex: string;
}): string {
  const kbRefList = opts.wikiRefs.length ? opts.wikiRefs.map((t) => `- ${t}`).join("\n") : "";
  const kb = opts.kbRetrieved
    ? `以下是从【运营知识库（wiki）】检索到的参考依据（仅供制度/模板对照，不视为合同条款本身）：

命中的知识库页面：
${kbRefList}

参考片段：
"""
${opts.kbRetrieved}
"""

`
    : "";
  return `你是中建八局二公司合同评审专家，站在乙方（我方）立场。下面给出合同的一段原文条款，请识别其中的风险与问题。

【合同片段】（出处：${opts.clauseLocation}）
"""
${opts.clauseText}
"""

${kb}【现有标准风险清单（44 项，仅作参考，不限于此）】
${opts.ruleIndex}

请只输出一个 JSON 数组（不要任何额外说明文字），列出该片段中识别出的全部风险/问题。对每一项：
- type："expected" 表示该风险已被上面标准清单覆盖（在清单中找最接近的规则编号填入 matchedRule）；"unexpected" 表示标准清单未覆盖、出乎意料的潜在风险（请重点挖掘此类）。
- 必须基于合同原文，不得臆造；severity 取 高/中/低/不适用。

输出结构：
[
  {
    "type": "expected | unexpected",
    "matchedRule": "OPS-XXX（仅 expected 时填；unexpected 填空字符串）",
    "description": "风险点描述（须有条款支撑）",
    "severity": "高 | 中 | 低 | 不适用",
    "suggestion": "修改/补充建议（unexpected 项尤其要给出可落地建议）"
  }
]

约束：
- 忠于原文，description 须有条款支撑。
- 重点产出 unexpected 项：标准清单未覆盖、但结合运营经验/知识库可能酿成损失的隐患（如权属瑕疵、主体不适格、隐性义务、数据/舆情、衍生权益、退出障碍、调价缺位、保险缺位等）。
- 若本片段无可识别风险，输出空数组 []。`;
}
