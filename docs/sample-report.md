# Playtest 报告 · smoke（验收样例）

> **本文是一次真实运行的报告样例**（2026-11-05，本机 othello-online preview）。
> 复现命令：`npm run playtest -- --scenario smoke --seed=42`。
> 原始运行产物不入库（`reports/` 已在 `.gitignore`）。
>
> 本次未配置模型、aiwarden 不可达，因此：LLM tokens=0、治理 tokens 为内存替身的**合成值**、
> traceId 为替身生成值。这三项不能当作真实成本/真实 trace 证据；真实链路口径见 README。

# Playtest 报告 · smoke

| 项                   | 值            |
| -------------------- | ------------- |
| 状态                 | **passed**    |
| 场景                 | smoke         |
| 会话                 | `pt-smoke-42` |
| 对局                 | `RBZB86`      |
| 随机种子             | `42`          |
| 步数                 | 60            |
| 降级步数             | 60            |
| 重放步数（幂等命中） | 0             |
| 失败步数             | 0             |
| 治理来源             | `in-memory`   |

> ⚠️ **治理降级**：aiwarden 不可达（fetch failed），已降级到内存治理替身

## 治理证据

| 项               | 值        |
| ---------------- | --------- |
| LLM tokens       | 0         |
| 治理 tokens      | 600       |
| tokens 合计      | 600       |
| token 来源       | synthetic |
| 无成本数据步数   | 0         |
| traceId 覆盖步数 | 60/60     |

> 内存替身的 token 数是固定合成值，不代表真实成本。

## 发现

无。

## 步骤

