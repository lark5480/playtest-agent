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

| 能力           | 说明                                                                             |
| -------------- | -------------------------------------------------------------------------------- |
| **自主开局**   | 自动注册房间、加入对局、开始游戏 —— 不需要人工摆姿势                             |
| **确定性游玩** | 基线同 seed + 同局面 → 同动作；模型不重采样复现，改由完整录制动作回放            |
| **机制断言**   | 每步执行后校验不变量（回合、终局、失败无副作用、合法集、历史连续性…）            |
| **治理证据**   | 每步带幂等指纹；traceId / 成本按来源标注（治理侧提供时），拿不到标 unavailable   |
| **成本口径**   | 模型 usage / 治理 usage / 合成值分开记，单位的 unknown 不填 0                    |
| **崩溃续跑**   | 检查点 + pending 意图 + 状态哈希；CLI `--resume`，同 businessKey，不自动新开一局 |
| **缺陷复现**   | 报告记录公开初局与完整动作；`replay` 在新进程、新房间重放，不问模型              |
| **模型预算**   | 请求前预扣调用次数；未知用量停止后续付费调用，崩溃恢复不退还额度                 |
| **降级不崩**   | 模型不可用 → 降级到确定性基线，**仍跑完整局**，报告显式标注降级段                |

---

## 快速开始

```bash
npm install

# 零外部依赖：在本地假服务上发现预置缺陷 → 新进程复现 → 健康实现对照
npm run demo
# 产物在 reports/demo-*.json|md|html；summary 明确标注 injected-fixture

# 被测游戏 A：othello-online（自带内存版 /api，无需 EdgeOne 账号或 KV）
cd ../othello-online && npm install && npm run build && npm run preview
# 另开一个终端：
cd playtest-agent
npm run playtest -- --scenario smoke

# 被测游戏 B：chess-arena（Next.js 自带内存房间 API，默认 localhost:3000）
cd ../chess-arena && npm install && npm run dev
# 另开一个终端：
cd playtest-agent
npm run playtest -- --scenario chess

# 崩溃续跑：先跑到第 10 步后崩溃，再从检查点接着跑
npm run playtest -- --scenario crash --inject-crash=10 \
  --checkpoint=reports/checkpoints/crash.json
npm run playtest -- --resume=reports/checkpoints/crash.json

# 多 seed 扫描（Oracle 覆盖）
npm run scan -- --scenario smoke --seeds=1-50 --max-steps=60
```

> PowerShell 会把裸 `--` 当自己的参数分隔符吃掉；在 PowerShell 里请写成
> `npm run playtest '--' --scenario chess`。cmd / bash 不受影响。

### 接真实模型

把 `.env.example` 复制为 `.env` 并填三项；npm 脚本会通过
`--env-file-if-exists=.env` 自动加载（`.env` 在 `.gitignore` 内）：

```bash
cp .env.example .env
# 编辑 .env：AI_API_BASE / AI_API_KEY / AI_MODEL
npm run playtest -- --scenario smoke --max-steps=5
```

也可以直接在命令行注入（shell 变量优先于 `.env`）。

- **reasoning 模型**（如 LongCat-2.5）会把最终答案放在 `reasoning_content`；
  客户端已兼容，并默认 `AI_MAX_TOKENS=1024`、`AI_TIMEOUT_MS=60000`。
- 模型只从合法动作集里选；报告写 `model` 与 `llmTokens`。**未配置时不会静默**：
  每一步都标 `degraded` 并写明原因。
- 密钥只进本地 `.env`（gitignored），不进仓库、日志与报告。

跑完后看 `reports/` 下的 Markdown / JSON / HTML 报告（运行产物，不入库）。
HTML 是自包含页面（无脚本、无 ServiceWorker），可以直接用 Chrome/Edge 打开；
如果 Qoder 的 Web 预览报 `Could not register service worker`，用 HTML 即可。
报告格式样例见 [`docs/sample-report.md`](docs/sample-report.md)。

---

