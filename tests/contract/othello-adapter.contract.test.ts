/**
 * 契约测试 · OthelloLocalAdapter
 *
 * 使用本地 HTTP 假服务，不依赖真实 othello-online 进程。
 */

import { after } from "node:test";

import { OthelloLocalAdapter } from "../../src/adapter/othello-local.js";
import { registerAdapterContract } from "../../src/adapter/contract-suite.js";
import { startOthelloStubServer } from "../helpers/othello-stub-server.js";

const stub = await startOthelloStubServer();
after(async () => {
  await stub.close();
});

registerAdapterContract(
  () => new OthelloLocalAdapter({ baseUrl: stub.baseUrl, timeoutMs: 5000 }),
  "othello 适配器契约",
);
