/**
 * 契约测试 · ChessArenaAdapter
 *
 * 使用本地 HTTP 假服务，不依赖真实 chess-arena 进程。
 */

import { after } from "node:test";

import { ChessArenaAdapter } from "../../src/adapter/chess-arena.js";
import { registerAdapterContract } from "../../src/adapter/contract-suite.js";
import { startChessStubServer } from "../helpers/chess-stub-server.js";

const stub = await startChessStubServer();
after(async () => {
  await stub.close();
});

registerAdapterContract(
  () => new ChessArenaAdapter({ baseUrl: stub.baseUrl, timeoutMs: 5000 }),
  "chess-arena 适配器契约",
);
