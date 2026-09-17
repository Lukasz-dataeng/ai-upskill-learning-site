# AI Upskill Learning Site

## Where this started

I wanted a way to actually prepare for an AI-engineering interview. Not another wall of text to read through, but something I'd use: search through it, track which answers I could give confidently, quiz myself before the real thing.

So I vibecoded one. I sat down with an AI assistant and iterated on a single page until it did what I wanted: topic sections, a search box, expandable answers, checkboxes for what I'd already nailed. There was no plan beyond building the thing. I described what I wanted, looked at the result, and adjusted until it felt right. That's what vibecoding is, really: describe, look, adjust, repeat, with your own judgment as the only thing checking the result.

It worked for that one topic. But that approach doesn't scale. The moment I need to prep for something else, a different interview, a different subject entirely, "does it feel right" isn't something I can check without rebuilding the whole page again and eyeballing it. Hand-building one more page, one prompt at a time, would be the only option.

## What this is for

So this time the approach is different. Instead of vibecoding each new topic from scratch, this works like spec-driven development: write down what a topic's content looks like and what the generator is supposed to do with it, before building anything against it. That written contract is what makes "any topic" realistic. A new topic gets checked against a definition that never changes, instead of being judged by feel every time.

The result I'm after: **a repeatable way to generate and publish a self-quiz site for any topic I need to prepare for**, not just the original interview questions. Same experience every time: search, filtering, confidence tracking, a clean interactive layout, without redoing the hand-crafted-page work per topic.

The shape of it: I hand over what I want to study, and I get back a live site for it. That can be a full set of questions and answers I've already written, just the questions, or, since the topic pipeline below, nothing but a title. The tenth topic should cost the same one request as the first.

## How it's structured

The original page tangled two things together: the content (which questions, which answers) and the presentation (the search, the layout, the interactivity). Pulling those apart is the whole design:

- **Content**: one file per topic, in a plain structured format. Questions are grouped by section and difficulty, and each one has a short answer and a longer one.
  ```yaml
  sections:
    - title: "..."
      tiers:
        - name: Foundational
          questions:
            - question: "..."
              lead: "..."   # the short version
              body: "..."   # the rest
  ```
  Human-writable and assistant-writable equally. It shouldn't matter whether I typed a topic's content myself or handed over raw notes to be structured.
- **A shared template**: the interactive shell every topic gets. Navigation, search, difficulty filters, expandable cards, the confidence tracker, a light/dark theme. One template, reused across every topic, not rebuilt per topic.
- **A generator**: combines the two into a static site. Plain HTML, CSS, and JS, no framework, so it stays cheap to host and fast to load no matter how many topics pile up.
- **A publish step**: carries a topic from written to live without manual hosting work getting in the way each time a topic changes.

On disk, that split looks like this:

```
.
├── data/                     one YAML file per topic
│   ├── <topic>.yaml
│   └── quiz/<topic>.yaml     generated quiz items, reviewed as a diff
├── drafts/<topic>/           what the models proposed: plan, answers, report
├── template/                 the shared interactive shell, topic-agnostic
│   ├── shell.html
│   ├── styles.css
│   └── app.js
├── agents/                   one prompt file per agent, plus the reply schemas
├── lib/                      the DIAL call, deck loading, the interview handler, HTML sanitising
├── scripts/
│   ├── build.mjs             renders data + template into a static site, checked against the schema
│   ├── topic.mjs             a title in, a reviewed deck out (npm run topic)
│   ├── generate-quiz.mjs     quiz items for a deck (npm run quiz)
│   ├── interview-server.mjs  the local mock-interview server (npm run interview)
│   └── publish.sh            build, commit, push, deploy, and confirm it's live, all in one call
├── specs/                    the written contracts: site-generator, agents, topic-pipeline
├── test/                     47 tests, all against canned replies: no key, no network
├── .claude/skills/
│   └── publish-content/      turns "here's a topic" into a single request
└── dist/                     generated output, disposable, never hand-edited
```

A new topic never touches `template/` or `scripts/`: it is content under `data/`, with what the models proposed alongside it in `drafts/`. That's the constraint the whole layout is designed around, and it's also the practical difference between this and vibecoding: a topic either fits the written contract or the build says exactly why not, rather than the answer being "it looks a bit off."

## Stack

- **Node.js** runs the generator: a small build script, not a framework. Nothing to compile, nothing to configure beyond what's in `package.json`.
- **YAML** (`js-yaml`) is the content format. It's readable to write by hand, and more forgiving of long multi-line prose than JSON would be.
- **Plain HTML, CSS, and JS** is what gets generated. No frontend framework: the interactivity (search, filtering, confidence tracking, theming) is small enough that one hasn't been worth the weight.
- **Cloudflare Pages** is where a topic ends up live, deployed through its CLI (`wrangler`) rather than its dashboard. The point is that publishing stays a command, not a series of clicks. The site sits behind **Cloudflare Access**: visitors on an allowed list log in with a one-time code sent to their email.
- **Git and GitHub** are the source of truth. Every topic is a tracked file, so what's live is always exactly what's in the repo.
- **EPAM DIAL** is the LLM gateway behind every agent below: nine of them now, each on the cheapest model that passed a spot check for its job, listed in [`agents/models.mjs`](agents/models.mjs). It is reachable only through the EPAM VPN, and my key is a personal one, which is what keeps the mock interview off the public site.

