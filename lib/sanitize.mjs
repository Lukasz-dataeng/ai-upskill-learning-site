// Allow-list for model-written HTML, applied before an answer is saved.
// lead and body are inserted into the page unescaped (site-generator spec
// §3.3), which is fine for hand-written decks and not for generated ones.
// See specs/topic-pipeline/spec.md §8.

import * as cheerio from "cheerio";

const ALLOWED = new Set(
  "p strong em code pre ul ol li table thead tbody tr th td br div b".split(" ")
);

// Allowed tags whose class must be one of these; with any other class they are
// unwrapped. Other allowed tags lose every attribute.
const CLASSES = {
  div: new Set(["tw", "box trap", "box tip"]),
  b: new Set(["t"]),
};

// Removed together with everything inside them, not just unwrapped: their
// content is code or markup, never text a reader should see.
const DROP = new Set("script style iframe object embed svg math noscript template head link meta".split(" "));

export function sanitizeHtml(html) {
  const $ = cheerio.load(String(html ?? ""), null, false);

  // Deepest first, so unwrapping a parent never skips its children.
  const elements = $("*").toArray().reverse();
  for (const el of elements) {
    const tag = el.tagName.toLowerCase();
    const node = $(el);

    if (DROP.has(tag)) {
      node.remove();
      continue;
    }
    const cls = (node.attr("class") || "").trim().replace(/\s+/g, " ");
    const keepClass = CLASSES[tag]?.has(cls);
    if (!ALLOWED.has(tag) || (CLASSES[tag] && !keepClass)) {
      node.replaceWith(node.contents());
      continue;
    }
    for (const name of Object.keys(el.attribs)) node.removeAttr(name);
    if (keepClass) node.attr("class", cls);
  }

  // A table outside its scrolling wrapper overflows on a phone.
  $("table").each((_, t) => {
    const parent = $(t).parent();
    if (!(parent.is("div") && parent.attr("class") === "tw")) $(t).wrap('<div class="tw"></div>');
  });

  return $.html().trim();
}
