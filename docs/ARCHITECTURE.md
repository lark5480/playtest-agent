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

| 边界                      | 现状                                                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 真实模型接入              | **已实现**（`src/llm/openai-client.ts`，OpenAI 兼容）；无端点时**显式降级**并标注原因                                              |
| MCP 通道                  | **未做**。治理接入走 HTTP；aiwarden 已是 MCP 服务端，客户端接入为后续增强                                                          |
| aiwarden 真实 HTTP 客户端 | **已实现**（`src/governance/aiwarden-client.ts`）；aiwarden 不可达时**显式降级**到内存替身                                         |
| aiwarden 侧游戏动作工具   | **没有**（实测注册的是 `assign_ticket` / `create_ticket`）；本项目**用 `create_ticket` 作替身**验证整条治理管道，**不改 aiwarden** |
| 单次工具调用的 traceId    | **真实实现不提供**（`ToolInvokeResponse` 无该字段；traceId 属于 session 层）→ 治理契约中该条标为「不适用」                         |
| 被测游戏                  | othello-online（本地 mock API）；chess-arena（本地内存房间 API，默认 `localhost:3000`）—— 均零云端依赖                             |

---

## 6. 真实治理链路的验证状态（2026-11-04 已实跑）

### 6.1 结论

**真实 aiwarden 链路已实跑通过**：治理契约 **7 条实跑通过 + 1 条标为不适用**，0 失败。

```console
$ npm run test:integration
✔ 真实 aiwarden 契约 · 首次调用执行副作用且 replayed=false
✔ 真实 aiwarden 契约 · 同键重放不产生第二次副作用（幂等）
✔ 真实 aiwarden 契约 · 不同步号不互相命中（键含 stepNo）
✔ 真实 aiwarden 契约 · 不同 session 不互相命中
✔ 真实 aiwarden 契约 · 同一步不同动作不互相命中（键含动作内容）
✔ 真实 aiwarden 契约 · 动作内容键序不同视为同一动作
✔ 真实 aiwarden 契约 · 重放返回的 tokens 与首次一致（成本归因不重复计入）
ℹ tests 8  ℹ pass 7  ℹ fail 0  ℹ skipped 1
```

**不可达时的行为**（同一份测试）：8 条**全部跳过并打印原因**，不伪装通过：

```console
$ AIWARDEN_BASE_URL=http://127.0.0.1:59999 npm run test:integration
[集成] 跳过真实 aiwarden 契约：aiwarden 不可达：fetch failed
ℹ tests 8  ℹ pass 0  ℹ fail 0  ℹ skipped 8
```

### 6.2 落库证据（治理链路真的通了，不是 HTTP 200 而已）

| 表                  | 实测                                    | 说明                   |
| ------------------- | --------------------------------------- | ---------------------- |
| `t_ticket`          | 45 张（`title LIKE 'playtest step%'`）  | 副作用真的落库         |
| `t_tool_invocation` | 56 条 SUCCEEDED + 1 条 PENDING_APPROVAL | 调用记录 + 审批分支    |
| `t_audit_log`       | `TOOL_APPROVED` / `QUOTA_EXCEEDED` 等   | 审计留痕（含治理拒绝） |

**启动链证据**（aiwarden 进程日志的关键时序，说明"治理面真的起来了"而非"端口能连"）：

```
08:31:23  Flyway 开始迁移（应用启动即校验 schema，库不在会直接启动失败）
08:31:27  Tomcat started
08:31:28  Started AiwardenApplication
08:31:32  kafka-1 / kafka-2 消费者 Successfully joined group
          → 分配到 llm.call.recorded-0 与 document.delete/index.requested-0
```

> 日志本身**不入库**（运行产物）；上面是关键时序的摘录，完整复现命令见 §6.1。

### 6.3 实跑过程中修掉的三个真实缺陷

> 这三条都是**只有真实实现才会暴露**的问题 —— 内存替身全都测不出来。

| #   | 缺陷                            | 根因                                                                                                                                                                                  | 修法                                                                                               |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| D1  | 租户标识被拒（HTTP 400）        | aiwarden 的 `tenant_id` 是 `long`，`requireTenantIdAsLong()` 对非数值直接拒绝；客户端原本默认 `"playtest"`                                                                            | 改为**数值字符串**，默认 `"1"`（种子数据 `id=1, name=demo-tenant`）；`setup.ts` 与集成测试同步修正 |
| D2  | **不同 session 的动作互相吞掉** | 客户端把 `digest`（只吃 `{stepNo, payload}`）当 `orderRef`；而 `create_ticket` 用 `orderRef` 做唯一约束 → 不同 session 的同一动作撞键 → `ON CONFLICT DO NOTHING` → **副作用静默丢失** | `orderRef` 改为**完整幂等键**（businessKey:session:stepNo:digest），含全部维度                     |
| D3  | 键序不同的同一动作被当成两个    | `title` 用 `JSON.stringify(action)` 原样保留键序；aiwarden 侧只对**顶层** Map 排序（`ORDER_MAP_ENTRIES_BY_KEYS`），嵌套结构不保证                                                     | 客户端先 `canonicalize` 再写入 `title`（规范化必须在本侧做，不能指望服务端）                       |

> **D2 是本项目最重要的一条**：它同时暴露了两件事 ——
> ① 冻结契约 ③ 的 `digest` **故意不含** businessKey/session（那是"动作身份"）；
> ② 但**下游系统的唯一约束字段必须承载全部幂等维度**，否则跨维度会撞。
> 「digest 是动作身份」与「orderRef 是完整幂等键」是两个不同层次的键，不能混用。

### 6.4 仍然存在的边界

| 项                              | 现状                                                                                                                             | 处置                                                                                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| aiwarden 侧**没有游戏动作工具** | 实测注册的是 `assign_ticket` / `create_ticket`（`GET /api/v1/agent/tools`）。aiwarden PRD §10 明说「工单是零资金风险的演示替身」 | 本项目用 `create_ticket` 作**替身**验证整条管道（幂等 / 配额 / 审计 / 补偿全部生效）。**不改 aiwarden**；若将来要真游戏动作工具，需 aiwarden 侧注册 |
| 单次调用无 traceId              | `ToolInvokeResponse` 无该字段；traceId 在 session 层（`t_agent_session.trace_id`）                                               | 治理契约中该条标 `inMemoryOnly: true`，对真实实现**显式跳过并注明原因**（不是删断言）                                                               |
| 真实链路的**续跑**未实跑        | `POST /api/v1/agent/runs/{sessionKey}/resume` 需要先有 session 记录；本项目的续跑语义目前由内存替身 + 崩溃注入测试覆盖           | 后续项：把游戏 session 与 aiwarden session 对齐后再验证                                                                                             |
