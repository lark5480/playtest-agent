/**
 * 集成测试 · 真实 tongshi-ju duel（HTTP 层契约）
 *
 * 为什么是"HTTP 契约"而不是 end-to-end 自对弈：
 * 见 docs 里的可行性结论 —— duel 需要第二名玩家、服务端时钟进入关键路径，
 * 把它硬塞进 GameAdapter 会破坏"同 seed 同局面"的确定性前提。
 * 这里只验证**协议与状态机**：相位流转、错误码、并发提交、超时结算。
 *
 * 题库答案的取得方式：读被测仓库的公开题库 JSON（只读，不改它），
 * 用快照里脱敏后的 `questionId` 反查答案，从而让"答对"这件事可复现。
 *
 * 前置：tongshi-ju 在 localhost:3100 运行（见 README 快速开始）。
 * 环境变量：TONGSHI_JU_BASE_URL（默认 http://localhost:3100）
 *          TONGSHI_JU_DIR（默认 ../tongshi-ju，用于读 content/domains）
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { integrationGate } from "../helpers/integration-gate.js";

const BASE_URL = process.env.TONGSHI_JU_BASE_URL ?? "http://localhost:3100";
const TONGSHI_DIR = process.env.TONGSHI_JU_DIR ?? resolve(process.cwd(), "..", "tongshi-ju");

type Slot = 0 | 1;
type Phase = "lobby" | "countdown" | "question" | "feedback" | "finished";

interface Credential {
  readonly code: string;
  readonly playerId: string;
  readonly slot: Slot;
  readonly isHost: boolean;
}

interface QuestionMeta {
  readonly id: string;
  readonly domain: string;
  readonly topic: string;
  readonly difficulty: 1 | 2 | 3;
  readonly type: "single" | "multi" | "judge";
  readonly stem: string;
  readonly options: readonly string[];
}

interface RoundRecord {
  readonly roundIndex: number;
  readonly questionId: string;
  readonly correctAnswer: string | readonly string[];
  readonly winnerSlot: Slot | null;
  readonly correct: Readonly<Record<string, boolean>>;
  readonly points: Readonly<Record<string, number>>;
}

interface RoomSnapshot {
  readonly code: string;
  readonly matchId: string;
  readonly status: Phase;
  readonly roundIndex: number;
  readonly questions: readonly QuestionMeta[];
  readonly totalRounds: number;
  readonly scores: Readonly<Record<string, number>>;
  readonly history: readonly RoundRecord[];
  readonly startedAt: number | null;
  readonly deadlineAt: number | null;
  readonly nextAt: number | null;
  readonly limitMs: number;
  readonly reason?: string;
}

interface ErrorBody {
  readonly error?: string;
  readonly code?: string;
}

interface AnswerBody extends ErrorBody {
  readonly ok?: true;
  readonly correct?: boolean;
  readonly winnerSlot?: Slot | null;
}

async function jsonRequest<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let parsed: unknown = {};
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: text };
    }
  }
  return { status: res.status, body: parsed as T };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((done) => setTimeout(done, ms));
}

async function createRoom(name: string): Promise<Credential> {
  const res = await jsonRequest<Credential & ErrorBody>("POST", "/api/rooms", {
    name,
    emoji: "🧠",
    domains: ["gaming"],
  });
  assert.equal(res.status, 201, `建房失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function joinRoom(code: string, name: string): Promise<Credential> {
  const res = await jsonRequest<Credential & ErrorBody>("POST", `/api/rooms/${code}/join`, {
    code,
    name,
    emoji: "🎯",
  });
  assert.equal(res.status, 201, `加入失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function setReady(code: string, playerId: string): Promise<void> {
  const res = await jsonRequest<{ room?: RoomSnapshot } & ErrorBody>(
    "POST",
    `/api/rooms/${code}/ready`,
    {
      playerId,
      ready: true,
    },
  );
  assert.equal(res.status, 200, `准备失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
}

async function startRoom(code: string, playerId: string): Promise<RoomSnapshot> {
  const res = await jsonRequest<{ room: RoomSnapshot } & ErrorBody>(
    "POST",
    `/api/rooms/${code}/start`,
    {
      playerId,
    },
  );
  assert.equal(res.status, 200, `开局失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.room;
}

async function submitAnswer(
  code: string,
  playerId: string,
  roundIndex: number,
  answer: string,
): Promise<{ status: number; body: AnswerBody }> {
  return jsonRequest<AnswerBody>("POST", `/api/rooms/${code}/answer`, {
    playerId,
    roundIndex,
    answer,
  });
}

async function getRoom(code: string): Promise<RoomSnapshot> {
  const res = await jsonRequest<{ room: RoomSnapshot } & ErrorBody>("GET", `/api/rooms/${code}`);
  assert.equal(res.status, 200, `读房间失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.room;
}

async function waitRoom(
  code: string,
  predicate: (room: RoomSnapshot) => boolean,
  description: string,
  timeoutMs = 45_000,
): Promise<RoomSnapshot> {
  const startedAt = Date.now();
  let last: RoomSnapshot | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    const room = await getRoom(code);
    last = room;
    if (predicate(room)) return room;
    await sleep(250);
  }
  const snapshot = last === null ? "无" : `status=${last.status} roundIndex=${last.roundIndex}`;
  throw new Error(`等待「${description}」超时（${timeoutMs}ms）：最后一次 ${snapshot}`);
}

/** 公开题库：id → 答案（只读取被测仓库 content/domains，不修改）。 */
function loadAnswerBank(): Map<string, string> {
  const dir = resolve(TONGSHI_DIR, "content", "domains");
  const bank = new Map<string, string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
      questions?: readonly { id: string; answer: string | readonly string[] }[];
    };
    for (const question of parsed.questions ?? []) {
      if (typeof question.answer === "string") bank.set(question.id, question.answer);
    }
  }
  assert.ok(bank.size > 0, `题库为空：${dir}（检查 TONGSHI_JU_DIR）`);
  return bank;
}

