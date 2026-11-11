/**
 * 治理客户端加固单测（裁决 37）：typed error / 有限重试 / 用量硬化 / orderRef 哈希 / 探活校验。
 *
 * 全部 mock fetch，不打真实服务；真实链路由 tests/integration/aiwarden-*.test.ts 覆盖。
 * 冻结契约套件（tests/contract/）保持不变，这里只补加固行为的差分断言。
 */

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { AiwardenHttpClient, DEFAULT_BASE_URL } from "../src/governance/aiwarden-client.js";
import {
  GovernanceContractError,
  GovernanceDeniedError,
  GovernanceHttpError,
} from "../src/governance/errors.js";
import { setupGovernance } from "../src/governance/setup.js";

function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

const succeeded = { status: "SUCCEEDED", replayed: false, invocationId: 1, tool: "create_ticket" };

function mockSequence(t: TestContext, queue: Array<() => Response>): string[] {
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    urls.push(String(input));
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra fetch");
    return next();
  });
  return urls;
}

const invokeParams = (action: Record<string, unknown> = { row: 1 }) => ({
  businessKey: "room",
  session: "run",
  stepNo: 0,
  action,
  perform: async () => {},
});

// ---- 重试矩阵 ----

test("409 租约在飞：重试后成功，副作用只执行一次", async (t) => {
  let performed = 0;
  mockSequence(t, [
    () => json({ detail: "工具调用执行中" }, 409),
    () => json({ detail: "工具调用执行中" }, 409),
    () => json(succeeded),
  ]);
  const client = new AiwardenHttpClient({ baseUrl: "http://test" });
  const result = await client.invoke({
    ...invokeParams(),
    perform: async () => {
      performed += 1;
    },
  });
  assert.equal(result.replayed, false);
  assert.equal(performed, 1);
});

