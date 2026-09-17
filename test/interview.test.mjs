// Slice B's acceptance criteria, as tests. Numbers refer to
// specs/agents/spec.md §8. The agents run against the DIAL stub, through a spy
// that records what would have been sent, so the suite needs no credentials
// and no network.

import { test } from "node:test";
import assert from "node:assert/strict";

import { handleInterview, answeredQuestionIds, plainText, LIMITS } from "../lib/interview.mjs";
import { askJson } from "../lib/dial.mjs";
import { loadDecks, loadDeck, sectionQuestions } from "../lib/deck.mjs";
import { validateInterviewerReply, validateEvaluatorReply, validateCoachReply } from "../agents/schemas.mjs";
import { startServer, HOST } from "../scripts/interview-server.mjs";

const decks = loadDecks();
const DECK = "interview-prep";
const SECTION = "s1";
const section = loadDeck(DECK).sections.find((s) => s.id === SECTION);
const questions = sectionQuestions(section);

function spy() {
  const calls = [];
  const ask = (args) => {
    calls.push(args);
    return askJson(args);
  };
  return { ask, calls };
}

function request(overrides = {}) {
  return { deckId: DECK, sectionId: SECTION, action: "next", transcript: [], ...overrides };
}

// n question-and-answer pairs, walking the section in order.
function pairs(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const q = questions[i % questions.length];
    out.push({ role: "interviewer", text: `ask ${q.id}`, questionId: String(q.id) });
    out.push({ role: "candidate", text: `answer ${i}` });
  }
  return out;
}

test.beforeEach(() => {
  process.env.DIAL_STUB = "1";
});

// --- the happy path --------------------------------------------------------

test("next opens the interview with a question from the section", async () => {
  const { status, body } = await handleInterview(request(), { decks });
  assert.equal(status, 200);
  assert.ok(questions.some((q) => String(q.id) === body.questionId));
  assert.equal(body.turnsLeft, LIMITS.turns - 1);
});

test("finish grades the answered questions and plans at most three", async () => {
  const { ask, calls } = spy();
  const { status, body } = await handleInterview(request({ action: "finish", transcript: pairs(4) }), { decks, ask });
  assert.equal(status, 200);
  assert.deepEqual(calls.map((c) => c.agent), ["evaluator", "coach"]);
  assert.equal(body.forced, false);
  assert.equal(body.scores.length, 4);
  assert.ok(body.plan.length >= 1 && body.plan.length <= 3);
});

// --- criterion 5: the Interviewer never sees lead or body -------------------

test("the interviewer prompt contains no lead or body text", async () => {
  const { ask, calls } = spy();
  await handleInterview(request({ transcript: pairs(2) }), { decks, ask });
  assert.equal(calls.length, 1);
  const sent = calls[0].system + calls[0].user;
  for (const q of questions) {
    for (const field of [q.lead, q.body]) {
      // A run of six words from the answer: long enough that it cannot turn
      // up in a question by accident.
      const words = plainText(field).split(/\s+/).filter((w) => w.length > 3);
      const probe = words.slice(2, 8).join(" ");
      if (probe) assert.ok(!sent.includes(probe), `found "${probe}" from ${q.id}`);
    }
  }
  assert.ok(!/"lead"|"body"|"answer"/.test(calls[0].user));
});

// --- criterion 14: the Evaluator gets answers only for what was asked -------

test("the evaluator gets lead and body only for answered questions", async () => {
  const { ask, calls } = spy();
  const transcript = pairs(2).concat([{ role: "interviewer", text: "unanswered", questionId: String(questions[5].id) }]);
  await handleInterview(request({ action: "finish", transcript }), { decks, ask });
  const input = JSON.parse(calls[0].user);
  assert.deepEqual(input.questions.map((q) => q.id), [String(questions[0].id), String(questions[1].id)]);
  assert.ok(!/<[a-z]/i.test(input.questions[0].answer), "answer is plain text, not HTML");
});

