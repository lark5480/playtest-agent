import type { LlmClient, LlmPickResult } from "../strategy/llm.js";
import type { ModelAttempt, ModelBudgetState, RunBudget } from "../types/budget.js";
import { StrategyStop } from "../types/run.js";
import { abortable, cancellationError, LlmRequestError } from "./request.js";

export interface BudgetOptions {
  readonly maxCalls: number;
  /** 已知 token 的软停止线，不是云端费用硬上限。 */
  readonly tokenLimit?: number;
  readonly initial?: ModelBudgetState;
  readonly batch?: BatchBudget;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** CLI 可在创建房间/发请求之前验证参数；0 表示明确禁用模型调用。 */
export function validate(options: {
  readonly maxCalls: number;
  readonly tokenLimit?: number;
}): void {
  if (!count(options.maxCalls)) throw new Error("maxCalls 须为非负安全整数");
  if (options.tokenLimit !== undefined && !count(options.tokenLimit)) {
    throw new Error("tokenLimit 须为非负安全整数");
  }
}

/** 检查点是运行时输入，不依赖 TypeScript 断言冒充校验。 */
export function validateModelBudgetState(value: unknown): asserts value is ModelBudgetState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("模型预算检查点格式无效");
  }
  const raw = value as Record<string, unknown>;
  if (!count(raw["maxCalls"]) || (raw["tokenLimit"] !== undefined && !count(raw["tokenLimit"]))) {
    throw new Error("模型预算检查点配置无效");
  }
  const attempts = raw["attempts"];
  if (!Array.isArray(attempts) || attempts.length > raw["maxCalls"]) {
    throw new Error("模型预算检查点账目无效");
  }
  let total = 0;
  for (const [index, value] of attempts.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("模型预算检查点调用记录无效");
    }
    const attempt = value as Record<string, unknown>;
    if (attempt["callId"] !== index + 1) throw new Error("模型预算 callId 必须从 1 连续递增");
    if (attempt["state"] === "settled") {
      if (!count(attempt["tokens"])) throw new Error("已结算模型调用必须有已知用量");
      total += attempt["tokens"];
      if (!Number.isSafeInteger(total)) throw new Error("模型用量超出安全整数范围");
    } else if (attempt["state"] === "unknown" || attempt["state"] === "in-flight") {
      if (attempt["tokens"] !== undefined || index !== attempts.length - 1) {
        throw new Error("未知或在途调用不得包含用量或后续调用");
      }
    } else {
      throw new Error("模型预算调用状态无效");
    }
  }
}

function stop(message: string): StrategyStop {
  return new StrategyStop("budget-limit", message);
}

/** 同一次串行 scan 共享一个实例，不随 seed/单局 wrapper 重置。 */
export class BatchBudget {
  private calls = 0;
  private blocked = false;
  private active = false;

  constructor(readonly maxCalls: number) {
    validate({ maxCalls });
  }

  get usedCalls(): number {
    return this.calls;
  }
  get exhausted(): boolean {
    return this.blocked || this.calls >= this.maxCalls;
  }

  /** 预扣；不退款，包括请求前持久化失败的保守停止。 */
  reserve(): void {
    if (this.exhausted || this.active) throw stop("整批模型预算已停止或已有在途请求");
    this.calls++;
    this.active = true;
  }

  finish(unknown = false): void {
    this.active = false;
    this.blocked ||= unknown;
  }
}

/** 独立请求账本是预算权威源；从不读取或累加 StepRecord。 */
export class BudgetedLlmClient implements LlmClient, RunBudget {
  readonly name: string;
  private readonly maxCalls: number;
  private readonly tokenLimit: number | undefined;
  private readonly batch: BatchBudget | undefined;
  private readonly attempts: ModelAttempt[];
  private save: (() => void) | undefined;
  private persistenceFailed = false;
  private active = false;

  constructor(
    private readonly client: LlmClient,
    options: BudgetOptions,
  ) {
    validate(options);
    this.name = client.name;
    this.maxCalls = options.maxCalls;
    this.tokenLimit = options.tokenLimit;
    this.batch = options.batch;
    if (options.initial !== undefined) {
      validateModelBudgetState(options.initial);
      if (
        options.initial.maxCalls !== this.maxCalls ||
        options.initial.tokenLimit !== this.tokenLimit
      ) {
        throw new Error("恢复模型预算配置不匹配");
      }
    }
    this.attempts = (options.initial?.attempts ?? []).map((attempt) =>
      attempt.state === "settled"
        ? { callId: attempt.callId, state: "settled", tokens: attempt.tokens! }
        : { callId: attempt.callId, state: "unknown" },
    );
    // 旧 in-flight 可能已收费：不退额度、不重发；也阻止同批继续收费。
    if (this.attempts.some((attempt) => attempt.state === "unknown")) this.batch?.finish(true);
  }

  snapshot(): ModelBudgetState {
    return {
      maxCalls: this.maxCalls,
      ...(this.tokenLimit === undefined ? {} : { tokenLimit: this.tokenLimit }),
      attempts: this.attempts.map((attempt) => ({ ...attempt })),
    };
  }

  bindPersistence(save: () => void): void {
    this.save = save;
  }

  async pickAction(params: Parameters<LlmClient["pickAction"]>[0]): Promise<LlmPickResult> {
    this.assertAvailable();
    if (params.signal?.aborted) throw cancellationError(params.signal);
    this.batch?.reserve();
    this.active = true;
    const index = this.attempts.length;
    const callId = index + 1;
    this.attempts.push({ callId, state: "in-flight" });
    try {
      // 必须先保存预扣意图；此处失败不得进入底层客户端。
      this.persist();
      let result: LlmPickResult;
      try {
        result = await abortable(params.signal, () => this.client.pickAction(params));
      } catch (error) {
        this.attempts[index] = { callId, state: "unknown" };
        this.batch?.finish(true);
        this.persist();
        if (error instanceof StrategyStop || error instanceof LlmRequestError) throw error;
        throw new LlmRequestError("network");
      }
      const tokens = result.usage?.totalTokens;
      this.attempts[index] = count(tokens)
        ? { callId, state: "settled", tokens }
        : { callId, state: "unknown" };
      if (!count(tokens)) this.batch?.finish(true);
      // 无效动作仍然结算；保存失败不给策略返回结果（也不给降级动作）。
      this.persist();
      return count(tokens) ? result : { actionId: result.actionId };
    } finally {
      this.active = false;
      this.batch?.finish(this.persistenceFailed);
    }
  }

  private assertAvailable(): void {
    const known = this.attempts.reduce((sum, attempt) => sum + (attempt.tokens ?? 0), 0);
    if (
      this.persistenceFailed ||
      this.active ||
      this.batch?.exhausted ||
      this.attempts.length >= this.maxCalls ||
      this.attempts.some((attempt) => attempt.state !== "settled") ||
      (this.tokenLimit !== undefined && known >= this.tokenLimit)
    )
      throw stop("模型预算已达停止线，或存在未结清用量");
  }

  private persist(): void {
    try {
      this.save?.();
    } catch {
      this.persistenceFailed = true;
      throw stop("模型预算持久化失败，已停止模型调用");
    }
  }
}
