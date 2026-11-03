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

| #   | 用例                                  | 断言什么                       |
| --- | ------------------------------------- | ------------------------------ |
| 1   | 首次调用执行副作用且 `replayed=false` | 首次不丢动作                   |
| 2   | 同键重放不产生第二次副作用            | **幂等语义**（承诺 C3 的地基） |
| 3   | 不同步号不互相命中                    | 键含 stepNo                    |
| 4   | 不同 session 不互相命中               | 键含 session                   |
| 5   | 返回 traceId                          | 能与治理侧 trace 串联          |
| 6   | 重放的 tokens 与首次一致              | 成本不重复计入                 |

---

## 4. 验收判据（MVP）

```bash
# 0) 起被测游戏（本地，免云端）
cd ../othello-online && npm run build && npm run preview   # :5173

# 1) Agent 自动打完一局
npm run playtest -- --scenario smoke
#    期望：完整 StepRecord 链 + reports/smoke-<ts>.md 与 .json

# 2) 崩溃续跑不重复副作用
npm run playtest -- --scenario crash --inject-crash=after-action
#    期望：续跑后动作总数与未崩溃基线逐项相等（diff 为空）

# 3) 模型不可用降级
AI_API_KEY= npm run playtest -- --scenario smoke
#    期望：仍跑完，报告标注"本段由确定性基线驱动"

# 4) 治理证据落库
#    期望：aiwarden 的 t_agent_step / t_llm_call_log 有该 session 记录，四维齐全
```

**完成的判定**（避免"做完了就算数"）：

- 上述命令**全部可复现**，真实输出贴进 README；
- 至少**发现并修复一个真实缺陷**（不是植入的假缺陷）——
  若一个都没有，说明断言不够强，需加强 Oracle 再验；
- CI 两段全绿。

---

## 5. 断言的独立性

Oracle 跑在**被测游戏之外**，是**独立实现**，不复用被测游戏的规则代码。

> 用游戏自己的规则校验游戏自己，会漏掉共模错误 —— 双方共享同一个错误假设时，
> 校验必然通过。

游戏特异断言由适配器提供，但**必须独立于游戏的实现**。

---

## 6. 确定性要求

| 场景 | 要求                                                |
| ---- | --------------------------------------------------- |
| 策略 | 同 seed + 同局面 → 同动作。不得用真随机 / 时间      |
| PRNG | 自实现 mulberry32，种子写进报告                     |
| 指纹 | 只吃 `{ stepNo, payload }`，不吃时间 / 随机 / id    |
| 报告 | 纯渲染，同样步骤序列必得同样字节（可 diff、可入库） |

---

## 7. 缺陷编号

发现项的 `code` 必须**稳定**（跨次运行可对照），格式：

- 通用断言：`G<n>-<描述>`（如 `G1-turn-did-not-alternate`）
- 游戏特异断言：`<游戏缩写><n>-<描述>`（如 `OTH3-flip-count-mismatch`）

报告编号体系与 `othello-online/tests/playtest/smoke-checklist.md` 对齐 ——
机器结果能直接接人工观察表。
