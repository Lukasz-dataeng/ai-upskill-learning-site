// The topic pipeline's acceptance criteria, as tests. Numbers refer to
// specs/topic-pipeline/spec.md §9. Agents run against the DIAL stub, and the
// quiz, build and publish steps are replaced by recorders, so nothing here
// touches the network, the real data/ folder, git or Cloudflare.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";

import { runTopic, normalizePlan, assembleDeck, slugify } from "../scripts/topic.mjs";
import { askJson } from "../lib/dial.mjs";
import { validateDeck } from "../lib/deck.mjs";
import { sanitizeHtml } from "../lib/sanitize.mjs";
import { validatePlannerReply } from "../agents/schemas.mjs";
import { MODELS } from "../agents/models.mjs";

const TITLE = "Testing Things in Python";
const ID = slugify(TITLE);
const quiet = () => {};

function tempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "topic-test-"));
  mkdirSync(path.join(root, "data"), { recursive: true });
  return root;
}

// Records agent calls and pipeline steps. `reject` names question text the
// Reviewer always turns down.
function harness({ answers = [true, true], reject = null } = {}) {
  const calls = [];
  const steps = { quiz: [], build: 0, publish: [] };
  const replies = [...answers];
  return {
    calls,
    steps,
    options: {
      title: TITLE,
      questions: 9,
      log: quiet,
      date: "2026-09-17",
      confirm: async () => replies.shift() ?? false,
      ask: async (args) => {
        calls.push(args);
        if (args.agent === "reviewer" && reject && args.user.includes(reject)) {
          return { ok: false, problems: [`planted rejection of "${reject}"`] };
        }
        return askJson(args);
      },
      steps: {
        quiz: async (a) => {
          steps.quiz.push(a);
          return { generated: 0, skipped: [] };
        },
        build: () => steps.build++,
        publish: (a) => steps.publish.push(a),
      },
    },
  };
}

const agents = (calls, name) => calls.filter((c) => c.agent === name);
const readDeck = (root) => yaml.load(readFileSync(path.join(root, "data", `${ID}.yaml`), "utf8"));
const planFile = (root) => path.join(root, "drafts", ID, "plan.yaml");

test.beforeEach(() => {
  process.env.DIAL_STUB = "1";
});

// --- criterion 1: ids and tiers come from code --------------------------------

test("the plan gets ids in code, fixed tiers, and tier order within a section", () => {
  const planned = normalizePlan(
    {
      title: "T",
      sections: [
        { title: "A", questions: [
          { tier: "Deep-dive", question: "deep" },
          { tier: "Foundational", question: "basic", id: "9.9" },
          { tier: "Expert", question: "unknown tier" },
        ] },
        { title: "B", questions: [{ tier: "Intermediate", question: "mid" }] },
      ],
    },
    { deckId: "t" }
  );
  assert.deepEqual(planned.sections.map((s) => s.id), ["s1", "s2"]);
  assert.deepEqual(planned.sections[0].questions.map((q) => [q.tier, q.question]), [
    ["Foundational", "basic"],
    ["Intermediate", "unknown tier"],
    ["Deep-dive", "deep"],
  ]);
  assert.deepEqual(planned.sections[0].questions.map((q) => q.id), ["1.1", "1.2", "1.3"]);
  assert.equal(planned.sections[1].questions[0].id, "2.1");
});

test("an id already given survives renormalising, so answers stay matched", () => {
  const once = normalizePlan({ sections: [{ questions: [{ tier: "Foundational", question: "a" }, { tier: "Foundational", question: "b" }] }] }, { deckId: "t" });
  once.sections[0].questions.splice(0, 1); // remove "a"
  once.sections[0].questions.push({ tier: "Foundational", question: "c" }); // add without id
  const twice = normalizePlan(once, { deckId: "t" });
  assert.deepEqual(twice.sections[0].questions.map((q) => [q.id, q.question]), [["1.2", "b"], ["1.1", "c"]]);
});

test("a planner reply with more questions than asked is rejected", () => {
  const sections = [0, 1, 2].map(() => ({ title: "s", summary: "s", questions: [0, 1, 2, 3].map((n) => ({ tier: "Foundational", question: `q${Math.random()}${n}` })) }));
  const problems = validatePlannerReply({ title: "t", description: "d", sections }, { questionCount: 9 });
  assert.match(problems.join(), /12 questions; it must have between 7 and 9/);
});

// --- criterion 2: an existing plan is not replanned ---------------------------