## How it works

The flow, start to finish:

1. **Give it a topic.** Fully-formed content, questions with answers already written, bare questions, or just a title.
2. **It becomes structured content.** Anything already written gets carried across faithfully, nothing rephrased or dropped. A title goes through the topic pipeline below, so there is a named model and a review step behind every generated answer rather than an assistant writing something once.
3. **It gets checked before it ships.** Twice over: the structured content has a defined shape and the build refuses anything that doesn't match it, and generated content waits for me to read it.
4. **It goes live** at its own address, as part of the same request rather than a separate manual step to remember afterward. Behind a login, so a reader needs an allowed email.

Which topic, how many questions, how the answers were sourced: all of that is a detail the workflow absorbs. The point is that none of it should require touching the presentation layer again.

## Practising with agents

Reading answers only goes so far, so two features put a model to work on the same content. Both are specified in [`specs/agents/spec.md`](specs/agents/spec.md), and both use several small agents with one job each rather than one big prompt.

- **Quiz me** (on the live site). Every card has a multiple-choice question. A Writer drafts it from the card, a Distractor adds three wrong options, and a Critic rejects anything unfair or guessable. They run once, ahead of time; the result is committed to `data/quiz/` and reviewed as a diff, so a visitor never triggers a model call.
- **Mock interview** (on my laptop only). An Interviewer asks questions from one section without ever being given the answers, an Evaluator grades each reply against the card, and a Coach picks up to three cards to re-read. Afterwards each question gets a score, what I missed and what I got wrong, and the cards to go back to.

  ```
  npm run interview            # http://127.0.0.1:8788, needs the VPN
  npm run interview -- --stub  # canned replies, no DIAL, nothing billed
  ```

  It is local for two reasons, not by preference: DIAL only answers from inside the EPAM VPN, and it whitelists infrastructure in EPAM-managed cloud accounts only, which Cloudflare's edge is not; and a personal key is not meant to serve other people. Fixing that means hosting the whole thing in an EPAM-managed AWS account with a team key, which is the next thing I want to try.

## From a title to a live deck

The goal from the start was "any topic", so the last piece generates the deck itself. One command, two stops where I read what the models wrote before anything ships ([`specs/topic-pipeline/spec.md`](specs/topic-pipeline/spec.md)):

```
npm run topic -- "Object Oriented Programming in Python"
```

1. A **Planner** proposes sections and questions. **Stop 1:** I read `drafts/<id>/plan.yaml`, edit it if I want, and say yes.
2. An **Author** writes each answer and a **Reviewer** checks it, with one rewrite if rejected. The quiz agents then run on the new deck, and the site is built. **Stop 2:** I read the deck, the quiz and `drafts/<id>/report.md` (what was left out, what it cost), and try the mock interview on it locally.
3. On a second yes, it is committed and deployed.

Each agent runs on the cheapest DIAL model that passed a spot check for its job, recorded in the spec. A deck costs a few cents: the first real run, eight questions on Python decorators, took two minutes and $0.02. The cheap Reviewer catches plainly wrong answers but not every slip, which is exactly why stop 2 exists: reading that deck myself, I found two terminology slips it had passed.

Nothing is published without that second yes. `publish.sh` also refuses to deploy while `data/` holds anything not staged, so a deck I turned down cannot ride along with the next change.

## Where it stands

- **Live** at [ai-upskill-learning-site.pages.dev](https://ai-upskill-learning-site.pages.dev), behind Cloudflare Access: a reader needs an email on the allowed list and logs in with a one-time code.
- **One deck so far**, the original 44 AI-engineering interview questions, with a generated quiz item on every card.
- **Three written contracts**, each followed by the code rather than the other way round: [`specs/site-generator/spec.md`](specs/site-generator/spec.md), [`specs/agents/spec.md`](specs/agents/spec.md), [`specs/topic-pipeline/spec.md`](specs/topic-pipeline/spec.md). Each one records what was actually verified, and what was not.
- **47 tests**, all against canned replies, so the suite needs no key and no network.
- **Next:** host it in an EPAM-managed AWS account with a team key, so the mock interview runs on the site instead of my laptop, and add a daily spend cap per person.

## Running this yourself

Nothing in this repo can deploy anywhere, or spend anyone's LLM budget, on its own: every credential and every target lives in `.env`, which is gitignored and has never been committed. To run your own copy:

1. `cp .env.example .env` and fill it in. For deploying, that means **your** Cloudflare API token (scoped to Account, Cloudflare Pages, Edit), **your** account id, a Pages project name of your own, the address to check afterwards, and whether that address sits behind a login. `publish.sh` checks all five before it builds or commits anything, so a missing one costs you nothing.
2. `npm install`, then `npm test`. All 47 tests run against canned replies, so they need no key and no network.
3. `npm run build` renders the site into `dist/`. That much works with no credentials at all.
4. The agents need an LLM gateway that speaks the Azure OpenAI shape. Mine is EPAM DIAL, reachable only over the EPAM VPN, with a personal key that is not meant to serve other people; that is the whole reason the mock interview runs locally. Yours will differ: put your endpoint, key and model in `.env`, and set per-agent models in [`agents/models.mjs`](agents/models.mjs).
5. A login gate, if you want one, is configured in your own Cloudflare Zero Trust account, not here. There is nothing in this repo that grants access to mine.
