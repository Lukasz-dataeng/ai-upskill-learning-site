# Topic pipeline — specification

Status: **built and verified** (§10), not yet run on a deck that was published. Builds on [`specs/site-generator/spec.md`](../site-generator/spec.md)
(the deck format and the build) and [`specs/agents/spec.md`](../agents/spec.md) (the quiz
and the mock interview), and changes neither.

## 1. Purpose

Type a topic title. Get a published study deck with answers, a quiz on every card, and a
mock interview, with a human check of the content at two points before anything ships.

```
npm run topic -- "Object Oriented Programming in Python"
```

## 2. Non-goals

- **No web form.** The title is typed in a terminal, or given to Claude Code, which runs
  the same command.
- **No publishing without a yes.** The pipeline stops twice; nothing is committed or
  deployed until the second stop is approved.
- **No web search or retrieval.** Answers come from the model. The two stops, and the
  Reviewer, are the only checks on them (§8).
- **No diagrams.** `diagram` stays empty in generated decks.
- **No editing of hand-made decks.** A title whose deck id already exists in `data/` with
  no `drafts/<id>/` folder beside it was not made by this pipeline, and is refused.

## 3. Flow

| Step | What happens | Writes |
|---|---|---|
| 1. Plan | **Planner** turns the title into sections and questions | `drafts/<id>/plan.yaml` |
| **Stop 1** | Owner reads the plan, may edit it, answers `y` to go on | |
| 2. Answer | Per question, 4 at a time: **Author** writes the answer, **Reviewer** checks it, one rewrite if rejected | `drafts/<id>/answers.yaml` as each arrives, then `data/<id>.yaml` |
| 3. Quiz | The existing Slice A generator, for this deck only | `data/quiz/<id>.yaml`, `drafts/<id>/report.md` |
| 4. Build | `npm run build`, which validates the deck | `dist/` |
| **Stop 2** | Owner reads the deck, the quiz and the report, previews it with `npm run interview`, answers `y` to publish | |
| 5. Publish | Stage the two data files, `scripts/publish.sh` | commit, push, deploy |

`<id>` is the title in kebab case: `object-oriented-programming-in-python`.

**At a stop**, in a terminal, the script asks `[y/N]`. Anything but `y` exits and prints
the command to resume. Without a terminal (Claude Code, CI) it exits at the stop and
prints the same. There, the only way past a stop is `--approve plan` or
`--approve publish` on the next run, which a person has to choose to add.

**Resuming** is the same command again. Every step skips work its output file already
holds:

- `plan.yaml` exists → no Planner call. Edits made to it at stop 1 are what step 2 uses.
- An answer exists in `drafts/<id>/answers.yaml` for the same question id **and** the same
  question text → kept. A question edited or added in the plan gets a new answer; one
  removed from the plan is dropped. An answer that failed on an error (DIAL down, VPN
  dropped) is retried; one the Reviewer rejected is not, unless its question is edited.
- Ids already in the plan are kept when it is edited; a question added by hand needs no
  id and gets the next free one in its section.
