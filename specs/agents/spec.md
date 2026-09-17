# Learning agents — specification

Status: **Slice A implemented, verified and live** (see §10). **Slice B implemented and
verified for local use only** (§5, §6, §10). This was written before either, and is kept true as code
lands. Same spec-driven approach as
[`specs/site-generator/spec.md`](../site-generator/spec.md), which this builds on rather
than replaces.

## 1. Purpose

Add two agent-backed features to the learning site:

- **Slice A, Quiz.** Turn each existing question/answer card into one multiple-choice
  question, generated ahead of time and committed to the repo.
- **Slice B, Mock interview.** Let the owner sit a short interview on one section of a
  deck, in the browser, and get graded afterwards. It runs on the owner's laptop, not on
  the public site (§6).

Both run on **EPAM DIAL**, so the model behind them is Azure-hosted. Both use several
agents with separate jobs rather than one big prompt, because the separation is what
makes the output trustworthy: a critic that never saw the writer's intent catches
giveaways, and an interviewer that never saw the answers cannot leak them.

## 2. Non-goals

- **No agent framework.** An agent is a prompt file plus a function that calls DIAL. The
  project has no frontend framework and no templating engine; it does not need an agent
  library either.
- **No accounts, no server-side storage.** Slice B has exactly one user, the owner, on
  their own machine (§6). Nothing about a session is stored, ever.
- **No streaming.** A reply arrives when it is complete.
- **No auto-publish.** Generated quiz content lands in a file for a human to read as a
  diff before it ships. An agent never commits and never deploys.
- **No retrieval, no vector store.** Agents are grounded by being handed the exact deck
  content they may use. Nothing is searched at run time.
- **Not a replacement for the cards.** The site still works with both slices switched
  off.

## 3. The agents

Six agents. Each one gets a fixed input, is denied everything else, and returns JSON in a
fixed shape.

| Agent | Slice | Gets | Never gets | Returns |
|---|---|---|---|---|
| Writer | A | one question's `question`, `lead`, `body` | other questions | stem, plus the correct option |
| Distractor | A | the same source, plus the correct option | anything else | three wrong options, each with a reason it is wrong |
| Critic | A | the assembled item, plus the source answer | anything else | `ok`, or a list of problems |
| Interviewer | B | the section's question list, the transcript so far | **any `lead` or `body` text** | the next thing to say |
| Evaluator | B | the transcript, plus `lead` and `body` for every question asked | anything else | per-question score and notes |
| Coach | B | the Evaluator's output | the raw transcript | three things to study, with card ids |

Two rules apply to all six:

1. **Grounding.** An agent may only assert what is in the deck content it was handed. If
   a claim is not supported there, it does not go in the output.
2. **Shape.** The reply must parse as JSON matching that agent's schema. On a parse or
   schema failure, retry once with the error appended, then fail. No third attempt, no
   silent repair.

## 4. Slice A, Quiz

### 4.1 Where quiz content lives

A separate file per deck, **not** inside `data/<deck>.yaml`:

```
data/quiz/<deck-id>.yaml
```

Reason: deck files are hand-authored, with block-literal answers and inline SVG. A script
that rewrote them would reformat all of that. Keeping generated content in its own file
means the generator only writes files it owns.

### 4.2 Quiz file schema

```yaml
deck: interview-prep          # required, must match a deck id in data/
items:                        # required
  - question_id: '1.1'        # required, must exist in that deck
    stem: "..."               # required, plain text, HTML-escaped on render
    options:                  # required, exactly 4
      - text: "..."           # required, plain text
        correct: true         # optional, exactly one option per item has it
        why: "..."            # required, one line, shown after answering
```

### 4.3 Generating

```
npm run quiz -- --deck interview-prep [--only 1.1,1.2] [--force] [--stub]
```

1. Load the deck. Pick every question with no item in the quiz file yet. `--force` redoes
   existing ones, `--only` limits the run to the ids given.
2. Per question: Writer, then Distractor, then Critic.
3. If the Critic reports problems, hand them back to the Writer once. If it still fails,
   skip that question, print why, carry on with the rest.
4. Write the quiz file. Print a summary: generated, skipped, unchanged.