test("the coach gets the evaluator's output and nothing else", async () => {
  const { ask, calls } = spy();
  await handleInterview(request({ action: "finish", transcript: pairs(2) }), { decks, ask });
  assert.deepEqual(Object.keys(JSON.parse(calls[1].user)), ["scores"]);
  assert.ok(!calls[1].user.includes("answer 0"), "no transcript text reaches the coach");
});

// --- criterion 6: a 13th turn is refused ------------------------------------

test("a next after 12 interviewer turns becomes a forced finish", async () => {
  const { ask, calls } = spy();
  const { status, body } = await handleInterview(request({ transcript: pairs(LIMITS.turns) }), { decks, ask });
  assert.equal(status, 200);
  assert.equal(body.forced, true);
  assert.ok(body.scores);
  assert.deepEqual(calls.map((c) => c.agent), ["evaluator", "coach"]);
});

test("the twelfth turn is still a question", async () => {
  const { body } = await handleInterview(request({ transcript: pairs(LIMITS.turns - 1) }), { decks });
  assert.equal(body.turnsLeft, 0);
  assert.ok(body.text);
});

// --- criterion 7: oversized input is refused and costs nothing --------------

test("a 5000-character answer returns 413 without calling any agent", async () => {
  const { ask, calls } = spy();
  const transcript = pairs(1);
  transcript[1].text = "x".repeat(5000);
  const { status } = await handleInterview(request({ transcript }), { decks, ask });
  assert.equal(status, 413);
  assert.equal(calls.length, 0);
});

test("a transcript over 32 KB returns 413 without calling any agent", async () => {
  const { ask, calls } = spy();
  const transcript = pairs(11).map((t) => (t.role === "candidate" ? { ...t, text: "y".repeat(3500) } : t));
  const { status } = await handleInterview(request({ transcript }), { decks, ask });
  assert.equal(status, 413);
  assert.equal(calls.length, 0);
});

test("finish with nothing answered returns 400 without calling any agent", async () => {
  const { ask, calls } = spy();
  const transcript = [{ role: "interviewer", text: "hello", questionId: String(questions[0].id) }];
  const { status } = await handleInterview(request({ action: "finish", transcript }), { decks, ask });
  assert.equal(status, 400);
  assert.equal(calls.length, 0);
});

test("bad requests are refused before any agent runs", async () => {
  const { ask, calls } = spy();
  const first = String(questions[0].id);
  const cases = [
    [request({ deckId: "nope" }), 404],
    [request({ sectionId: "nope" }), 404],
    [request({ action: "grade" }), 400],
    [request({ transcript: [{ role: "judge", text: "x" }] }), 400],
    [request({ transcript: [{ role: "interviewer", text: "x", questionId: "9.9" }, { role: "candidate", text: "y" }] }), 400],
    [request({ transcript: [{ role: "interviewer", text: "x", questionId: first }] }), 400],
  ];
  for (const [req, expected] of cases) {
    const { status } = await handleInterview(req, { decks, ask });
    assert.equal(status, expected, JSON.stringify(req));
  }
  assert.equal(calls.length, 0);
});

// --- criterion 10: bad replies fail loudly after one retry ------------------

for (const action of ["next", "finish"]) {
  test(`an unparseable reply on ${action} returns 502 after exactly two attempts`, async () => {
    process.env.DIAL_STUB = "badjson";
    const { ask, calls } = spy();
    const { status, body } = await handleInterview(request({ action, transcript: pairs(1) }), { decks, ask });
    assert.equal(status, 502);
    assert.match(body.error, /2 attempt/);
    assert.equal(calls.length, 1, "the handler asks once; askJson does the one retry inside");
  });
}

// --- criterion 15: replies naming the wrong question are rejected -----------

