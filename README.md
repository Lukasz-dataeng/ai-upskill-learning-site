# AI Upskill Learning Site

## Where this started

I wanted a way to actually prepare for an AI-engineering interview — not another wall of text, something I'd actually use: search through it, track which answers I could give confidently, quiz myself before the real thing. So I vibecoded one — sat down with an AI assistant and iterated on a single page until it did what I wanted: topic sections, a search box, expandable answers, checkboxes for what I'd already nailed. No plan beyond "build the thing" — just describing what I wanted and refining it until it felt right.

It worked, for that one topic. But the moment I need to prep for something else — a different interview, a different subject entirely — hand-building another page from scratch, one prompt at a time, is the only option I'd have.

## What this is for

Turning that one-off into something reusable: **a repeatable way to generate and publish a self-quiz site for any topic I need to prepare for**, not just the original interview questions. Same experience every time — search, filtering, confidence tracking, a clean interactive layout — without redoing the hand-crafted-page work per topic.

The shape of it: hand over what I want to study — a full set of questions and answers I've already written, or just the questions themselves — and get back a live, shareable site for it. The tenth topic should cost the same one request as the first.

## How it's structured

The original page tangled two things together: the *content* (which questions, which answers) and the *presentation* (the search, the layout, the interactivity). Pulling those apart is the whole design:

- **Content** — one file per topic, in a plain structured format: questions grouped by section and difficulty, each with a short answer and a longer one.
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
  Human-writable and assistant-writable equally — it shouldn't matter whether I typed a topic's content myself or handed over raw notes to be structured.
- **A shared template** — the interactive shell every topic gets: navigation, search, difficulty filters, expandable cards, the confidence tracker, a light/dark theme. One template, reused across every topic, not rebuilt per topic.
- **A generator** that combines the two into a static site — plain HTML/CSS/JS, no framework, so it stays cheap to host and fast to load regardless of how many topics pile up.
- **A publish step** that carries a topic from "written" to "live" without manual hosting work getting in the way each time a topic changes.

## How it works

The flow, start to finish:

1. **Give it a topic.** Either fully-formed content — questions with answers already written — or just the bare questions.
2. **It becomes structured content.** Anything already written gets carried across faithfully, nothing rephrased or dropped. Bare questions get answers drafted as part of the process; that drafting step should eventually go through a proper LLM service rather than being done ad hoc, so there's a real, checkable source behind every generated answer instead of just "an assistant wrote something once."
3. **It gets checked before it ships.** The structured content has a defined shape, and anything that doesn't match it needs to be caught there — not discovered later on the live site.
4. **It goes live**, at its own address, as part of the same request — not a separate manual step to remember afterward.

Everything else — which topic, how many questions, how the answers were sourced — is a detail the workflow absorbs. The point is that none of it should require touching the presentation layer again.