## 常用命令

```bash
npm run typecheck        # tsc --noEmit
npm test                 # 单元测试（纯函数内核）
npm run test:contract    # 契约测试（适配器 / 治理实现必过）
npm run test:integration # 集成测试
npm run test:integration:resume  # 进程级崩溃续跑（自带假服务）
npm run test:integration:llm     # 真实模型（需配置 AI_API_*，否则显式跳过）
npm run playtest -- --scenario smoke   # 跑 othello 一整局
npm run playtest -- --scenario chess   # 跑 chess-arena（默认 localhost:3000）
npm run scan -- --scenario smoke --seeds=1-50   # 多 seed 扫描（默认基线，不产生模型费用）
npm run demo                                   # 发现→新进程复现→健康对照（无密钥）
npm run replay -- --file=reports/xxx.json --game-url=http://127.0.0.1:5173  # 重放录制动作
npm run report:html -- --file=reports/xxx.json  # 把已有报告转成可浏览器打开的 HTML
npm run report:diff -- --before=a.json --after=b.json  # 有条件对比，不可比会说明原因
npm run test:integration:replay   # 进程级缺陷复现（自带假服务）
npm run test:integration:budget   # 模型预算跨进程恢复（本地假模型）
npm run lint && npm run format:check
npm run build
```

### 缺陷复现与模型预算

- **报告 v2** 记录公开初局、完整动作、前后状态、停止原因、来源与首错证据；
  历史 v1 报告不做补造，`replay` / `diff` 会明确拒绝。
- `replay` 只接受显式本地 HTTP 目标，重新开局执行已录动作，**不重新询问模型**；
  到达原首错步且证据一致记 `reproduced`，健康实现同前缀消失记 `not-reproduced`
  （只证明该前缀，不宣称整局修复）。`--resume` 仍只接回旧房间。
- `--max-model-calls` 是每局硬上限，`--max-batch-model-calls` 是整批硬上限；
  `--llm-token-limit` 只是**已知** usage 的软停止线，不会宣称账单硬上限。
  未知用量记 unknown 并停止后续付费调用，恢复不会退还无结果的在途请求。
- `--strategy=heuristic|llm|llm-explore`；`scan --compare=heuristic,llm-explore`
  只比较同 seed、初局、目标、步限与预算的可比窗口。数字是观测事实，不预设 AI 胜出。

---

## MVP 验收（真实输出）

> 以下是本机实跑输出（2026-11-03，Node v24.22.1）。
> 被测游戏：`othello-online` 本地 `preview`（内存版 `/api`，**无需 EdgeOne 账号或 KV**）。
> **历史口径提示**：本节是 2026-11-03 的 v1 报告输出，仅作时点证据。
> 2026-11-05 起 Heuristic PRNG 改为无状态，动作序列不同；2026-11-06 起报告升级 v2
> （停止原因、公开初局、完整动作与分源用量），旧 v1 报告不能再用当前 CLI 渲染。
> 当前口径见「缺陷复现与模型预算」与 [`docs/sample-report.md`](docs/sample-report.md)。

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

> 2026-11-05 起，实际续跑需要同时传 `--checkpoint=<路径>`；未传时会提示无法续跑。
> 当前用法见下一节「2026-11-05 收口实跑」。

### 验收 3 · 模型不可用 → 降级但不中断

```console
$ npm run playtest -- --scenario smoke --seed=99
[playtest] 完成：passed · 60 步 · 降级 60 · 重放 0 · 发现 0
```

**60 步全部标注降级、原因写明在报告的「降级说明」节、局照样跑完、状态 passed。**
这就是承诺 C4 的证据：AI 是地基，但地基塌了游戏不崩，且**如实标注**。

### 2026-11-05 收口实跑：治理证据 + 真续跑 + 扫描（v1 时点证据）

> 这一轮把「报告自证治理证据」和「CLI 真续跑」补齐。运行环境同上。

**自动完成一局（报告新增治理证据）**