test("409 超过重试上限：抛 GovernanceHttpError 且保留状态码，不执行副作用", async (t) => {
  let performed = 0;
  mockSequence(t, [
    () => json({}, 409),
    () => json({}, 409),
    () => json({}, 409),
    () => json({}, 409),
  ]);
  const client = new AiwardenHttpClient({ baseUrl: "http://test" });
  await assert.rejects(
    client.invoke({
      ...invokeParams(),
      perform: async () => {
        performed += 1;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof GovernanceHttpError);
      assert.equal(error.status, 409);
      return true;
    },
  );
  assert.equal(performed, 0);
});

test("429 带 Retry-After：退避后成功", async (t) => {
  mockSequence(t, [
    () => json({ detail: "租户请求频率超限" }, 429, { "Retry-After": "1" }),
    () => json(succeeded),
  ]);
  const client = new AiwardenHttpClient({ baseUrl: "http://test" });
  const result = await client.invoke(invokeParams());
  assert.equal(result.replayed, false);
});

test("429 无 Retry-After（配额耗尽）：不重试，立即失败", async (t) => {
  const urls = mockSequence(t, [() => json({ detail: "配额超限" }, 429)]);
  const client = new AiwardenHttpClient({ baseUrl: "http://test" });
  await assert.rejects(client.invoke(invokeParams()), (error: unknown) => {
    assert.ok(error instanceof GovernanceHttpError);
    assert.equal(error.status, 429);
    return true;
  });
  assert.equal(urls.length, 1);
});

for (const status of [400, 403, 500]) {
  test(`HTTP ${status}：不重试，状态码可辨`, async (t) => {
    const urls = mockSequence(t, [() => json({ detail: "x" }, status)]);
    const client = new AiwardenHttpClient({ baseUrl: "http://test" });
    await assert.rejects(client.invoke(invokeParams()), (error: unknown) => {
      assert.ok(error instanceof GovernanceHttpError);
      assert.equal(error.status, status);
      return true;
    });
    assert.equal(urls.length, 1);
  });
}

// ---- 治理拒绝分类 ----

for (const status of ["PENDING_APPROVAL", "REJECTED"]) {
  test(`${status}：抛 GovernanceDeniedError，不执行副作用，消息不含响应体`, async (t) => {
    let performed = 0;
    mockSequence(t, [() => json({ status, replayed: false, error: "SECRET-TOKEN" })]);
    const client = new AiwardenHttpClient({ baseUrl: "http://test" });
    await assert.rejects(
      client.invoke({
        ...invokeParams(),
        perform: async () => {
          performed += 1;
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof GovernanceDeniedError);
        assert.ok(!error.message.includes("SECRET-TOKEN"));
        return true;
      },
    );
    assert.equal(performed, 0);
  });
}

// ---- 用量硬化 ----

const usageClient = () =>
  new AiwardenHttpClient({ baseUrl: "http://test", usagePollAttempts: 3, usagePollIntervalMs: 1 });

const usageRow = { stepNo: 0, tool: "create_ticket", promptTokens: 100, completionTokens: 0 };

test("usage 行缺 token 字段：unavailable，不填 0", async (t) => {
  const urls = mockSequence(t, [() => json([{ stepNo: 0, tool: "create_ticket" }])]);
  const usage = await usageClient().queryUsage({ session: "s", expectedSteps: [0] });
  assert.equal(usage.source, "unavailable");
  assert.equal(usage.unavailableReason, "usage-query-failed");
  assert.equal(urls.length, 1, "契约破裂应立即放弃，不空轮询");
});

test("usage 行缺 tool：unavailable，不伪造归因标签", async (t) => {
  mockSequence(t, [() => json([{ stepNo: 0, promptTokens: 100, completionTokens: 0 }])]);
  const usage = await usageClient().queryUsage({ session: "s", expectedSteps: [0] });
  assert.equal(usage.source, "unavailable");
  assert.equal(usage.unavailableReason, "usage-query-failed");
});

test("usage 非数组响应：unavailable，不当空数组", async (t) => {
  mockSequence(t, [() => json({ items: [usageRow] })]);
  const usage = await usageClient().queryUsage({ session: "s", expectedSteps: [0] });
  assert.equal(usage.source, "unavailable");
  assert.equal(usage.unavailableReason, "usage-query-failed");
});

test("usage 字段存在值为 0：合法（未配预算当量记 0 是设计）", async (t) => {
  mockSequence(t, [() => json([{ ...usageRow, promptTokens: 0 }])]);
  const usage = await usageClient().queryUsage({ session: "s", expectedSteps: [0] });
  assert.equal(usage.source, "governance-usage");
  assert.equal(usage.byStep[0]?.promptTokens, 0);
});

test("usage 瞬时网络错误：继续轮询而非立即放弃", async (t) => {
  mockSequence(t, [
    () => {
      throw new TypeError("fetch failed");
    },
    () => json([usageRow]),
  ]);
  const usage = await usageClient().queryUsage({ session: "s", expectedSteps: [0] });
  assert.equal(usage.source, "governance-usage");
  assert.equal(usage.byStep[0]?.promptTokens, 100);
});

test("usage 4xx：立即放弃", async (t) => {
  const urls = mockSequence(t, [() => json({}, 400)]);
  const usage = await usageClient().queryUsage({ session: "s", expectedSteps: [0] });
  assert.equal(usage.source, "unavailable");
  assert.equal(urls.length, 1);
});

test("usage 命中 500 行上限：用 stepNo 过滤补查缺失步", async (t) => {
  const bulk = Array.from({ length: 500 }, () => ({ ...usageRow, stepNo: 1 }));
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    return url.includes("stepNo=0") ? json([usageRow]) : json(bulk);
  });
  const usage = await usageClient().queryUsage({ session: "s", expectedSteps: [0, 1] });
  assert.equal(usage.source, "governance-usage");
  assert.deepEqual(
    usage.byStep.map((e) => e.stepNo),
    [0, 1],
  );
  assert.ok(
    urls.some((u) => u.includes("stepNo=0")),
    "必须发起 stepNo 补查",
  );
});

