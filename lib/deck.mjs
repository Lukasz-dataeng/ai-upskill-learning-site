// Reading decks from data/, shared by the quiz generator (Slice A) and the
// interview handler (Slice B). The build has its own loader with full field
// validation; this one only finds a deck and walks its questions.

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