```console
$ npm run playtest -- --scenario smoke --seed=42
[playtest] 场景=smoke seed=42 被测=http://localhost:5173 模型=未配置（走确定性基线） 治理=in-memory（降级） 注入=无 续跑=否
[playtest] 治理降级：aiwarden 不可达（fetch failed），已降级到内存治理替身
[playtest] 完成：passed · 60 步 · 降级 60 · 重放 0 · 发现 0
[playtest] 成本：llm 0 · 治理 600 · 来源 synthetic · 无数据 0 步
[playtest] 报告：.../reports/smoke-2026-11-05T07-38-03-136Z.md
```

报告新增「治理证据」节：LLM tokens / 治理 tokens / 来源 / 无成本数据步数 /
traceId 覆盖步数；步骤表新增 tokens 与 trace 列。**synthetic 明确标注为合成值**，
不会被当成真实成本。

**崩溃 → 检查点 → 续跑**

```console
$ npm run playtest -- --scenario crash --seed=7 --inject-crash=10 \
    --checkpoint=reports/checkpoints/crash-demo.json
[playtest] 注入崩溃：第 10 步执行完成后（续跑应从这里接着跑）
[playtest] 检查点：.../reports/checkpoints/crash-demo.json

$ npm run playtest -- --resume=reports/checkpoints/crash-demo.json
[playtest] 完成：passed · 60 步 · 降级 60 · 重放 1 · 发现 0
[playtest] 成本：llm 0 · 治理 590 · 来源 synthetic/unavailable · 无数据 1 步
```

第 10 步判定为 `replayed`（不重复落子），后续动作与未崩溃基线一致；
`reports/checkpoints/` 在 gitignore 内，检查点含凭证但不进日志/报告。
进程级测试 `npm run test:integration:resume` 自带假服务，CI `verify` 也跑。

**真实模型 + 真实 aiwarden（5 步）**

```console
$ npm run playtest -- --scenario smoke --max-steps=5
[playtest] 模型=openai-compatible:LongCat-2.5 治理=aiwarden-http ...
[playtest] 完成：passed · 5 步 · 降级 0 · 重放 0 · 发现 0
[playtest] 成本：llm 4940 · 治理 500 · 来源 model-usage/governance-usage · 无数据 0 步
```

> 5 步全部非降级；`llmTokens` 来自模型 usage。
> 预算已配置：5 步 × 100 = **500** 治理 tokens。
> 未配置当月预算时 aiwarden 会按设计记 0；`model-usage / governance-usage` 两个来源都已入报告。

**真实 aiwarden 续跑（30 步）**

```console
$ ... playtest --scenario crash --seed=7 --inject-crash=10 --max-steps=30 --checkpoint=...
[playtest] 治理=aiwarden-http
[playtest] 注入崩溃：第 10 步执行完成后（续跑应从这里接着跑）
exit=3

$ ... playtest --resume=... --max-steps=30
[playtest] 完成：passed · 30 步 · 降级 30 · 重放 1 · 发现 0
[playtest] 成本：llm 0 · 治理 3000 · 来源 governance-usage · 无数据 0 步
exit=0
```

> 这条用确定性基线跑，专门验证治理续跑（所以「降级 30」是没配模型，不是失败）。
> 第 10 步命中 pending 状态哈希 → `replayed 1`，不重复落子。

**多 seed 扫描（Oracle 加强后）**

```console
$ npm run scan -- --scenario smoke --seeds=1-50 --max-steps=60
[scan] 完成：50 局 · 2999 步 · 发现 0（待人工复核）
```

新增 OTH2 整盘投影、OTH8 合法集、OTH9 winner、OTH10 累计棋子数；
chess 侧 CHS12–CHS15（合法集、FEN 历史连续性、子力不足、result 口径）由单测覆盖，
并实跑 `3 seeds / 120 步`（CHS1–CHS15 零违规）。

**本地验证（2026-11-04 快照）**

- 单元 **131** / 契约 **23** / 集成 **21**（othello 起来时 4 条通过；
  其余依赖未起按规则显式跳过）
