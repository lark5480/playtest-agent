import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseReportJson,
  publicAction,
  publicSnapshot,
  snapshotHash,
} from "../src/core/recording.js";
import { buildReportJson } from "../src/core/report-core.js";
import { digestOf } from "../src/core/fingerprint.js";
import {
  chessState,
  chessReport,
  opening,
  params,
  faultyReport,
  START_FEN,
  AFTER_FEN,
  step,
  afterMove,
} from "./helpers/report-fixtures.js";

test("数组getter拒绝而不执行", () => {
  let called = false;
  const state = opening();
  const actions = [...state.legalActions];
  Object.defineProperty(actions, "0", {
    get() {
      called = true;
      throw new Error("SECRET");
    },
  });
  assert.throws(() => publicSnapshot("othello", { ...state, legalActions: actions }), /校验失败/);
  assert.equal(called, false);
});

test("失败动作即使有后态也不允许继续下一步", () => {
  const raw = JSON.parse(JSON.stringify(buildReportJson(params())));
  raw.steps[0].outcome = "failed";
  raw.steps.push(structuredClone(raw.steps[0]));
  raw.steps[1].stepNo = 1;
  raw.steps[1].digest = digestOf(raw.steps[1].action, 1);
  assert.throws(() => parseReportJson(raw), /失败步骤后/);
});