test("the interviewer may only name a question in the section", () => {
  const questionIds = ["1.1", "1.2"];
  assert.deepEqual(validateInterviewerReply({ text: "hi", questionId: "1.2" }, { questionIds }), []);
  assert.match(validateInterviewerReply({ text: "hi", questionId: "2.1" }, { questionIds }).join(), /not one of/);
  assert.match(validateInterviewerReply({ questionId: "1.1" }, { questionIds }).join(), /text/);
});

test("the evaluator must grade exactly the asked questions, 0 to 5", () => {
  const askedIds = ["1.1", "1.2"];
  const entry = (questionId, score = 3) => ({ questionId, score, missed: [], wrong: [] });
  assert.deepEqual(validateEvaluatorReply({ scores: [entry("1.1"), entry("1.2")] }, { askedIds }), []);
  assert.match(validateEvaluatorReply({ scores: [entry("1.1")] }, { askedIds }).join(), /no score for asked/);
  assert.match(validateEvaluatorReply({ scores: [entry("1.1"), entry("1.3")] }, { askedIds }).join(), /not one of/);
  assert.match(validateEvaluatorReply({ scores: [entry("1.1"), entry("1.1"), entry("1.2")] }, { askedIds }).join(), /second time/);
  assert.match(validateEvaluatorReply({ scores: [entry("1.1", 6), entry("1.2")] }, { askedIds }).join(), /0 to 5/);
  assert.match(validateEvaluatorReply({ scores: [entry("1.1", 2.5), entry("1.2")] }, { askedIds }).join(), /integer/);
});

test("the coach plans one to three graded questions, no repeats", () => {
  const scoredIds = ["1.1", "1.2", "1.3", "1.4"];
  const p = (questionId) => ({ questionId, why: "re-read it" });
  assert.deepEqual(validateCoachReply({ plan: [p("1.1"), p("1.2"), p("1.3")] }, { scoredIds }), []);
  assert.match(validateCoachReply({ plan: [] }, { scoredIds }).join(), /1 to 3/);
  assert.match(validateCoachReply({ plan: [p("1.1"), p("1.2"), p("1.3"), p("1.4")] }, { scoredIds }).join(), /1 to 3/);
  assert.match(validateCoachReply({ plan: [p("1.1"), p("1.1")] }, { scoredIds }).join(), /repeats/);
  assert.match(validateCoachReply({ plan: [p("2.1")] }, { scoredIds }).join(), /not one of/);
  assert.match(validateCoachReply({ plan: [p("1.1"), p("1.2")] }, { scoredIds: ["1.1"] }).join(), /1 to 1/);
});

// --- transcript bookkeeping -------------------------------------------------

test("a question counts as answered only once the candidate replied", () => {
  const t = [
    { role: "interviewer", questionId: "1.1", text: "" },
    { role: "candidate", text: "" },
    { role: "interviewer", questionId: "1.1", text: "follow-up" },
    { role: "candidate", text: "" },
    { role: "interviewer", questionId: "1.2", text: "" },
  ];
  assert.deepEqual(answeredQuestionIds(t), ["1.1"]);
});

// --- criterion 11: loopback only, over real HTTP ----------------------------

test("the server listens on 127.0.0.1 only, and serves the API", async () => {
  const server = await startServer({ port: 0, decks, log: () => {} });
  try {
    const { address, port } = server.address();
    assert.equal(HOST, "127.0.0.1");
    assert.equal(address, HOST);

    const base = `http://${HOST}:${port}/api/interview`;
    assert.deepEqual(await (await fetch(base)).json(), { ok: true, mode: "stub" });

    const res = await fetch(base, { method: "POST", body: JSON.stringify(request()) });
    assert.equal(res.status, 200);
    assert.ok((await res.json()).questionId);

    // The server may cut the connection once the limit is passed, which fetch
    // reports as an error rather than a status. Either way nothing got through.
    const big = await fetch(base, { method: "POST", body: "z".repeat(LIMITS.requestBytes + 1) }).catch(() => null);
    assert.ok(!big || big.status === 413);

    const bad = await fetch(base, { method: "POST", body: "{not json" });
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
});