- `lint` / `format:check` / `typecheck` / `build` 全绿
- 当轮代码对应的 CI green run 为 `41801302392`；当前规模以「测试结果」节的命令输出为准

**本轮真实链路补跑（2026-11-05）**

- **真实模型 + 真实 aiwarden**：5 步、**0 降级**、`llmTokens=4795`；
  报告同时含 `model-usage` 与 `governance-usage` 两个来源。
- **真实 aiwarden 契约 + usage**：**7 通过 + 3 显式不适用**；
  usage 专用测试会在「期望步集合」未到齐时继续轮询，不提前返回。
- **真实 aiwarden 续跑**：30 步、`replayed 1`、退出 0；对局 `businessKey` 不变。
- **治理 tokens 口径**：预算已配置，5 步=**500**、30 步续跑=**3000**（100/次）；
  未配置当月预算时 aiwarden 按设计记 0。
- **仍受边界**：真实模型只跑了 5 步，不是 60 步整局；模型即使 `temperature=0`
  也不保证逐字一致，报告只保证「合法动作 + 可复现的治理证据」。

当月预算已配置（2026-11，limit 10,000,000）。新库/重置后需要重新执行：

```bash
curl -X PUT http://localhost:8080/api/v1/admin/budgets/1 \
  -H "X-Aiwarden-Tenant-Id: 1" \
  -H "X-Aiwarden-User-Id: 1" \
  -H "Content-Type: application/json" \
  -d '{"tokenLimit":10000000}'
```

### 测试结果

| 层   | 现查命令                     | 说明                                                                                         |
| ---- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| 单元 | `npm test`                   | 纯函数内核、策略、Oracle、状态哈希、续跑判定、预算、探索指标、报告 v2、录制与对比            |
| 契约 | `npm run test:contract`      | 治理（内存 + HTTP 状态白名单）+ chess / othello 适配器；真实实现显式标不适用                 |
| 进程 | `npm run test:integration:*` | 崩溃续跑、缺陷回放、模型预算、游戏链路、tongshi duel、aiwarden；依赖不可达按 gate 跳过或失败 |

数量不写死，以命令输出为准；依赖真实服务的用例在未启动时必须显式跳过或失败，不能伪装通过。

### 集成测试：跳过 vs 失败

规则实现只有一处：[`tests/helpers/integration-gate.ts`](tests/helpers/integration-gate.ts)。

| 场景                      | 行为                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------- |
| 依赖可达                  | 正常跑                                                                                |
| 依赖不可达 + 未强制       | 跳过，并打印 `SKIPPED: <依赖> 未启动（设置 PLAYTEST_REQUIRE_INTEGRATION=1 强制失败）` |
| 依赖不可达 + 已强制       | **失败**（`assert.fail`），不允许 skip 兜绿                                           |
| CI（`integration-games`） | 两个游戏必须起来、4 条必须通过；起不来即红                                            |

强制方式（全部显式，不靠 `CI` 的隐式副作用）：

- `PLAYTEST_REQUIRE_INTEGRATION=1` —— 所有依赖都必须跑
- `PLAYTEST_REQUIRE_INTEGRATION=othello-online,chess-arena` —— 只强制列出的依赖
- `PLAYTEST_REQUIRE_INTEGRATION=0` —— 显式本地模式，覆盖环境里常驻的 `CI=true`
- 未设置上面变量且 `CI=true`（GitHub Actions 自动注入）—— 视同全部强制

一键复现：

