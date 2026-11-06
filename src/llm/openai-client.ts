/**
 * 模型客户端 · OpenAI 兼容协议
 *
 * 与 `tongshi-ju/lib/ai/provider.ts` 同构（OpenAI 兼容 + 显式降级），
 * 但独立实现 —— 不共享代码，也不依赖 aiwarden（本项目对它是零改动）。
 *
 * 密钥纪律：API Key **只从环境变量读取**，不进 bundle、不入日志、不入报告。
 */

import type { LlmClient, LlmPickResult, LlmUsage } from "../strategy/llm.js";
import { cancellationError, LlmRequestError } from "./request.js";

export interface OpenAiCompatibleOptions {
  /** 端点（OpenAI 兼容，如 https://api.deepseek.com/v1）。 */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /** 单次请求超时（毫秒）。 */
  readonly timeoutMs?: number;
  /** 单次响应最大 token。reasoning 模型需要给推理留余量。 */
  readonly maxTokens?: number;
}

export class OpenAiCompatibleClient implements LlmClient {
  readonly name: string;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;

  public constructor(options: OpenAiCompatibleOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxTokens = options.maxTokens ?? 1024;
    this.name = `openai-compatible:${options.model}`;
  }

  async pickAction(params: {
    readonly actions: readonly {
      readonly id: string;
      readonly payload: Readonly<Record<string, unknown>>;
    }[];
    readonly prompt: string;
    readonly signal?: AbortSignal;
  }): Promise<LlmPickResult> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: "system",
              content:
                "你是一个游戏自动测试 Agent 的决策器。只返回一个合法动作的 id，不要任何解释、不要 markdown 代码块。",
            },
            { role: "user", content: params.prompt },
          ],
          temperature: 0,
          max_tokens: this.maxTokens,
        }),
        signal,
      });

      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new LlmRequestError("http", res.status);
      }

      const data: unknown = await res.json().catch(() => {
        throw new LlmRequestError("invalid-response");
      });
      const root = recordOf(data);
      const usage = usageOf(root?.["usage"]);
      const choices = root?.["choices"];
      const message = Array.isArray(choices) ? recordOf(recordOf(choices[0])?.["message"]) : null;
      // 先保全 usage；空内容/畸形 choices 不得把已知用量变成丢失。
      const content = typeof message?.["content"] === "string" ? message["content"].trim() : "";
      const reasoning =
        typeof message?.["reasoning_content"] === "string"
          ? message["reasoning_content"].trim()
          : "";

      // 依次尝试 content → reasoning：
      // 1) 整段就是 id；
      // 2) 文本里提到合法 id 时取**最后出现**的那个（推理模型通常把结论放末尾）。
      // 任何合法动作都可接受；这里不做棋力判断，只保证不臆造动作。
      for (const source of [content, reasoning]) {
        if (!source) continue;

        const cleaned = source.replace(/^["'`]|["'`]$/g, "").trim();
        const direct = params.actions.find((a) => a.id === cleaned);
        if (direct) {
          return { actionId: direct.id, ...(usage ? { usage } : {}) };
        }

        const mentioned = params.actions
          .map((action) => ({ action, index: lastActionMention(source, action.id) }))
          .filter((item) => item.index >= 0)
          .sort((a, b) => b.index - a.index || b.action.id.length - a.action.id.length);
        if (mentioned.length > 0) {
          return { actionId: mentioned[0]!.action.id, ...(usage ? { usage } : {}) };
        }
      }

      return { actionId: null, ...(usage ? { usage } : {}) };
    } catch (error) {
      if (signal.aborted) throw cancellationError(signal);
      if (error instanceof LlmRequestError) throw error;
      throw new LlmRequestError("network");
    }
  }
}

function recordOf(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function tokenCount(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0;
}

function usageOf(raw: unknown): LlmUsage | undefined {
  const usage = recordOf(raw);
  if (!usage) return undefined;
  const prompt = usage["prompt_tokens"];
  const completion = usage["completion_tokens"];
  const total = usage["total_tokens"];
  // 缺失字段不补 0；仅在两部分都已知时计算总量。
  const totalTokens =
    total === undefined && tokenCount(prompt) && tokenCount(completion)
      ? prompt + completion
      : total;
  if (!tokenCount(totalTokens)) return undefined;
  return {
    totalTokens,
    ...(tokenCount(prompt) ? { promptTokens: prompt } : {}),
    ...(tokenCount(completion) ? { completionTokens: completion } : {}),
  };
}

/** 防止合法 id 2,3 被错误匹配成非法输出 12,30 的子串。 */
function lastActionMention(source: string, id: string): number {
  if (!id) return -1;
  let index = source.lastIndexOf(id);
  while (index >= 0) {
    const before = source[index - 1] ?? "";
    const after = source[index + id.length] ?? "";
    if (!/[A-Za-z0-9_,]/.test(before) && !/[A-Za-z0-9_,]/.test(after)) return index;
    if (index === 0) break;
    index = source.lastIndexOf(id, index - 1);
  }
  return -1;
}

/**
 * 从环境变量构造模型客户端。
 *
 * 缺任何一项都返回 null —— 由调用方走**显式降级**路径，不静默失败。
 */
export function clientFromEnv(): LlmClient | null {
  const base = process.env.AI_API_BASE?.trim();
  const key = process.env.AI_API_KEY?.trim();
  const model = process.env.AI_MODEL?.trim();
  if (!base || !key || !model) return null;

  const maxTokens = Number(process.env.AI_MAX_TOKENS ?? 1024);
  const timeoutMs = Number(process.env.AI_TIMEOUT_MS ?? 60_000);
  return new OpenAiCompatibleClient({
    baseUrl: base,
    apiKey: key,
    model,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 1024,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000,
  });
}
