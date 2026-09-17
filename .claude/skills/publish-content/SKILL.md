---
name: publish-content
description: Take a study-content deck (new, updated, or just a topic title to generate one from) for the ai-upskill-learning-site repo from raw source through to live on Cloudflare Pages, in one pass. Use this whenever the user hands over content for this repo and wants it on the site — "publish this", "add this deck", "here are some questions on X, can you add them", "update the vector-databases section", "put this HTML file on the site" — even if they don't say "deploy" or "publish" outright. Also use it for pure re-deploys after editing template/, scripts/, or specs/ directly.
---

# Publish content to the AI Upskill learning site

This repo turns structured Q&A decks into an interactive static site. This skill is the whole pipeline, end to end: source content in, live URL out, in one request. It exists so that adding the next topic never becomes another hand-built page — see [`specs/site-generator/spec.md`](../../../specs/site-generator/spec.md) for why that separation (data vs. template vs. generator) is the point of this project.

## 1. Work out what you're publishing

Figure out the deck id (e.g. `interview-prep`) and whether this is a **new deck** or an **update to an existing one** (`data/<deck-id>.yaml`). If the user didn't name an id, pick a short kebab-case one from the topic and confirm it in your summary rather than asking up front — it's a cheap thing to fix later, not worth blocking on.

## 2. Get the content into the schema

Read [`specs/site-generator/spec.md`](../../../specs/site-generator/spec.md) §3.2 for the exact `data/*.yaml` shape (deck → sections → tiers → questions, each question needs `id`/`question`/`lead`, `body` is optional). Two cases:

- **Source is already Q&A** (an HTML page, existing notes, a doc with real answers written out): extract it faithfully into the schema. Don't paraphrase, trim, or "clean up" the actual content — copy it across. `lead` and `body` accept a small set of trusted inline HTML (`<p>`, `<strong>`, `<em>`, `<code>`, `<ul>/<ol>`, `<table>`, the `.box.trap`/`.box.tip`/`.terms` markup the template's CSS already styles) per spec §3.3 — write real HTML there, not Markdown, and don't escape it.
- **Source is only a title** ("make a deck on Object Oriented Programming in Python"): do not write the deck yourself. Run the topic pipeline, which plans, answers and quizzes it on EPAM DIAL and stops twice for the user; see [`specs/topic-pipeline/spec.md`](../../../specs/topic-pipeline/spec.md). It needs the EPAM VPN.
  1. `npm run topic -- "<title>"` (add `--questions <n>` if the user gave a size). It stops at stop 1: summarise `drafts/<id>/plan.yaml` for the user (sections and questions) and ask whether to go on or what to change. Make any changes they ask for in that file.
  2. Only after the user says go on: `npm run topic -- "<title>" --approve plan`. It stops at stop 2: give them `drafts/<id>/report.md` (what was left out, cost), point them at `data/<id>.yaml` and `data/quiz/<id>.yaml`, and suggest `npm run interview` to preview. Read the answers yourself too and flag anything you think is wrong; the Reviewer model is cheap and misses terminology slips.
  3. Only after the user explicitly approves publishing: `npm run topic -- "<title>" --approve publish`. That stages the deck, its quiz and its drafts and runs `publish.sh` itself, so skip section 3 below.

  **Never pass `--approve` for a stop the user has not approved in this conversation**, even if the content looks fine to you. The stops are the user's review, not yours.
- **Source is bare questions** (no answers yet): draft the answers yourself. The topic pipeline above only starts from a title, so answers you draft here are *your* output, not a retrieved or verified source. Say so plainly in your final summary to the user (which questions got AI-drafted answers) so they know to review those before treating the deck as finished. Don't blur this line even if it'd make the summary shorter.

If you're adding a genuinely new deck (not the first one), skim `data/interview-prep.yaml` for a concrete example of the shape in practice.

## 3. Build, commit, push, deploy, verify

Once `data/<deck-id>.yaml` is written or updated, stage exactly what this request touched:

```bash
git add data/<deck-id>.yaml   # plus template/, scripts/, specs/ too, if this request changed those
```

Then hand off to the script that does the rest:

```bash
scripts/publish.sh "Add <deck-id> deck: <short description>

Co-Authored-By: <the model you are running as> <noreply@anthropic.com>"
```

The script commits the message exactly as given and adds no attribution of its own, so the trailer is yours to write, naming the model actually doing the work.

That one command builds (`npm run build` — this **validates** every deck's required fields and fails loudly, naming the exact bad field, rather than shipping a broken page), commits whatever you staged, pushes to `origin/main`, deploys to Cloudflare Pages via `wrangler` (reading the token, account, project name and site URL from the repo's gitignored `.env`, all five checked before anything is built or committed — no dashboard step, ever, including first-time project creation), and checks the live site actually returns HTTP 200 before declaring success.

**If the build step fails, stop there.** Fix the data (the error names the exact section/tier/question and field at fault) and rerun the script — never work around a validation failure, and never deploy something the build itself rejected. If the script's final verification step fails (non-200), say so plainly rather than reporting success; that means something's wrong with the deploy, not the content.

A pure re-deploy (you only touched `template/`, `scripts/`, or `specs/`, no content change) works the same way — `git add` those paths, same script call, just describe the change in the commit message instead of a deck name.

## 4. Report back

Tell the user, briefly:
- What was published (deck id, what changed)
- The live URL — https://ai-upskill-learning-site.pages.dev/ (a single-deck site serves that one deck directly at the root; once a second deck exists the root becomes a listing page automatically — nothing to configure for that switch)
- Any AI-drafted answers from step 2, so they know what's worth a review pass
