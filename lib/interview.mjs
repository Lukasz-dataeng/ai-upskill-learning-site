// Slice B request handling, with no HTTP in it: a parsed request goes in, a
// status and a JSON body come out. scripts/interview-server.mjs is the only
// caller today; if Slice B is ever hosted, this file moves and the server is
// what gets replaced. See specs/agents/spec.md §5.
//
// Every limit in §5.3 is checked before any agent runs, so a refused request
// costs nothing.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { askJson as defaultAsk, AgentError } from "./dial.mjs";
import { sectionQuestions } from "./deck.mjs";
import {
  validateInterviewerReply,
  validateEvaluatorReply,
  validateCoachReply,
} from "../agents/schemas.mjs";

export const LIMITS = {
  turns: 12, // interviewer turns per session
  transcriptBytes: 32 * 1024,
  answerChars: 4000,
  requestBytes: 64 * 1024, // enforced by the server, before parsing
  outputTokens: 800,
};

const agentsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "agents");
const prompts = new Map();
function prompt(name) {
  if (!prompts.has(name)) prompts.set(name, readFileSync(path.join(agentsDir, `${name}.md`), "utf8"));
  return prompts.get(name);
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };

// Deck answers are HTML. The Evaluator needs the words, not the markup, and
// the markup (tables, inline SVG) would roughly double the tokens.
export function plainText(html) {
  return String(html ?? "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<\/(p|li|tr|h\d|div)>|<br\s*\/?>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ENTITIES[e])
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

const fail = (status, error) => ({ status, body: { error } });

// Which questions the candidate actually answered: an interviewer turn
// followed by at least one candidate turn. A last question left hanging when
// the candidate pressed finish is not graded.
export function answeredQuestionIds(transcript) {
  const ids = [];
  let current = null;
  for (const turn of transcript) {
    if (turn.role === "interviewer") current = turn.questionId;
    else if (current && !ids.includes(current)) ids.push(current);
  }
  return ids;
}

function checkRequest(req, decks) {
  if (!req || typeof req !== "object") return { error: fail(400, "request body must be a JSON object") };

  const deck = decks.find((d) => d.id === req.deckId);
  if (!deck) return { error: fail(404, `no deck "${req.deckId}"`) };
  const section = (deck.sections ?? []).find((s) => s.id === req.sectionId);
  if (!section) return { error: fail(404, `no section "${req.sectionId}" in deck "${deck.id}"`) };
  if (req.action !== "next" && req.action !== "finish") {
    return { error: fail(400, `"action" must be "next" or "finish"`) };
  }

  const transcript = req.transcript ?? [];
  if (!Array.isArray(transcript)) return { error: fail(400, `"transcript" must be an array`) };
  if (Buffer.byteLength(JSON.stringify(transcript), "utf8") > LIMITS.transcriptBytes) {
    return { error: fail(413, `the transcript is over ${LIMITS.transcriptBytes / 1024} KB; finish this interview and start a new one`) };
  }

  const questions = sectionQuestions(section);
  const ids = new Set(questions.map((q) => String(q.id)));
  for (const [i, turn] of transcript.entries()) {
    if (!turn || (turn.role !== "interviewer" && turn.role !== "candidate") || typeof turn.text !== "string") {
      return { error: fail(400, `transcript[${i}] must have "role" (interviewer or candidate) and "text"`) };
    }
    if (turn.role === "candidate" && turn.text.length > LIMITS.answerChars) {
      return { error: fail(413, `an answer is ${turn.text.length} characters; the limit is ${LIMITS.answerChars}`) };
    }
    if (turn.role === "interviewer" && !ids.has(String(turn.questionId))) {
      return { error: fail(400, `transcript[${i}].questionId "${turn.questionId}" is not in section "${section.id}"`) };
    }
  }

  return { deck, section, questions, transcript };
}

async function next({ section, questions, transcript }, ask) {
  const interviewerTurns = transcript.filter((t) => t.role === "interviewer").length;
  const last = transcript[transcript.length - 1];
  if (last?.role === "interviewer") {
    return fail(400, "answer the current question before asking for the next one");
  }

  const turnsLeft = LIMITS.turns - interviewerTurns - 1;
  const questionIds = questions.map((q) => String(q.id));

  // Built from id and question only. lead and body never enter this object,
  // so they cannot reach the Interviewer however its prompt is worded.
  const input = {
    section: { id: section.id, title: section.title },
    questions: questions.map((q) => ({ id: String(q.id), question: q.question })),
    asked: [...new Set(transcript.filter((t) => t.role === "interviewer").map((t) => String(t.questionId)))],
    turnsLeft,
    transcript: transcript.map(({ role, text, questionId }) =>
      role === "interviewer" ? { role, text, questionId } : { role, text }
    ),
  };

  const reply = await ask({
    agent: "interviewer",
    system: prompt("interviewer"),
    user: JSON.stringify(input),
    validate: (r) => validateInterviewerReply(r, { questionIds }),
    maxTokens: LIMITS.outputTokens,
  });
  return { status: 200, body: { text: reply.text, questionId: String(reply.questionId), turnsLeft } };
}

async function finish({ questions, transcript }, ask, { forced }) {
  const askedIds = answeredQuestionIds(transcript).map(String);
  if (askedIds.length === 0) return fail(400, "nothing to grade yet: answer at least one question first");

  const byId = new Map(questions.map((q) => [String(q.id), q]));
  const evaluation = await ask({
    agent: "evaluator",
    system: prompt("evaluator"),
    user: JSON.stringify({
      questions: askedIds.map((id) => {
        const q = byId.get(id);
        return { id, question: q.question, answer: `${plainText(q.lead)}\n\n${plainText(q.body)}`.trim() };
      }),
      transcript,
    }),
    validate: (r) => validateEvaluatorReply(r, { askedIds }),
    maxTokens: LIMITS.outputTokens,
  });

  const scores = evaluation.scores.map((s) => ({ ...s, questionId: String(s.questionId) }));

  // The Coach gets the Evaluator's output and nothing else: no transcript,
  // no deck text.
  const coaching = await ask({
    agent: "coach",
    system: prompt("coach"),
    user: JSON.stringify({ scores }),
    validate: (r) => validateCoachReply(r, { scoredIds: scores.map((s) => s.questionId) }),
    maxTokens: LIMITS.outputTokens,
  });

  const plan = coaching.plan.map((p) => ({ questionId: String(p.questionId), why: p.why }));
  return { status: 200, body: { forced, scores, plan } };
}

export async function handleInterview(req, { decks, ask = defaultAsk }) {
  const checked = checkRequest(req, decks);
  if (checked.error) return checked.error;

  const interviewerTurns = checked.transcript.filter((t) => t.role === "interviewer").length;
  const forced = req.action === "next" && interviewerTurns >= LIMITS.turns;

  try {
    if (req.action === "finish" || forced) return await finish(checked, ask, { forced });
    return await next(checked, ask);
  } catch (e) {
    // A model that will not give valid JSON, DIAL refusing the call, or no
    // route to DIAL at all (VPN off). All the same to the page: try again.
    const detail = e instanceof AgentError ? e.message : `${e.name}: ${e.message}`;
    return fail(502, `DIAL call failed: ${detail}`);
  }
}
