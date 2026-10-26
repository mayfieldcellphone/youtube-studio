import { findFootage, footageConfigured, type Footage } from "./media";

/**
 * Free picture sources, tried in order before any paid AI picture is drawn:
 * Pexels (videos and photos, needs a free key), Pixabay (photos, free key) and
 * Wikimedia Commons (public-domain and CC0 photos only, no key; good for history).
 * None of these need credit lines on YouTube.
 */

export const pixabayConfigured = () => Boolean(process.env.PIXABAY_API_KEY);

/** Free sources that can be used right now (Wikimedia Commons always works, it needs no key). */
export const freeSources = () => [
  ...(footageConfigured() ? ["pexels"] : []),
  ...(pixabayConfigured() ? ["pixabay"] : []),
  "wikimedia",
];

const UA = "ChannelPlanner/1.0 (https://planner.repairrange.io; video tool)";

async function pixabay(query: string, portrait: boolean, used: Set<string>): Promise<Footage | null> {
  const url =
    `https://pixabay.com/api/?key=${encodeURIComponent(process.env.PIXABAY_API_KEY ?? "")}` +
    `&q=${encodeURIComponent(query.slice(0, 100))}&image_type=photo&orientation=${portrait ? "vertical" : "horizontal"}` +
    `&safesearch=true&per_page=20&min_width=${portrait ? 1000 : 1600}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pixabay error ${res.status}`);
  const data: any = await res.json();
  for (const hit of data.hits ?? []) {
    const id = `x${hit.id}`;
    const src = hit.largeImageURL ?? hit.webformatURL;
    if (!used.has(id) && src) return { id, kind: "photo", url: src };
  }
  return null;
}

/** Public-domain or CC0 (no attribution needed), judged by Commons' own license field. */
export const isPublicDomain = (license?: string) => /^(public domain|pd\b|pd-|cc0|cc 0)/i.test((license ?? "").trim());

/** Picks the best usable photo from a Wikimedia Commons search result. */
export function pickWikimedia(pages: any[], portrait: boolean, used: Set<string>): Footage | null {
  const minShort = 900;
  const candidates = pages
    .map((p) => ({ id: `w${p.pageid}`, info: p.imageinfo?.[0] }))
    .filter(({ id, info }) => {
      if (!info || used.has(id)) return false;
      if (!/^image\/(jpeg|png)$/.test(info.mime ?? "")) return false;
      if (Math.min(info.width, info.height) < minShort) return false;
      return isPublicDomain(info.extmetadata?.LicenseShortName?.value);
    });
  // Prefer a picture shaped like the frame; any size-OK public-domain picture is cropped to fit otherwise.
  const shaped = candidates.find(({ info }) => (info.height > info.width) === portrait);
  const pick = shaped ?? candidates[0];
  return pick ? { id: pick.id, kind: "photo", url: pick.info.thumburl ?? pick.info.url } : null;
}

async function wikimedia(query: string, portrait: boolean, used: Set<string>): Promise<Footage | null> {
  const params = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: `${query} filetype:bitmap`,
    gsrnamespace: "6",
    gsrlimit: "25",
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
    iiurlwidth: portrait ? "1400" : "1920",
    format: "json",
  });
  const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Wikimedia error ${res.status}`);
  const data: any = await res.json();
  return pickWikimedia(Object.values(data.query?.pages ?? {}), portrait, used);
}

type Finder = (query: string, portrait: boolean, used: Set<string>) => Promise<Footage | null>;

const FINDERS: Record<string, Finder> = {
  pexels: (q, portrait, used) => findFootage(q, portrait, used),
  pixabay,
  wikimedia,
};

/**
 * Looks for a free picture: for each search (the shot's own, then the scene's broader one), every
 * free source in turn. A source that errors (rate limit, bad key) is skipped for the rest of the video.
 */
export async function findFreeVisual(
  queries: string[],
  portrait: boolean,
  used: Set<string>,
  broken: Set<string>,
  sources = freeSources(),
  finders: Record<string, Finder> = FINDERS,
): Promise<Footage | null> {
  for (const query of queries) {
    if (!query.trim()) continue;
    for (const name of sources) {
      if (broken.has(name)) continue;
      try {
        const found = await finders[name](query, portrait, used);
        if (found) return found;
      } catch (err) {
        console.warn(`Free picture source ${name} failed, skipping it for this video: ${(err as Error).message}`);
        broken.add(name);
      }
    }
  }
  return null;
}
