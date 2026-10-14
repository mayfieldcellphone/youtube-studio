/**
 * Splits narration into sentence-sized pieces for text-to-speech, and works out the
 * surrounding text each piece is sent with so intonation carries across the joins.
 */

const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "st", "jr", "sr", "vs", "etc", "prof", "gen", "col", "capt", "lt", "sgt",
  "mt", "fig", "inc", "ltd", "co", "no", "vol", "dept", "est", "approx", "ca", "rev", "hon", "gov", "sen",
]);

/** Pieces shorter than this are joined to a neighbour: tiny clips sound clipped and odd on their own. */
export const MIN_CHUNK_CHARS = 24;
/** Pieces longer than this are cut at a comma or dash so no request is a long paragraph. */
export const MAX_CHUNK_CHARS = 320;
/** How much surrounding text is sent as previous_text / next_text. */
export const CONTEXT_CHARS = 240;

const normalise = (text: string) => text.replace(/\s+/g, " ").trim();

/** True when the full stop after `word` ends an abbreviation or an initial rather than a sentence. */
function isAbbreviation(word: string) {
  const w = word.replace(/^[("'“‘[]+/, "");
  if (/^[A-Za-z]$/.test(w)) return true; // an initial: "H. P. Lovecraft"
  if (/^([A-Za-z]\.)+[A-Za-z]$/.test(w)) return true; // "U.S", "e.g", "a.m"
  return ABBREVIATIONS.has(w.toLowerCase());
}

/** Splits text into sentences. Audio tags such as [whispering] stay with the sentence they introduce. */
export function splitSentences(text: string): string[] {
  const clean = normalise(text);
  if (!clean) return [];
  const sentences: string[] = [];
  let start = 0;
  const boundary = /([.!?…]+)(["'”’)\]]*)\s+/g;
  for (let m = boundary.exec(clean); m; m = boundary.exec(clean)) {
    const end = m.index + m[0].length;
    const next = clean[end];
    // A new sentence starts with a capital, a digit, a quote or an audio tag; otherwise it's the same one.
    if (next === undefined || !/[A-Z0-9"'“‘([]/.test(next)) continue;
    if (m[1] === ".") {
      const word = clean.slice(start, m.index).split(" ").pop() ?? "";
      if (isAbbreviation(word)) continue;
    }
    sentences.push(clean.slice(start, end).trim());
    start = end;
  }
  const rest = clean.slice(start).trim();
  if (rest) sentences.push(rest);
  return sentences;
}

/** Cuts a long sentence at the comma, semicolon or dash nearest its middle. */
function cutLong(sentence: string): string[] {
  if (sentence.length <= MAX_CHUNK_CHARS) return [sentence];
  const middle = sentence.length / 2;
  let best = -1;
  for (const m of sentence.matchAll(/[,;:—–]\s+|\s-\s/g)) {
    const at = m.index + m[0].length;
    if (at < 40 || sentence.length - at < 40) continue;
    if (best < 0 || Math.abs(at - middle) < Math.abs(best - middle)) best = at;
  }
  if (best < 0) return [sentence];
  return [...cutLong(sentence.slice(0, best).trim()), ...cutLong(sentence.slice(best).trim())];
}

/** Sentence-sized chunks: split, cut overlong ones, and join tiny ones to a neighbour. */
export function chunkForSpeech(text: string): string[] {
  const pieces = splitSentences(text).flatMap(cutLong);
  const merged: string[] = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.length < MIN_CHUNK_CHARS) merged[merged.length - 1] = `${last} ${piece}`;
    else merged.push(piece);
  }
  // A short final piece joins the one before it.
  if (merged.length > 1 && merged[merged.length - 1].length < MIN_CHUNK_CHARS) {
    const tail = merged.pop()!;
    merged[merged.length - 1] = `${merged[merged.length - 1]} ${tail}`;
  }
  return merged;
}

const stripTags = (t: string) => t.replace(/\[[^\]]*\]\s*/g, "").trim();

/** The end of `text`, starting at a sentence or word boundary, at most `max` characters. */
function tail(text: string, max: number) {
  const t = stripTags(text);
  if (t.length <= max) return t;
  const cut = t.slice(t.length - max);
  const space = cut.indexOf(" ");
  return space >= 0 ? cut.slice(space + 1) : cut;
}

/** The start of `text`, ending at a word boundary, at most `max` characters. */
function head(text: string, max: number) {
  const t = stripTags(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return space > 0 ? cut.slice(0, space) : cut;
}

/**
 * previous_text and next_text for chunk `i`: the neighbouring chunks, reaching into `before`
 * and `after` (the narration either side of this scene) at the edges. Audio tags are removed so
 * they are not read as part of the context.
 */
export function contextFor(chunks: string[], i: number, before = "", after = "") {
  const prev = [before, ...chunks.slice(0, i)].filter(Boolean).join(" ");
  const next = [...chunks.slice(i + 1), after].filter(Boolean).join(" ");
  return {
    previousText: prev ? tail(prev, CONTEXT_CHARS) : undefined,
    nextText: next ? head(next, CONTEXT_CHARS) : undefined,
  };
}
