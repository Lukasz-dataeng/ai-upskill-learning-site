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
