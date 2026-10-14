/**
 * Film finishing for the picture: an optional colour grade on top of the channel's look,
 * 2.39:1 letterbox bars, and light film grain. Pure functions that return FFmpeg filter text.
 */
export const GRADES = ["none", "sepia", "desaturated"] as const;
export type Grade = (typeof GRADES)[number];

const GRADE_FILTERS: Record<Grade, string> = {
  none: "",
  // The classic sepia matrix: old photographs, 19th-century scenes.
  sepia: "colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131:0",
  // Washed-out and cold: archive footage, grim true stories.
  desaturated: "eq=saturation=0.45:contrast=1.08,colorbalance=bs=0.03:rs=-0.02",
};

export interface Finishing {
  grade?: Grade;
  /** Light film grain. Grain doesn't compress, so files get noticeably larger. */
  grain?: boolean;
  /** 2.39:1 cinemascope bars (horizontal videos only) */
  letterbox?: boolean;
}

export const CINEMASCOPE = 2.39;

/** Filters applied after the look, to a W x H picture. */
export function finishingFilters(f: Finishing, W: number, H: number): string[] {
  const out: string[] = [];
  const grade = GRADE_FILTERS[f.grade ?? "none"];
  if (grade) out.push(grade);
  if (f.grain) out.push("noise=alls=6:allf=t");
  // Bars only make sense when the frame is wider than 2.39:1 would be; a vertical Short has no room.
  if (f.letterbox && W / H > 1.2) {
    const picture = Math.max(2, Math.floor(W / CINEMASCOPE / 2) * 2);
    if (picture < H) out.push(`crop=${W}:${picture}`, `pad=${W}:${H}:0:(oh-ih)/2:black`);
  }
  return out;
}