```bash
# 服务都不起 + 本地模式：跳过并打印，退出码 0
PLAYTEST_REQUIRE_INTEGRATION=0 npm run test:integration

# 服务都不起 + 强制模式：除自足的进程级续跑外，依赖项全部失败；
# 3 条真实实现不适用的契约显式跳过，退出码 1
PLAYTEST_REQUIRE_INTEGRATION=1 npm run test:integration

# 起两个游戏后 + 强制模式：游戏链路 4/4 通过
cd ../othello-online && npm run build && npm run preview -- --port 5173
cd ../chess-arena && npm run build && npm start
PLAYTEST_REQUIRE_INTEGRATION=1 npm run test:integration:games

# 起 aiwarden 后 + 强制模式：治理契约 6 条实跑 + usage 1 条（3 条显式不适用）
PLAYTEST_REQUIRE_INTEGRATION=1 AIWARDEN_ADMIN_USER_ID=1 npm run test:integration:aiwarden
```

CI 侧相关 job：

| job                    | 内容                                                                                                                        | 超时    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------- |
| `verify`               | lint / format / typecheck / 单测 / 契约 / **进程级续跑** / **缺陷回放** / **预算** / 构建                                   | 未设    |
| `windows-recovery`     | Windows 上的进程级续跑 / 缺陷回放 / 预算（与 verify 并行）                                                                  | 10 分钟 |
| `e2e`                  | 拉 othello-online → 起服 → `npm run playtest -- --scenario smoke` → 上传 `playtest-report`                                  | 未设    |
| `integration-games`    | 拉 othello-online / chess-arena → 构建 → 5173 / 3000 起服 → `PLAYTEST_REQUIRE_INTEGRATION=1 npm run test:integration:games` | 10 分钟 |
| `integration-tongshi`  | 拉 tongshi-ju → 构建 → 3100 起服 → `PLAYTEST_REQUIRE_INTEGRATION=1 npm run test:integration:tongshi`                        | 15 分钟 |
| `e2e-tongshi`          | 拉 tongshi-ju → 构建 `.next-e2e` → 由其 Playwright `webServer` 起服 → 跑自带套件（actor 侧不引 Playwright 依赖）            | 15 分钟 |
| `integration-aiwarden` | 仅当仓库变量 `AIWARDEN_BASE_URL` 配置时运行，运行即强制（契约 + usage）；不配置则不运行                                     | 5 分钟  |

aiwarden 的治理链路需要 Java 21 + Maven + Docker（测试只需 PG / Redis / Kafka；MinIO 是 aiwarden 完整 compose 的一部分，治理契约用不到），但单轮约 2 分钟、叠加镜像拉取抖动，挂到每次 push 的默认流水线既不划算也不稳定，**不在默认 CI 里假装通过**：job 不配置 URL 就不运行（Actions 里显示 Skipped），配置了就必须真跑、失败即红。运行时会设 `AIWARDEN_ADMIN_USER_ID=1`，因为 `/api/v1/admin/usage` 要求数值主体。

另有一个独立 workflow（`.github/workflows/aiwarden-nightly.yml`）：夜间 cron + 手动 `workflow_dispatch` 触发，不挂在 push / PR 主流程上。它起的是真实 aiwarden 服务（真实 PG / Redis / Kafka，覆盖幂等 / 限流 / 审计链路；模型侧是确定性替身，零 API Key、零云端审批），但覆盖范围有限：只验证治理契约（6 实跑 + 3 显式不适用）与 usage 查询，不验证真实模型行为，也不覆盖依赖对象存储的路径（MinIO 未启动）。

### 第二游戏适配：chess-arena（2026-11-04 实跑）

```console
$ npm run playtest '--' --scenario chess
[playtest] 场景=chess seed=42 被测=http://localhost:3000 模型=未配置（走确定性基线） 治理=in-memory（降级） 注入=无
[playtest] 治理降级：aiwarden 不可达（fetch failed），已降级到内存治理替身
[playtest] 完成：passed · 60 步 · 降级 60 · 重放 0 · 发现 0
```

真实集成测试（服务可达时）：

```console
$ node --import tsx --test tests/integration/chess-arena.test.ts
✔ 真实 chess-arena：能开局、走子并通过通用与象棋断言
ℹ tests 1  ℹ pass 1  ℹ fail 0  ℹ skipped 0
```