The script never commits and never deploys. Publishing stays
[`scripts/publish.sh`](../../scripts/publish.sh), run after a human `git add`.

`--stub` runs the whole pipeline against canned replies from
[`lib/dial-stub.mjs`](../../lib/dial-stub.mjs) instead of DIAL, so the generator, the
schema checks, the retry, the skip path, the build and the page can all be exercised
before DIAL access exists. Stubbed strings are marked `[stub]`, the build warns when it
renders any, and `publish.sh` refuses to deploy a `dist/` containing them. Canned content
cannot reach the live site by accident.

### 4.4 What the Critic rejects

- More than one defensible option, or no correct one.
- A correct option claiming more than the source answer says.
- A distractor the source cannot rule out. A distractor that contradicts the source is
  the point, not a defect: the first full run lost 6 of 7 skipped questions to a Critic
  that read "not supported by the source" as applying to wrong options too.
- The correct option being the longest, or the only specific one.
- A distractor that is obviously silly rather than a real confusion.

### 4.5 Rendering

`build.mjs` reads `data/quiz/<deck-id>.yaml` when it exists and attaches each item to its
question by `question_id`. An id matching no question **fails the build**, the same way a
missing required field does today.

In the page, a card with a quiz item gets a **Quiz me** button. Clicking it shows the stem
and the four options in a fixed order. Picking one marks it right or wrong and reveals
every option's `why`. This is plain client-side JS in `template/app.js`. No server call,
no cost per visitor.

## 5. Slice B, Mock interview

### 5.1 Endpoint

A small local Node server, started on the owner's laptop while connected to the EPAM VPN:

```
npm run interview          # builds, then serves dist/ and the API on http://127.0.0.1:8788
npm run interview -- --stub
```

It serves the built site unchanged, plus one endpoint:

```
GET  /api/interview        → { "ok": true, "mode": "live" | "stub" }
POST /api/interview
```

The `GET` exists so the page can tell whether it is talking to this server. The public
site on Cloudflare has no such route, so there the probe fails and no interview button
appears.

Request:

```json
{
  "deckId": "interview-prep",
  "sectionId": "s1",
  "action": "next",
  "transcript": [{ "role": "interviewer", "text": "...", "questionId": "1.3" },
                 { "role": "candidate",   "text": "..." }]
}
```

`action` is `next` or `finish`. `questionId` is set on interviewer turns only, and must
name a question in that section. The browser holds the transcript and sends it back each
turn, so the server keeps no state and needs no database.

Response to `next`:

```json
{ "text": "...", "questionId": "1.3", "turnsLeft": 7 }
```

Response to `finish`, and to a `next` that the turn limit turns into a finish:

```json
{
  "forced": false,
  "scores": [{ "questionId": "1.3", "score": 3, "missed": ["..."], "wrong": ["..."] }],
  "plan":   [{ "questionId": "1.3", "why": "..." }]
}
```

`score` is an integer from 0 to 5. `plan` has one to three entries, each naming a question
that appears in `scores`.

The request handling lives in `lib/interview.mjs` as one function that takes the parsed
request and returns a status and a body. The server in `scripts/interview-server.mjs`
only does HTTP around it. If Slice B is ever hosted (§6.2), that function moves; the
HTTP wrapper is what gets replaced.

### 5.2 Orchestration

The handler is the orchestrator and holds no logic beyond routing:

- `next` calls the **Interviewer** once and returns its reply.
- `finish` calls the **Evaluator**, then passes only the Evaluator's output to the
  **Coach**. Two calls, in order, one handoff.

The Interviewer's prompt is built from the section's `id` and `question` fields only.
`lead` and `body` are stripped in code before the prompt is assembled, not by telling the
model to ignore them.

The Evaluator gets `lead` and `body` for the questions the Interviewer actually asked,
as plain text with the HTML removed, and nothing for questions that were not asked.

### 5.3 Limits

Checked in the handler, per request, before any DIAL call:

| Limit | Value | On breach |
|---|---|---|
| Interviewer turns per session | 12 | a `next` becomes a `finish`, with `forced: true` |
| Transcript size | 32 KB | HTTP 413 |
| Candidate answer | 4000 characters | HTTP 413 |
| Request body | 64 KB | HTTP 413, before parsing |
| `finish` with no candidate answer | | HTTP 400, nothing to grade |
| Output tokens per call | 800 | passed to DIAL |