const answerBank = loadAnswerBank();

function currentQuestion(room: RoomSnapshot): QuestionMeta {
  const question = room.questions[room.roundIndex];
  assert.ok(question, `快照缺少第 ${room.roundIndex} 题（roundIndex 与 questions 不同步）`);
  return question;
}

function correctText(room: RoomSnapshot): string {
  const question = currentQuestion(room);
  const answer = answerBank.get(question.id);
  assert.ok(
    answer !== undefined,
    `题库中找不到题目 ${question.id}（检查 TONGSHI_JU_DIR=${TONGSHI_DIR}）`,
  );
  return answer;
}

function wrongText(room: RoomSnapshot): string {
  const question = currentQuestion(room);
  const wrong = question.options.find((option) => option !== correctText(room));
  assert.ok(wrong !== undefined, `题目 ${question.id} 没有与正确答案不同的选项`);
  return wrong;
}

async function createStartedRoom(): Promise<{
  code: string;
  host: Credential;
  guest: Credential;
  room: RoomSnapshot;
}> {
  const host = await createRoom("契约·房主");
  const code = host.code;
  const guest = await joinRoom(code, "契约·访客");
  await setReady(code, host.playerId);
  await setReady(code, guest.playerId);
  const started = await startRoom(code, host.playerId);
  assert.equal(started.status, "countdown", `开局后应进入 countdown，实际 ${started.status}`);
  const room = await waitRoom(code, (snapshot) => snapshot.status === "question", "首题开始");
  return { code, host, guest, room };
}

