# AI Upskill Learning Site

**The workflow:** hand over a deck of questions and answers as YAML, get back a fast, interactive, self-quizzing static site. Content in, deployable site out — the same shell, styling, search, and confidence-tracking every time, with a new topic costing one data file instead of another hand-built page.

> Status: the workflow is built and verified end-to-end locally (see [Verified](#verified)). Not deployed yet — no GitHub repo or Cloudflare Pages project exists. Live URL: TBD.

---

## How it works

![Architecture: data/*.yaml and template/ feed into build.mjs, which validates and renders dist/, deployed to Cloudflare Pages. A dashed future path shows bare questions going through EPAM DIAL / Azure AI Foundry back into the data.](specs/site-generator/architecture.png)

Two inputs, one script:

- **`data/*.yaml`** — the content. One file per deck: sections → difficulty tiers → questions, each with a `lead` (the 15-second answer) and a `body` (the rest).
- **`template/`** — the chrome. Sidebar nav, search, difficulty filters, expand/collapse, the confidence-checkbox progress bar, light/dark toggle — lifted from a hand-built prototype, now generic across any deck.
- **`scripts/build.mjs`** — the generator. Validates every deck's shape (fails loudly, names the exact field, rather than shipping a broken page), renders each into `dist/<deck>/index.html`, and writes a `dist/index.html` that lists every deck found in `data/`.

Nothing here is a framework. The output is plain static HTML/CSS/JS — deployable anywhere, currently targeting Cloudflare Pages.

## Try it

```bash
npm install
npm run build          # data/*.yaml + template/ → dist/
npx serve dist          # preview locally
```

To add a topic: drop a new `data/<deck>.yaml` following the schema below, `npm run build`, then deploy `dist/`. That whole loop — content in, agent runs the build, pushes, confirms the live URL — is meant to become a single Claude Code request; see [Status](#status).

### The schema

```yaml
id: interview-prep              # → /interview-prep/
title: "..."                    # hero heading
sections:
  - id: s1
    title: "..."
    tiers:
      - name: Foundational
        questions:
          - id: "1.1"
            question: "..."
            lead: "..."         # the one-sentence version
            body: "..."         # the rest — trusted inline HTML (p, ul/ol, table, code)
```

Full contract — every field, what's optional, how difficulty filtering works, header stats — is in [`specs/site-generator/spec.md`](specs/site-generator/spec.md). That spec is this project's spec-driven piece (per the AI Upskill initiative's SDD requirement): written down, then built and checked against, before this README was.

## Verified

The first deck (`interview-prep`, 44 questions extracted from an original hand-built prototype — see `scripts/migrate-html-to-yaml.mjs`) was built and driven in a real browser: search filtered correctly, a question expanded to show its answer, ticking a confidence checkbox moved the progress bar to the exact right percentage, and the theme toggle switched palettes. Full detail and the known gaps (no persisted progress, no automated visual-regression check) are in the spec's own [Verification](specs/site-generator/spec.md#8-verification-performed) and [Known limitations](specs/site-generator/spec.md#7-known-limitations) sections.

## Status

- [x] Workflow built: schema, template, generator, spec
- [x] Verified locally (search, filters, checkboxes, theme toggle all match the source)
- [ ] `.claude/skills/publish-content/` — package the loop above as one repeatable Claude Code skill
- [ ] Public GitHub repo, Cloudflare Pages project, first live deploy
- [ ] Answer-generation hook wired to an EPAM DIAL endpoint, for decks that start as bare questions