test("两种快照字段白名单，去掉房间 / 凭证 / 时钟 / seq；数组复制", () => {
  for (const game of ["othello", "chess"] as const) {
    const state = game === "othello" ? opening() : chessState();
    const dirty = {
      ...state,
      id: "SECRET_ROOM",
      token: "SECRET_TOKEN",
      playerId: "SECRET_PLAYER",
      updatedAt: 555,
      payload: {
        ...state.payload,
        seq: 100,
        token: "SECRET_TOKEN",
        roomId: "SECRET_ROOM",
        clock: 10,
        rawResponse: { authorization: "SECRET_TOKEN" },
      },
      legalActions: state.legalActions.map((action) => ({
        ...action,
        token: "SECRET_TOKEN",
        payload: { ...action.payload, token: "SECRET_TOKEN" },
      })),
    };
    const clean = publicSnapshot(game, dirty);
    assert.deepEqual(clean, publicSnapshot(game, state));
    assert.ok(!JSON.stringify(clean).includes("SECRET"));
    assert.equal(snapshotHash(clean), snapshotHash(publicSnapshot(game, state)));
  }
});
test("完整棋类回放 hash 包含 result / SAN / FEN 历史，不是 resume 窄摘要", () => {
  const state = chessState();
  const original = publicSnapshot("chess", state);
  for (const payload of [
    { ...state.payload, result: { winner: "white", reason: "resignation" } },
    { ...state.payload, moves: ["e4"] },
    { ...state.payload, fenHistory: [START_FEN, AFTER_FEN] },
  ])
    assert.notEqual(
      snapshotHash(original),
      snapshotHash(publicSnapshot("chess", { ...state, payload })),
    );
});
test("相同合法动作集顺序与对象键序不同不造成状态分歧", () => {
  const state = opening();
  const reversed = { ...state, id: "other-room", legalActions: [...state.legalActions].reverse() };
  assert.equal(
    snapshotHash(publicSnapshot("othello", state)),
    snapshotHash(publicSnapshot("othello", reversed)),
  );
});
test("国际象棋往返、升变 ID 与完整 payload", () => {
  const report = chessReport();
  assert.deepEqual(parseReportJson(JSON.parse(JSON.stringify(report))), report);
  assert.deepEqual(
    publicAction("chess", {
      id: "a7a8q",
      payload: { from: "a7", to: "a8", promotion: "q", token: "SECRET" },
    }),
    { id: "a7a8q", payload: { from: "a7", to: "a8", promotion: "q" } },
  );
  assert.throws(
    () => publicAction("chess", { id: "a7a8q", payload: { from: "a7", to: "a8", promotion: "r" } }),
    /不一致/,
  );
});
test("v1明确拒绝，不补默认字段；未知schema拒绝", () => {
  assert.throws(() => parseReportJson({ schemaVersion: 1 }), /不支持报告 v1.*重新运行生成 v2/);
  for (const value of [null, [], {}, { schemaVersion: "2" }, { schemaVersion: 99 }])
    assert.throws(() => parseReportJson(value), /校验失败/);
});
test("所有必需 v2 字段缺失均拒绝", () => {
  const valid = buildReportJson(params());
  for (const key of Object.keys(valid).filter(
    (key) => !["budget", "errorCategory", "governanceDegradedReason"].includes(key),
  )) {
    const raw = JSON.parse(JSON.stringify(valid));
    delete raw[key];
    assert.throws(() => parseReportJson(raw), /校验失败/, key);
  }
});
const mutations: [string, (raw: ReturnType<typeof JSON.parse>) => void][] = [
  [
    "步骤跳号",
    (raw) => {
      raw.steps[0].stepNo = 1;
    },
  ],
  [
    "动作ID不一致",
    (raw) => {
      raw.steps[0].actionId = "3,2";
    },
  ],
  [
    "动作payload篡改",
    (raw) => {
      raw.steps[0].action.payload.col = 4;
    },
  ],
  [
    "另一个合法动作但旧digest",
    (raw) => {
      raw.steps[0].actionId = "3,2";
      raw.steps[0].action = { id: "3,2", payload: { row: 3, col: 2 } };
    },
  ],
  [
    "动作不在合法集合",
    (raw) => {
      const action = { id: "0,0", payload: { row: 0, col: 0 } };
      raw.steps[0].action = action;
      raw.steps[0].actionId = action.id;
      raw.steps[0].digest = digestOf(action, 0);
    },
  ],
  [
    "beforeHash篡改",
    (raw) => {
      raw.steps[0].beforeHash = "0".repeat(64);
    },
  ],
  [
    "afterHash篡改",
    (raw) => {
      raw.steps[0].afterHash = null;
    },
  ],
  [
    "初态不匹配",
    (raw) => {
      raw.initialState.payload.board[0][0] = 1;
    },
  ],
  [
    "末态不匹配",
    (raw) => {
      raw.finalState.payload.moveCount = 2;
    },
  ],
  [
    "棋盘少一行",
    (raw) => {
      raw.initialState.payload.board.pop();
    },
  ],
  [
    "棋盘少一列",
    (raw) => {
      raw.initialState.payload.board[0].pop();
    },
  ],
  [
    "棋盘值非枚举",
    (raw) => {
      raw.initialState.payload.board[0][0] = 3;
    },
  ],
  [
    "棋盘凭证代替数组",
    (raw) => {
      raw.initialState.payload.board = { token: "SECRET" };
    },
  ],
  [
    "超多动作",
    (raw) => {
      raw.initialState.legalActions = Array(65).fill(raw.initialState.legalActions[0]);
    },
  ],
  [
    "重复动作",
    (raw) => {
      raw.initialState.legalActions.push(raw.initialState.legalActions[0]);
    },
  ],
  [
    "非法turn",
    (raw) => {
      raw.initialState.turn = "SECRET_PLAYER";
    },
  ],
  [
    "非法winner",
    (raw) => {
      raw.finalState.payload.winner = "SECRET_PLAYER";
    },
  ],
  [
    "负数",
    (raw) => {
      raw.seed = -1;
    },
  ],
  [
    "NaN",
    (raw) => {
      raw.steps[0].elapsedMs = NaN;
    },
  ],
  [
    "Infinity",
    (raw) => {
      raw.steps[0].elapsedMs = Infinity;
    },
  ],
  [
    "小数计数",
    (raw) => {
      raw.stepCount = 0.5;
    },
  ],
  [
    "时序回退",
    (raw) => {
      raw.finishedAt = 0;
    },
  ],
  [
    "上限越界",
    (raw) => {
      raw.metadata.maxSteps = 10001;
    },
  ],
  [
    "步数超限",
    (raw) => {
      raw.metadata.maxSteps = 0;
    },
  ],
  [
    "不支持generic游戏",
    (raw) => {
      raw.metadata.game = "generic";
    },
  ],
  [
    "状态伪造passed",
    (raw) => {
      raw.status = "passed";
    },
  ],
  [
    "assertionStatus伪造",
    (raw) => {
      raw.assertionStatus = "not-evaluated";
    },
  ],
  [
    "terminal伪造",
    (raw) => {
      raw.gameTerminal = true;
    },
  ],
  [
    "停止枚举缺失",
    (raw) => {
      raw.stopReason = "other";
    },
  ],
  [
    "统计篡改",
    (raw) => {
      raw.replayedSteps = 1;
    },
  ],
  [
    "不再接受跨单位total",
    (raw) => {
      raw.usage.total = 0;
    },
  ],
  [
    "未知填0",
    (raw) => {
      raw.usage.llm = 0;
    },
  ],
  [
    "token单位不明确",
    (raw) => {
      raw.steps[0].governanceTokens = 5;
      raw.steps[0].tokenSources = ["synthetic", "governance-usage"];
    },
  ],
];
for (const [label, mutate] of mutations)
  test(`严格读取拒绝：${label}`, () => {
    const raw = JSON.parse(JSON.stringify(buildReportJson(params())));
    mutate(raw);
    assert.throws(() => parseReportJson(raw), /校验失败/);
  });
