// Canned DIAL replies, so Slice A runs end to end before EPAM DIAL access
// exists. The shapes are exact; the content is deliberately poor. Every string
// starts with [stub] so stubbed output can never be mistaken for a real quiz,
// on the page or in a git diff.
//
// Scenarios, set through DIAL_STUB:
//   1 | ok               every agent behaves
//   badjson              every agent returns unparseable text (exercises the retry)
//   criticfail           the Critic rejects everything
//   criticfail:<id>      the Critic rejects only that question, others pass

function parsePayload(user) {
  try {
    return JSON.parse(user);
  } catch {
    return {};
  }
}

function plain(html, limit = 150) {
  const text = String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const firstSentence = text.split(/(?<=\.)\s/)[0] || text;
  return firstSentence.slice(0, limit).trim();
}

function writerReply(payload) {
  const source = plain(payload.lead) || `the answer to question ${payload.id}`;
  return JSON.stringify({
    stem: `[stub] Which statement matches the deck's answer to question ${payload.id}?`,
    correct: {
      text: `[stub] ${source}`.slice(0, 200),
      why: "[stub] This is the opening line of the deck's own answer.",
    },
  });
}

function distractorReply(payload) {
  const source = plain(payload.lead, 90) || "the deck's answer";
  return JSON.stringify({
    options: [
      {
        text: `[stub] The opposite of: ${source}`.slice(0, 200),
        why: "[stub] Inverts the claim the deck actually makes.",
      },
      {
        text: `[stub] A neighbouring idea confused with: ${source}`.slice(0, 200),
        why: "[stub] Describes a related mechanism, not this one.",
      },
      {
        text: `[stub] An unsupported extension of: ${source}`.slice(0, 200),
        why: "[stub] Goes further than anything in the source answer.",
      },
    ],
  });
}

function criticReply(payload, scenario) {
  const [, target] = scenario.split(":");
  const rejects = scenario.startsWith("criticfail") && (!target || target === payload.id);
  return rejects
    ? JSON.stringify({
        ok: false,
        problems: [`[stub] forced rejection of question ${payload.id}, to exercise the skip path`],
      })
    : JSON.stringify({ ok: true, problems: [] });
}

export function stubReply({ agent, user, scenario = "ok" }) {
  if (scenario === "badjson") return "[stub] this is not JSON {";

  const payload = parsePayload(user);
  switch (agent) {
    case "writer":
      return writerReply(payload);
    case "distractor":
      return distractorReply(payload);
    case "critic":
      return criticReply(payload, scenario);
    default:
      throw new Error(`dial-stub has no canned reply for agent "${agent}"`);
  }
}
