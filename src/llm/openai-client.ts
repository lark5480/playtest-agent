/**
 * 模型客户端 · OpenAI 兼容协议
 *
 * 与 `tongshi-ju/lib/ai/provider.ts` 同构（OpenAI 兼容 + 显式降级），
 * 但独立实现 —— 不共享代码，也不依赖 aiwarden（本项目对它是零改动）。
 *
 * 密钥纪律：API Key **只从环境变量读取**，不进 bundle、不入日志、不入报告。
 */

import type { LlmClient } from "../strategy/llm.js";

export interface OpenAiCompatibleOptions {
  /** 端点（OpenAI 兼容，如 https://api.deepseek.com/v1）。 */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /** 单次请求超时（毫秒）。 */
  readonly timeoutMs?: number;
}

export class OpenAiCompatibleClient implements LlmClient {
  readonly name: string;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  public constructor(options: OpenAiCompatibleOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.name = `openai-compatible:${options.model}`;
  }

  async pickAction(params: {
    readonly actions: readonly {
      readonly id: string;
      readonly payload: Readonly<Record<string, unknown>>;
    }[];
    readonly prompt: string;
  }): Promise<string | null> {
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
        max_tokens: 64,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      throw new Error(
        `模型请求失败：HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 120)}`,
      );
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("模型返回内容为空");

    // 模型可能回一句解释 —— 取第一个合法动作 id 匹配
    const cleaned = content.replace(/^["'`]|["'`]$/g, "").trim();
    const direct = params.actions.find((a) => a.id === cleaned);
    if (direct) return direct.id;

    const mentioned = params.actions.find((a) => content.includes(a.id));
    if (mentioned) return mentioned.id;

    return null;
  }
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
  return new OpenAiCompatibleClient({ baseUrl: base, apiKey: key, model });
}
