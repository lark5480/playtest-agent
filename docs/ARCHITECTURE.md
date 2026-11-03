# ARCHITECTURE —— 地基契约的权威源

> **本文件是 8 项冻结契约的唯一正文。** 其他文档引用它们，不复制定义。
> 改动任何一项冻结契约，需在 [`decisions/`](decisions/) 追加裁决条目，说明兼容性影响。

---

## 0. 分层

```
src/
├─ types/       共享类型：全项目对"什么是一局/一个动作/一条记录"的唯一定义
├─ core/        纯函数内核：无 IO、无网络、无模型、无时钟读取
├─ adapter/     适配器 SPI + 契约测试套件（游戏专属代码的入口）
├─ strategy/    策略 SPI + 确定性基线
├─ oracle/      断言 SPI + 通用断言集
├─ governance/  治理契约 + 幂等键装配 + 内存替身
└─ report/      报告落盘薄壳（渲染逻辑在 core/report-core.ts）
```

**依赖方向（单向，不得反向）**：

```
types  ←  core  ←  adapter / strategy / oracle / governance
                     ↑
                  driver（组装层，不含业务规则）
```

- `core/` **不得** import `adapter/` / `strategy/` / `oracle/` —— 纯内核不认识具体实现。
- `core/` **不得**发起 IO（`fetch` / `fs` / 读时钟）。
- 适配器 / 策略 / 断言的实现**不得**互相依赖 —— 它们只依赖 `types/`。

---

## 1. 冻结契约清单

| #   | 契约                                                         | 定义位置                                                            | 为什么冻结                                                   |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| ①   | `GameState` / `Action` / `Observation` / `Decision` 形状     | [`src/types/game.ts`](../src/types/game.ts)                         | 全部层的公共词汇；改形状 = 全项目返工                        |
| ②   | `StepRecord` / `IdempotencyFingerprint` / `StepOutcome` 形状 | [`src/types/step.ts`](../src/types/step.ts)                         | 报告的原子单位 + 治理记账单位                                |
| ③   | **幂等指纹算法**                                             | [`src/core/fingerprint.ts`](../src/core/fingerprint.ts)             | 改了会让历史 session 的续跑认不出重放 → **产生第二次副作用** |
| ④   | `GameAdapter` 方法签名                                       | [`src/adapter/game-adapter.ts`](../src/adapter/game-adapter.ts)     | 契约测试套件依赖它                                           |
| ⑤   | `Strategy.decide` 签名                                       | [`src/strategy/strategy.ts`](../src/strategy/strategy.ts)           | 降级路径与模型策略共用                                       |
| ⑥   | `Oracle.assert` 签名                                         | [`src/oracle/oracle.ts`](../src/oracle/oracle.ts)                   | 断言集可插拔的前提                                           |
| ⑦   | **治理幂等键构成**                                           | [`src/governance/idempotency.ts`](../src/governance/idempotency.ts) | 与 aiwarden 侧口径对齐，两侧要能对照                         |
| ⑧   | 报告 JSON 结构                                               | [`src/core/report-core.ts`](../src/core/report-core.ts)             | 报告要被机器再解析（跨场景对比、基线 diff）                  |

### 1.1 冻结后的扩展记录

冻结契约**只增不改**：新增字段是允许的（向后兼容），改既有字段语义不允许。
以下为冻结后新增的字段，均为**可选**（不传时行为与冻结时一致）：

| 契约 | 新增项                        | 何时加的 | 为什么                                                               |
| ---- | ----------------------------- | -------- | -------------------------------------------------------------------- |
| ⑧    | `steps[].degradedReason`      | Stage 5  | 承诺 C4 要求降级**可追溯** —— 只标 `degraded: true` 说不清为什么降级 |
| ⑧    | `governanceSource`            | Stage 5  | 区分"真实 aiwarden 链路"与"内存替身降级"，否则报告无法自证证据等级   |
| ⑧    | `governanceDegradedReason`    | Stage 5  | 同上，写明降级原因                                                   |
| ④    | `GameAdapter.resume?`（可选） | Stage 4  | 续跑需要"从凭证恢复对局"；不实现该方法的适配器照常工作               |

---

## 2. 幂等指纹算法（契约 ③ 的正文）

```
digest = sha256(canonicalize({ stepNo, payload })).hex.slice(0, 32)
canonicalize 规则：
  1. 对象键按字典序递归排序
  2. 数组保持原顺序（动作序列有语义，不能打乱）
  3. undefined 的键直接丢弃（与 JSON 序列化一致）
  4. NaN / Infinity → null（保证摘要可复现）
```

