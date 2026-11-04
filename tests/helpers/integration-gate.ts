/**
 * 集成测试的「跳过 vs 失败」策略（唯一权威源）。
 *
 * - 依赖可用：正常跑。
 * - 依赖不可用 + 未强制：本地开发跳过，但必须打印
 *   `SKIPPED: <依赖> 未启动（设置 PLAYTEST_REQUIRE_INTEGRATION=1 强制失败）`，
 *   不伪装通过。
 * - 依赖不可用 + 已强制：用例直接失败（assert.fail），不允许 skip 兜绿。
 *
 * 强制方式（显式，不依赖 CI 的隐式副作用）：
 *   PLAYTEST_REQUIRE_INTEGRATION=1                     → 所有依赖都必须跑
 *   PLAYTEST_REQUIRE_INTEGRATION=othello-online,chess-arena → 只强制列出的依赖
 *   PLAYTEST_REQUIRE_INTEGRATION=0                     → 显式本地模式（覆盖 CI=true）
 *   CI=true（且未设置上面变量时）                      → 视同全部强制
 *
 * 注意：有些本机环境会常驻 `CI=true`（IDE / 终端包装层设置的）。那种情况下
 * 想本地跳过必须显式传 `PLAYTEST_REQUIRE_INTEGRATION=0`，否则会按 CI 严格模式失败。
 */

import assert from "node:assert/strict";

export interface IntegrationProbe {
  /** 依赖名，用于日志与强制列表匹配，例如 "othello-online"。 */
  readonly dependency: string;
  readonly available: boolean;
  /** 不可用原因（写进 skip 与失败信息）。 */
  readonly reason: string;
}

export interface IntegrationGate {
  /** 直接传给 node:test 的 skip 参数。 */
  readonly skip: false | string;
  /** 强制模式下依赖不可用时的前置检查：一旦调用即让用例失败。 */
  readonly precheck?: () => void;
}

function requiredDependencies(): "all" | readonly string[] | null {
  const raw = process.env.PLAYTEST_REQUIRE_INTEGRATION?.trim();
  if (raw) {
    const normalized = raw.toLowerCase();
    if (
      normalized === "0" ||
      normalized === "false" ||
      normalized === "off" ||
      normalized === "none"
    ) {
      return [];
    }
    if (raw === "1" || normalized === "true" || normalized === "all") return "all";
    return raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return process.env.CI === "true" ? "all" : null;
}

export function integrationRequired(dependency: string): boolean {
  const required = requiredDependencies();
  if (required === null) return false;
  return required === "all" || required.includes(dependency);
}

export function integrationGate(probe: IntegrationProbe): IntegrationGate {
  if (probe.available) return { skip: false };

  const message = `${probe.dependency} 未启动：${probe.reason}`;
  if (integrationRequired(probe.dependency)) {
    console.log(`[集成] 强制模式：${message}`);
    return {
      skip: false,
      precheck: () => {
        assert.fail(`集成依赖不可达（PLAYTEST_REQUIRE_INTEGRATION 已强制）：${message}`);
      },
    };
  }

  console.log(
    `SKIPPED: ${probe.dependency} 未启动（设置 PLAYTEST_REQUIRE_INTEGRATION=1 强制失败）`,
  );
  console.log(`[集成] 跳过原因：${probe.reason}`);
  return { skip: message };
}