- Quiz items already in the quiz file are kept (Slice A's own rule).

Flags: `--questions <n>` (6 to 40, default 16), `--from <plan|answer|publish>` to redo
from a step onward, `--approve <plan|publish>` to pass that stop without a prompt.

## 4. Agents

Same rules as [`specs/agents/spec.md`](../agents/spec.md) §3: a prompt file in `agents/`,
a fixed input, JSON out, one retry on a bad shape, then fail.

| Agent | Gets | Returns |
|---|---|---|
| Planner | title, question count | deck `title`, `description`; 3 to 5 sections, each with `title`, `summary` and questions, each with `tier` and `question` |
| Author | title, the section, one question, every other question in the deck (to avoid overlap) | `lead` and `body` as HTML, from the allowed tags (§8) |
| Reviewer | the question and the Author's answer | `ok`, or a list of problems |

Ids are assigned **in code**, not by the Planner: sections `s1`…`sN`, questions
`<section>.<n>`. Tiers are fixed to the ones the existing deck uses: `Foundational`,
`Intermediate`, `Deep-dive`. Code orders questions by tier within a section.

**The Reviewer rejects** an answer that:

- is wrong, or states something as fact that is disputed or version-dependent without
  saying so;
- gives a specific number, version, date or API name it cannot stand behind;
- does not answer the question asked, or mostly repeats another question in the section;
- has a `lead` longer than two sentences, or a `body` that is filler.

Rejected twice → the question is **left out** of the deck and listed in `report.md` with
the Reviewer's reasons. A tier or section left empty is dropped, so the build never fails
on it.

## 5. Files

```
agents/planner.md  author.md  reviewer.md     prompts
agents/models.mjs                             which DIAL model each agent uses (§6)
lib/sanitize.mjs                              allow-list for generated HTML (§8)
scripts/topic.mjs                             the pipeline (npm run topic)
test/topic.test.mjs                           §9, against the stub
drafts/<id>/plan.yaml                         editable plan, committed with the deck
drafts/<id>/answers.yaml                      every answer and verdict, so a run resumes where it stopped
drafts/<id>/report.md                         what was left out and why, token use and cost
```

`drafts/` is committed together with the deck at step 5, so the repo shows what the
model proposed next to what was published.

## 6. Models

**Rule: each agent uses the cheapest DIAL model that passes a spot check for its job.**
Price comes from DIAL's own `/openai/models` listing. A model is only a candidate if its
`lifecycle_status` is `generally-available`.

`agents/models.mjs` maps agent → deployment id. `DIAL_DEPLOYMENT_ID` in `.env` stays the
fallback for any agent not listed. Every agent, the existing six included, goes through
this one map.

Spot check, per agent, cheapest candidate first, stop at the first that passes:

| Agent | Check |
|---|---|
| Planner | For two titles, the plan has no duplicate or off-topic questions and the tiers rise in difficulty. |
| Author | For three questions from `interview-prep`, the answer covers the main points of the hand-written card and has no factual error. |
| Reviewer | Given one correct answer and one with a planted factual error, accepts the first and names the error in the second. |

The chosen models, and what each check showed, are recorded in §10 before the pipeline is
first run for real.

## 7. Limits and cost

- At most 40 questions per deck. Output caps: Planner 2200, Author 1500, Reviewer 800.
  The Planner's was 800 until a 16-question plan was cut off mid-string; a reply that hits
  its cap now fails saying so, instead of as unparseable JSON.
- `lib/dial.mjs` adds up the `usage` DIAL returns per model. At each stop and at the end
  the script prints tokens and cost, priced from `/openai/models`, and writes them to
  `report.md`.

## 8. Trust

Generated answers are shown to people as study material, and the quiz and the interview
then treat them as the truth. So:

- **Two human stops**, and nothing is published without the second `y`.
- **Nothing unapproved ships by the back door.** `scripts/publish.sh` deploys `dist/`, which
  is built from the working tree. A deck turned down at stop 2 stays in `data/`, so
  `publish.sh` refuses to run while `data/` holds anything not staged.
- **Allow-listed HTML.** `lead` and `body` are inserted into the page unescaped
  (site-generator §3.3). Before anything is written to `data/<id>.yaml`, generated HTML
  is reduced to: `p strong em code pre ul ol li table thead tbody tr th td br`,
  `div` with `class="tw"` (table wrapper), `"box trap"` or `"box tip"`, and
  `b class="t"` (a box label). Every other tag is unwrapped to its text, every other attribute removed.
- **Labelled.** A generated deck's `footer_note` says it was generated with the named
  DIAL model on the date, and reviewed before publishing.

## 9. Acceptance criteria

| # | Criterion | How it's checked |
|---|---|---|
| 1 | The Planner's output gets ids in code, fixed tiers, and at most `--questions` questions | test |
| 2 | With `plan.yaml` present, no Planner call is made | test, spy on the agent calls |
| 3 | An answer is kept when id and question text are unchanged, regenerated when the text changed, dropped when removed | test |
| 4 | A question rejected twice is left out, listed in the report, and an emptied tier or section is dropped | test |
| 5 | The assembled deck passes the build's validation | test, against the same validation `build.mjs` runs |
| 6 | Script, event-handler attributes and unknown tags never reach `data/<id>.yaml` | test on the sanitizer |
| 7 | Without a `y` at a stop, nothing after it runs, and the resume command is printed | test |
| 8 | Nothing is staged, committed or deployed before stop 2 is approved | test, spy on the publish step |
| 9 | A title matching an existing hand-made deck is refused | test |
| 10 | A full run on a real title, with both stops, ends with the deck live and the interview working on it locally | by hand, recorded in §10 |
| 11 | `--approve` passes only the stop it names | test |
| 12 | `publish.sh` refuses while `data/` has unstaged or untracked changes | by hand: clean, untracked, staged, staged-then-edited |

## 10. Verification performed

Checked on 2026-09-17.

### Models (§6)

Candidates tried cheapest first, prices per million tokens in / out from DIAL's listing.

| Agent | Chosen | Price | What the check showed |
|---|---|---|---|
| Planner | `gemini-2.5-flash-lite` | $0.10 / $0.40 | Both titles: 16 and 15 questions, clear sections, tiers rising. `glm-4.7-flash` returned 10 of 16 and nonsense questions; `gpt-4.1-nano` asked about encapsulation twice. |
| Author | `gpt-5.6-luna-2026-07-09` | $0.20 / $1.20 | On 3.2, 2.4 and 1.1 of `interview-prep`: correct, allowed HTML only, and on 3.2 the same trap as the hand-written card. `gpt-4.1-nano` and `gemini-2.5-flash-lite` both taught the misconception that card warns against (a higher max tokens gives longer answers); nano also said 100 tokens is about 100 words. |
| Reviewer | `gemini-3.1-flash-lite` | $0.25 / $1.50 | Accepted both correct cards, rejected the planted error (max tokens as a cap on prompt plus output) and named it. Cheaper models missed the plant or rejected correct cards; `gpt-5.6-luna` rejected all three, correct ones included, which would empty a deck. |

The existing six agents stay on `gpt-5.6-luna`, already verified in the agents spec.

### Automated

`npm test`: 47 tests, all passing, 16 of them in `test/topic.test.mjs` for criteria 1 to 9
and 11, against the stub with the quiz, build and publish steps replaced by recorders.

### One real run, stopped before publishing

`npm run topic -- "Python Decorators" --questions 8`:

- **Plan:** 3 sections, 8 questions, then stop 1. Question 2.2 (use cases in Flask and
  Django, framework-specific) was replaced by hand with one on stacked decorator order,
  then `--approve plan`.
- **Answer, quiz, build:** 8 of 8 answers passed the Reviewer first time, 8 quiz items,
  build with two decks, stop 2. About 2 minutes, **$0.02**. The page has code blocks, a
  Quiz me button on every card and the generated-content footer; a stub interview on the
  new deck returned a question from the chosen section.
- **Read by hand at stop 2**, two errors the Reviewer passed: 2.1's lead calls a plain
  decorator a "decorator factory" (a term 2.3 then uses correctly), and 1.3's lead says
  the decorator nearest the function "runs first", which is true of application and
  wrong of the call order 2.2 describes. 1.3 and 2.2 also overlapped, because the Author
  was shown only its own section's questions; it is now shown the whole deck.

**What this means:** the cheap Reviewer catches plainly wrong statements, not slips of
terminology or wording that is right in one sense and wrong in another. Stop 2 is where
those are caught, and it is not optional.

Not yet done: criterion 10's publish and a local interview on a published generated deck.
