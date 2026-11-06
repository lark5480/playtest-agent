import assert from "node:assert/strict";
import { test } from "node:test";

import { OpenAiCompatibleClient } from "../src/llm/openai-client.js";
import { LlmRequestError } from "../src/llm/request.js";

const actions = [{ id: "2,3", payload: { row: 2, col: 3 } }];

function client(timeoutMs = 5000): OpenAiCompatibleClient {
  return new OpenAiCompatibleClient({
    baseUrl: "http://127.0.0.1:1",
    apiKey: "api-key-marker",
    model: "fake",
    timeoutMs,
  });
}

async function withFetch(impl: typeof fetch, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("HTTP 错误只保留状态码，不回显响应体或密钥", async () => {
  await withFetch(
    async () => new Response("SECRET-BODY api-key-marker", { status: 500 }),
    async () => {
      await assert.rejects(client().pickAction({ actions, prompt: "p" }), (error: unknown) => {
        assert.ok(error instanceof LlmRequestError);
        assert.equal(error.category, "http");
        assert.equal(error.status, 500);
        assert.ok(!error.message.includes("SECRET-BODY"));
        assert.ok(!error.message.includes("api-key-marker"));
        return true;
      });
    },
  );
});

test("空内容但带 usage：返回 null 动作且不丢已知用量", async () => {
  await withFetch(
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "  " } }],
          usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 },
        }),
        { status: 200 },
      ),
    async () => {
      const result = await client().pickAction({ actions, prompt: "p" });
      assert.equal(result.actionId, null);
      assert.equal(result.usage?.totalTokens, 8);
    },
  );
});

test("reasoning_content 可作为最终答案", async () => {
  await withFetch(
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "", reasoning_content: "结论：2,3" } }],
          usage: { total_tokens: 3 },
        }),
        { status: 200 },
      ),
    async () => {
      const result = await client().pickAction({ actions, prompt: "p" });
      assert.equal(result.actionId, "2,3");
      assert.equal(result.usage?.totalTokens, 3);
    },
  );
});

test("不把 12,30 误判为合法动作 2,3", async () => {
  await withFetch(
    async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "我选择 12,30" } }] }), {
        status: 200,
      }),
    async () => {
      assert.equal((await client().pickAction({ actions, prompt: "p" })).actionId, null);
    },
  );
});

test("缺 usage 字段不补 0，返回 undefined", async () => {
  await withFetch(
    async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "2,3" } }] }), { status: 200 }),
    async () => {
      const result = await client().pickAction({ actions, prompt: "p" });
      assert.equal(result.actionId, "2,3");
      assert.equal(result.usage, undefined);
    },
  );
});

test("取消信号传到 fetch，立即以取消错误结束而不是等超时", async () => {
  const controller = new AbortController();
  const abortingFetch: typeof fetch = async (_input, init) => {
    controller.abort();
    return new Promise<Response>((_, reject) => {
      if (init?.signal?.aborted) reject(init.signal.reason);
      else
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  };
  await withFetch(abortingFetch, async () => {
    const started = Date.now();
    await assert.rejects(
      client(30_000).pickAction({ actions, prompt: "p", signal: controller.signal }),
      (error: unknown) => {
        assert.ok(error instanceof LlmRequestError);
        assert.equal(error.category, "cancelled");
        return true;
      },
    );
    assert.ok(Date.now() - started < 1000, "取消不应等到 30s 超时");
  });
});

test("超时走 timeout 分类，并取消底层请求", async () => {
  const timeoutFetch: typeof fetch = async (_input, init) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  await withFetch(timeoutFetch, async () => {
    await assert.rejects(client(20).pickAction({ actions, prompt: "p" }), (error: unknown) => {
      assert.ok(error instanceof LlmRequestError);
      assert.equal(error.category, "timeout");
      return true;
    });
  });
});