test("多步前后链断裂，即使单步hash正确也拒绝", () => {
  const raw = JSON.parse(JSON.stringify(buildReportJson(params())));
  const second = structuredClone(raw.steps[0]);
  second.stepNo = 1;
  second.digest = digestOf(second.action, 1);
  raw.steps.push(second);
  raw.stepCount = 2;
  assert.throws(() => parseReportJson(raw), /状态链/);
});
test("缺后态后不能追加步骤", () => {
  const raw = JSON.parse(
    JSON.stringify(
      buildReportJson(
        params({
          finalState: opening(),
          steps: [step({ observationAfter: null, outcome: "failed" })],
          stopReason: "execution-failed",
        }),
      ),
    ),
  );
  const second = structuredClone(raw.steps[0]);
  second.stepNo = 1;
  second.digest = digestOf(second.action, 1);
  raw.steps.push(second);
  raw.stepCount = 2;
  assert.throws(() => parseReportJson(raw), /缺失后态/);
});
test("预算 shape / 计数 / 序号 / unknown 用量严格验证", () => {
  const cases = [
    { maxCalls: -1, attempts: [] },
    { maxCalls: 0, attempts: [{ callId: 1, state: "settled", tokens: 3 }] },
    {
      maxCalls: 2,
      attempts: [
        { callId: 1, state: "settled", tokens: 3 },
        { callId: 1, state: "settled", tokens: 3 },
      ],
    },
    {
      maxCalls: 2,
      attempts: [
        { callId: 1, state: "in-flight" },
        { callId: 2, state: "settled", tokens: 3 },
      ],
    },
    { maxCalls: 1, attempts: [{ callId: 1, state: "unknown", tokens: 0 }] },
    { maxCalls: 1, attempts: [{ callId: 1, state: "settled", tokens: -1 }] },
    { maxCalls: 1, tokenLimit: Infinity, attempts: [] },
  ];
  for (const budget of cases)
    assert.throws(() => parseReportJson({ ...buildReportJson(params()), budget }), /budget/);
});
test("棋类快照不接受坏FEN、非法SAN、凭证结果与超界历史", () => {
  const state = chessState();
  for (const payload of [
    { ...state.payload, fen: "SECRET_TOKEN" },
    { ...state.payload, fen: START_FEN.replace(" 0 1", " -1 1") },
    { ...state.payload, moves: ["SECRET_TOKEN"] },
    { ...state.payload, fenHistory: [] as string[], result: { winner: null, reason: "SECRET" } },
    { ...state.payload, fenHistory: Array(10002).fill(START_FEN) },
    { ...state.payload, result: { winner: "SECRET_PLAYER", reason: "draw" } },
  ])
    assert.throws(() => publicSnapshot("chess", { ...state, payload }), /校验失败/);
});
test("读取重建所有层级白名单，去掉额外token字段与原始错误消息", () => {
  const raw = JSON.parse(JSON.stringify(faultyReport()));
  for (const object of [
    raw,
    raw.metadata,
    raw.initialState,
    raw.initialState.payload,
    raw.finalState,
    raw.steps[0],
    raw.steps[0].before.payload,
    raw.steps[0].action,
    raw.steps[0].action.payload,
    raw.findings[0],
    raw.findings[0].evidence[0],
    raw.usage,
  ])
    object.token = "SECRET_TOKEN";
  raw.steps[0].error = "SECRET_TOKEN";
  raw.findings[0].message = "SECRET_TOKEN";
  const clean = parseReportJson(raw);
  assert.ok(!JSON.stringify(clean).includes("SECRET_TOKEN"));
  assert.deepEqual(clean.findings[0]?.evidence, [{ field: "board[3][3]", expected: 1, actual: 2 }]);
});
test("evidence不允许任意对象 / token字段 / 原始响应值", () => {
  for (const evidence of [
    [{ field: "token", expected: "x", actual: "SECRET" }],
    [{ field: "board[3][3]", expected: 1, actual: { token: "SECRET" } }],
  ]) {
    const raw = JSON.parse(JSON.stringify(faultyReport()));
    raw.findings[0].evidence = evidence;
    assert.throws(
      () => parseReportJson(raw),
      (error: unknown) => error instanceof Error && !error.message.includes("SECRET"),
    );
  }
});
test("原型 / getter 不参与 DTO 读取；错误不回显恶意内容", () => {
  let called = false;
  const raw = {
    schemaVersion: 2,
    get metadata() {
      called = true;
      throw new Error("SECRET");
    },
  };
  assert.throws(() => parseReportJson(raw), /校验失败/);
  assert.equal(called, false);
  assert.throws(() => parseReportJson(Object.create({ schemaVersion: 2 })), /校验失败/);
});
test("初末状态的棋规矛盾保留给Oracle，而不是读取器伪装修复", () => {
  const state = afterMove();
  const contradictory = { ...state, payload: { ...state.payload, moveCount: 10 } };
  const report = buildReportJson(
    params({
      finalState: contradictory,
      steps: [step({ observationAfter: { state: contradictory, seq: 1, at: 2 } })],
      findings: [{ code: "OTH-count", severity: "fatal", message: "计数不一致", stepNo: 0 }],
    }),
  );
  assert.equal(report.finalState.payload["moveCount"], 10);
  assert.equal(report.status, "failed");
});
