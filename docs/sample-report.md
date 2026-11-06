# Playtest 报告样例（v2）

> 真实 `npm run demo` 产物（2026-11-06，本机）。来源是**预置漏翻的本地假服务**，
> 不是真实游戏缺陷；运行产物不入库。完整闭环见 README「缺陷复现与模型预算」。

```markdown
# Playtest 报告 · demo-missed-flip

| 项                     | 值                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------- |
| 状态                   | **failed**                                                                          |
| 断言                   | failed                                                                              |
| 停止原因               | assertion-failed                                                                    |
| 游戏终局               | 否                                                                                  |
| 错误类别               | state                                                                               |
| 证据来源               | injected-fixture                                                                    |
| 游戏 / 目标版本        | othello / othello-fixture-v1:missed-flip@5                                          |
| Agent / Oracle / 策略  | c5980a9f961afca1522c97a0b9109081507af2fe+dirty / generic+othello / heuristic-random |
| 会话 / 对局            | 0ecaba9e-ea0d-4ad3-a4a1-a471460922e8 / R00001                                       |
| 随机种子               | 42                                                                                  |
| 步数 / 上限            | 6 / 20                                                                              |
| 降级 / 重放 / 失败步数 | 0 / 0 / 0                                                                           |
| 治理来源               | in-memory                                                                           |

## 治理证据

| 项             | 值        |
| -------------- | --------- |
| LLM tokens     | unknown   |
| 治理配额当量   | unknown   |
| 替身合成值     | 60        |
| 来源           | synthetic |
| 无成本数据步数 | 0         |

> 三种单位分列；合成值不代表真实成本。unknown 不是 0；已知部分不能冒充完整总用量。

## 发现

| 编号                           | 级别               | 步骤 | 描述                               |
| ------------------------------ | ------------------ | ---- | ---------------------------------- |
| OTH2-board-projection-mismatch | fatal              | 5    | 落子后棋盘与独立 Oracle 推演不一致 |
| board\[4\]\[5\]                | Oracle 预期 / 实际 | 5    | 2 / 1                              |

## 步骤

| #   | 动作 | 结果    | 幂等 | 降级 | 分源用量                   | trace          | 摘要                        | 耗时(ms) |
| --- | ---- | ------- | ---- | ---- | -------------------------- | -------------- | --------------------------- | -------- |
| 0   | 5,4  | applied | 否   | 否   | llm:unknown / synthetic:10 | trace-R00001-0 | a81a612509a6 → 5f9276bd01a0 | 7        |
| 1   | 5,3  | applied | 否   | 否   | llm:unknown / synthetic:10 | trace-R00001-1 | 5f9276bd01a0 → 5b3a3ceb0eb4 | 6        |
| 2   | 4,2  | applied | 否   | 否   | llm:unknown / synthetic:10 | trace-R00001-2 | 5b3a3ceb0eb4 → 30a8494f8f8d | 6        |
| 3   | 3,5  | applied | 否   | 否   | llm:unknown / synthetic:10 | trace-R00001-3 | 30a8494f8f8d → 6f56635e746e | 6        |
| 4   | 4,5  | applied | 否   | 否   | llm:unknown / synthetic:10 | trace-R00001-4 | 6f56635e746e → fbdb238ca4d4 | 5        |
| 5   | 5,6  | applied | 否   | 否   | llm:unknown / synthetic:10 | trace-R00001-5 | fbdb238ca4d4 → 27ef2faabbb8 | 4        |
```
