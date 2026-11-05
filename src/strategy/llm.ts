/**
 * 策略 · LLM 策略（带确定性降级）
 *
 * 职责：把"模型不可用"这件事**显式化**。
 *
 * 关键设计（红线：不静默降级）：
 * - 模型可用 → 正常决策，`degraded: false`；
 * - 模型不可用（无 Key / 请求失败 / 超时 / 配额耗尽）→
 *   **降级到确定性基线**，`degraded: true` 且写明 `degradedReason`。
 *
 * 绝不允许"悄悄换一个策略假装无事发生" —— 那样报告里的降级信息就是假的，
 * 而"模型不可用时游戏是否还能玩"恰恰是承诺 C4 要证明的事。
 *
 * 模型接口刻意做得很薄：本项目只需要"给定局面，返回一个合法动作"。
 * 具体接哪家模型由 `LlmClient` 决定，与 aiwarden 的 `ModelClient` 语义对齐
 * （但不共享代码 —— aiwarden 是 Java 且本项目对它是零改动）。
 */

import { HeuristicStrategy } from "./heuristic.js";
import type { Strategy } from "./strategy.js";
import type { Decision, Observation } from "../types/game.js";

/**
 * 模型调用的 token 用量（来源：OpenAI 兼容响应的 `usage`）。
 */
export interface LlmUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

/**
 * 模型选择结果。
 */
export interface LlmPickResult {
  /** 选中的动作 id；null 表示模型没有给出可识别的合法动作。 */
  readonly actionId: string | null;
  /** 本次调用消耗的 token；响应未带 usage 时不填。 */
  readonly usage?: LlmUsage;
}

/**
 * 最小模型客户端契约。
 */
export interface LlmClient {
  /** 模型标识（写进报告，便于区分数据来源）。 */
  readonly name: string;
  /**
   * 从候选动作中挑一个。
   *
   * @param actions 当前局面的全部合法动作（模型只能在其中选）
   * @param prompt 构造好的提示词
   */
  pickAction(params: {
    readonly actions: readonly {
      readonly id: string;
      readonly payload: Readonly<Record<string, unknown>>;
    }[];
    readonly prompt: string;
  }): Promise<LlmPickResult>;
}

/**
 * LLM 策略。
 */
export class LlmStrategy implements Strategy {
  readonly name = "llm";

  /** 降级用的确定性基线。 */
  private readonly fallback = new HeuristicStrategy();

  public constructor(
    private readonly client: LlmClient | null,
    private readonly timeoutMs = 60_000,
  ) {}

  async decide(params: {
    readonly observation: Observation;
    readonly seed: number;
  }): Promise<Decision> {
    const { observation, seed } = params;
    const actions = observation.state.legalActions;

    // 无合法动作 → 终局，与模型是否可用无关（不标降级：那不是降级，是正常结束）
    if (actions.length === 0) {
      return { action: null, reason: "无合法动作", degraded: false };
    }

    // 无模型客户端 → 降级
    if (!this.client) {
      const base = await this.fallback.decide({ observation, seed });
      return {
        ...base,
        degraded: true,
        degradedReason: "未配置模型客户端（AI_API_KEY 缺失或模型端点不可用）",
      };
    }

    try {
      const result = await this.withTimeout(
        this.client.pickAction({
          actions: actions.map((a) => ({ id: a.id, payload: a.payload })),
          prompt: this.buildPrompt(observation),
        }),
      );
      const chosen = actions.find((a) => a.id === result.actionId);
      if (!chosen) {
        // 模型给了非法动作 → 降级（不静默）
        const base = await this.fallback.decide({ observation, seed });
        return {
          ...base,
          degraded: true,
          degradedReason: `模型返回的动作 "${result.actionId ?? "null"}" 不在合法动作集内，已降级到确定性基线`,
          ...(result.usage ? { llmTokens: result.usage.totalTokens } : {}),
          model: this.client.name,
        };
      }
      return {
        action: chosen,
        reason: `模型 ${this.client.name} 选择 ${chosen.id}`,
        degraded: false,
        ...(result.usage ? { llmTokens: result.usage.totalTokens } : {}),
        model: this.client.name,
      };
    } catch (error) {
      const base = await this.fallback.decide({ observation, seed });
      return {
        ...base,
        degraded: true,
        degradedReason: `模型调用失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * 构造提示词。
   *
   * 只给**合法动作**，不让模型臆造。棋盘/局面用可读格式，避免 reasoning 模型
   * 在截断的 JSON 上"分析棋理"把 token 烧完却不给最终 id。
   */
  private buildPrompt(observation: Observation): string {
    const list = observation.state.legalActions
      .map((a) => `- ${a.id} -> ${JSON.stringify(a.payload)}`)
      .join("\n");
    return [
      "你是一个游戏自动测试 Agent 的决策器。",
      "任务：只从下面的合法动作里选一个。",
      "要求：不要分析棋理；不要输出解释；最终只输出一个 id。",
      "",
      `当前执子方：${observation.state.turn ?? "无"}`,
      formatState(observation.state.payload),
      "",
      "合法动作（只能选这些）：",
      list,
      "",
      "只返回一个 id（例如 2,3），不要返回其他文字。",
    ].join("\n");
  }

  /** 给模型调用加超时（超时即降级）。 */
  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`模型调用超时（${this.timeoutMs}ms）`)),
            this.timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * 把局面格式化成模型可读的文本。
 *
 * othello：逐行打印棋盘；chess：FEN + moveCount；其他游戏回退到截断 JSON。
 */
function formatState(payload: Readonly<Record<string, unknown>>): string {
  const fen = payload["fen"];
  if (typeof fen === "string") {
    return `FEN：${fen}\nmoveCount：${String(payload["moveCount"] ?? "?")}`;
  }

  const rawBoard = payload["board"];
  if (Array.isArray(rawBoard) && rawBoard.every((row) => Array.isArray(row))) {
    const rows = (rawBoard as unknown[][]).map((row, index) => `行${index}: ${row.join(" ")}`);
    return ["棋盘（0=空，1=黑，2=白；列从左到右 0..7）：", ...rows].join("\n");
  }

  return `局面：${JSON.stringify(payload).slice(0, 800)}`;
}
