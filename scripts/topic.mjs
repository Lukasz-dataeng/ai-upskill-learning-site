#!/usr/bin/env node
// Topic pipeline: a title in, a published deck with quiz out, with two human
// stops on the way. See specs/topic-pipeline/spec.md.
//
//   npm run topic -- "Object Oriented Programming in Python" [--questions 16] [--from plan|answer|publish]
//                    [--approve plan] [--approve publish]
//
// Every step writes a file and skips work that file already holds, so the
// same command resumes after a stop, a crash or a dropped VPN.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as yaml from "js-yaml";

import { askJson as defaultAsk, AgentError, dialMode, usageByModel } from "../lib/dial.mjs";
import { validateDeck } from "../lib/deck.mjs";
import { sanitizeHtml } from "../lib/sanitize.mjs";
import { MODELS } from "../agents/models.mjs";
import {
  TIERS,
  validatePlannerReply,
  validateAuthorReply,
  validateCriticReply,
} from "../agents/schemas.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_QUESTIONS = 16;
export const MAX_QUESTIONS = 40;
const AUTHOR_ROUNDS = 2; // one attempt, plus one rewrite from the Reviewer's notes
// Output caps per agent. The Planner's has to hold a whole plan: 16 questions
// with section titles and summaries came to just over 800 tokens, which cut the
// JSON off mid-string, so it has room to spare now.
const TOKENS = { planner: 2200, author: 1500, reviewer: 800 };
const CONCURRENCY = 4; // answers written in parallel, well inside DIAL's per-minute limits
const STEPS = ["plan", "answer", "publish"];

export function slugify(title) {
  return String(title)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "") // accents: "é" becomes "e"
    .toLowerCase()
    .replace(/ł/g, "l") // the one Polish letter NFKD does not split
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
}

const prompts = new Map();
function prompt(name) {
  if (!prompts.has(name)) {
    prompts.set(name, readFileSync(path.join(repoRoot, "agents", `${name}.md`), "utf8"));
  }
  return prompts.get(name);
}

const readYaml = (file) => yaml.load(readFileSync(file, "utf8"));
function writeYaml(file, header, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, header + yaml.dump(value, { lineWidth: 100, noRefs: true }), "utf8");
}

// ---------------------------------------------------------------- 1. plan

// Ids and tier order come from code, never from the model (spec §4).
export function normalizePlan(plan, { deckId }) {
  const sections = (plan.sections ?? []).map((sec, i) => {
    const sid = `s${i + 1}`;
    const used = new Set();
    const questions = (sec.questions ?? [])
      .filter((q) => q && String(q.question ?? "").trim())
      .map((q) => ({ ...q, tier: TIERS.includes(q.tier) ? q.tier : "Intermediate" }))
      .sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier));

    // Keep an id someone already has (the answers cache is keyed on it);
    // give new questions the next free number in their section.
    for (const q of questions) {
      if (q.id && String(q.id).startsWith(`${i + 1}.`) && !used.has(String(q.id))) used.add(String(q.id));
      else q.id = null;
    }
    let n = 1;
    for (const q of questions) {
      if (q.id) continue;
      while (used.has(`${i + 1}.${n}`)) n++;
      q.id = `${i + 1}.${n}`;
      used.add(q.id);
    }
    return {
      id: sid,
      title: String(sec.title ?? `Section ${i + 1}`),
      summary: String(sec.summary ?? ""),
      questions: questions.map((q) => ({ id: String(q.id), tier: q.tier, question: String(q.question).trim() })),
    };
  });
  return { deck: deckId, title: String(plan.title ?? deckId), description: String(plan.description ?? ""), sections };
}

const PLAN_HEADER = `# Plan for a generated deck. Stop 1: edit freely before answering "y".
# Change, add or remove questions; tier is Foundational, Intermediate or Deep-dive.
# New questions need no id. Removing a section renumbers the ones after it.
`;

