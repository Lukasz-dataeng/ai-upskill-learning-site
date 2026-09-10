// The only file in this project that knows EPAM DIAL exists. Everything else
// asks for JSON from a named agent and gets back a parsed, validated object.
//
// Contract, from specs/agents/spec.md §3 rule 2: the reply must parse as JSON
// and match the agent's schema. On a parse or schema failure, retry once with
// the error appended, then fail. No third attempt, no silent repair.
//
// Credentials come from .env locally (DIAL_ENDPOINT, DIAL_API_KEY,
// DIAL_DEPLOYMENT_ID) and from Cloudflare secrets in production. Set DIAL_STUB
// to run against canned replies instead — see lib/dial-stub.mjs.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { stubReply } from "./dial-stub.mjs";

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

function endpointUrl() {
  const base = (process.env.DIAL_ENDPOINT || "").trim();
  if (!base) {
    throw new Error(
      "DIAL_ENDPOINT is not set. Put it in .env (see .env.example), or run with --stub to use canned replies."
    );
  }
  if (base.includes("/chat/completions")) return base;

  const deployment = (process.env.DIAL_DEPLOYMENT_ID || "").trim();
  if (!deployment) {
    throw new Error(
      "DIAL_ENDPOINT has no /chat/completions path, so DIAL_DEPLOYMENT_ID is needed to build one."
    );
  }
  return `${base.replace(/\/+$/, "")}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions`;
}

async function complete({ agent, system, user, maxTokens }) {
  const { mode, scenario } = dialMode();
  if (mode === "stub") return stubReply({ agent, user, scenario });

  const key = (process.env.DIAL_API_KEY || "").trim();
  if (!key) {
    throw new Error(
      "DIAL_API_KEY is not set. Put it in .env (see .env.example), or run with --stub to use canned replies."
    );
  }

  const res = await fetch(endpointUrl(), {
    method: "POST",
    headers: { "content-type": "application/json", "api-key": key },
    body: JSON.stringify({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: maxTokens,
      temperature: 0.4,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`DIAL returned HTTP ${res.status} for ${agent}: ${detail}`);
  }

  const data = await res.json();
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

export async function askJson({ agent, system, user, validate, maxTokens = 800 }) {
  let problems = [];
  let currentUser = user;
  let attempt = 0;

  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    const text = await complete({ agent, system, user: currentUser, maxTokens });

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
