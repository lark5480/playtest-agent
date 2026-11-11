# TESTING —— 测试约定与验收判据

> 本项目只有一种测试框架：`node --import tsx --test`（Node 内置）。
> **不引测试框架** —— 对齐 tongshi-ju / chess-arena 的既有习惯。

---

## 1. 三层测试

| 层   | 目录                          | 跑什么                               | 门禁                       |
| ---- | ----------------------------- | ------------------------------------ | -------------------------- |
| 单元 | `tests/*.test.ts`             | `core/` 的纯函数、策略、Oracle       | `npm test`                 |
| 契约 | `tests/contract/*.test.ts`    | 适配器与治理实现的**同一套行为约定** | `npm run test:contract`    |
| 集成 | `tests/integration/*.test.ts` | 真实被测游戏 / 真实治理面            | `npm run test:integration` |

全跑：`npm run test:all`。

---

## 2. 契约测试为什么最重要

本项目有两套治理实现：

- `InMemoryGovernanceClient`（内存替身）—— 用于单测与本机无 Docker 时；
- `AiwardenHttpClient`（真实 aiwarden）—— 用于集成测试。

**替身与真实实现必须跑同一套契约测试。** 若二者行为不一致，
就会出现"单测全绿但真实链路是坏的"—— 这正是 aiwarden AGENTS §4 点名的坑形态
（**不报错、只是静默不生效**）。

同理，任何新适配器接入，必须通过 `src/adapter/contract-suite.ts` 导出的全套用例。

---

## 3. 契约套件覆盖什么

### 适配器契约（`src/adapter/contract-suite.ts`）

| #   | 用例                       | 断言什么                     |
| --- | -------------------------- | ---------------------------- |
| 1   | open 返回可观察的初始状态  | 状态有 id / status           |
| 2   | observe 的序号单调递增     | 不会回退                     |
| 3   | 合法动作集完整             | 每个动作有稳定 id、无重复 id |
| 4   | 同 seed 开两局初始状态一致 | 开局确定性                   |
| 5   | 执行合法动作后局面变化     | 动作真的生效                 |
| 6   | 执行非法动作被拒且局面不变 | 拒绝路径无副作用             |
| 7   | isTerminal 与状态自洽      | 终局判定不撒谎               |

### 治理契约（`tests/contract/governance.contract.ts`）

| #   | 用例                                  | 断言什么                       | 真实实现适用         |
| --- | ------------------------------------- | ------------------------------ | -------------------- |
| 1   | 首次调用执行副作用且 `replayed=false` | 首次不丢动作                   | ✅                   |
| 2   | 同键重放不产生第二次副作用            | **幂等语义**（承诺 C3 的地基） | ✅                   |
| 3   | 不同步号不互相命中                    | 键含 stepNo                    | ✅                   |
| 4   | 不同 session 不互相命中               | 键含 session                   | ✅                   |
| 5   | 同一步不同动作不互相命中              | 键含动作内容（否则漏动作）     | ✅                   |
| 6   | 动作内容键序不同视为同一动作          | 语义相同 → 同键                | ✅                   |
| 7   | 返回 traceId                          | 能与治理侧 trace 串联          | ❌ **不适用**        |
| 8   | 单次调用返回 tokens                   | 同步成本口径的实现必须返回数值 | ❌ **专用 usage 测** |
| 9   | 按 session 查询用量                   | 重放不重复计入成本             | ❌ **专用 usage 测** |