async function plan({ title, deckId, questions, ask, log }) {
  log(`→ planning ${questions} questions`);
  const reply = await ask({
    agent: "planner",
    system: prompt("planner"),
    user: JSON.stringify({ title, questionCount: questions }),
    validate: (r) => validatePlannerReply(r, { questionCount: questions }),
    maxTokens: TOKENS.planner,
  });
  return normalizePlan(reply, { deckId });
}

// -------------------------------------------------------------- 2. answer

async function answerOne({ deckTitle, section, q, others, ask }) {
  let notes = [];
  for (let round = 1; round <= AUTHOR_ROUNDS; round++) {
    const rejection = notes.length
      ? `\n\nA previous version was rejected by the reviewer:\n${notes.map((n) => `- ${n}`).join("\n")}`
      : "";
    const written = await ask({
      agent: "author",
      system: prompt("author"),
      user:
        JSON.stringify({
          deck: deckTitle,
          section: { title: section.title, summary: section.summary },
          question: { tier: q.tier, question: q.question },
          otherQuestions: others,
        }) + rejection,
      validate: validateAuthorReply,
      maxTokens: TOKENS.author,
    });
    const lead = sanitizeHtml(written.lead);
    const body = sanitizeHtml(written.body);

    const verdict = await ask({
      agent: "reviewer",
      system: prompt("reviewer"),
      user: JSON.stringify({ deck: deckTitle, question: q.question, lead, body }),
      validate: validateCriticReply,
      maxTokens: TOKENS.reviewer,
    });
    if (verdict.ok) return { question: q.question, status: "ok", rounds: round, lead, body };
    notes = verdict.problems;
  }
  return { question: q.question, status: "rejected", rounds: AUTHOR_ROUNDS, problems: notes };
}