### 5.4 Page behaviour

When the probe in §5.1 succeeds, a **Mock interview** button appears in the toolbar. It
opens a panel: pick a section, start, then the interviewer's question, a text box, send,
and finish. When the interview ends, the panel shows a score per question with what was
missed or wrong, and up to three cards to study, each linking to its card.

The transcript lives in the browser tab and is gone when it closes. A failed call never
clears it, and never clears what was typed in the text box. It shows one of these, then
lets the same action be retried:

| Failure | Message |
|---|---|
| The server cannot be reached | The local interview server is not running. Start `npm run interview` and send again. |
| HTTP 502 (DIAL failed or unreachable) | DIAL did not answer. Check the EPAM VPN is connected and send again. |
| HTTP 400 or 413 | the server's own message |

## 6. Access control

Slice B is **local only**. The server binds to `127.0.0.1`, so nothing else on the network
can reach it. The site on Cloudflare Pages has no API: static files only, where the
Mock interview button never appears.

That site is itself behind **Cloudflare Access**, set up on 2026-09-17 as in step 6 of the
owner's `setup-strony.md` runbook: one self-hosted application covering both
`ai-upskill-learning-site.pages.dev` and `*.ai-upskill-learning-site.pages.dev` (the
wildcard matters: every deployment also gets its own subdomain, which would otherwise
stay public), an Allow policy on named email addresses, and one-time PIN login. It is
set up once in the Zero Trust dashboard, not per deploy. `scripts/publish.sh` expects an
anonymous request to be redirected to the Access login page, and fails if the site
answers 200 without one.

### 6.1 Why not a Cloudflare Pages Function

The first version of this spec put `/api/interview` in a Cloudflare Pages Function behind
Cloudflare Access. Once the DIAL key arrived, two of its terms ruled that out:

- **DIAL is reachable only through the EPAM VPN.** Whitelisting is offered only for
  infrastructure in EPAM-managed accounts on Azure, AWS or GCP. Cloudflare's edge is
  neither, so a Function would be refused before any prompt ran.
- **The key is personal.** It "should not be shared or used for team-based workloads". A
  site that lets up to 50 invited people spend it is exactly that.

Running on the owner's laptop satisfies both: the call leaves over the VPN, and the only
person spending the key is its owner.

### 6.2 What hosting it would take

Recorded so the decision can be revisited, not planned:

1. A host in an **EPAM-managed** Azure, AWS or GCP account, with its outbound IP
   whitelisted through SupportDIAL@epam.com.
2. A **non-personal** DIAL key, sized for more than one user.
3. A gate in front of it. Cloudflare Access would no longer be the obvious fit, since the
   site and the API would sit on different providers; that choice belongs with step 1.
4. The per-request caps in §5.3 still apply, and a per-person daily cap becomes worth
   having, because a gate bounds who calls the endpoint, not how often.

## 7. Shared plumbing

```
agents/
  writer.md  distractor.md  critic.md          Slice A prompts
  interviewer.md  evaluator.md  coach.md       Slice B prompts
  schemas.mjs                                  the shape each agent must return, and §4.2's item
lib/dial.mjs                                   one function: call DIAL, parse JSON, retry once
lib/dial-stub.mjs                              canned replies, for running without DIAL access
lib/deck.mjs                                   load a deck and list its questions, shared by A and B
lib/interview.mjs                              Slice B request handling: limits, prompts, routing
scripts/interview-server.mjs                   local HTTP server for Slice B (dist/ + the API)
scripts/generate-quiz.mjs                      build-time run (Slice A)
data/quiz/<deck-id>.yaml                       generated, reviewed as a diff
test/quiz.test.mjs                             Slice A's acceptance criteria, as tests
test/interview.test.mjs                        Slice B's acceptance criteria, as tests
```

A prompt file is Markdown: the agent's role, its rules, and the JSON shape it must return.
Prompts are edited as text, not buried in code.

