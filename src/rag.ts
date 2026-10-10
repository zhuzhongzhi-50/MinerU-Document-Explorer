/**
 * RAG answer synthesis.
 *
 * Given a user query and the retrieval results from `store.search()`, this module
 * calls an OpenAI-compatible chat-completions endpoint (configured via settings
 * or the LLM_BASE_URL / LLM_API_KEY / LLM_MODEL environment variables) to produce
 * a grounded natural-language answer with citations.
 *
 * If no answer-model is configured, it degrades gracefully to a "retrieval only"
 * mode so the frontend still receives the source chunks.
 */
import { getSettings } from "./settings.js";

/** Minimal shape of a search result we need for synthesis (avoids tight coupling to store types). */
export interface RagSearchResult {
  title: string;
  displayPath: string;
  body?: string;
  bestChunk?: string;
  score: number;
}

export interface RagSource {
  index: number;
  title: string;
  file: string;
  score: number;
}

export interface RagAnswer {
  answer: string;
  model: string;
  /** Present when the answer model is unreachable or errored; `answer` may be empty. */
  error?: string;
  sources: RagSource[];
}

export interface GenerateAnswerOptions {
  /** How many top results to feed into the prompt. Defaults to settings.queryLimit. */
  topK?: number;
  intent?: string;
  /** Called for each streamed answer token (only when the LLM endpoint supports SSE streaming). */
  onToken?: (chunk: string) => void;
}

const SYSTEM_PROMPT = `你是一个基于本地知识库的问答助手。请仅使用下面提供的「参考文档」来回答问题。
要求：
1. 答案必须基于参考文档内容，不得编造或引入文档之外的知识。
2. 在答案中用 [1]、[2] 这样的编号标注引用对应的参考文档。
3. 如果参考文档中没有相关信息，请明确说明"根据现有资料无法回答"，不要猜测。
4. 回答简洁、准确，优先给出直接结论，必要时分条列出。`;

// 通用问答（未选择任何集合时使用）：不注入参考文档，不限制"只能依据文档作答"
const DIRECT_SYSTEM_PROMPT = `你是一个通用智能助手。请直接、清晰地回答用户的问题。
要求：
1. 基于你自身的知识作答，不需要引用任何文档编号。
2. 回答简洁、准确，优先给出直接结论，必要时分条列出。
3. 若问题存在歧义，可先说明你的理解再作答。`;

/**
 * 通用直答：跳过检索环节，直接把问题交给大模型。
 * 与 generateAnswer 的区别：不拼接参考文档上下文，也不套用 RAG 的受限提示词。
 */
export async function generateDirectAnswer(
  query: string,
  opts?: GenerateAnswerOptions,
): Promise<RagAnswer> {
  const settings = getSettings();
  const baseUrl = (settings.llmBaseUrl || process.env.LLM_BASE_URL || "").replace(/\/+$/, "");
  const apiKey = settings.llmApiKey || process.env.LLM_API_KEY || "";
  const model = settings.llmModel || process.env.LLM_MODEL || "";

  if (!baseUrl || !model) {
    return {
      answer:
        "（未配置问答模型：请配置 llmBaseUrl / llmModel / llmApiKey，" +
        "或设置环境变量 LLM_BASE_URL / LLM_MODEL / LLM_API_KEY。）",
      model: "",
      sources: [],
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const buildBody = (stream: boolean) =>
      JSON.stringify({
        model,
        messages: [
          { role: "system", content: DIRECT_SYSTEM_PROMPT },
          { role: "user", content: query },
        ],
        temperature: 0.3,
        stream,
      });

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: buildBody(true),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      return {
        answer: "",
        model,
        sources: [],
        error: `问答 API 错误 ${resp.status}: ${text.slice(0, 500)}`,
      };
    }

    let answer = "";
    const reader = resp.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      let buf = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() || "";
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith("data:")) continue;
            const payload = t.slice(5).trim();
            if (payload === "[DONE]") continue;
            try {
              const json = JSON.parse(payload);
              const delta = json.choices?.[0]?.delta?.content;
              if (delta) {
                answer += delta;
                opts?.onToken?.(delta);
              }
            } catch {
              /* ignore malformed chunk */
            }
          }
        }
      } catch {
        /* stream interrupted — fall through to fallback */
      }
    }

    if (!answer) {
      try {
        const r2 = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: buildBody(false),
          signal: controller.signal,
        });
        if (r2.ok) {
          const j = (await r2.json().catch(() => null)) as { choices?: { message?: { content?: string } }[] } | null;
          answer = String(j?.choices?.[0]?.message?.content ?? "");
          if (answer) opts?.onToken?.(answer);
        }
      } catch {
        /* ignore */
      }
    }

    return { answer, model, sources: [] };
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateAnswer(
  query: string,
  results: ReadonlyArray<RagSearchResult>,
  opts?: GenerateAnswerOptions,
): Promise<RagAnswer> {
  const settings = getSettings();
  const baseUrl = (settings.llmBaseUrl || process.env.LLM_BASE_URL || "").replace(/\/+$/, "");
  const apiKey = settings.llmApiKey || process.env.LLM_API_KEY || "";
  const model = settings.llmModel || process.env.LLM_MODEL || "";

  const topK = opts?.topK ?? settings.queryLimit;
  const topResults = results.slice(0, topK);

  const sources: RagSource[] = topResults.map((r, i) => ({
    index: i + 1,
    title: r.title,
    file: r.displayPath,
    score: Math.round((r.score ?? 0) * 100) / 100,
  }));

  // No answer model configured → retrieval-only mode.
  if (!baseUrl || !model) {
    return {
      answer:
        "（未配置问答模型：请通过 `qmd config set llmBaseUrl <url>`、`qmd config set llmModel <model>`、" +
        "以及 `qmd config set llmApiKey <key>` 配置，或设置环境变量 LLM_BASE_URL / LLM_MODEL / LLM_API_KEY。当前仅返回检索结果。）",
      model: "",
      sources,
    };
  }

  const context = topResults
    .map((r, i) => {
      const chunk = (r.bestChunk || r.body || "").trim();
      return `[${i + 1}] (来源: ${r.displayPath})\n${chunk}`;
    })
    .join("\n\n");

  const userMessage = `参考文档：\n${context}\n\n用户问题：${query}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const buildBody = (stream: boolean) =>
      JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        temperature: 0.3,
        stream,
      });

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: buildBody(true),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      return {
        answer: "",
        model,
        sources,
        error: `问答 API 错误 ${resp.status}: ${text.slice(0, 500)}`,
      };
    }

    // Parse the SSE stream; fall back to a non-streaming request if no tokens arrive.
    let answer = "";
    const reader = resp.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      let buf = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() || "";
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith("data:")) continue;
            const payload = t.slice(5).trim();
            if (payload === "[DONE]") continue;
            try {
              const json = JSON.parse(payload);
              const delta = json.choices?.[0]?.delta?.content;
              if (delta) {
                answer += delta;
                opts?.onToken?.(delta);
              }
            } catch {
              /* ignore malformed chunk */
            }
          }
        }
      } catch {
        /* stream interrupted — fall through to fallback */
      }
    }

    if (!answer) {
      const plain = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: buildBody(false),
        signal: controller.signal,
      });
      if (plain.ok) {
        const data = (await plain.json()) as { choices?: { message?: { content?: string } }[] };
        answer = data.choices?.[0]?.message?.content ?? "";
      }
    }
    return { answer, model, sources };
  } catch (e) {
    return {
      answer: "",
      model,
      sources,
      error: `问答请求失败: ${(e as Error).message}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}
