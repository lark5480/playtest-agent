/**
 * 集成测试 · 真实模型决策链路
 *
 * 只有配置了 AI_API_BASE / AI_API_KEY / AI_MODEL 才运行；未配置时显式跳过。
 * 强制模式（PLAYTEST_REQUIRE_INTEGRATION=1 或 =llm）下未配置 → 失败，不允许兜绿。
 *
 * 验证的不是"模型下得好"，而是：
 * - 真实模型能返回一个合法动作；
 * - usage 能进入 StepRecord（llmTokens > 0）；
 * - 至少一步不是降级。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { OthelloLocalAdapter } from "../../src/adapter/othello-local.js";
import { drive } from "../../src/driver/game-driver.js";
import { InMemoryGovernanceClient } from "../../src/governance/client.js";
import { clientFromEnv } from "../../src/llm/openai-client.js";
import { GenericOracle } from "../../src/oracle/generic.js";
import { LlmStrategy } from "../../src/strategy/llm.js";
import { startOthelloStubServer } from "../helpers/othello-stub-server.js";

const client = clientFromEnv();
const configured = client !== null;
const forced =
  process.env.PLAYTEST_REQUIRE_INTEGRATION === "1" ||
  process.env.PLAYTEST_REQUIRE_INTEGRATION === "llm";

test(
  "真实模型：能选出合法动作并记录 usage",
  {
    skip: configured
      ? false
      : forced
        ? false
        : "未配置 AI_API_BASE / AI_API_KEY / AI_MODEL（设置后运行）",
  },
  async () => {
    if (!client) {
      assert.fail(
        "强制模式要求真实模型：请配置 AI_API_BASE / AI_API_KEY / AI_MODEL；" +
          "不要用假数据冒充真实模型结果。",
      );
    }

    const server = await startOthelloStubServer();
    try {
      const result = await drive({
        adapter: new OthelloLocalAdapter({ baseUrl: server.baseUrl }),
        strategy: new LlmStrategy(client),
        oracle: new GenericOracle(),
        governance: new InMemoryGovernanceClient(),
        scenario: "llm-real",
        seed: 42,
        maxSteps: 1,
      });

      const nonDegraded = result.steps.filter((step) => !step.degraded);
      assert.ok(
        nonDegraded.length > 0,
        `真实模型一步都没成功，全部降级：${result.steps
          .map((step) => step.degradedReason ?? "?")
          .join(" | ")}`,
      );
      assert.ok(
        nonDegraded.some((step) => (step.llmTokens ?? 0) > 0),
        "真实模型调用必须记录 usage（llmTokens > 0）",
      );
      assert.ok(
        nonDegraded.every((step) => step.model === client.name),
        "非降级步必须记录实际模型标识",
      );
    } finally {
      await server.close();
    }
  },
);
