# AGENTS.md —— Playtest Agent AI 协作指南

> 本文只放 AI 必读的内容：不可破坏的红线、技术栈、日常命令、文档路由。
> 契约定义与架构见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)；产品需求见 [`docs/PRD.md`](docs/PRD.md)。

**项目**：`playtest-agent` —— AI 游戏自动测试 Agent（自主开局、按策略游玩、为每步产出治理证据、产出可复现缺陷报告）
**位置**：`F:\other\code\ai\playtest-agent`（与作品集其余项目平级，独立仓库）

---

## 1. 技术栈

Node.js **≥ 24.22.1**（2026-10 Node 安全公告修复线；低于此线不跑 CI）· TypeScript 5.5 ·
**运行时零依赖**（HTTP 客户端用 Node 内置 `fetch`）· 测试用 `node --import tsx --test`
（**不引测试框架**，对齐 tongshi-ju / chess-arena 既有习惯）。

---

## 2. 七条红线

> 违反任何一条都会破坏产品本身，不是"风格问题"。

### 2.1 aiwarden 零改动

本项目**只消费** aiwarden 的既有边界（HTTP / MCP），**不修改它一个字节**。
aiwarden 的 `AgentDagEngine` 是固定 10 节点的单次问答管线，本项目需要的是循环
—— 两者形状不同。改造 aiwarden 会污染它已收口的 M4 口径（STATUS §4）。

### 2.2 既有游戏零改动

被测对象（othello-online / chess-arena）**只读**。需要新能力时，
在 `src/adapter/` 内用适配器解决，不去改游戏仓库。

### 2.3 零云端审批依赖

**不引入任何需要人工审批的外部资源作为关键路径**（EdgeOne KV 审批、域名、
实名认证一律不进）。othello-online 本地 mock API 已覆盖全部动作面。

### 2.4 决策确定性

确定性基线必须由 seed、观察序号与显式探索上下文决定，不引入真随机或时间依赖。
LLM 不承诺相同 seed 的重新采样一致：**完整记录动作与公开状态，复现时不重新调用模型**。
新运行身份可在 IO 层生成；身份不得影响策略决策。

### 2.5 依赖克制

PRNG / 指纹 / 报告 / 洗牌**全部自实现**，不引游戏 / 随机 / 日期库
（对齐 tongshi-ju 红线 2.4）。新增依赖需先说明为什么现有能力做不到。

### 2.6 凭证纪律

`playerId` / `token` 是对局写操作的唯一凭证，**绝不能出现在日志、报告、对外数据里**。
凭证只进幂等键（作为 businessKey 的一部分）。续跑检查点会保存 token，
**只允许落在 gitignore 的 `reports/checkpoints/`**，同样不进日志与报告。

### 2.7 不记录密钥

API Key **只从服务端环境变量读取**，不进 bundle、不入日志、不入仓库。
提交前用 `git ls-files` 自查 `.env`、构建产物、`*.tsbuildinfo`。

---

## 3. 目录速查

```
src/
├─ types/       共享类型（地基冻结契约 ①②）
├─ core/        纯函数内核（③④⑧）：指纹 / PRNG / 驱动骨架 / 报告渲染
├─ adapter/     适配器 SPI + 契约测试套件（④）
├─ strategy/    策略 SPI + 确定性基线（⑤）
├─ oracle/      断言 SPI + 通用断言集（⑥）
├─ governance/  治理契约 + 幂等键装配 + 内存替身（⑦）
└─ report/      报告落盘薄壳
tests/
├─ *.test.ts        单元测试
├─ contract/        契约测试（适配器 / 治理实现必过）
└─ integration/     集成测试（真实被测游戏 / 真实治理面）
docs/
├─ PRD.md            产品需求
├─ ARCHITECTURE.md   地基契约权威源（8 项冻结契约）
├─ TESTING.md        测试约定与验收判据
├─ research/         带日期的一次性调研快照（**不回改**）
└─ decisions/        裁决清单（编号顺延追加）
scenarios/           预留的外部场景目录（当前未接入；内置场景在 src/scenarios/registry.ts）
reports/             产出报告（**不入库**）
```

---

## 4. 极简命令

```bash
npm install
npm run typecheck        # tsc --noEmit
npm test                 # 单元测试
npm run test:contract    # 契约测试（适配器 / 治理实现必过）
npm run test:integration # 集成测试
npm run test:integration:resume  # 进程级崩溃续跑（自带假服务）
npm run playtest -- --scenario smoke   # 跑一局
npm run scan -- --scenario smoke --seeds=1-50   # 多 seed 扫描（默认基线，不收费）
npm run demo                                   # 预置缺陷发现 → 新进程复现 → 健康对照
npm run replay -- --file=reports/xxx.json --game-url=http://127.0.0.1:5173
npm run report:html -- --file=reports/xxx.json  # 已有报告 → 自包含 HTML
npm run report:diff -- --before=a.json --after=b.json
npm run lint && npm run format:check
npm run build
```

完整脚本以 `package.json` 为准。

---

## 5. 改代码前必读

| 你要改什么          | 先读                                                |
| ------------------- | --------------------------------------------------- |
| 类型形状 / 冻结契约 | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §1–2 |
| 驱动循环 / 终止判定 | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §4   |
| 幂等键 / 治理语义   | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §3   |
| 产品需求 / 成功标准 | [`docs/PRD.md`](docs/PRD.md)                        |
| 测试约定 / 验收判据 | [`docs/TESTING.md`](docs/TESTING.md)                |

---

## 6. 改动纪律

1. **先看现状再改** —— 读邻近文件，沿用既有命名与模式。
2. **冻结契约要改，先写裁决** —— 在 `docs/decisions/` 追加条目说明兼容性影响，再动代码。
3. **新逻辑补单测** —— `core/` 的新纯函数必须能被单测覆盖；适配器 / 治理实现必须过契约套件。
4. **一个事实一个权威源** —— 契约定义只在 `docs/ARCHITECTURE.md`；
   `docs/research/` 是带日期的一次性快照，**只作时点证据、不回改**。
5. **文档分层** —— 人类入口 `README.md`、AI 入口 `AGENTS.md`、长文与规则 `docs/`；
   改完跑 `npm run format:check`。
6. **不静默降级** —— 模型不可用要**显式**标 `degraded` 并写进报告，
   不能悄悄换一个策略假装无事发生（aiwarden §4 的坑形态）。

---

## 7. 仓库与流水线

**分支**：`dev` 是开发主干，`master` 是 GitHub 默认分支（发布口径）。
改动一律在 `dev` 上做 → 提 PR → 合入 `master`；**不直推 `master`、不 force-push**。

**CI**：push / PR 到 `master` / `main` / `dev` 均触发；
`verify`（lint / format / typecheck / 单测 / 契约 / **进程级续跑** / **缺陷回放** / **预算** / 构建）
→ Windows 恢复 job → `e2e`（真实跑一局）
→ `integration-games` / `integration-tongshi` / `e2e-tongshi`（强制真实服务），
细节以 `.github/workflows/ci.yml` 为准。**CI 绿灯 = 可合并判据**。

**提交信息**：`type: 中文描述`（`docs` / `feat` / `fix` / `test` / `chore`），
**单行 subject + 中文正文**；正文要回答"凭什么说这个改动是对的"——
有实测就写实测命令与结果，有取舍就写放弃了什么。
