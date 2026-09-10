// Slice A's acceptance criteria, as tests. Numbers refer to
// specs/agents/spec.md §8. Everything here runs against the DIAL stub, so the
// suite needs no credentials and no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { validateQuizItem } from "../agents/schemas.mjs";
import { askJson, AgentError } from "../lib/dial.mjs";
import { generateQuiz } from "../scripts/generate-quiz.mjs";

const DECK = "interview-prep";
const quiet = () => {};

function tempQuizFile() {
  return path.join(mkdtempSync(path.join(tmpdir(), "quiz-test-")), `${DECK}.yaml`);
}

function item(overrides = {}) {
  return {
    question_id: "1.1",
    stem: "a stem",
    options: [
      { text: "a", correct: true, why: "because" },
      { text: "b", why: "no" },
      { text: "c", why: "no" },
      { text: "d", why: "no" },
    ],
    ...overrides,
  };
}

// --- criterion 1: four options, exactly one correct ------------------------

test("a well-formed item has no problems", () => {
  assert.deepEqual(validateQuizItem(item()), []);
});

test("three options is rejected", () => {
  const bad = item();
  bad.options.pop();
  assert.match(validateQuizItem(bad).join(" "), /exactly 4 options/);
});

test("two correct options is rejected", () => {
  const bad = item();
  bad.options[1].correct = true;
  assert.match(validateQuizItem(bad).join(" "), /2 options marked correct/);
});

test("no correct option is rejected", () => {
  const bad = item();
  delete bad.options[0].correct;
  assert.match(validateQuizItem(bad).join(" "), /0 options marked correct/);
});

test("a blank why is rejected", () => {
  const bad = item();
  bad.options[2].why = "   ";
  assert.match(validateQuizItem(bad).join(" "), /why must be a non-empty string/);
});

test("two identical options are rejected", () => {
  const bad = item();
  bad.options[3].text = "b";
  assert.match(validateQuizItem(bad).join(" "), /same text/);
});

// --- criterion 10: one retry, then fail loudly -----------------------------

test("an agent that will not return JSON fails after exactly one retry", async () => {
  process.env.DIAL_STUB = "badjson";
  await assert.rejects(
    () => askJson({ agent: "writer", system: "s", user: "{}", validate: () => [] }),
    (e) => {
      assert.ok(e instanceof AgentError);
      assert.equal(e.attempts, 2);
      assert.match(e.message, /not valid JSON/);
      return true;
    }
  );
});

test("a valid reply comes back parsed", async () => {
  process.env.DIAL_STUB = "1";
  const reply = await askJson({
    agent: "writer",
    system: "s",
    user: JSON.stringify({ id: "9.9", lead: "Vectors are numbers." }),
    validate: () => [],
  });
  assert.equal(typeof reply.stem, "string");
  assert.match(reply.correct.text, /^\[stub\]/);
});

// --- criterion 4: a rejected question is skipped, the run continues --------

test("a question the critic keeps rejecting is skipped, the others generate", async () => {
  process.env.DIAL_STUB = "criticfail:1.2";
  const file = tempQuizFile();

  const summary = await generateQuiz({
    deckId: DECK,
    only: ["1.1", "1.2", "1.3"],
    quizFile: file,
    log: quiet,
  });

  assert.equal(summary.generated, 2);
  assert.equal(summary.skipped.length, 1);
  assert.equal(summary.skipped[0].id, "1.2");
  assert.match(summary.skipped[0].reason, /forced rejection/);

  const written = readFileSync(file, "utf8");
  assert.match(written, /question_id: '1\.1'/);
  assert.match(written, /question_id: '1\.3'/);
  assert.doesNotMatch(written, /question_id: '1\.2'/);
});

// --- criterion 3: idempotent -----------------------------------------------

test("a second run without --force writes nothing and changes nothing", async () => {
  process.env.DIAL_STUB = "1";
  const file = tempQuizFile();
  const args = { deckId: DECK, only: ["1.1", "1.2"], quizFile: file, log: quiet };

  const first = await generateQuiz(args);
  assert.equal(first.generated, 2);
  assert.equal(first.written, true);
  const afterFirst = readFileSync(file, "utf8");

  const second = await generateQuiz(args);
  assert.equal(second.generated, 0);
  assert.equal(second.unchanged, 2);
  assert.equal(second.written, false);
  assert.equal(readFileSync(file, "utf8"), afterFirst);
});

test("--force regenerates an item that already exists", async () => {
  process.env.DIAL_STUB = "1";
  const file = tempQuizFile();
  const args = { deckId: DECK, only: ["1.1"], quizFile: file, log: quiet };

  await generateQuiz(args);
  const forced = await generateQuiz({ ...args, force: true });
  assert.equal(forced.generated, 1);
});

// --- the generated file is valid by the build's own rules ------------------

test("generated items pass the validation the build applies", async () => {
  process.env.DIAL_STUB = "1";
  const file = tempQuizFile();
  await generateQuiz({ deckId: DECK, only: ["1.1", "1.2", "1.3"], quizFile: file, log: quiet });

  assert.ok(existsSync(file));
  const yaml = await import("js-yaml");
  const parsed = yaml.load(readFileSync(file, "utf8"));

  assert.equal(parsed.deck, DECK);
  assert.equal(parsed.items.length, 3);
  for (const written of parsed.items) {
    assert.deepEqual(validateQuizItem(written), []);
  }
});

test("--only rejects an id that is not in the deck", async () => {
  process.env.DIAL_STUB = "1";
  await assert.rejects(
    () => generateQuiz({ deckId: DECK, only: ["99.9"], quizFile: tempQuizFile(), log: quiet }),
    /names ids not in/
  );
});