**指纹不含**：`Action.id`（展示标识）、时间戳、随机数、session 之外的任何环境量。

**为什么 stepNo 必须参与摘要**：同一动作出现在不同步号属于不同步骤。
若步号不入摘要，"第 3 步与第 7 步做了同一个动作"会撞键，续跑时会误判为重放
而跳过真实动作 —— 这正是本项目在单测阶段抓到并修正过的真实缺陷。

---

## 3. 治理接入模型（契约 ⑦ 的正文）

### 幂等键构成（与 aiwarden ADR-013 决策 6 对齐）

```
幂等键 = { businessKey } :: { session } :: { stepNo } :: { digest }
```

- `businessKey` = 对局标识（房间码 / session id）
- `session` = 本次 playtest 运行的 session key
- `stepNo` = 步骤序号（从 0 起）
- `digest` = 动作内容摘要（见 §2）

### 关键语义

| 语义         | 规则                                                                                      | 依据                                       |
| ------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------ |
| **动作幂等** | 同键重复调用 → `replayed: true`，**不产生第二次副作用**                                   | aiwarden ADR-013 决策 6                    |
| **崩溃续跑** | 崩在"动作已生效、检查点未落" → 续跑重做该步，幂等键命中 `SUCCEEDED` 终态 → 无第二次副作用 | 同上（双防线）                             |
| **租约独占** | 同 session 并发 → 409，不并行产生副作用                                                   | aiwarden ADR-013 决策 4                    |
| **成本归因** | 四维：租户 / 会话 / 步骤 / 工具                                                           | aiwarden ADR-014                           |
| **替身等价** | 内存替身与真实 HTTP 实现必须跑**同一套**治理契约测试                                      | 见 [`tests/contract/`](../tests/contract/) |

---

## 4. 驱动循环形状

```
observe → decide → act → observe → …
```

**与 aiwarden 的 DAG 的关系**：本项目**不复用** `AgentDagEngine`——
它是固定 10 节点的单次问答管线（`AgentRunContext` 硬绑 `ChatAskRequest`，
ADR-013 决策 1），而游戏 Agent 需要**循环**。两者形状不同，强行套用会污染
aiwarden 已收口的 M4 口径。

本项目只**进程外消费** aiwarden 的治理能力（HTTP / MCP 边界），aiwarden 零改动。

### 终止判定（纯逻辑）

```
isTerminal(state) = state.status === "finished"
                  || (state.turn !== null && state.legalActions.length === 0)
```

### 动作合法性约束

策略返回的动作**必须**落在 `state.legalActions` 内，否则 `planNextStep` 抛错。
这条约束是 Oracle 能抓到"策略越界"类缺陷的前提。

---

## 5. 已知边界

| 边界                      | 现状                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| 真实模型接入              | **已实现**（`src/llm/openai-client.ts`，OpenAI 兼容）；无端点时**显式降级**并标注原因      |
| MCP 通道                  | **未做**。治理接入走 HTTP；aiwarden 已是 MCP 服务端，客户端接入为后续增强                  |
| aiwarden 真实 HTTP 客户端 | **已实现**（`src/governance/aiwarden-client.ts`）；aiwarden 不可达时**显式降级**到内存替身 |
| aiwarden 侧工具注册       | **未做**（需 aiwarden 侧注册 `playtest.game.action` —— 本项目对 aiwarden 零改动）          |
| 被测游戏                  | othello-online（本地 mock API，零云端依赖）；chess-arena 适配器延后                        |

---

## 6. 已知的验证缺口（如实记录，不掩饰）

| 缺口                         | 原因                                                          | 影响                                                                                                                |
| ---------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 真实 aiwarden 治理链路未实跑 | 本机 Docker daemon 不可用（Rancher Desktop 后端 socket 超时） | `tests/integration/aiwarden-governance.test.ts` 的 8 条契约**跳过**并打印原因。真实链路的幂等语义**尚未在本机验证** |
| aiwarden 侧缺对应工具        | 本项目对 aiwarden 零改动，不能注册 `playtest.game.action`     | 即使 aiwarden 起来，工具调用也会被治理拒绝。需另行协调 aiwarden 侧注册                                              |

> 这两条是**如实记录**的验证缺口，不是"已完成"。
> 恢复方式：本机 Docker 可用 → 起 aiwarden → 协调工具注册 → 重跑 `npm run test:integration`，
> 届时跳过项会变成实跑项。
