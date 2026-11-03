# Playtest Agent

**AI 游戏自动测试 Agent** —— 自己注册房间、自己开局、自己按策略玩，为每一步产出**治理证据**（成本归因 / trace / 幂等续跑），最终产出**可复现**的缺陷报告。

`Node.js 24` · `TypeScript 5.5` · **运行时零依赖**

---

## 这是什么

一个**游戏的质量保障基础设施**，不是又一个游戏。

现有做法里，游戏的质量靠"真人试玩"兜底 —— 但真人试玩有两个硬约束：
**要找到没接触过项目的人**（`othello-online` 的试玩手册就因此从未执行），
以及**只能覆盖一次、不可复现**。

本 Agent 补上机器能测的那一半：自己开局、按策略玩、断言机制、产出报告。
它与人工试玩是**串联**关系 —— 机器没过的，不该浪费真人注意力。

> 依据 `othello-online/tests/playtest/phase6-verdict.md` 原文：
> 「**自动化只能证明"数据一致"，证明不了"人看着不难受"。**」

---

## 它做什么

| 能力           | 说明                                                              |
| -------------- | ----------------------------------------------------------------- |
| **自主开局**   | 自动注册房间、加入对局、开始游戏 —— 不需要人工摆姿势              |
| **确定性游玩** | 同 seed + 同局面 → 同动作。缺陷能稳定复现，报告才有证据价值       |
| **机制断言**   | 每步执行后校验不变量（回合交替、终局不可动、失败无副作用…）       |
| **治理证据**   | 每步带幂等指纹、成本归因、traceId —— 可与治理侧 trace 串联        |
| **崩溃续跑**   | 崩在"动作已生效、检查点未落" → 续跑**不产生第二次副作用**         |
| **降级不崩**   | 模型不可用 → 降级到确定性基线，**仍跑完整局**，报告显式标注降级段 |

---

## 快速开始

```bash
npm install

# 起被测游戏（本地，免云端 —— othello-online 自带内存版 /api，无需 EdgeOne 账号或 KV）
cd ../othello-online && npm install && npm run build && npm run preview
# 另开一个终端：
cd playtest-agent

npm run playtest -- --scenario smoke
```

跑完后看 `reports/` 下的 Markdown 与 JSON 报告。

---

## 常用命令

```bash
npm run typecheck        # tsc --noEmit
npm test                 # 单元测试（纯函数内核）
npm run test:contract    # 契约测试（适配器 / 治理实现必过）
npm run test:integration # 集成测试
npm run playtest -- --scenario smoke   # 跑一局
npm run lint && npm run format:check
npm run build
```

---

## MVP 验收（真实输出）

> 以下是本机实跑输出（2026-11-03，Node v24.22.1）。
> 被测游戏：`othello-online` 本地 `preview`（内存版 `/api`，**无需 EdgeOne 账号或 KV**）。

### 验收 1 · Agent 无人值守自动完成一局

```console
$ npm run playtest -- --scenario smoke
[playtest] 场景=smoke seed=42 被测=http://localhost:5173 模型=未配置（走确定性基线） 治理=in-memory（降级） 注入=无
[playtest] 治理降级：aiwarden 不可达（fetch failed），已降级到内存治理替身
[playtest] 完成：passed · 59 步 · 降级 59 · 重放 0 · 发现 0
[playtest] 报告：reports/smoke-2026-11-03T09-35-43-251Z.md
```

**59 步全自动走完一整局**，产出完整 StepRecord 链与 Markdown / JSON 报告。

### 验收 2 · 崩溃注入（崩在"动作已生效"之后）

```console
$ npm run playtest -- --scenario crash --inject-crash=10
[playtest] 注入崩溃：第 10 步执行完成后（续跑应从这里接着跑）
```

续跑语义由集成测试验证（见下）。

### 验收 3 · 模型不可用 → 降级但不中断

```console
$ npm run playtest -- --scenario smoke --seed=99
[playtest] 完成：passed · 60 步 · 降级 60 · 重放 0 · 发现 0
```

**60 步全部标注降级、原因写明在报告的「降级说明」节、局照样跑完、状态 passed。**
这就是承诺 C4 的证据：AI 是地基，但地基塌了游戏不崩，且**如实标注**。

### 测试结果