> 第 7 条对真实实现「不适用」：真实 aiwarden 的 `ToolInvokeResponse` 没有 traceId 字段
> （traceId 属于 session 层）。第 8/9 条对真实实现也不适用：它的成本走
> `GET /api/v1/admin/usage` 异步查询，由
> [`tests/integration/aiwarden-usage.test.ts`](../tests/integration/aiwarden-usage.test.ts)
> 专门覆盖（真实服务、唯一 session、Kafka 落库轮询）。
>
> 真实 aiwarden 的治理契约因此是 **6 实跑 + 3 显式不适用**；加上 usage 专用测试，
> 成本链路仍有真实覆盖。**不适用 ≠ 通过**，报告与文档都按这个口径写。
> 2026-11-05 本机已启动 aiwarden 并实跑：契约 + usage 共 **7 通过 + 3 显式不适用**。
> 注意：aiwarden 未配置租户当月预算时，工具调用当量按设计记 **0**；
> usage 测试验证「能按 step 查到记录、重放不重复计入」，不把 0 当成失败。
> 要看到 100/次，需要先配置 `t_budget`（或在管理面设置预算）——nightly 流水线已配预算，
> 并在 `PLAYTEST_EXPECT_QUOTA_EQUIVALENT=1` 下断言 **100/次**（裁决 37）。
> 客户端遇行缺字段 / 非数组响应会显式标 `unavailable`（不填 0、不伪造 tool 标签）；
> 瞬时网络错误继续轮询，4xx 立即放弃。
> CLI 查询 usage 时会带 `since=run.startedAt`，同 session 的历史运行不会混进本次报告。

### 真实链路的额外约束（实跑踩过的坑）

| 坑                              | 原因                                                                            | 修法                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 租户标识被拒（HTTP 400）        | aiwarden 的 `tenant_id` 是 `long`，非数值直接拒绝                               | 用**数值字符串**，默认 `"1"`                                                                                                    |
| **不同 session 的动作互相吞掉** | `create_ticket` 用 `orderRef` 做唯一约束，客户端只传了 `digest`（不含 session） | `orderRef` = **完整幂等键的 sha256**（businessKey::session::stepNo::digest 哈希成 64 hex；前缀截断会砍掉 digest 撞键，裁决 37） |
| 键序不同的同一动作被当成两个    | 服务端只对**顶层** Map 排序，嵌套不保证                                         | 客户端先 `canonicalize` 再写入                                                                                                  |

**测试数据必须用唯一键**：真实实现会把调用终态持久化，用固定键跑第二次会命中旧终态
→ `replayed: true` → 副作用不再执行 → 用例看起来"失败"，实际是**数据污染**。
契约套件用 `uniqueKey()`（含 pid + 时间戳 + 计数器）。

---

## 4. 验收判据（MVP）

```bash
# 0) 缺陷闭环（无外部服务、无密钥、无模型）
npm run demo
#    期望：预置漏翻被检出；新进程复现 reproduced；健康前缀 not-reproduced；
#    summary 标 injected-fixture，退出 0。进程级门禁：
npm run test:integration:replay
npm run test:integration:budget

# 0.1) 起被测游戏（本地，免云端）
cd ../othello-online && npm run build && npm run preview   # :5173

# 1) Agent 自动打完一局
npm run playtest -- --scenario smoke
#    期望：完整 StepRecord 链 + reports/smoke-<ts>.md / .json / .html

# 2) 崩溃续跑（检查点 + pending 意图）
npm run playtest -- --scenario crash --inject-crash=10 \
  --checkpoint=reports/checkpoints/crash.json
npm run playtest -- --resume=reports/checkpoints/crash.json
#    期望：退出码 3 → 续跑；第 10 步记 replayed、同 businessKey、无 failed 步
#    进程级验证（自带假服务，CI verify 也跑）：
npm run test:integration:resume

# 3) 模型不可用降级
AI_API_KEY= npm run playtest -- --scenario smoke
#    期望：仍跑完，报告标注"本段由确定性基线驱动"

# 4) 治理成本与 usage
PLAYTEST_REQUIRE_INTEGRATION=1 AIWARDEN_BASE_URL=http://localhost:8080 \
  AIWARDEN_ADMIN_USER_ID=1 npm run test:integration:aiwarden
#    期望：usage 接口能按 session/step 查到数值；重放不重复计入

# 5) 多 seed 扫描（Oracle 加强后再跑一轮）
npm run scan -- --scenario smoke --seeds=1-50 --max-steps=60
#    期望：生成 reports/scan-<scenario>-<ts>.md/.json；发现项需人工复核
```

**完成的判定**（避免"做完了就算数"）：

