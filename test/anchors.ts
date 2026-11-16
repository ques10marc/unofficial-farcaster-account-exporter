// GitHub's heading anchors, computed here rather than by the generator: lower case, punctuation other
// than - and _ dropped, spaces to hyphens, and -1, -2 and so on for repeats.
export function anchors(md: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  let fence = false;
  for (const l of md.split('\n')) {
    if (/^\s*```/.test(l)) fence = !fence;
    const m = fence ? null : /^#{1,6} (.+?)\s*#*\s*$/.exec(l);
    if (!m) continue;
    const base = m[1].toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}
