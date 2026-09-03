#!/usr/bin/env node
// The generator. Reads every data/*.yaml deck, renders each through
// template/shell.html (+ styles.css/app.js, copied unchanged), and writes
// static output to dist/. This is the one piece of this project that's
// spec-driven — see specs/site-generator/spec.md for the contract this
// script is expected to satisfy, and the acceptance checks below.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "data");
const templateDir = path.join(root, "template");
const distDir = path.join(root, "dist");

const REQUIRED_DECK_FIELDS = ["id", "title", "sections"];
const REQUIRED_QUESTION_FIELDS = ["id", "question", "lead"];

function esc(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fail(message) {
  console.error(`✗ build failed: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------- load data

function loadDecks() {
  let files;
  try {
    files = readdirSync(dataDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  } catch {
    fail(`no data/ directory found at ${dataDir}`);
  }
  if (files.length === 0) fail(`data/ contains no .yaml deck files`);

  return files.map((file) => {
    const filePath = path.join(dataDir, file);
    let deck;
    try {
      deck = yaml.load(readFileSync(filePath, "utf8"));
    } catch (e) {
      fail(`${file}: invalid YAML — ${e.message}`);
    }
    validateDeck(deck, file);
    return deck;
  });
}

function validateDeck(deck, file) {
  for (const field of REQUIRED_DECK_FIELDS) {
    if (!deck?.[field]) fail(`${file}: missing required top-level field "${field}"`);
  }
  if (!Array.isArray(deck.sections) || deck.sections.length === 0) {
    fail(`${file}: "sections" must be a non-empty array`);
  }
  for (const sec of deck.sections) {
    if (!sec.id || !sec.title) fail(`${file}: a section is missing "id" or "title"`);
    if (!Array.isArray(sec.tiers) || sec.tiers.length === 0) {
      fail(`${file}: section "${sec.id}" has no tiers`);
    }
    for (const tier of sec.tiers) {
      if (!tier.name) fail(`${file}: a tier in section "${sec.id}" is missing "name"`);
      if (!Array.isArray(tier.questions) || tier.questions.length === 0) {
        fail(`${file}: tier "${tier.name}" in section "${sec.id}" has no questions`);
      }
      for (const q of tier.questions) {
        for (const field of REQUIRED_QUESTION_FIELDS) {
          if (!q?.[field]) {
            fail(`${file}: question ${q?.id ?? "(no id)"} in "${sec.id}/${tier.name}" is missing "${field}"`);
          }
        }
      }
    }
  }
}

// -------------------------------------------------------------- statistics

function deckStats(deck) {
  let questions = 0;
  let tierNames = new Set();
  let tablesAndDiagrams = 0;
  for (const sec of deck.sections) {
    if (sec.diagram) tablesAndDiagrams++;
    for (const tier of sec.tiers) {
      tierNames.add(tier.name);
      for (const q of tier.questions) {
        questions++;
        tablesAndDiagrams += (q.body?.match(/<table[\s>]/g) || []).length;
      }
    }
  }
  return {
    questions,
    sections: deck.sections.length,
    tiers: tierNames.size,
    tablesAndDiagrams,
  };
}

// ------------------------------------------------------------------ render

function renderQuestion(q, filterValue) {
  return `
    <article class="q" data-d="${esc(filterValue)}">
      <div class="qh"><span class="qid">${esc(q.id)}</span><span class="qt">${esc(q.question)}</span><span class="chev">▶</span></div>
      <div class="qb">
        <p class="lead">${q.lead}</p>
        ${q.body || ""}
        <div class="done-wrap"><label><input type="checkbox"> I can answer this confidently</label></div>
      </div>
    </article>`;
}

function renderTier(tier) {
  const questions = tier.questions.map((q) => renderQuestion(q, tier.filter_value || tier.name)).join("\n");
  return `
  <div class="tier">
    <div class="tierlbl">${esc(tier.name)}</div>
${questions}
  </div>`;
}

function renderFigure(sec) {
  if (!sec.diagram) return "";
  return `
  <figure>
    ${sec.diagram}
    <figcaption>${esc(sec.diagram_caption || "")}</figcaption>
  </figure>`;
}

function renderSection(sec, index) {
  const num = String(index + 1).padStart(2, "0");
  const accent = sec.accent || `s${(index % 5) + 1}`;
  const tiers = sec.tiers.map(renderTier).join("\n");
  return `
<section class="sec" id="${esc(sec.id)}" style="--acc:var(--${esc(accent)})">
  <div class="sechead">
    <div class="secnum">${num}</div>
    <div><h2>${esc(sec.title)}</h2>
    <p>${esc(sec.summary || "")}</p></div>
  </div>
${renderFigure(sec)}
${tiers}
</section>`;
}

function renderNavLinks(deck) {
  return deck.sections
    .map((sec) => {
      const count = sec.tiers.reduce((n, t) => n + t.questions.length, 0);
      const meta = [`${count} question${count === 1 ? "" : "s"}`, sec.nav_tag].filter(Boolean).join(" · ");
      return `    <a href="#${esc(sec.id)}" data-s="${esc(sec.id)}"><span class="dot" style="background:var(--${esc(sec.accent || "s1")})"></span> ${esc(sec.title)}</a>
    <div class="navmeta">${esc(meta)}</div>`;
    })
    .join("\n");
}

function renderFilterButtons(deck) {
  const seen = new Map(); // filter_value -> display name
  for (const sec of deck.sections) {
    for (const tier of sec.tiers) {
      const fv = tier.filter_value || tier.name;
      if (!seen.has(fv)) seen.set(fv, tier.name);
    }
  }
  const buttons = [`  <button class="btn" data-f="all" id="fall">All</button>`];
  for (const [filterValue, name] of seen) {
    buttons.push(`  <button class="btn" data-f="${esc(filterValue)}">${esc(name)}</button>`);
  }
  return buttons.join("\n");
}

function renderDeckPage(deck, { showIndexLink }) {
  const shell = readFileSync(path.join(templateDir, "shell.html"), "utf8");
  const stats = deckStats(deck);
  const sectionsHtml = deck.sections.map(renderSection).join("\n");
  const deckIndexLink = showIndexLink
    ? `  <div class="sidebox">
    <h4>All decks</h4>
    <div style="font-size:12.3px"><a href="/">&larr; Back to deck index</a></div>
  </div>`
    : "";

  const replacements = {
    PAGE_TITLE: `${deck.title} · AI Upskill`,
    BRAND_SUBTITLE: deck.short_title || deck.title,
    NAV_LINKS: renderNavLinks(deck),
    TOTAL_QUESTIONS: String(stats.questions),
    HERO_TITLE: esc(deck.title),
    HERO_DESC: esc(deck.description || ""),
    STAT_QUESTIONS: String(stats.questions),
    STAT_SECTIONS: String(stats.sections),
    STAT_TIERS: String(stats.tiers),
    STAT_TABLES_DIAGRAMS: String(stats.tablesAndDiagrams),
    FILTER_BUTTONS: renderFilterButtons(deck),
    SECTIONS_HTML: sectionsHtml,
    FOOTER_NOTE: deck.footer_note ? `  <p>${deck.footer_note}</p>` : "",
    DECK_INDEX_LINK: deckIndexLink,
  };

  return Object.entries(replacements).reduce(
    (html, [token, value]) => html.replaceAll(`{{${token}}}`, value),
    shell
  );
}

function renderIndexPage(decks) {
  const cards = decks
    .map((deck) => {
      const stats = deckStats(deck);
      return `
    <a class="deck-card" href="/${esc(deck.id)}/">
      <h2>${esc(deck.title)}</h2>
      <p>${esc(deck.description || "")}</p>
      <div class="deck-stats">${stats.questions} questions · ${stats.sections} sections</div>
    </a>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Upskill Program</title>
<link rel="stylesheet" href="/assets/styles.css">
<style>
  body{padding:60px 24px}
  .idx{max-width:820px;margin:0 auto}
  .idx h1{font-size:28px;letter-spacing:-.02em}
  .deck-card{display:block;border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin-top:16px;text-decoration:none;background:var(--card)}
  .deck-card:hover{border-color:var(--line2)}
  .deck-card h2{margin:0 0 6px;color:var(--tx);font-size:18px}
  .deck-card p{margin:0 0 10px;color:var(--tx2);font-size:13.5px}
  .deck-stats{font-size:11.5px;color:var(--tx3);text-transform:uppercase;letter-spacing:.06em}
</style>
</head>
<body>
  <div class="idx">
    <h1>AI Upskill Program</h1>
    <p style="color:var(--tx2)">Interactive learning decks.</p>
${cards}
  </div>
</body>
</html>`;
}

// --------------------------------------------------------------------- run

const decks = loadDecks();

rmSync(distDir, { recursive: true, force: true });
mkdirSync(path.join(distDir, "assets"), { recursive: true });
copyFileSync(path.join(templateDir, "styles.css"), path.join(distDir, "assets", "styles.css"));
copyFileSync(path.join(templateDir, "app.js"), path.join(distDir, "assets", "app.js"));

// A single deck needs no separate landing page to click through — it IS the
// site. Once a second deck shows up in data/, this automatically switches
// back to a real index page listing all of them; nothing to toggle by hand.
const singleDeck = decks.length === 1;

for (const deck of decks) {
  const deckDir = path.join(distDir, deck.id);
  mkdirSync(deckDir, { recursive: true });
  const page = renderDeckPage(deck, { showIndexLink: !singleDeck });
  writeFileSync(path.join(deckDir, "index.html"), page, "utf8");
  if (singleDeck) writeFileSync(path.join(distDir, "index.html"), page, "utf8");
  const stats = deckStats(deck);
  console.log(`✓ ${deck.id}: ${stats.questions} questions, ${stats.sections} sections → dist/${deck.id}/index.html`);
}

if (singleDeck) {
  console.log(`✓ dist/index.html (single deck served directly at the site root)`);
} else {
  writeFileSync(path.join(distDir, "index.html"), renderIndexPage(decks), "utf8");
  console.log(`✓ dist/index.html (${decks.length} decks listed)`);
}
console.log(`\nBuild complete: ${decks.length} deck(s) → ${path.relative(root, distDir)}/`);