async function inParallel(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

// Answers are cached per question in drafts/<id>/answers.yaml as they arrive,
// so a run that dies at question 12 keeps the first 11.
async function answer({ planned, answersFile, force, ask, log }) {
  const cache = existsSync(answersFile) ? readYaml(answersFile)?.answers ?? {} : {};
  const current = {};
  const changed = [];
  const todo = [];

  for (const section of planned.sections) {
    for (const q of section.questions) {
      const hit = cache[q.id];
      // A "failed" answer (DIAL down, VPN dropped) is retried; a "rejected"
      // one is not, unless its question is edited.
      if (!force && hit && hit.question === q.question && hit.status !== "failed") current[q.id] = hit;
      else todo.push({ section, q });
    }
  }
  log(`→ answering ${todo.length} question(s), keeping ${Object.keys(current).length}`);

  const save = () =>
    writeYaml(answersFile, "# Answers cache for the topic pipeline. Edit the plan, not this file.\n", {
      answers: current,
    });

  // The whole deck, not just the section: questions in different sections
  // can still overlap, and the Author can only avoid what it is shown.
  const all = planned.sections.flatMap((s) => s.questions);
  await inParallel(todo, CONCURRENCY, async ({ section, q }) => {
    let result;
    try {
      const others = all.filter((o) => o.id !== q.id).map((o) => o.question);
      result = await answerOne({ deckTitle: planned.title, section, q, others, ask });
    } catch (e) {
      const reason = e instanceof AgentError ? e.message : `${e.name}: ${e.message}`;
      result = { question: q.question, status: "failed", problems: [reason] };
    }
    current[q.id] = result;
    if (result.status === "ok") changed.push(q.id);
    log(`  ${q.id} ${result.status}${result.status === "ok" ? ` (round ${result.rounds})` : `: ${result.problems[0]}`}`);
    save();
  });
  save();
  return { answers: current, changed };
}

// Only ok answers go in. A tier or section with nothing left is dropped, so
// the build never fails on an empty one (spec §4).
export function assembleDeck({ planned, answers, models, date }) {
  const sections = [];
  for (const sec of planned.sections) {
    const tiers = TIERS.map((name) => ({
      name,
      questions: sec.questions
        .filter((q) => q.tier === name && answers[q.id]?.status === "ok")
        .map((q) => ({ id: q.id, question: q.question, lead: answers[q.id].lead, body: answers[q.id].body })),
    })).filter((t) => t.questions.length > 0);
    if (tiers.length === 0) continue;
    sections.push({
      id: sec.id,
      accent: `s${(sections.length % 5) + 1}`,
      title: sec.title,
      summary: sec.summary,
      tiers,
    });
  }
  return {
    id: planned.deck,
    title: planned.title,
    description: planned.description,
    footer_note:
      `<b>Generated ${date} by the topic pipeline</b> on EPAM DIAL ` +
      `(answers: ${models.author}, checked by ${models.reviewer}), with a human review before publishing. ` +
      `Answers are AI-written: verify anything you plan to rely on.`,
    sections,
  };
}

// ------------------------------------------------------------------ report

async function prices() {
  if (dialMode().mode === "stub") return {};
  try {
    const res = await fetch(`${process.env.DIAL_ENDPOINT.replace(/\/+$/, "")}/openai/models`, {
      headers: { "Api-Key": process.env.DIAL_API_KEY.trim() },
    });
    return Object.fromEntries((await res.json()).data.map((m) => [m.id, m.pricing ?? {}]));
  } catch {
    return {};
  }
}

export function costLines(usage, pricing) {
  let total = 0;
  const lines = Object.entries(usage).map(([model, u]) => {
    const p = pricing[model];
    const cost = p ? u.prompt * Number(p.prompt) + u.completion * Number(p.completion) : null;
    if (cost != null) total += cost;
    return `| ${model} | ${u.calls} | ${u.prompt} | ${u.completion} | ${cost == null ? "?" : `$${cost.toFixed(4)}`} |`;
  });
  return { lines, total };
}

async function writeReport({ reportFile, planned, answers, quiz, deck }) {
  const { lines, total } = costLines(usageByModel(), await prices());
  const planned_n = planned.sections.reduce((n, s) => n + s.questions.length, 0);
  const published = deck.sections.reduce((n, s) => n + s.tiers.reduce((m, t) => m + t.questions.length, 0), 0);
  const left = Object.entries(answers).filter(([, a]) => a.status !== "ok");

  const md = [
    `# ${planned.title}`,
    "",
    `Deck \`${planned.deck}\`: ${published} of ${planned_n} planned questions in the deck.`,
    quiz ? `Quiz: ${quiz.generated} generated this run, ${quiz.skipped.length} skipped.` : "",
    "",
    "## Left out",
    "",
    left.length
      ? left.map(([id, a]) => `- **${id}** ${a.question}\n  - ${a.status}: ${(a.problems ?? []).join("\n  - ")}`).join("\n")
      : "Nothing. Every planned question passed the Reviewer.",
    "",
    quiz?.skipped.length ? `## Quiz skipped\n\n${quiz.skipped.map((s) => `- **${s.id}**: ${s.reason}`).join("\n")}\n` : "",
    "## Models and cost (this run)",
    "",
    "| Model | Calls | Prompt tokens | Output tokens | Cost |",
    "|---|---|---|---|---|",
    ...lines,
    "",
    `Total this run: **$${total.toFixed(4)}**`,
    "",
  ].join("\n");
  writeFileSync(reportFile, md, "utf8");
  return { total, left };
}

// -------------------------------------------------------- the real steps

function runBuild() {
  const r = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "build.mjs")], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("the build failed, see above");
}

async function runQuiz({ deckId, changed, log }) {
  const { generateQuiz } = await import("./generate-quiz.mjs");
  const quiet = (line) => log(`  ${line}`);
  // Answers rewritten this run need their quiz item redone; the second call
  // fills in anything missing and drops items for questions no longer there.
  const redone = changed.length
    ? await generateQuiz({ deckId, only: changed, force: true, log: quiet })
    : { generated: 0, skipped: [] };
  const rest = await generateQuiz({ deckId, log: quiet });
  return { generated: redone.generated + rest.generated, skipped: [...redone.skipped, ...rest.skipped] };
}

