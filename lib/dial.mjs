// The only file in this project that knows EPAM DIAL exists. Everything else
// asks for JSON from a named agent and gets back a parsed, validated object.
//
// Contract, from specs/agents/spec.md §3 rule 2: the reply must parse as JSON
// and match the agent's schema. On a parse or schema failure, retry once with
// the error appended, then fail. No third attempt, no silent repair.
//
// Credentials come from .env (DIAL_ENDPOINT, DIAL_API_KEY). Which model an
// agent uses comes from agents/models.mjs, with DIAL_DEPLOYMENT_ID as the
// fallback. Set DIAL_STUB to run against canned replies instead, see
// lib/dial-stub.mjs.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { stubReply } from "./dial-stub.mjs";
import { modelFor } from "../agents/models.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MAX_ATTEMPTS = 2; // the first try, plus the one retry the spec allows

let envLoaded = false;
function loadEnv() {
  if (envLoaded) return;
  envLoaded = true;
  try {
    process.loadEnvFile(path.join(root, ".env"));
  } catch {
    // No .env on disk. Fine: the variables may already be in the environment,
    // and stub mode needs none of them.
  }
}

export class AgentError extends Error {
  constructor(agent, problems, attempts) {
    super(`${agent} failed after ${attempts} attempt(s): ${problems.join("; ")}`);
    this.name = "AgentError";
    this.agent = agent;
    this.problems = problems;
    this.attempts = attempts;
  }
}

// "ok" | "badjson" | "criticfail" | "criticfail:<question id>" when stubbed.
export function dialMode() {
  loadEnv();
  const stub = process.env.DIAL_STUB;
  if (stub && stub !== "0" && stub !== "off") {
    return { mode: "stub", scenario: stub === "1" || stub === "true" ? "ok" : stub };
  }
  return { mode: "live", scenario: null };
}

// Tokens DIAL reports per model, added up across every call in this process.
// The topic pipeline prices and prints it; nothing else reads it.
const usage = new Map();

export function usageByModel() {
  return Object.fromEntries(usage);
}

export function resetUsage() {
  usage.clear();
}

function record(model, reported) {
  const entry = usage.get(model) ?? { calls: 0, prompt: 0, completion: 0 };
  entry.calls++;
  entry.prompt += reported?.prompt_tokens ?? 0;
  entry.completion += reported?.completion_tokens ?? 0;
  usage.set(model, entry);
}

function endpointUrl(deployment) {
  const base = (process.env.DIAL_ENDPOINT || "").trim();
  if (!base) {
    throw new Error(
      "DIAL_ENDPOINT is not set. Put it in .env (see .env.example), or run with --stub to use canned replies."
    );
  }
  if (base.includes("/chat/completions")) return base;

  if (!deployment) {
    throw new Error(
      "no model for this agent: add it to agents/models.mjs, or set DIAL_DEPLOYMENT_ID in .env."
    );
  }
  return `${base.replace(/\/+$/, "")}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions`;
}

async function complete({ agent, system, user, maxTokens, model }) {
  const { mode, scenario } = dialMode();
  if (mode === "stub") return stubReply({ agent, user, scenario });

  const key = (process.env.DIAL_API_KEY || "").trim();
  if (!key) {
    throw new Error(
      "DIAL_API_KEY is not set. Put it in .env (see .env.example), or run with --stub to use canned replies."
    );
  }

  const body = {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
  };
  // Newer GPT deployments reject any temperature, so it is sent only when
  // DIAL_TEMPERATURE is set for a model that accepts it.
  const temperature = (process.env.DIAL_TEMPERATURE || "").trim();
  if (temperature) body.temperature = Number(temperature);

  const deployment = model || modelFor(agent);
  const res = await fetch(endpointUrl(deployment), {
    method: "POST",
    headers: { "content-type": "application/json", "api-key": key },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`DIAL returned HTTP ${res.status} for ${agent}: ${detail}`);
  }

  const data = await res.json();
  record(deployment, data?.usage);

  // A reply cut off at the token cap is usually unterminated JSON, and the
  // retry would hit the same cap. Say what actually happened instead.
  if (data?.choices?.[0]?.finish_reason === "length") {
    throw new Error(
      `DIAL cut the reply for ${agent} off at the ${maxTokens}-token cap. Raise maxTokens for this agent, or ask it for less.`
    );
  }

  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new Error(`DIAL reply for ${agent} carried no message content`);
  }
  return text;
}

// Models sometimes wrap JSON in a code fence even when asked not to. Stripping
// that is not "silent repair" — the content is untouched, only the wrapper goes.
function parseJson(text) {
  const cleaned = String(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  return JSON.parse(cleaned);
}

function retryPrompt(originalUser, problems) {
  return `${originalUser}

Your previous reply was rejected for these reasons:
${problems.map((p) => `- ${p}`).join("\n")}

Return corrected JSON only. No prose, no code fence.`;
}

export async function askJson({ agent, system, user, validate, maxTokens = 800, model }) {
  let problems = [];
  let currentUser = user;
  let attempt = 0;

  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    const text = await complete({ agent, system, user: currentUser, maxTokens, model });

    let parsed;
    try {
      parsed = parseJson(text);
    } catch (e) {
      problems = [`reply was not valid JSON: ${e.message}`];
      currentUser = retryPrompt(user, problems);
      continue;
    }

    problems = validate ? validate(parsed) : [];
    if (problems.length === 0) return parsed;
    currentUser = retryPrompt(user, problems);
  }

  throw new AgentError(agent, problems, attempt);
}