`lib/dial.mjs` is the only place that knows DIAL exists. It reads `DIAL_ENDPOINT`,
`DIAL_API_KEY`, `DIAL_DEPLOYMENT_ID` and the optional `DIAL_TEMPERATURE`, declared in
[`.env.example`](../../.env.example). They come from the gitignored `.env`, are read only
by Node on the owner's machine, and are never in the repo and never sent to the browser.

### 7.1 What is sent to DIAL

Traffic is **outbound only**: browser → local server on `127.0.0.1` → EPAM VPN → DIAL →
model. DIAL never connects back, has no URL for the server, and never sits on an inbound
path.

DIAL cannot read the site. It receives exactly what a prompt puts in front of it, and
nothing else:

| Slice | What leaves the machine | When |
|---|---|---|
| A | one question's `question`, `lead` and `body` | build time, on a developer's laptop, once per question |
| B | the deck's question list, plus the transcript so far | every `next` turn |
| B | the transcript, plus `lead` and `body` for the questions asked | once, on `finish` |

Over a full quiz-generation run, a deck's entire text passes through DIAL one question at a
time. That is acceptable because **deck content is already public**: it lives in a public
GitHub repo.

The **transcript is different**. It is the only data this project creates rather than
copies, and it is a record of what someone did not know, in their own words. Treat it as
the sensitive part of the system, even though nothing about it is secret.

No identity of any kind is put in a prompt, and none reaches DIAL beyond the key itself.

Two things are outside this project's control and should be confirmed with whoever grants
DIAL access, before Slice B is ever used by anyone other than the owner (§6.2): whether EPAM's DIAL instance
logs prompts and replies and for how long, and what retention the underlying Azure
deployment applies (Azure OpenAI keeps prompts for abuse monitoring, typically up to 30
days, unless the tenant has that switched off).

**Rule:** nothing beyond this table goes into a prompt without changing this section
first.

## 8. Acceptance criteria

| # | Criterion | How it's checked |
|---|---|---|
| 1 | Every quiz item has exactly 4 options and exactly 1 marked `correct` | `build.mjs` validation, fails the build |
| 2 | Every `question_id` in a quiz file matches a question in that deck | `build.mjs` validation, fails the build |
| 3 | `npm run quiz` is idempotent: a second run without `--force` changes no file | run twice, `git diff` is empty |
| 4 | A question the Critic keeps rejecting is skipped without killing the run | force a failure on one question, the rest still generate |
| 5 | The Interviewer prompt contains no `lead` or `body` text | assert on the assembled prompt before the DIAL call |
| 6 | A 13th turn is refused | send a transcript with 12 interviewer turns, expect a forced `finish` |
| 7 | An oversized answer returns 413 and costs nothing | send 5000 characters, assert no DIAL call was made |
| 8 | No DIAL key reaches the browser | grep `dist/` for the key and for `DIAL_`, expect nothing |
| 9 | With `data/quiz/` absent and `/api/interview` down, the site behaves exactly as it does today | build with neither, check a deck page; the live site shows no Mock interview button |
| 10 | Every agent reply parses against its schema, or fails loudly after one retry | one test per agent with a deliberately broken reply |
| 11 | The interview server is reachable only from the same machine | it binds `127.0.0.1`, asserted in a test |
| 12 | A failed call shows a readable message, not a silent hang, and loses nothing | stop the server mid-interview, send a turn, expect the message with the transcript and the typed answer still there |
| 13 | Stub-generated content cannot be published | `scripts/publish.sh` greps `dist/` for `[stub]` after building and exits non-zero if it finds any |
| 14 | The Evaluator gets `lead` and `body` only for questions that were asked | assert on the assembled prompt |
| 15 | A reply naming a question outside the section, or outside what was asked, is rejected | schema validation, one test per agent |

## 9. Known limitations, accepted for now

- **The site is not publicly viewable.** Anyone reviewing it needs an allowed email
  address added to the Access policy. The public GitHub repo required by the programme
  is unaffected. The Zero Trust Free plan caps that list at 50 users.
- **One user, one laptop.** Slice B works only on the owner's machine, on the VPN. A demo
  means sharing a screen, not a link. See §6.2 for what changing that would take.
- **No daily ceiling.** The per-request caps in §5.3 bound a single call. Nothing bounds a
  day's use except the key's own DIAL limits and the owner's budget.
