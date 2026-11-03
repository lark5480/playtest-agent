/**
 * 场景定义。
 *
 * 场景是"跑什么"的声明：步数上限与说明。
 * 具体策略、断言、治理配置在 CLI 组装时决定（见 `src/cli.ts`）。
 */

export interface Scenario {
  /** 场景标识（写进报告与文件名）。 */
  readonly name: string;
  /** 步数上限（防止失控长跑）。 */
  readonly maxSteps: number;
  /** 说明。 */
  readonly description: string;
}

/** 内置场景。 */
export const BUILTIN_SCENARIOS: readonly Scenario[] = [
  {
    name: "smoke",
    maxSteps: 120,
    description: "跑完一整局，产出完整 StepRecord 链与报告",
  },
  {
    name: "crash",
    maxSteps: 120,
    description: "在指定步之后注入崩溃，用于验证续跑不重复副作用",
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