function git(args) {
  return spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

function runPublish({ deckId, files, models }) {
  // Only this deck's own files may be staged. A publish that failed late (say,
  // on publish.sh's own checks) leaves exactly those staged, and resuming has
  // to work; anything else staged is someone's unrelated work, so stop.
  const staged = git(["diff", "--cached", "--name-only"]).stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const mine = files.map((f) => f.replace(/\\/g, "/"));
  const others = staged.filter((p) => !mine.some((m) => p === m || p.startsWith(`${m}/`)));
  if (others.length) {
    throw new Error(
      `git already has unrelated work staged: ${others.join(", ")}. Commit or unstage it, then resume`
    );
  }
  const add = git(["add", "--", ...files]);
  if (add.status !== 0) throw new Error(`git add failed: ${add.stderr}`);
  const message =
    `Add ${deckId} deck, generated by the topic pipeline\n\n` +
    `Plan by ${models.planner}, answers by ${models.author}, checked by ${models.reviewer},\n` +
    `quiz by ${models.writer}, all on EPAM DIAL. Reviewed at both stops before publishing.`;
  const r = spawnSync("bash", [path.join(repoRoot, "scripts", "publish.sh"), message], { cwd: repoRoot, stdio: "inherit" });
  if (r.status !== 0) throw new Error("publish.sh failed, see above");
}

async function terminalConfirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`${question} [y/N] `)).trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

// -------------------------------------------------------------- pipeline