test("with plan.yaml present, no planner call is made", async () => {
  const root = tempRoot();
  const first = harness({ answers: [false] });
  await runTopic({ ...first.options, root });
  assert.equal(agents(first.calls, "planner").length, 1);

  const second = harness({ answers: [false] });
  await runTopic({ ...second.options, root });
  assert.equal(agents(second.calls, "planner").length, 0);
});

// --- criterion 7: no yes, no next step ----------------------------------------

test("no at stop 1: nothing is answered, built or published, and resume is printed", async () => {
  const root = tempRoot();
  const h = harness({ answers: [false] });
  const lines = [];
  const result = await runTopic({ ...h.options, root, log: (l) => lines.push(l) });

  assert.equal(result.stopped, "stop 1 (plan)");
  assert.equal(agents(h.calls, "author").length, 0);
  assert.deepEqual([h.steps.quiz.length, h.steps.build, h.steps.publish.length], [0, 0, 0]);
  assert.ok(existsSync(planFile(root)));
  assert.ok(!existsSync(path.join(root, "data", `${ID}.yaml`)));
  assert.match(lines.join("\n"), new RegExp(`Resume with: npm run topic -- "${TITLE}"`));
});

// --- criterion 8: nothing published before the second yes --------------------

test("no at stop 2: the deck is built but nothing is published", async () => {
  const root = tempRoot();
  const h = harness({ answers: [true, false] });
  const result = await runTopic({ ...h.options, root });

  assert.equal(result.stopped, "stop 2 (publish)");
  assert.equal(h.steps.build, 1);
  assert.equal(h.steps.quiz.length, 1);
  assert.equal(h.steps.publish.length, 0);
  assert.equal(validateDeck(readDeck(root)).length, 0);
});

test("yes at both stops publishes the deck, its quiz and its drafts", async () => {
  const root = tempRoot();
  const h = harness({ answers: [true, true] });
  const result = await runTopic({ ...h.options, root });

  assert.equal(result.stopped, null);
  assert.equal(h.steps.publish.length, 1);
  const files = h.steps.publish[0].files.map((f) => f.replace(/\\/g, "/"));
  assert.ok(files.includes(`data/${ID}.yaml`));
  assert.ok(files.includes(`drafts/${ID}`));
});

test("--approve passes the stop it names without asking, and only that one", async () => {
  const root = tempRoot();
  const h = harness({ answers: [] });
  let asked = 0;
  const result = await runTopic({ ...h.options, root, approve: ["plan"], confirm: async () => (asked++, false) });
  assert.equal(result.stopped, "stop 2 (publish)");
  assert.equal(asked, 1, "stop 2 was still asked");
  assert.equal(h.steps.publish.length, 0);
});

// --- criterion 3: answers kept, regenerated, dropped --------------------------

test("answers are kept when unchanged, redone when edited, dropped when removed", async () => {
  const root = tempRoot();
  await runTopic({ ...harness({ answers: [true, false] }).options, root });

  const plan = yaml.load(readFileSync(planFile(root), "utf8"));
  const [edited, removed] = plan.sections[0].questions;
  edited.question = "An edited question?";
  plan.sections[0].questions.splice(1, 1);
  plan.sections[1].questions.push({ tier: "Deep-dive", question: "A brand new question?" });
  writeFileSync(planFile(root), yaml.dump(plan));

  const h = harness({ answers: [true, false] });
  await runTopic({ ...h.options, root });

  const authored = agents(h.calls, "author").map((c) => JSON.parse(c.user.split("\n\n")[0]).question.question);
  assert.deepEqual(authored.sort(), ["A brand new question?", "An edited question?"]);

  const questions = readDeck(root).sections.flatMap((s) => s.tiers.flatMap((t) => t.questions));
  assert.ok(!questions.some((q) => q.id === removed.id));
  assert.equal(questions.length, 9);
  assert.deepEqual(h.steps.quiz[0].changed.sort(), [edited.id, "2.4"].sort());
});

test("an answer that failed on a DIAL error is retried on resume", async () => {
  const root = tempRoot();
  const h1 = harness({ answers: [true, false] });
  const failing = { ...h1.options, ask: async (a) => { if (a.agent === "author") throw new Error("VPN down"); return h1.options.ask(a); } };
  await assert.rejects(() => runTopic({ ...failing, root }), /not valid/); // nothing answered, deck empty

  const h2 = harness({ answers: [true, false] });
  await runTopic({ ...h2.options, root });
  assert.equal(agents(h2.calls, "author").length, 9);
});

// --- criterion 4: rejected twice, left out and reported -----------------------

