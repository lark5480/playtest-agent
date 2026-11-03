/**
 * 治理契约测试 · 内存替身
 *
 * 用契约套件校验内存替身的行为（幂等、重放不重复副作用、成本口径一致）。
 * 真实 aiwarden 的 HTTP 实现必须跑同一套件 —— 见 tests/integration/。
 */

import { InMemoryGovernanceClient } from "../../src/governance/client.js";

import { registerGovernanceContract } from "./governance.contract.js";

registerGovernanceContract(() => new InMemoryGovernanceClient());
