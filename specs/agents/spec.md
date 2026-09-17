# Learning agents — specification

Status: **Slice A implemented and verified** (see §10), **Slice B not started.** This was
written before either, and is kept true as code lands. Same spec-driven approach as
[`specs/site-generator/spec.md`](../site-generator/spec.md), which this builds on rather
than replaces.

## 1. Purpose

Add two agent-backed features to the learning site:

- **Slice A, Quiz.** Turn each existing question/answer card into one multiple-choice
  question, generated ahead of time and committed to the repo.
- **Slice B, Mock interview.** Let someone sit a short spoken-style interview on a deck,
  in the browser, and get graded afterwards.

Both run on **EPAM DIAL**, so the model behind them is Azure-hosted. Both use several
agents with separate jobs rather than one big prompt, because the separation is what
makes the output trustworthy: a critic that never saw the writer's intent catches
giveaways, and an interviewer that never saw the answers cannot leak them.

## 2. Non-goals

- **No agent framework.** An agent is a prompt file plus a function that calls DIAL. The
  project has no frontend framework and no templating engine; it does not need an agent
  library either.
- **No accounts of our own, no server-side storage.** Who may use the site is Cloudflare
  Access's job (§6). We store nothing about a user, ever.
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
| Interviewer | B | the deck's question list, the transcript so far | **any `lead` or `body` text** | the next thing to say |
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

One Cloudflare Pages Function, shipped by the same `wrangler pages deploy` that already
deploys the site:

```
POST /api/interview
```

Request:

```json
{
  "deckId": "interview-prep",
  "sectionId": "s1",
  "action": "next",
  "transcript": [{ "role": "interviewer", "text": "..." },
                 { "role": "candidate",   "text": "..." }]
}
```

`action` is `next` or `finish`. The browser holds the transcript and sends it back each
turn, so the server keeps no state and needs no database.

Response to `next`:

```json
{ "text": "...", "questionId": "1.3", "turnsLeft": 7 }
```

Response to `finish`:

```json
{
  "scores": [{ "questionId": "1.3", "score": 3, "missed": ["..."], "wrong": ["..."] }],
  "plan":   [{ "questionId": "1.3", "why": "..." }]
}
```

### 5.2 Orchestration

The Function is the orchestrator and holds no logic beyond routing:

- `next` calls the **Interviewer** once and returns its reply.
- `finish` calls the **Evaluator**, then passes only the Evaluator's output to the
  **Coach**. Two calls, in order, one handoff.

The Interviewer's prompt is built from the deck's `question` fields only. `lead` and
`body` are stripped in code before the prompt is assembled, not by telling the model to
ignore them.

### 5.3 Limits

Checked in the Function, per request, before any DIAL call:

| Limit | Value | On breach |
|---|---|---|
| Turns per session | 12 | `finish` is forced |
| Transcript size | 32 KB | HTTP 413 |
| Candidate answer | 4000 characters | HTTP 413 |
| Output tokens per call | 800 | passed to DIAL |

### 5.4 Page behaviour

A **Mock interview** button on a deck page opens a panel: the interviewer's question, a
text box, send, and finish. The transcript lives in the browser tab and is gone when it
closes. If `/api/interview` is unreachable the panel says so, and the rest of the page
keeps working.

One case needs handling by name. When an Access session expires mid-interview (§6), the
call is redirected to the login page on another host and the browser reports it as an
opaque network error, not as "please log in". Any failed call therefore shows **"Your
session expired, reload the page to carry on"**, with the transcript still on screen so
nothing typed is lost.

## 6. Access control

The whole site sits behind **Cloudflare Access**, content and `/api/*` alike. This is the
same setup as step 6 of the project owner's own
[`setup-strony.md`](../../setup-strony.md) runbook, already proven on this account for a
different site.

| | |
|---|---|
| Application | one self-hosted app on `ai-upskill-learning-site.pages.dev` |
| Policy | Allow, Include → Emails ending in → the EPAM domain, plus named addresses for anyone outside it |
| Login | one-time PIN, so no visitor needs a Cloudflare or GitHub account |
| Plan | Zero Trust Free, up to 50 users |

Set up once, in the Zero Trust dashboard or through the Cloudflare API. It is **not** a
per-deploy step: `wrangler pages deploy` and
[`scripts/publish.sh`](../../scripts/publish.sh) are unchanged.

### 6.1 Why this matters to the agents

A request without a valid Access session is rejected **at Cloudflare's edge, before the
Function runs**. No prompt is assembled, no DIAL call is made, nothing is billed. That is
the actual protection here, and it is the reason the agent endpoints can exist at all
without a rate limiter.

### 6.2 What it does not do

Access bounds **who** can call the endpoint, not **how often**. An invited person, or a
loop in the page's own JavaScript, can still spend budget. The per-request caps in §5.3
are what bound that, and they are not optional because of the gate.