test("a question rejected twice is left out of the deck and listed in the report", async () => {
  const root = tempRoot();
  const target = "Question 2 about";
  const h = harness({ answers: [true, false], reject: target });
  await runTopic({ ...h.options, root });

  const rejectedCalls = agents(h.calls, "reviewer").filter((c) => c.user.includes(target));
  assert.equal(rejectedCalls.length, 2, "one rewrite, then give up");

  const questions = readDeck(root).sections.flatMap((s) => s.tiers.flatMap((t) => t.questions));
  assert.equal(questions.length, 8);
  assert.ok(!questions.some((q) => q.question.includes(target)));

  const report = readFileSync(path.join(root, "drafts", ID, "report.md"), "utf8");
  assert.match(report, /8 of 9 planned questions/);
  assert.match(report, /planted rejection/);
});

test("an emptied tier or section is dropped and the deck still validates", () => {
  const planned = normalizePlan(
    {
      title: "T",
      sections: [
        { title: "Kept", questions: [{ tier: "Foundational", question: "a" }, { tier: "Deep-dive", question: "b" }] },
        { title: "Emptied", questions: [{ tier: "Foundational", question: "c" }] },
      ],
    },
    { deckId: "t" }
  );
  const answers = {
    "1.1": { question: "a", status: "ok", lead: "L", body: "<p>B</p>" },
    "1.2": { question: "b", status: "rejected", problems: ["x"] },
    "2.1": { question: "c", status: "failed", problems: ["y"] },
  };
  const deck = assembleDeck({ planned, answers, models: MODELS, date: "2026-09-17" });
  assert.equal(deck.sections.length, 1);
  assert.deepEqual(deck.sections[0].tiers.map((t) => t.name), ["Foundational"]);
  // criterion 5: the build's own rules
  assert.deepEqual(validateDeck(deck), []);
  assert.match(deck.footer_note, /gpt-5\.6-luna.*gemini-3\.1-flash-lite/);
});

// --- criterion 6: allow-listed HTML --------------------------------------------

test("script, handlers and unknown tags never survive sanitising", () => {
  const out = sanitizeHtml(
    `<p onclick="x()">a <a href="javascript:alert(1)">link</a><script>alert(1)</script><img src=x onerror=alert(1)></p>` +
      `<div class="box trap" style="x"><b class="t">T</b></div><div class="evil">e</div><svg><text>s</text></svg>` +
      `<table><tr><td>1</td></tr></table><pre><code>a &lt; b</code></pre>`
  );
  assert.doesNotMatch(out, /script|onclick|onerror|javascript|<a|<img|<svg|style=|evil|alert/i);
  assert.match(out, /<div class="box trap"><b class="t">T<\/b><\/div>/);
  assert.match(out, /<div class="tw"><table>/);
  assert.match(out, /<pre><code>a &lt; b<\/code><\/pre>/);
});

test("sanitised HTML is what lands in the deck", async () => {
  const root = tempRoot();
  const h = harness({ answers: [true, false] });
  const evil = {
    ...h.options,
    ask: async (a) =>
      a.agent === "author" ? { lead: "<em>ok</em><script>bad()</script>", body: '<p onmouseover="bad()">fine</p>' } : h.options.ask(a),
  };
  await runTopic({ ...evil, root });
  const text = readFileSync(path.join(root, "data", `${ID}.yaml`), "utf8");
  assert.doesNotMatch(text, /<script|onmouseover|bad\(\)/);
  assert.match(text, /<em>ok<\/em>/);
});

// --- criterion 9: hand-made decks are left alone -------------------------------

test("a title matching a hand-made deck is refused", async () => {
  const root = tempRoot();
  writeFileSync(path.join(root, "data", `${ID}.yaml`), "id: x\n");
  const h = harness();
  await assert.rejects(() => runTopic({ ...h.options, root }), /not made by this pipeline/);
  assert.equal(h.calls.length, 0);
});

test("bad arguments are refused before any agent runs", async () => {
  const root = tempRoot();
  const h = harness();
  await assert.rejects(() => runTopic({ ...h.options, root, title: "  " }), /give a title/);
  await assert.rejects(() => runTopic({ ...h.options, root, questions: 41 }), /from 6 to 40/);
  await assert.rejects(() => runTopic({ ...h.options, root, from: "quiz" }), /--from must be/);
  await assert.rejects(() => runTopic({ ...h.options, root, approve: ["all"] }), /--approve must be/);
  assert.equal(h.calls.length, 0);
});