| 层   | 用例数 | 通过 | 说明                                                                |
| ---- | ------ | ---- | ------------------------------------------------------------------- |
| 单元 | 59     | 59   | 纯函数内核（指纹 / PRNG / 驱动骨架 / 报告 / 策略 / Oracle）         |
| 契约 | 8      | 8    | 治理实现的幂等语义（替身与真实实现同套件）                          |
| 集成 | 11     | 3    | 崩溃续跑 + 并发冲突通过；**8 条跳过**（真实 aiwarden 不可达，见下） |

### 已知的验证缺口（如实记录）

| 缺口                                      | 原因                                                          | 影响                                                   |
| ----------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------ |
| 真实 aiwarden 治理链路未实跑              | 本机 Docker daemon 不可用（Rancher Desktop 后端 socket 超时） | 8 条真实链路契约**跳过**并打印原因，**未伪装通过**     |
| aiwarden 侧缺 `playtest.game.action` 工具 | 本项目对 aiwarden **零改动**，不能注册工具                    | 即使 aiwarden 起来，工具调用也会被治理拒绝，需另行协调 |

### 关于"发现真实缺陷"的诚实结论

计划要求 MVP 至少发现一个真实缺陷。**实际扫描结果是：没有发现 othello 的机制缺陷。**

- 扫描 41 个 seed、约 2400 步，游戏特异断言（OTH1–OTH7）**零违规**；
- 并发场景（两个客户端同房间同时落子）**保护有效**：乐观并发精确返回 409 冲突。

过程中确实出现过一次"发现"，但经查证是**本项目的断言误报**（通用 Oracle 无法区分
othello 的"对方无子可下 → 保持当前回合"合法跳过与"该换没换"）。已修正断言分层：
通用层只判通用可判的，跳过规则交给游戏特异 Oracle（OTH6）。
这条误报本身也写进了 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) —— **它比一个假缺陷更有价值**。

---

**当前阶段：Stage 0 · 地基完成**（见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)）。

已交付：

- 8 项**冻结契约**（类型 / 指纹算法 / 四个 SPI / 治理键构成 / 报告结构）
- 纯函数内核：幂等指纹、种子化 PRNG、驱动骨架、报告渲染
- 适配器与治理的**契约测试套件**（任何实现接入必过）

进行中：驱动层 → 治理层 → MVP 验收（路线见 [`docs/PRD.md`](docs/PRD.md) §14）。

---

## 项目状态

**当前阶段：Stage 0–6 · 地基 → 驱动层 → 治理层 → MVP 验收**（路线见 [`docs/PRD.md`](docs/PRD.md) §14）。

已交付：

- 8 项**冻结契约**（类型 / 指纹算法 / 四个 SPI / 治理键构成 / 报告结构）
- 纯函数内核：幂等指纹、种子化 PRNG、驱动骨架、报告渲染
- 适配器与治理的**契约测试套件**（任何实现接入必过）
- 驱动层：GameDriver + othello 适配器 + LLM 策略（带显式降级）+ 通用 / 游戏特异 Oracle
- 治理层：真实 aiwarden HTTP 客户端（不可达时**显式降级**到内存替身）
- MVP 验收：自动打完一局、崩溃续跑不重复副作用、并发冲突 409 拦截、降级不中断

待做：Stage 1–3 的文档（调研 / PRD / 裁决清单）；真实 aiwarden 链路实跑（受本机 Docker 限制）。

---

## 文档

| 文档                                           | 内容                                         |
| ---------------------------------------------- | -------------------------------------------- |
| [`AGENTS.md`](AGENTS.md)                       | AI 协作入口：红线 / 技术栈 / 命令 / 改动纪律 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | **地基契约的权威源**（8 项冻结契约）         |
| [`docs/PRD.md`](docs/PRD.md)                   | 产品需求 / 成功标准 / 路线图                 |
| [`docs/TESTING.md`](docs/TESTING.md)           | 测试约定与验收判据                           |
| [`docs/decisions/`](docs/decisions/)           | 裁决清单（编号顺延追加）                     |

---

## 设计要点

**aiwarden 零改动。** 本项目只通过它既有的 HTTP / MCP 边界**消费**治理能力
（幂等键 / 版本 CAS / 租约独占 / 成本归因 / 检查点续跑），不去改它。
理由与证据见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §4。

**零云端审批依赖。** 被测游戏跑本地进程，不依赖任何需要人工审批的外部资源。

**不静默降级。** 模型不可用会**显式**标 `degraded` 并写进报告，
不悄悄换一个策略假装无事发生。

---

## 许可

MIT · GitHub handle 署名
