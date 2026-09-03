#!/usr/bin/env node
// One-time migration tool: extracts structured deck data out of the original
// hand-built ai-interview-prep.html and writes data/interview-prep.yaml.
//
// This is NOT part of the ongoing build. Once a deck exists as YAML, future
// decks are authored directly as YAML — this script only exists to bootstrap
// the first one without hand-retyping 44 questions.
//
// Usage: node scripts/migrate-html-to-yaml.mjs [source.html] [output.yaml]

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as cheerio from "cheerio";
import * as yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const srcPath = path.resolve(root, process.argv[2] || "ai-interview-prep.html");
const outPath = path.resolve(root, process.argv[3] || "data/interview-prep.yaml");

const html = readFileSync(srcPath, "utf8");
const $ = cheerio.load(html);

function text(el) {
  return $(el).text().trim();
}
function htmlOf(el) {
  return ($(el).html() || "").trim();
}

// ---- deck-level metadata ----
const deckId = path.basename(outPath, ".yaml");
const title = text($(".hero h1"));
const description = text($(".hero p").first());
const shortTitle = text($(".brand span"));
const footerNoteHtml = htmlOf($("footer p").first()) || undefined;

// nav meta text ("9 questions · pipeline, eval, failure modes") per section id,
// used only to cross-check the extracted question count below.
const navMetaBySection = {};
$("#nav a[data-s]").each((_, a) => {
  const sid = $(a).attr("data-s");
  const meta = $(a).next(".navmeta").text().trim();
  navMetaBySection[sid] = meta;
});

// ---- sections ----
const sections = [];
$("section.sec").each((sIdx, secEl) => {
  const $sec = $(secEl);
  const id = $sec.attr("id");
  const style = $sec.attr("style") || "";
  const accentMatch = style.match(/--acc:\s*var\((--s\d+)\)/);
  const accent = accentMatch ? accentMatch[1].replace("--", "") : `s${(sIdx % 5) + 1}`;

  const secTitle = text($sec.find(".sechead h2").first());
  const summary = text($sec.find(".sechead p").first());

  // nav_meta looks like "9 questions · pipeline, eval, failure modes" — the
  // count is derivable from the actual questions below, so only the
  // descriptive tail is worth keeping; storing the count too would let the
  // two drift out of sync whenever a question is added or removed by hand.
  const rawNavMeta = navMetaBySection[id] || "";
  const navTagMatch = rawNavMeta.match(/^\d+\s+questions?\s*(?:·|-)?\s*(.*)$/i);
  const navTag = navTagMatch ? navTagMatch[1].trim() : rawNavMeta;

  const svg = $sec.find("figure svg").first();
  const diagram = svg.length ? $.html(svg).trim() : undefined;
  const diagramCaption = svg.length ? text($sec.find("figure figcaption").first()) : undefined;

  const tiers = [];
  $sec.find(".tier").each((_, tierEl) => {
    const $tier = $(tierEl);
    const name = text($tier.find(".tierlbl").first());
    const $articles = $tier.find("article.q");
    const filterValue = $articles.first().attr("data-d") || name;

    const questions = [];
    $articles.each((_, qEl) => {
      const $q = $(qEl);
      const qid = text($q.find(".qid").first());
      const question = text($q.find(".qt").first());
      const $qb = $q.find(".qb").first();

      let lead = "";
      const bodyParts = [];
      $qb.children().each((_, child) => {
        const $child = $(child);
        if ($child.hasClass("lead")) {
          lead = htmlOf(child);
        } else if ($child.hasClass("done-wrap")) {
          // template boilerplate (the confidence checkbox) — not stored
        } else {
          bodyParts.push($.html(child).trim());
        }
      });

      questions.push({
        id: qid,
        question,
        lead,
        body: bodyParts.join("\n"),
      });
    });

    tiers.push({ name, filter_value: filterValue, questions });
  });

  sections.push({
    id,
    accent,
    title: secTitle,
    summary,
    nav_tag: navTag,
    diagram,
    diagram_caption: diagramCaption,
    tiers,
  });
});

const deck = {
  id: deckId,
  title,
  short_title: shortTitle,
  description,
  footer_note: footerNoteHtml,
  sections,
};

// ---- validation ----
const problems = [];
let totalQuestions = 0;
for (const sec of sections) {
  let secCount = 0;
  for (const tier of sec.tiers) {
    for (const q of tier.questions) {
      totalQuestions++;
      secCount++;
      if (!q.id) problems.push(`section ${sec.id}: a question is missing an id`);
      if (!q.question) problems.push(`section ${sec.id} q${q.id}: missing question text`);
      if (!q.lead) problems.push(`section ${sec.id} q${q.id}: missing lead paragraph`);
      if (!q.body) problems.push(`section ${sec.id} q${q.id}: empty body`);
    }
  }
  const navCountMatch = (navMetaBySection[sec.id] || "").match(/(\d+)\s+questions?/i);
  const navCount = navCountMatch ? Number(navCountMatch[1]) : null;
  if (navCount !== null && navCount !== secCount) {
    problems.push(
      `section ${sec.id} (${sec.title}): nav says ${navCount} questions, extracted ${secCount}`
    );
  }
}

if (problems.length) {
  console.warn(`\n⚠ ${problems.length} issue(s) found during migration:`);
  for (const p of problems) console.warn(`  - ${p}`);
} else {
  console.log("✓ no issues detected");
}
console.log(`Extracted ${sections.length} sections, ${totalQuestions} questions total.`);

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  yaml.dump(deck, { lineWidth: -1, noRefs: true, quotingType: '"' }),
  "utf8"
);
console.log(`Wrote ${path.relative(root, outPath)}`);
