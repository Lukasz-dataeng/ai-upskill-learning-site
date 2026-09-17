// The JSON shape each Slice A agent must return, plus the shape of an assembled
// quiz item. Hand-rolled on purpose: three small shapes, nothing here worth a
// dependency. Every validator returns a list of problems, empty when the value
// is fine. See specs/agents/spec.md §3 rule 2, and §4.2 for the item schema.

export const OPTIONS_PER_ITEM = 4;

function str(value, label, problems, { max = 400 } = {}) {
  if (typeof value !== "string" || value.trim() === "") {
    problems.push(`${label} must be a non-empty string`);
    return;
  }
  if (value.length > max) {
    problems.push(`${label} is ${value.length} characters, longer than the ${max} allowed`);
  }
}

export function validateWriterReply(reply) {
  if (!reply || typeof reply !== "object") return ["reply must be a JSON object"];
  const problems = [];
  str(reply.stem, "stem", problems, { max: 300 });
  if (!reply.correct || typeof reply.correct !== "object") {
    problems.push('"correct" must be an object with "text" and "why"');
  } else {
    str(reply.correct.text, "correct.text", problems, { max: 220 });
    str(reply.correct.why, "correct.why", problems, { max: 300 });
  }
  return problems;
}

export function validateDistractorReply(reply) {
  if (!reply || typeof reply !== "object") return ["reply must be a JSON object"];
  const problems = [];
  const wanted = OPTIONS_PER_ITEM - 1;
  if (!Array.isArray(reply.options) || reply.options.length !== wanted) {
    return [`"options" must be an array of exactly ${wanted} wrong options`];
  }
  reply.options.forEach((opt, i) => {
    if (!opt || typeof opt !== "object") {
      problems.push(`options[${i}] must be an object`);
      return;
    }
    str(opt.text, `options[${i}].text`, problems, { max: 220 });
    str(opt.why, `options[${i}].why`, problems, { max: 300 });
    if (opt.correct) problems.push(`options[${i}] is a distractor and must not be marked correct`);
  });
  return problems;
}

export function validateCriticReply(reply) {
  if (!reply || typeof reply !== "object") return ["reply must be a JSON object"];
  const problems = [];
  if (typeof reply.ok !== "boolean") problems.push('"ok" must be true or false');
  if (!Array.isArray(reply.problems)) {
    problems.push('"problems" must be an array of strings');
  } else {
    reply.problems.forEach((p, i) => str(p, `problems[${i}]`, problems, { max: 300 }));
    if (reply.ok === false && reply.problems.length === 0) {
      problems.push('"ok": false needs at least one entry in "problems"');
    }
  }
  return problems;
}

// The assembled item, as it is written to data/quiz/<deck>.yaml. Used by the
// generator before it spends a Critic call, and again by scripts/build.mjs so a
// hand-edited quiz file cannot ship broken.
export function validateQuizItem(item, label = "item") {
  if (!item || typeof item !== "object") return [`${label} must be a mapping`];
  const problems = [];
  str(item.question_id, `${label}.question_id`, problems, { max: 40 });
  str(item.stem, `${label}.stem`, problems, { max: 300 });

  if (!Array.isArray(item.options) || item.options.length !== OPTIONS_PER_ITEM) {
    problems.push(`${label}.options must be an array of exactly ${OPTIONS_PER_ITEM} options`);
    return problems;
  }

  item.options.forEach((opt, i) => {
    if (!opt || typeof opt !== "object") {
      problems.push(`${label}.options[${i}] must be a mapping`);
      return;
    }
    str(opt.text, `${label}.options[${i}].text`, problems, { max: 220 });
    str(opt.why, `${label}.options[${i}].why`, problems, { max: 300 });
    if ("correct" in opt && typeof opt.correct !== "boolean") {
      problems.push(`${label}.options[${i}].correct must be true or omitted`);
    }
  });

  const correct = item.options.filter((opt) => opt?.correct === true).length;
  if (correct !== 1) {
    problems.push(`${label} has ${correct} options marked correct, it must have exactly 1`);
  }

  const texts = item.options.map((opt) => String(opt?.text ?? "").trim().toLowerCase());
  if (new Set(texts).size !== texts.length) {
    problems.push(`${label} has two options with the same text`);
  }

  return problems;
}