- **Quiz quality is judged by one Critic and one human.** Nothing measures whether the
  questions are actually good, only that they are well-formed and grounded.
- **Evaluator scores are not calibrated.** A 3 out of 5 means what the prompt says it
  means and nothing more. The number is not comparable across sessions.
- **Slice A changes `template/app.js`.** The README says a new topic never touches
  `template/`. That still holds: this is a new feature, not a new topic.
- **Transcripts are lost when the tab closes.** Deliberate, see §2.

## 10. Verification performed

Slice A, checked on 2026-09-10 against a build of the `interview-prep` deck.

`npm test` covers criteria 1, 3, 4 and 10 as 13 automated tests, all passing, all against
the stub so the suite needs no credentials and no network: item validation rejects three
options, two correct options, none correct, a blank `why` and a duplicate option; a
question the Critic keeps rejecting is skipped while its neighbours still generate; a
second run without `--force` writes nothing and leaves the file byte-identical; an agent
that will not return JSON throws after exactly two attempts.

The rest was checked in a browser against a real build, with four items generated in stub
mode:

- **Quiz me does not reveal the answer.** With the panel open, the card's answer body
  stayed `display: none` and the card never gained the `open` class. This is the point of
  putting the panel between the header and the body, so it was worth confirming rather
  than assuming.
- **One pick, then explanations.** Picking a wrong option marked it red, marked the
  correct one green, revealed every option's `why`, and ignored a second click.
- **Search excludes quiz text.** Searching `quantization` still returns 5 cards across 2
  sections, matching the site generator spec's own figure. Searching `[stub]` or a
  distractor's wording returns nothing and shows the empty state, so a search can never
  surface an answer.
- **Nothing else moved.** Clicking a card header still expands it, and the confidence
  checkbox still drives the progress bar (1 of 44, 2.27%). No console errors.
- **Both themes.** In light mode the answered options render as dark text on pale green
  and pink, not the dark-mode tints reused unchanged.
- **The stub guard fires.** `npm run build` warns that the quiz file holds `[stub]`
  content, and the `publish.sh` check exits non-zero on the resulting `dist/`.

### Slice B

Checked on 2026-09-17, against a build of the `interview-prep` deck.

`npm test` covers criteria 5, 6, 7, 10, 11, 14 and 15 as 18 automated tests in
`test/interview.test.mjs`, all passing against the stub, next to Slice A's 13:

- the Interviewer's assembled prompt contains no run of words from any `lead` or `body`
  in the section, and no `lead`, `body` or `answer` key;
- the Evaluator gets answers only for questions the candidate replied to, as plain text;
  the Coach gets a single `scores` key and no transcript text;
- a `next` after 12 interviewer turns returns a forced finish; the twelfth is still a
  question;
- a 5000-character answer, a transcript over 32 KB, a finish with nothing answered and
  six kinds of malformed request are all refused with **zero** agent calls;
- an unparseable reply returns 502 after exactly two attempts, for `next` and `finish`;
- each Slice B validator rejects a question id outside what it was allowed to name,
  duplicates, and out-of-range scores or plan lengths;
- over real HTTP, the server listens on `127.0.0.1`, answers the probe, serves a turn,
  and refuses an oversized and a non-JSON body.

By hand, against the running server:

- **Stub mode over HTTP.** The page, `assets/app.js` and the API all answered. Path
  traversal to `.env`, plain and URL-encoded (`..%2F`, `%2e%2e%2f`, `..%5C`), returned
  403 or 404, never the file.
- **One live interview on DIAL** (`gpt-5.6-luna-2026-07-09`, section s3): two turns and a
  finish, about 16 seconds end to end, well under one cent. The Interviewer greeted, asked
  3.1, then moved to 3.2 with a neutral "Thanks. Next," and no feedback. For a partial
  answer on temperature the Evaluator gave 3 with three missed points and nothing wrong;
  for a planted misconception on max tokens (that it limits the prompt) it gave 1 and
  named both wrong claims against the deck. The Coach put 3.2 first for that reason.

Not yet checked: the panel in a real browser, including criterion 12 (stop the server
mid-interview and confirm the message appears with the transcript and typed answer
kept). The page code was syntax-checked and the built HTML inspected, nothing more.