| #   | 动作 | 结果    | 幂等 | 降级 | tokens | trace           | 摘要       | 耗时(ms) |
| --- | ---- | ------- | ---- | ---- | ------ | --------------- | ---------- | -------- |
| 0   | 5,4  | applied | 否   | 是   | gov:10 | trace-RBZB86-0  | `fbce98a1` | 3        |
| 1   | 5,3  | applied | 否   | 是   | gov:10 | trace-RBZB86-1  | `b6f6b3b9` | 3        |
| 2   | 4,2  | applied | 否   | 是   | gov:10 | trace-RBZB86-2  | `7748120b` | 3        |
| 3   | 3,5  | applied | 否   | 是   | gov:10 | trace-RBZB86-3  | `c0bd4564` | 6        |
| 4   | 4,5  | applied | 否   | 是   | gov:10 | trace-RBZB86-4  | `c4195d06` | 4        |
| 5   | 5,6  | applied | 否   | 是   | gov:10 | trace-RBZB86-5  | `4b36cfac` | 4        |
| 6   | 2,4  | applied | 否   | 是   | gov:10 | trace-RBZB86-6  | `60947961` | 3        |
| 7   | 3,2  | applied | 否   | 是   | gov:10 | trace-RBZB86-7  | `c6b02d55` | 2        |
| 8   | 3,6  | applied | 否   | 是   | gov:10 | trace-RBZB86-8  | `5ec69453` | 1        |
| 9   | 5,1  | applied | 否   | 是   | gov:10 | trace-RBZB86-9  | `78693441` | 2        |
| 10  | 6,3  | applied | 否   | 是   | gov:10 | trace-RBZB86-10 | `8d628449` | 2        |
| 11  | 1,4  | applied | 否   | 是   | gov:10 | trace-RBZB86-11 | `ec76baff` | 1        |
| 12  | 2,6  | applied | 否   | 是   | gov:10 | trace-RBZB86-12 | `077388a4` | 2        |
| 13  | 6,4  | applied | 否   | 是   | gov:10 | trace-RBZB86-13 | `86324704` | 2        |
| 14  | 2,5  | applied | 否   | 是   | gov:10 | trace-RBZB86-14 | `1f7bf416` | 1        |
| 15  | 4,7  | applied | 否   | 是   | gov:10 | trace-RBZB86-15 | `a803f6b9` | 1        |
| 16  | 6,2  | applied | 否   | 是   | gov:10 | trace-RBZB86-16 | `ebeece82` | 2        |
| 17  | 5,5  | applied | 否   | 是   | gov:10 | trace-RBZB86-17 | `780d4fc5` | 1        |
| 18  | 3,1  | applied | 否   | 是   | gov:10 | trace-RBZB86-18 | `eaa12150` | 1        |
| 19  | 6,1  | applied | 否   | 是   | gov:10 | trace-RBZB86-19 | `60666f1b` | 1        |
| 20  | 6,6  | applied | 否   | 是   | gov:10 | trace-RBZB86-20 | `75264490` | 2        |
| 21  | 2,7  | applied | 否   | 是   | gov:10 | trace-RBZB86-21 | `4a3360eb` | 1        |
| 22  | 1,5  | applied | 否   | 是   | gov:10 | trace-RBZB86-22 | `5bf5fc4a` | 1        |
| 23  | 3,0  | applied | 否   | 是   | gov:10 | trace-RBZB86-23 | `d39ac0a9` | 1        |
| 24  | 2,0  | applied | 否   | 是   | gov:10 | trace-RBZB86-24 | `e97196f6` | 1        |
| 25  | 7,7  | applied | 否   | 是   | gov:10 | trace-RBZB86-25 | `cd6aaa46` | 0        |
| 26  | 2,2  | applied | 否   | 是   | gov:10 | trace-RBZB86-26 | `6dd46158` | 1        |
| 27  | 1,0  | applied | 否   | 是   | gov:10 | trace-RBZB86-27 | `624f734c` | 1        |
| 28  | 6,0  | applied | 否   | 是   | gov:10 | trace-RBZB86-28 | `c1bf03c8` | 1        |
| 29  | 2,3  | applied | 否   | 是   | gov:10 | trace-RBZB86-29 | `c52479e2` | 1        |
| 30  | 7,3  | applied | 否   | 是   | gov:10 | trace-RBZB86-30 | `2f01c4c3` | 1        |
| 31  | 2,1  | applied | 否   | 是   | gov:10 | trace-RBZB86-31 | `ae2221ed` | 1        |
| 32  | 3,7  | applied | 否   | 是   | gov:10 | trace-RBZB86-32 | `8e3d7999` | 1        |
| 33  | 0,5  | applied | 否   | 是   | gov:10 | trace-RBZB86-33 | `6f7eebfa` | 1        |
| 34  | 0,3  | applied | 否   | 是   | gov:10 | trace-RBZB86-34 | `a19d8b7b` | 2        |
| 35  | 4,0  | applied | 否   | 是   | gov:10 | trace-RBZB86-35 | `a4b4692c` | 1        |
| 36  | 0,4  | applied | 否   | 是   | gov:10 | trace-RBZB86-36 | `29a69f19` | 2        |
| 37  | 1,7  | applied | 否   | 是   | gov:10 | trace-RBZB86-37 | `84850c70` | 1        |
| 38  | 7,4  | applied | 否   | 是   | gov:10 | trace-RBZB86-38 | `16dfac4b` | 1        |
| 39  | 7,5  | applied | 否   | 是   | gov:10 | trace-RBZB86-39 | `6fd03c70` | 2        |
| 40  | 5,7  | applied | 否   | 是   | gov:10 | trace-RBZB86-40 | `845b2d34` | 0        |
| 41  | 4,1  | applied | 否   | 是   | gov:10 | trace-RBZB86-41 | `a5d8a462` | 0        |
| 42  | 5,2  | applied | 否   | 是   | gov:10 | trace-RBZB86-42 | `496733f3` | 1        |
| 43  | 4,6  | applied | 否   | 是   | gov:10 | trace-RBZB86-43 | `8368eb63` | 1        |
| 44  | 6,5  | applied | 否   | 是   | gov:10 | trace-RBZB86-44 | `f9a23a03` | 0        |
| 45  | 0,6  | applied | 否   | 是   | gov:10 | trace-RBZB86-45 | `02cce338` | 1        |
| 46  | 0,7  | applied | 否   | 是   | gov:10 | trace-RBZB86-46 | `cd938976` | 1        |
| 47  | 1,3  | applied | 否   | 是   | gov:10 | trace-RBZB86-47 | `29f0805c` | 1        |
| 48  | 1,1  | applied | 否   | 是   | gov:10 | trace-RBZB86-48 | `74ea6844` | 1        |
| 49  | 7,2  | applied | 否   | 是   | gov:10 | trace-RBZB86-49 | `7a6b0c46` | 2        |
| 50  | 0,2  | applied | 否   | 是   | gov:10 | trace-RBZB86-50 | `04c25311` | 1        |
| 51  | 1,2  | applied | 否   | 是   | gov:10 | trace-RBZB86-51 | `03fa993e` | 1        |
| 52  | 7,6  | applied | 否   | 是   | gov:10 | trace-RBZB86-52 | `004626b2` | 0        |
| 53  | 1,6  | applied | 否   | 是   | gov:10 | trace-RBZB86-53 | `7c15f646` | 0        |
| 54  | 0,1  | applied | 否   | 是   | gov:10 | trace-RBZB86-54 | `93ee63a3` | 1        |
| 55  | 6,7  | applied | 否   | 是   | gov:10 | trace-RBZB86-55 | `aeb04c61` | 2        |
| 56  | 0,0  | applied | 否   | 是   | gov:10 | trace-RBZB86-56 | `326befb4` | 1        |
| 57  | 7,1  | applied | 否   | 是   | gov:10 | trace-RBZB86-57 | `819b73c9` | 2        |
| 58  | 5,0  | applied | 否   | 是   | gov:10 | trace-RBZB86-58 | `4823e623` | 1        |
| 59  | 7,0  | applied | 否   | 是   | gov:10 | trace-RBZB86-59 | `8da2460c` | 1        |

## 降级说明

- 未配置模型客户端（AI_API_KEY 缺失或模型端点不可用）