这是「通用测试工具」定位的证据：同一个驱动循环、治理与报告，只换适配器与游戏特异 Oracle。
本次 60 步止于场景上限（`chess-arena` 走子接口按 IP 限流 60 次/分钟）；报告状态 `passed`
只代表「末步生效且无断言失败」，不代表整局终局。连续跑多局撞上限时，适配器会等待一个
滑动窗口（约 61 秒）后重试一次，不把 429 当成游戏缺陷。

**历史型和棋由本地独立判定**：适配器在状态 payload 里维护 `fenHistory`，用
`core/chess-rules.ts` 的 `analyzeHistory` 重算「三次重复 / 50 步」；服务端仍报 playing 时
也会补判为和棋。Oracle 用 CHS8–CHS11 复核服务端声明（threefold 必须真有 3 次重复、
fifty 必须半回合到 100、漏判要报、将死优先于判和）。国际象棋**没有**「连续 60 步将军」
规则 —— 长将由三次重复或 50 步终结（另有五次重复 / 75 步自动和棋上限），判据不是将军次数。

### 真实 aiwarden 治理链路：已实跑（2026-11-04）

> 2026-11-05 契约扩为 9 条后，真实实现口径变为 **6 实跑 + 3 显式不适用**
> （traceId、单次 tokens、按 session 查询用量）；成本链路改由
> `tests/integration/aiwarden-usage.test.ts` 专门覆盖。下面是 2026-11-04 的
> 8 条版本记录，保留为时点证据。

本机 Docker 恢复可用后，真实链路首次跑通：

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

**落库证据**（不只是 HTTP 200）：`t_ticket` 45 张、`t_tool_invocation` 56 条 SUCCEEDED、
`t_audit_log` 含 `TOOL_APPROVED` / `QUOTA_EXCEEDED`。

依赖不可达时的两种行为（本地模式跳过并打印；强制模式直接失败）：

```console
$ PLAYTEST_REQUIRE_INTEGRATION=0 AIWARDEN_BASE_URL=http://127.0.0.1:59999 npm run test:integration
SKIPPED: aiwarden 未启动（设置 PLAYTEST_REQUIRE_INTEGRATION=1 强制失败）

$ PLAYTEST_REQUIRE_INTEGRATION=1 AIWARDEN_BASE_URL=http://127.0.0.1:59999 npm run test:integration:aiwarden
[集成] 强制模式：aiwarden 未启动：aiwarden 不可达：fetch failed
```

进程级续跑测试自带假服务，因此即使依赖全没起也会通过；其余用例按 gate 规则跳过或失败。

**实跑暴露了三个只有真实实现才会暴露的缺陷**（内存替身全都测不出来）——
租户标识必须是数值字符串、下游唯一约束字段必须承载全部幂等维度、
动作内容的规范化必须在本侧完成。详见
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §6.3 与
[`docs/decisions/`](docs/decisions/) 裁决 20–22。

### 仍然存在的边界（如实记录）

| 边界                                | 原因                                                         | 处置                                                                              |
| ----------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| aiwarden 侧**没有游戏动作工具**     | 实测注册的是 `assign_ticket` / `create_ticket`               | 用 `create_ticket` 作替身验证整条管道；**不改 aiwarden**                          |
| 单次工具调用**不返回 traceId**      | `ToolInvokeResponse` 无该字段（traceId 属 session 层）       | 契约该条标「不适用」并注明原因，而非删断言                                        |
| 真实 aiwarden **usage** 是异步落库  | Outbox → Kafka → `t_llm_call_log`；**未配预算时按设计记 0**  | 按 session + run `startedAt` 过滤，轮询到「期望步集合」；仍无记录标 `unavailable` |
| 真实 aiwarden **续跑**              | 2026-11-05 已实跑 30 步，`replayed 1`、退出 0                | 必须同 tenant / session / businessKey；检查点保留 token                           |
| 真实模型                            | 2026-11-05 已实跑 5 步（LongCat-2.5，0 降级）；60 步整局未跑 | 无 key 时显式降级；`reasoning_content` 已兼容                                     |
| chess-arena 走子**限流 60 次/分钟** | 游戏侧按 IP 的固定窗口限流                                   | chess 场景上限设为 60 步；不绕过限流、不改被测仓库                                |