- 报告 v2 的 `status: passed` 仅在**正常终局**且必要检查完成时出现；步限、预算、
  停滞、执行失败与证据不足均为 `incomplete` 或 `failed`，退出码按 1/4/5/6 分类。
- `replay` 必须在新进程、新房间执行录制动作，不能问模型；早于原首错步分歧记
  `diverged`，健康实现的同前缀消失只记 `not-reproduced` 且限定范围。
- 模型预算测试用本地假模型统计**实际请求数**；未知 usage 不得填 0，恢复不得
  退还在途调用额度。CI 默认不调用付费模型。

- 上述命令**全部可复现**，真实输出贴进 README；
- **真实缺陷**：按裁决 18，不强制要求发现缺陷；若扫描为零，必须如实记录
  seed 区间、步数、断言覆盖与产物路径；若扫描有发现，先排除 Oracle 误报
  再记为游戏缺陷，**不伪造、不夸大**；
- CI 全绿：`verify`（含进程级续跑 / 缺陷回放 / 预算）与真实链路各 job 全部通过；
  aiwarden 集成在未配置外部地址时按设计 Skipped
  （job 清单见 README 的「CI 侧相关 job」表，不在此重复维护）。

### e2e-tongshi 的启动约定

`e2e-tongshi` job **不得预启动 3100 服务**：测试服务由 tongshi-ju 的 Playwright `webServer` 自己起，
并跑干净构建（不设 `CI: ""` 之类的绕过）。我们的 job 必须与 tongshi-ju 自身 CI 同形：
`NEXT_DIST_DIR: .next-e2e` → `npm run build` → `npx playwright test`。
上游若变更 `E2E_PORT` / `NEXT_DIST_DIR` 等约定，我们跟随对齐，**不在 agent 侧放宽断言或跳过 job**
（背景：上游 `01b8c96` 在配置加载阶段检查端口，占用即 `exit(1)`）。

---

## 5. 断言的独立性

Oracle 跑在**被测游戏之外**，是**独立实现**，不复用被测游戏的规则代码。

> 用游戏自己的规则校验游戏自己，会漏掉共模错误 —— 双方共享同一个错误假设时，
> 校验必然通过。

游戏特异断言由适配器提供，但**必须独立于游戏的实现**。

---

## 6. 确定性要求

| 场景 | 要求                                                                                                      |
| ---- | --------------------------------------------------------------------------------------------------------- |
| 策略 | 确定性基线：同 seed + 同局面 + 显式上下文 → 同动作；LLM 不承诺重采样一致，复现依赖已录制动作              |
| PRNG | 自实现 mulberry32；**无状态**：每步由 `seed + observation.seq` 派生                                       |
| 指纹 | 只吃 `{ stepNo, payload }`，不吃时间 / 随机 / id                                                          |
| 报告 | 纯渲染：同一报告 JSON 渲染幂等；跨运行不保证字节相等（session / 时间戳 / 耗时不同），对比走 `report:diff` |
| 续跑 | 检查点存 pending 意图 + before/expectedAfter 哈希；不重新决策已定动作                                     |

> PRNG 无状态是续跑确定性的前提：有状态 PRNG 的序列依赖"从第 0 步一路走来"，
> 新进程续跑时内部状态已丢。按 `(seed, observation.seq)` 派生后，
> 续跑与独立运行的后续动作序列一致（裁决 27）。

---

## 7. 缺陷编号

发现项的 `code` 必须**稳定**（跨次运行可对照），格式：

- 通用断言：`G<n>-<描述>`（如 `G1-new-turn-has-no-legal-moves`）
- othello：`OTH<n>-<描述>`（OTH1–OTH10，含整盘投影、合法集、winner、累计棋子数）
- chess：`CHS<n>-<描述>`（CHS1–CHS15，含合法集、FEN 历史连续性、子力不足、result 口径）
- 治理重放相关：`G6-replayed-observation-unavailable`、
  `G7-governance-replayed-before-game-state`（补偿执行并如实记录）

报告编号体系与 `othello-online/tests/playtest/smoke-checklist.md` 对齐 ——
机器结果能直接接人工观察表。