export async function runTopic({
  title,
  questions = DEFAULT_QUESTIONS,
  from = null,
  approve = [],
  root = repoRoot,
  ask = defaultAsk,
  confirm = terminalConfirm,
  steps = {},
  log = console.log,
  date = new Date().toISOString().slice(0, 10),
}) {
  const { quiz = runQuiz, build = runBuild, publish = runPublish } = steps;
  if (!title || !String(title).trim()) throw new Error('give a title: npm run topic -- "Your topic"');
  if (!Number.isInteger(questions) || questions < 6 || questions > MAX_QUESTIONS) {
    throw new Error(`--questions must be a whole number from 6 to ${MAX_QUESTIONS}`);
  }
  if (from && !STEPS.includes(from)) throw new Error(`--from must be one of: ${STEPS.join(", ")}`);
  for (const a of approve) {
    if (a !== "plan" && a !== "publish") throw new Error('--approve must be "plan" or "publish"');
  }

  const deckId = slugify(title);
  if (!deckId) throw new Error("the title has no letters or digits to make a deck id from");
  const draftDir = path.join(root, "drafts", deckId);
  const files = {
    plan: path.join(draftDir, "plan.yaml"),
    answers: path.join(draftDir, "answers.yaml"),
    report: path.join(draftDir, "report.md"),
    deck: path.join(root, "data", `${deckId}.yaml`),
    quiz: path.join(root, "data", "quiz", `${deckId}.yaml`),
  };
  if (existsSync(files.deck) && !existsSync(draftDir)) {
    throw new Error(`data/${deckId}.yaml exists and was not made by this pipeline; it will not be overwritten`);
  }

  const resume = `npm run topic -- "${title}"`;
  const stop = (at, step, detail) => {
    log(`\n■ stopped at ${at}. ${detail}\n  Resume with: ${resume}\n  or, to approve without being asked: ${resume} --approve ${step}`);
    return { deckId, stopped: at, resume };
  };
  // A stop passes on a "y" at the prompt, or on --approve naming it: the way
  // to say yes when there is no terminal to type into (Claude Code, CI).
  const passes = async (step, question) => {
    if (approve.includes(step)) {
      log(`\n✓ ${step} approved with --approve ${step}`);
      return true;
    }
    return confirm(question);
  };
  const models = { ...MODELS };
  const fromIndex = from ? STEPS.indexOf(from) : -1;

  // 1. plan
  if (!existsSync(files.plan) || fromIndex === 0) {
    writeYaml(files.plan, PLAN_HEADER, await plan({ title, deckId, questions, ask, log }));
  }
  let planned = normalizePlan(readYaml(files.plan), { deckId });
  writeYaml(files.plan, PLAN_HEADER, planned); // ids given to questions added by hand
  const count = planned.sections.reduce((n, s) => n + s.questions.length, 0);
  log(`\n✓ plan: ${planned.sections.length} sections, ${count} questions → ${path.relative(root, files.plan)}`);
  for (const s of planned.sections) log(`  ${s.id} ${s.title} (${s.questions.length})`);

  if (!(await passes("plan", "Stop 1: plan ready. Review or edit it, then continue?"))) {
    return stop("stop 1 (plan)", "plan", `Read or edit ${path.relative(root, files.plan)}.`);
  }
  planned = normalizePlan(readYaml(files.plan), { deckId }); // edits made while waiting at the prompt
  writeYaml(files.plan, PLAN_HEADER, planned);

  let quizSummary = null;
  let deck;
  if (fromIndex < 2 || !existsSync(files.deck)) {
    // 2. answer
    const { answers, changed } = await answer({
      planned,
      answersFile: files.answers,
      force: fromIndex === 1,
      ask,
      log,
    });
    // Drop cached answers for questions no longer in the plan.
    const inPlan = new Set(planned.sections.flatMap((s) => s.questions.map((q) => q.id)));
    const kept = Object.fromEntries(Object.entries(answers).filter(([id]) => inPlan.has(id)));

    deck = assembleDeck({ planned, answers: kept, models, date });
    const problems = validateDeck(deck, `data/${deckId}.yaml`);
    if (problems.length) throw new Error(`the assembled deck is not valid: ${problems[0]}`);
    writeYaml(files.deck, "# Generated by scripts/topic.mjs. Source plan: drafts/" + deckId + "/plan.yaml\n", deck);
    log(`✓ deck → ${path.relative(root, files.deck)}`);

    // 3. quiz
    log("→ quiz");
    quizSummary = await quiz({ deckId, changed: changed.filter((id) => inPlan.has(id)), log });
    const report = await writeReport({ reportFile: files.report, planned, answers: kept, quiz: quizSummary, deck });
    log(`✓ report → ${path.relative(root, files.report)}: ${report.left.length} left out, $${report.total.toFixed(4)} this run`);
  } else {
    deck = readYaml(files.deck);
  }

  // 4. build
  build();

  if (
    !(await passes(
      "publish",
      `Stop 2: review ${path.relative(root, files.deck)}, ${path.relative(root, files.quiz)} and ${path.relative(root, files.report)}.\n` +
        `  Preview with "npm run interview" in another terminal. Publish?`
    ))
  ) {
    return stop("stop 2 (publish)", "publish", "Nothing was committed or deployed.");
  }

  // 5. publish
  publish({
    deckId,
    models,
    files: [files.deck, files.quiz, draftDir].filter((f) => existsSync(f)).map((f) => path.relative(root, f)),
  });
  log(`\n✓ ${deckId} published`);
  return { deckId, stopped: null };
}

// --------------------------------------------------------------------- cli

function parseArgs(argv) {
  const args = { title: [], questions: DEFAULT_QUESTIONS, from: null, approve: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--questions") args.questions = Number(argv[++i]);
    else if (a === "--from") args.from = argv[++i];
    else if (a === "--approve") args.approve.push(argv[++i]);
    else if (a === "--stub") process.env.DIAL_STUB = "1";
    else if (a.startsWith("--")) throw new Error(`unknown option "${a}"`);
    else args.title.push(a);
  }
  return { ...args, title: args.title.join(" ").trim() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (dialMode().mode === "stub") console.log("! stub mode: canned replies, nothing billed, cannot be published\n");
    await runTopic(args);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}