### 关于"发现真实缺陷"的诚实结论

按 [`docs/decisions/`](docs/decisions/) 裁决 18，MVP **不强制**要求发现真实缺陷，
但必须如实记录扫描结论。**目前仍没有发现 othello 的机制缺陷。**

- 2026-11-05 扫描 50 个 seed、2999 步，通用 G1–G5 + OTH1–OTH10 **零违规**
  （新增 OTH2 整盘投影、OTH8 合法集、OTH9 winner、OTH10 累计棋子数）；
- 并发场景（两个客户端同房间同时落子）**保护有效**：乐观并发精确返回 409 冲突；
- chess 侧 CHS12–CHS15 已由单测覆盖，并实跑 3 seeds / 120 步（CHS1–CHS15 零违规）；
  chess 扫描受 60 次/分限流，默认只扫 3 个 seed、40 步；
- 过程中出现过一次"发现"，经查证是**本项目的断言误报**（通用 Oracle 无法区分
  othello 的合法跳过与"该换没换"）。已修正断言分层：通用层只判通用可判的，
  跳过规则交给 OTH6。这条误报写进了 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ——
  **它比一个假缺陷更有价值**。

而**真实治理链路**这一侧确实发现了三个真缺陷（见上）—— 只是它们属于
**本项目的客户端**，而不是被测游戏。

---

## 项目状态

**当前阶段：Stage 0–6 + P0–P2 收口**（路线见 [`docs/PRD.md`](docs/PRD.md) §14）。

已交付：

- 8 项**冻结契约**（类型 / 指纹算法 / 四个 SPI / 治理键构成 / 报告结构）
- 纯函数内核：幂等指纹、无状态种子化 PRNG、驱动骨架、报告渲染、状态哈希、续跑判定、成本合并
- 适配器与治理的**契约测试套件**（任何实现接入必过）
- 驱动层：GameDriver + othello / chess-arena 双适配器 + LLM 策略（带显式降级）+ 通用 / 游戏特异 Oracle
- 治理层：真实 aiwarden HTTP 客户端 + 按 session 查询 usage（不可达/查不到时**显式降级或标 unavailable**）
- 续跑：检查点 + pending 意图 + `projectAfter` 状态哈希 + CLI `--resume`；进程级测试覆盖
- 报告：v2 保存公开初局、完整动作、前后状态与分源用量；不同单位不做跨口径合计
- 缺陷复现：`npm run demo` 实跑通过——预置漏翻被发现、新进程新房间复现同一违规，
  健康实现执行同前缀后目标违规消失；全流程无密钥、不调用模型
- 模型预算：预扣与 in-flight 持久化；CLI 进程被终止后恢复不退款、不重发
- 扫描：`npm run scan` 输出可追溯报告与成对可比窗口；发现项标注「待人工复核」
- 真实链路补跑（2026-11-05）：真实模型 5 步 0 降级、aiwarden 契约+usage 7 通过 + 3 不适用、aiwarden 续跑 30 步 `replayed 1`
- 测试：单元 270 / 契约 35 / 集成 25（本地无真实服务时按规则跳过 8 条）；
  `lint` / `format:check` / `typecheck` / `build` 全绿
- CI：`master` 最新一轮全绿（2026-11-06）；job 清单见上文表格

- 真实模型对照小样本（2026-11-06）：2 seeds × 10 步，两对同窗口可比、0 降级；
  seed 2 的探索策略在第 5 步触达角点，基线未触达；每局 10 步约 1.7 万已知 tokens
- 该样本只证明对照链路与指标可用，**不足以宣称普遍优势**；预算硬上限内完成

待做（路线图后续项）：MCP 通道、**真实模型 60 步整局实跑**（历史上只跑了 5 步）。

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