True rate limiting is not available on this hostname: Cloudflare's rate limiting rules are
zone-level, and `pages.dev` is Cloudflare's zone rather than ours. It becomes possible
only behind a custom domain, which is out of scope here.

### 6.3 Identity, available but unused

Access passes `Cf-Access-Authenticated-User-Email` to the Function on every request. V1
ignores it. It is recorded here because it is the hook a per-person daily cap would use
later, without building any login of our own.

The Function does **not** verify the Access JWT itself, because Access covers every route
on this hostname and nothing can reach the Function without passing it first. If the gate
is ever narrowed to a path, or a second hostname is added, that assumption breaks and the
Function must start verifying `Cf-Access-Jwt-Assertion`.

### 6.4 Order of operations

If a custom domain is ever added to this project, add it **before** creating the Access
policy. The reverse order does not work. This is noted in `setup-strony.md` and is easy to
get wrong once.

## 7. Shared plumbing

```
agents/
  writer.md  distractor.md  critic.md          Slice A prompts
  interviewer.md  evaluator.md  coach.md       Slice B prompts
  schemas.mjs                                  the shape each agent must return, and §4.2's item
lib/dial.mjs                                   one function: call DIAL, parse JSON, retry once
lib/dial-stub.mjs                              canned replies, for running without DIAL access
functions/api/interview.js                     Cloudflare Pages Function (Slice B)
scripts/generate-quiz.mjs                      build-time run (Slice A)
data/quiz/<deck-id>.yaml                       generated, reviewed as a diff
test/quiz.test.mjs                             Slice A's acceptance criteria, as tests
```

A prompt file is Markdown: the agent's role, its rules, and the JSON shape it must return.
Prompts are edited as text, not buried in code.

`lib/dial.mjs` is the only place that knows DIAL exists. It reads `DIAL_ENDPOINT`,
`DIAL_API_KEY` and `DIAL_DEPLOYMENT_ID`, already declared in
[`.env.example`](../../.env.example). Locally those come from `.env`. In production they
are Cloudflare secrets set with `wrangler pages secret put`, never in the repo and never
sent to the browser.

### 7.1 What is sent to DIAL

Traffic is **outbound only**: browser → Function → DIAL → Azure model. DIAL never connects
to this site, has no URL for it, and never sits on the inbound path. The Access gate in §6
therefore needs no exception, allowlist or hole for any of this to work.

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

`Cf-Access-Authenticated-User-Email` is **never** put in a prompt (§6.3). No identity of
any kind reaches DIAL.

Two things are outside this project's control and should be confirmed with whoever grants
DIAL access, before anyone other than the owner uses Slice B: whether EPAM's DIAL instance
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
| 6 | A 13th turn is refused | send an over-length transcript, expect a forced `finish` |
| 7 | An oversized answer returns 413 and costs nothing | send 5000 characters, assert no DIAL call was made |
| 8 | No DIAL key reaches the browser | grep `dist/` for the key and for `DIAL_`, expect nothing |
| 9 | With `data/quiz/` absent and `/api/interview` down, the site behaves exactly as it does today | build with neither, check a deck page |
| 10 | Every agent reply parses against its schema, or fails loudly after one retry | one test per agent with a deliberately broken reply |
| 11 | An anonymous request to `/api/interview` never reaches the Function | `curl` with no Access cookie, expect the Access login response and no DIAL call in the logs |
| 12 | An expired session shows a readable message, not a silent hang | clear the Access cookie mid-interview, send a turn, expect the reload prompt with the transcript still visible |
| 13 | Stub-generated content cannot be published | `scripts/publish.sh` greps `dist/` for `[stub]` after building and exits non-zero if it finds any |

## 9. Known limitations, accepted for now

- **A gate, not a rate limiter.** Access stops strangers, and a rejected request costs
  nothing. It does not stop an invited person, or a runaway loop in our own JavaScript,
  from spending budget. See §6.2. The per-request caps in §5.3 are the only thing bounding
  that, and there is no daily ceiling per person.
- **The site is no longer publicly viewable.** Anyone demoing or reviewing it needs an
  allowed email address. The public GitHub repo required by the programme is unaffected,
  since that criterion is about the repo, not the site.
- **50 seats.** The Zero Trust Free plan tops out there. Well beyond what this needs, but
  it is a ceiling, not an unlimited allowance.
- **Quiz quality is judged by one Critic and one human.** Nothing measures whether the
  questions are actually good, only that they are well-formed and grounded.
- **Evaluator scores are not calibrated.** A 3 out of 5 means what the prompt says it
  means and nothing more. The number is not comparable across sessions.
- **Slice A changes `template/app.js`.** The README says a new topic never touches
  `template/`. That still holds: this is a new feature, not a new topic.
- **Transcripts are lost when the tab closes.** Deliberate, see §2.
- **No quiz item has been generated by a real model yet.** Everything shipped so far ran
  against the stub, so nothing is yet known about whether the Critic actually catches a
  bad question written by a real Writer. That is the first thing to check once DIAL
  credentials exist.

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
