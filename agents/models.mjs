// Which EPAM DIAL deployment each agent runs on. One place, so "cheapest model
// that does the job" is a line per agent, not a setting hunted through code.
// See specs/topic-pipeline/spec.md §6 for the rule and §10 for the checks
// behind each choice. DIAL_DEPLOYMENT_ID in .env covers any agent not listed.

export const MODELS = {
  // Slice A, quiz
  writer: "gpt-5.6-luna-2026-07-09",
  distractor: "gpt-5.6-luna-2026-07-09",
  critic: "gpt-5.6-luna-2026-07-09",
  // Slice B, mock interview
  interviewer: "gpt-5.6-luna-2026-07-09",
  evaluator: "gpt-5.6-luna-2026-07-09",
  coach: "gpt-5.6-luna-2026-07-09",
  // Topic pipeline
  planner: "gemini-2.5-flash-lite",
  author: "gpt-5.6-luna-2026-07-09",
  reviewer: "gemini-3.1-flash-lite",
};

export function modelFor(agent) {
  return MODELS[agent] || (process.env.DIAL_DEPLOYMENT_ID || "").trim() || null;
}