async function probe(): Promise<{ ok: boolean; reason: string }> {
  try {
    const res = await fetch(`${BASE_URL}/`, { signal: AbortSignal.timeout(3000) });
    return res.ok
      ? { ok: true, reason: "" }
      : { ok: false, reason: `tongshi-ju 返回 HTTP ${res.status}（${BASE_URL}）` };
  } catch (error) {
    return {
      ok: false,
      reason: `tongshi-ju 不可达（${BASE_URL}）：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

const availability = await probe();
const gate = integrationGate({
  dependency: "tongshi-ju (3100)",
  available: availability.ok,
  reason: availability.reason,
});

test(
  "建房 → 加入 → 准备 → 开局：lobby → countdown → question，题目快照脱敏",
  { skip: gate.skip },
  async () => {
    gate.precheck?.();

    const host = await createRoom("契约·房主");
    assert.match(host.code, /^[A-HJ-NP-Z2-9]{4,8}$/, `房间码格式异常：${host.code}`);
    assert.equal(host.slot, 0);
    assert.equal(host.isHost, true);
    assert.ok(host.playerId.length > 0);

    const guest = await joinRoom(host.code, "契约·访客");
    assert.equal(guest.code, host.code);
    assert.equal(guest.slot, 1);
    assert.notEqual(guest.playerId, host.playerId, "两名玩家的 playerId 不应相同");

    await setReady(host.code, host.playerId);
    await setReady(host.code, guest.playerId);

    const started = await startRoom(host.code, host.playerId);
    assert.equal(started.totalRounds, 5, `duel 应为 5 回合，实际 ${started.totalRounds}`);
    assert.equal(started.questions.length, 5);
    assert.equal(started.questions[0]!.type.length > 0, true);

    // 关键：对局中快照不得下发答案 / 解析，否则等于把答案给玩家。
    const serialized = JSON.stringify(started.questions);
    assert.equal(serialized.includes('"answer"'), false, "题目快照泄露了 answer 字段");
    assert.equal(serialized.includes('"explanation"'), false, "题目快照泄露了 explanation 字段");

    const question = await waitRoom(host.code, (room) => room.status === "question", "首题开始");
    assert.equal(question.roundIndex, 0);
    assert.ok(question.deadlineAt !== null, "question 阶段必须有 deadlineAt");
    assert.ok(question.deadlineAt! > Date.now(), "question 阶段的 deadlineAt 应在未来");

    const correct = correctText(question);
    const answered = await submitAnswer(host.code, host.playerId, 0, correct);
    assert.equal(
      answered.status,
      200,
      `答对应被接受：HTTP ${answered.status} ${JSON.stringify(answered.body)}`,
    );
    assert.equal(answered.body.correct, true);
    assert.equal(answered.body.winnerSlot, 0);

    const feedback = await waitRoom(
      host.code,
      (room) => room.status === "feedback",
      "进入 feedback",
    );
    assert.equal(feedback.history.length, 1, "结算后 history 应有 1 条");
    const record = feedback.history[0]!;
    assert.equal(record.winnerSlot, 0);
    assert.equal(record.correctAnswer, correct, "结算后才应下发 correctAnswer");
    assert.ok(record.points["0"]! > 0, "答对的一方应得分");

    const next = await waitRoom(
      host.code,
      (room) => room.status === "question" && room.roundIndex === 1,
      "第二题开始",
    );
    assert.equal(next.roundIndex, 1);
  },
);

test("五回合全部答对 → finished，比分与 history 对账", { skip: gate.skip }, async () => {
  gate.precheck?.();

  const { code, host } = await createStartedRoom();

  for (let round = 0; round < 5; round += 1) {
    const question = await waitRoom(
      code,
      (room) => room.status === "question" && room.roundIndex === round,
      `第 ${round + 1} 题开始`,
    );
    const correct = correctText(question);
    const answered = await submitAnswer(code, host.playerId, round, correct);
    assert.equal(answered.status, 200, `第 ${round + 1} 题提交失败：HTTP ${answered.status}`);
    assert.equal(answered.body.correct, true, `第 ${round + 1} 题应判对`);

    const feedback = await waitRoom(
      code,
      (room) => room.status === "feedback" && room.history.length === round + 1,
      `第 ${round + 1} 题结算`,
    );
    const record = feedback.history[round]!;
    assert.equal(record.winnerSlot, 0, `第 ${round + 1} 题赢家应为房主`);
    assert.equal(record.correct["0"], true);
    assert.ok(record.points["0"]! > 0);
    assert.equal(record.points["1"], 0);
  }

  const finished = await waitRoom(code, (room) => room.status === "finished", "对局结束", 20_000);
  assert.equal(finished.reason, "全部题目已完成", `终局原因异常：${finished.reason}`);
  assert.equal(finished.history.length, 5);

  // 计分一致性：总分 = 每回合得分之和（这是"能验证什么"里唯一有数值意义的断言）。
  const hostPoints = finished.history.reduce((sum, record) => sum + (record.points["0"] ?? 0), 0);
  assert.equal(finished.scores["0"], hostPoints, "总比分与 history 得分之和不等");
  assert.equal(finished.scores["1"], 0, "未作答一方不应得分");
});

test(
  "错误码：already_answered / stale_round / round_locked 都是 4xx，不是 500",
  { skip: gate.skip },
  async () => {
    gate.precheck?.();

    const { code, host, guest } = await createStartedRoom();

    // 回合 0：同一玩家重复提交 → already_answered
    const round0 = await waitRoom(
      code,
      (room) => room.status === "question" && room.roundIndex === 0,
      "第 1 题",
    );
    const wrong0 = wrongText(round0);
    const first = await submitAnswer(code, host.playerId, 0, wrong0);
    assert.equal(first.status, 200, "首次（错误）提交应被接受");
    assert.equal(first.body.correct, false);
    const duplicate = await submitAnswer(code, host.playerId, 0, wrong0);
    assert.equal(duplicate.status, 409, `重复提交应 409，实际 ${duplicate.status}`);
    assert.equal(duplicate.body.code, "already_answered");

    // 双方都答错 → 立即结算，无人得分
    const guestWrong = await submitAnswer(code, guest.playerId, 0, wrong0);
    assert.equal(guestWrong.status, 200, "访客提交应被接受");
    const settled = await waitRoom(
      code,
      (room) => room.status === "feedback" && room.history.length === 1,
      "第 1 题结算",
    );
    assert.equal(settled.history[0]!.winnerSlot, null, "双方都错时不应有赢家");
    assert.equal(settled.history[0]!.points["0"], 0);
    assert.equal(settled.history[0]!.points["1"], 0);

    // 回合 1：提交过期的 roundIndex → stale_round
    const round1 = await waitRoom(
      code,
      (room) => room.status === "question" && room.roundIndex === 1,
      "第 2 题",
    );
    const stale = await submitAnswer(code, host.playerId, 0, wrongText(round1));
    assert.equal(stale.status, 409, `过期回合应 409，实际 ${stale.status}`);
    assert.equal(stale.body.code, "stale_round");

    // 把回合 1 结束掉，进入回合 2
    const wrong1 = wrongText(round1);
    assert.equal((await submitAnswer(code, host.playerId, 1, wrong1)).status, 200);
    assert.equal((await submitAnswer(code, guest.playerId, 1, wrong1)).status, 200);
    await waitRoom(
      code,
      (room) => room.status === "feedback" && room.history.length === 2,
      "第 2 题结算",
    );

    // 回合 2：房主答对锁定后，访客再提交 → round_locked
    const round2 = await waitRoom(
      code,
      (room) => room.status === "question" && room.roundIndex === 2,
      "第 3 题",
    );
    const correct2 = correctText(round2);
    const lock = await submitAnswer(code, host.playerId, 2, correct2);
    assert.equal(lock.status, 200, "房主答对应被接受");
    assert.equal(lock.body.correct, true);
    const locked = await submitAnswer(code, guest.playerId, 2, wrongText(round2));
    assert.equal(locked.status, 409, `锁定后提交应 409，实际 ${locked.status}`);
    assert.equal(locked.body.code, "round_locked");
  },
);

test("并发提交同一回合：无 500，且只有一方拿到 correct:true", { skip: gate.skip }, async () => {
  gate.precheck?.();

  const { code, host, guest } = await createStartedRoom();
  const room = await waitRoom(
    code,
    (snapshot) => snapshot.status === "question" && snapshot.roundIndex === 0,
    "首题",
  );
  const correct = correctText(room);
  const wrong = wrongText(room);

  // 真正并发：两个请求同时发出，顺序由服务端决定。
  const [hostResult, guestResult] = await Promise.all([
    submitAnswer(code, host.playerId, 0, correct),
    submitAnswer(code, guest.playerId, 0, wrong),
  ]);

  for (const result of [hostResult, guestResult]) {
    assert.notEqual(result.status, 500, "并发提交不应产生 500");
    if (result.status !== 200) {
      assert.ok(
        ["round_locked", "already_answered", "not_answering", "stale_round"].includes(
          result.body.code ?? "",
        ),
        `非成功响应必须是明确错误码，实际 HTTP ${result.status} ${JSON.stringify(result.body)}`,
      );
    }
  }

  const successes = [hostResult, guestResult].filter((result) => result.status === 200);
  assert.ok(successes.length >= 1, "并发提交后至少一方应成功");
  assert.equal(
    successes.filter((result) => result.body.correct === true).length,
    1,
    "同一回合只能有一方答对（另一方的错误答案不应被计为正确）",
  );

  const settled = await waitRoom(
    code,
    (snapshot) => snapshot.status === "feedback" && snapshot.history.length === 1,
    "并发后结算",
  );
  assert.equal(settled.history[0]!.winnerSlot, 0, "答对的一方应锁定回合");
  assert.ok(settled.history[0]!.points["0"]! > 0);
});

test("超时边界：无人作答时回合结算为无人得分，迟交被 4xx 拒绝", { skip: gate.skip }, async () => {
  gate.precheck?.();

  const { code, host } = await createStartedRoom();
  const room = await waitRoom(
    code,
    (snapshot) => snapshot.status === "question" && snapshot.roundIndex === 0,
    "首题",
  );
  assert.ok(room.deadlineAt !== null);

  // 等到 deadline 之后：相位定时器会把回合结算为"无人得分"。
  const waitMs = Math.max(0, room.deadlineAt! - Date.now()) + 1200;
  await sleep(waitMs);

  const late = await submitAnswer(code, host.playerId, 0, correctText(room));
  assert.ok(late.status >= 400 && late.status < 500, `迟交应被 4xx 拒绝，实际 HTTP ${late.status}`);
  assert.ok(
    ["timeout", "not_answering"].includes(late.body.code ?? ""),
    `迟交错误码应为 timeout / not_answering，实际 ${JSON.stringify(late.body)}`,
  );
  console.log(
    `[tongshi] 迟交实际错误码=${late.body.code}（timeout 分支要求相位定时器尚未抢先结算）`,
  );

  const settled = await getRoom(code);
  assert.equal(settled.history.length, 1, "超时后应结算 1 回合");
  const record = settled.history[0]!;
  assert.equal(record.winnerSlot, null, "超时回合不应有赢家");
  assert.equal(record.correct["0"], false);
  assert.equal(record.correct["1"], false);
  assert.equal(record.points["0"], 0);
  assert.equal(record.points["1"], 0);
  assert.equal(settled.scores["0"], 0);
  assert.equal(settled.scores["1"], 0);
});
