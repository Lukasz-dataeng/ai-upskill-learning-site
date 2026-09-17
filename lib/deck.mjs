// Reading and validating decks from data/, shared by the build, the quiz
// generator (Slice A), the interview handler (Slice B) and the topic pipeline.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as yaml from "js-yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const dataDir = path.join(root, "data");

function deckFiles() {
  return readdirSync(dataDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
}

export function loadDecks() {
  return deckFiles()
    .map((file) => yaml.load(readFileSync(path.join(dataDir, file), "utf8")))
    .filter((deck) => deck?.id);
}

export function loadDeck(deckId) {
  const decks = loadDecks();
  const deck = decks.find((d) => d.id === deckId);
  if (deck) return deck;
  const ids = decks.map((d) => d.id);
  throw new Error(`no deck with id "${deckId}" in data/. Available: ${ids.join(", ") || "none"}`);
}

export function sectionQuestions(section) {
  return (section?.tiers ?? []).flatMap((tier) => tier.questions ?? []);
}

export function deckQuestions(deck) {
  return (deck.sections ?? []).flatMap(sectionQuestions);
}

const REQUIRED_DECK_FIELDS = ["id", "title", "sections"];
const REQUIRED_QUESTION_FIELDS = ["id", "question", "lead"];

// The build's rules (site-generator spec §3.2), as a list of problems so a
// caller can decide whether to stop. The build stops on the first one.
export function validateDeck(deck, file = "deck") {
  const problems = [];
  for (const field of REQUIRED_DECK_FIELDS) {
    if (!deck?.[field]) problems.push(`${file}: missing required top-level field "${field}"`);
  }
  if (!Array.isArray(deck?.sections) || deck.sections.length === 0) {
    problems.push(`${file}: "sections" must be a non-empty array`);
    return problems;
  }
  for (const sec of deck.sections) {
    if (!sec.id || !sec.title) problems.push(`${file}: a section is missing "id" or "title"`);
    if (!Array.isArray(sec.tiers) || sec.tiers.length === 0) {
      problems.push(`${file}: section "${sec.id}" has no tiers`);
      continue;
    }
    for (const tier of sec.tiers) {
      if (!tier.name) problems.push(`${file}: a tier in section "${sec.id}" is missing "name"`);
      if (!Array.isArray(tier.questions) || tier.questions.length === 0) {
        problems.push(`${file}: tier "${tier.name}" in section "${sec.id}" has no questions`);
        continue;
      }
      for (const q of tier.questions) {
        for (const field of REQUIRED_QUESTION_FIELDS) {
          if (!q?.[field]) {
            problems.push(`${file}: question ${q?.id ?? "(no id)"} in "${sec.id}/${tier.name}" is missing "${field}"`);
          }
        }
      }
    }
  }
  return problems;
}