// ------------------------------------------------------------------ Slice B
// Each validator also takes the ids the reply is allowed to name, so a reply
// that points at a question outside the section, or outside what was asked,
// fails the same way a malformed one does (spec §8 criterion 15).

export const SCORE_MIN = 0;
export const SCORE_MAX = 5;
export const PLAN_MAX = 3;

function knownId(value, label, allowed, problems) {
  const id = String(value ?? "");
  if (!allowed.has(id)) {
    problems.push(`${label} is "${id}", which is not one of: ${[...allowed].join(", ")}`);
  }
  return id;
}

function strList(value, label, problems, { maxItems, maxLength }) {
  if (!Array.isArray(value)) {
    problems.push(`${label} must be an array of strings`);
    return;
  }
  if (value.length > maxItems) problems.push(`${label} has ${value.length} entries, at most ${maxItems} allowed`);
  value.forEach((v, i) => str(v, `${label}[${i}]`, problems, { max: maxLength }));
}

export function validateInterviewerReply(reply, { questionIds }) {
  if (!reply || typeof reply !== "object") return ["reply must be a JSON object"];
  const problems = [];
  str(reply.text, "text", problems, { max: 600 });
  knownId(reply.questionId, "questionId", new Set(questionIds), problems);
  return problems;
}

export function validateEvaluatorReply(reply, { askedIds }) {
  if (!reply || typeof reply !== "object") return ["reply must be a JSON object"];
  if (!Array.isArray(reply.scores)) return ['"scores" must be an array'];
  const problems = [];
  const allowed = new Set(askedIds);
  const seen = new Set();

  reply.scores.forEach((entry, i) => {
    const label = `scores[${i}]`;
    if (!entry || typeof entry !== "object") {
      problems.push(`${label} must be an object`);
      return;
    }
    const id = knownId(entry.questionId, `${label}.questionId`, allowed, problems);
    if (seen.has(id)) problems.push(`${label} grades "${id}" a second time`);
    seen.add(id);
    if (!Number.isInteger(entry.score) || entry.score < SCORE_MIN || entry.score > SCORE_MAX) {
      problems.push(`${label}.score must be an integer from ${SCORE_MIN} to ${SCORE_MAX}`);
    }
    strList(entry.missed, `${label}.missed`, problems, { maxItems: 4, maxLength: 300 });
    strList(entry.wrong, `${label}.wrong`, problems, { maxItems: 4, maxLength: 300 });
  });

  const ungraded = [...allowed].filter((id) => !seen.has(id));
  if (ungraded.length) problems.push(`no score for asked question(s): ${ungraded.join(", ")}`);
  return problems;
}

export function validateCoachReply(reply, { scoredIds }) {
  if (!reply || typeof reply !== "object") return ["reply must be a JSON object"];
  if (!Array.isArray(reply.plan)) return ['"plan" must be an array'];
  const problems = [];
  const allowed = new Set(scoredIds);
  const wanted = Math.min(PLAN_MAX, allowed.size);
  if (reply.plan.length < 1 || reply.plan.length > wanted) {
    problems.push(`"plan" has ${reply.plan.length} entries, it must have 1 to ${wanted}`);
  }
  const seen = new Set();
  reply.plan.forEach((entry, i) => {
    const label = `plan[${i}]`;
    if (!entry || typeof entry !== "object") {
      problems.push(`${label} must be an object`);
      return;
    }
    const id = knownId(entry.questionId, `${label}.questionId`, allowed, problems);
    if (seen.has(id)) problems.push(`${label} repeats "${id}"`);
    seen.add(id);
    str(entry.why, `${label}.why`, problems, { max: 400 });
  });
  return problems;
}