// ---- orderRef 全键哈希 ----

function captureBodies(t: TestContext): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: { body?: string }) => {
    bodies.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
    return json(succeeded);
  });
  return bodies;
}

test("orderRef：长 businessKey 下不同动作不撞键（前缀截断雷已拆）", async (t) => {
  const bodies = captureBodies(t);
  const client = new AiwardenHttpClient({ baseUrl: "http://test" });
  const longKey = "k".repeat(200);
  await client.invoke({ ...invokeParams({ row: 1 }), businessKey: longKey });
  await client.invoke({ ...invokeParams({ row: 2 }), businessKey: longKey });
  const inputOf = (b: Record<string, unknown>) => b.input as { orderRef: string };
  const a = inputOf(bodies[0]!).orderRef;
  const b = inputOf(bodies[1]!).orderRef;
  assert.notEqual(a, b, "同一步不同动作必须不同 orderRef");
  assert.equal(a.length, 64, "sha256 hex 定长，不受 businessKey 长度影响");
});

test("orderRef：键序不同的同一动作仍同键（D3 语义保持）", async (t) => {
  const bodies = captureBodies(t);
  const client = new AiwardenHttpClient({ baseUrl: "http://test" });
  await client.invoke(invokeParams({ row: 1, col: 2 }));
  await client.invoke(invokeParams({ col: 2, row: 1 }));
  const inputOf = (b: Record<string, unknown>) => b.input as { orderRef: string };
  assert.equal(inputOf(bodies[0]!).orderRef, inputOf(bodies[1]!).orderRef);
});

// ---- 探活与 env 单源 ----

test("探活：工具已注册 → 真实客户端", async (t) => {
  mockSequence(t, [() => json({ tools: ["create_ticket", "assign_ticket"] })]);
  const setup = await setupGovernance({ baseUrl: "http://test" });
  assert.equal(setup.degraded, false);
  assert.equal(setup.client.name, "aiwarden-http");
});

test("探活：工具未注册 → 降级 tool-not-registered", async (t) => {
  mockSequence(t, [() => json({ tools: ["assign_ticket"] })]);
  const setup = await setupGovernance({ baseUrl: "http://test" });
  assert.equal(setup.degraded, true);
  assert.equal(setup.reason, "tool-not-registered");
});

test("探活：HTTP 错误 → http-error；网络错误 → unreachable", async (t) => {
  mockSequence(t, [() => json({}, 500)]);
  const http = await setupGovernance({ baseUrl: "http://test" });
  assert.equal(http.reason, "http-error");
  t.mock.restoreAll();
  mockSequence(t, [
    () => {
      throw new TypeError("fetch failed");
    },
  ]);
  const net = await setupGovernance({ baseUrl: "http://test" });
  assert.equal(net.reason, "unreachable");
});

test("env 单源：构造函数直读 AIWARDEN_BASE_URL / AIWARDEN_TOOL", async (t) => {
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
  });
  process.env.AIWARDEN_BASE_URL = "http://env-host:9999";
  process.env.AIWARDEN_TOOL = "assign_ticket";
  const urls = mockSequence(t, [() => json(succeeded)]);
  const client = new AiwardenHttpClient();
  assert.equal(client.toolName, "assign_ticket");
  await client.invoke(invokeParams());
  assert.ok(urls[0]!.startsWith("http://env-host:9999/"));
  assert.ok(urls[0]!.includes("/tools/assign_ticket/invoke"));
});

test("默认地址单一事实源", () => {
  assert.equal(DEFAULT_BASE_URL, "http://localhost:8080");
});

test("listTools：形状非法 → GovernanceContractError", async (t) => {
  mockSequence(t, [() => json({ notTools: true })]);
  const client = new AiwardenHttpClient({ baseUrl: "http://test" });
  await assert.rejects(client.listTools(), GovernanceContractError);
});
