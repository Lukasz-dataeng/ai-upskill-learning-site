# AI Upskill Learning Site

## Where this started

I wanted a way to actually prepare for an AI-engineering interview. Not another wall of text to read through, but something I'd use: search through it, track which answers I could give confidently, quiz myself before the real thing.

So I vibecoded one. I sat down with an AI assistant and iterated on a single page until it did what I wanted: topic sections, a search box, expandable answers, checkboxes for what I'd already nailed. There was no plan beyond building the thing. I described what I wanted, looked at the result, and adjusted until it felt right. That's what vibecoding is, really: describe, look, adjust, repeat, with your own judgment as the only thing checking the result.

It worked for that one topic. But that approach doesn't scale. The moment I need to prep for something else, a different interview, a different subject entirely, "does it feel right" isn't something I can check without rebuilding the whole page again and eyeballing it. Hand-building one more page, one prompt at a time, would be the only option.

## What this is for

So this time the approach is different. Instead of vibecoding each new topic from scratch, this works like spec-driven development: write down what a topic's content looks like and what the generator is supposed to do with it, before building anything against it. That written contract is what makes "any topic" realistic. A new topic gets checked against a definition that never changes, instead of being judged by feel every time.

The result I'm after: **a repeatable way to generate and publish a self-quiz site for any topic I need to prepare for**, not just the original interview questions. Same experience every time: search, filtering, confidence tracking, a clean interactive layout, without redoing the hand-crafted-page work per topic.

The shape of it: I hand over what I want to study, either a full set of questions and answers I've already written or just the questions themselves, and I get back a live, shareable site for it. The tenth topic should cost the same one request as the first.

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
│   └── <topic>.yaml
├── template/                 the shared interactive shell, topic-agnostic
│   ├── shell.html
│   ├── styles.css
│   └── app.js
├── scripts/
│   ├── build.mjs             renders data + template into a static site, checked against the schema
│   └── publish.sh            build, commit, push, deploy, and confirm it's live, all in one call
├── specs/site-generator/
│   └── spec.md                the content schema and the generator's contract, written down
├── .claude/skills/
│   └── publish-content/      turns "here's a topic" into a single request
└── dist/                     generated output, disposable, never hand-edited
```

Nothing about a new topic touches `template/` or `scripts/`. It's purely a new file under `data/`. That's the constraint the whole layout is designed around, and it's also the practical difference between this and vibecoding: a topic either fits the written contract or the build says exactly why not, rather than the answer being "it looks a bit off."

## Stack

- **Node.js** runs the generator: a small build script, not a framework. Nothing to compile, nothing to configure beyond what's in `package.json`.
- **YAML** (`js-yaml`) is the content format. It's readable to write by hand, and more forgiving of long multi-line prose than JSON would be.
- **Plain HTML, CSS, and JS** is what gets generated. No frontend framework: the interactivity (search, filtering, confidence tracking, theming) is small enough that one hasn't been worth the weight.
- **Cloudflare Pages** is where a topic ends up live, deployed through its CLI (`wrangler`) rather than its dashboard. The point is that publishing stays a command, not a series of clicks.
- **Git and GitHub** are the source of truth. Every topic is a tracked file, so what's live is always exactly what's in the repo.
- **EPAM DIAL** will eventually draft answers to bare questions through an actual LLM service instead of ad hoc. It's the one piece still missing before "any topic" is fully hands-off.

## How it works

The flow, start to finish:

1. **Give it a topic.** Either fully-formed content, questions with answers already written, or just the bare questions.
2. **It becomes structured content.** Anything already written gets carried across faithfully, nothing rephrased or dropped. Bare questions get answers drafted as part of the process. That drafting step should eventually go through a proper LLM service rather than being done ad hoc, so there's a real, checkable source behind every generated answer instead of just an assistant writing something once.
3. **It gets checked before it ships.** The structured content has a defined shape, and anything that doesn't match it needs to be caught there, not discovered later on the live site.
4. **It goes live** at its own address, as part of the same request rather than a separate manual step to remember afterward.

Which topic, how many questions, how the answers were sourced: all of that is a detail the workflow absorbs. The point is that none of it should require touching the presentation layer again.
