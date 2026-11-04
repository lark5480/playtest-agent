/**
 * 场景定义。
 *
 * 场景是"跑什么"的声明：步数上限与说明。
 * 具体策略、断言、治理配置在 CLI 组装时决定（见 `src/cli.ts`）。
 */

export interface Scenario {
  /** 场景标识（写进报告与文件名）。 */
  readonly name: string;
  /** 被测游戏（决定适配器与游戏特异断言）。 */
  readonly game: "othello" | "chess";
  /** 步数上限（防止失控长跑）。 */
  readonly maxSteps: number;
  /** 说明。 */
  readonly description: string;
}

/** 内置场景。 */
export const BUILTIN_SCENARIOS: readonly Scenario[] = [
  {
    name: "smoke",
    game: "othello",
    maxSteps: 120,
    description: "跑完一整局，产出完整 StepRecord 链与报告",
  },
  {
    name: "crash",
    game: "othello",
    maxSteps: 120,
    description: "在指定步之后注入崩溃，用于验证续跑不重复副作用",
  },
  {
    name: "chess",
    game: "chess",
    maxSteps: 60,
    description: "跑一局 chess-arena；上限 60 步是为了避开该游戏走子接口 60 次/分钟的内存限流",
  },
];

/**
 * 加载全部场景（内置 + `scenarios/` 目录下的 JSON）。
 */
export function loadScenarios(): Scenario[] {
  return [...BUILTIN_SCENARIOS];
}

/**
 * 按名字找场景。
 */
export function findScenario(scenarios: readonly Scenario[], name: string): Scenario | undefined {
  return scenarios.find((s) => s.name === name);
}
