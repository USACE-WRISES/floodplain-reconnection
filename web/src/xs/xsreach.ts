// The default section of a reach: the one nearest both reach medians (STAF's
// geomorph.median_candidate, copied from STAF's static web app, apps/staf-web/src/engine/xsreach.ts).
// The explorer opens on it when the reach has no stored profile.

/** A scored section, as median_candidate reads it. */
export interface Candidate {
  /** where the section sits along the reach, 0 to 1 */
  position_frac: number
  entrenchment_ratio: number | null
  bank_height_ratio: number | null
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b)
  const n = s.length
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2
}

function avgRanks(idx: number[], values: Map<number, number>): Map<number, number> {
  const order = [...idx].sort((a, b) => values.get(a)! - values.get(b)!)
  const ranks = new Map<number, number>()
  let j = 0
  while (j < order.length) {
    let k = j
    while (k + 1 < order.length && values.get(order[k + 1]) === values.get(order[j])) k += 1
    for (let m = j; m <= k; m++) ranks.set(order[m], (j + k) / 2.0)
    j = k + 1
  }
  return ranks
}

function nearestMiddle(cands: Candidate[], idx: number[]): number {
  const n = cands.length
  const dist = (i: number) => (cands[i].position_frac !== null && cands[i].position_frac !== undefined
    ? Math.abs(cands[i].position_frac - 0.5) : Math.abs(i - (n - 1) / 2.0))
  return idx.reduce((best, i) => (dist(i) < dist(best) || (dist(i) === dist(best) && i < best) ? i : best), idx[0])
}

/** geomorph.median_candidate: the section nearest both reach medians (the default drawn). */
export function medianCandidate(cands: Candidate[]): number {
  if (!cands.length) return 0
  const both = cands.map((c, i) => [c, i] as const).filter(([c]) => c.entrenchment_ratio !== null && c.bank_height_ratio !== null).map(([, i]) => i)
  if (both.length >= 3) {
    const rer = avgRanks(both, new Map(both.map((i) => [i, cands[i].entrenchment_ratio as number])))
    const rbhr = avgRanks(both, new Map(both.map((i) => [i, cands[i].bank_height_ratio as number])))
    const mid = (both.length - 1) / 2.0
    const score = new Map(both.map((i) => [i, Math.abs(rer.get(i)! - mid) + Math.abs(rbhr.get(i)! - mid)]))
    const best = Math.min(...score.values())
    return nearestMiddle(cands, both.filter((i) => score.get(i) === best))
  }
  const ers = cands.map((c, i) => [c, i] as const).filter(([c]) => c.entrenchment_ratio !== null).map(([, i]) => i)
  if (ers.length) {
    const med = median(ers.map((i) => cands[i].entrenchment_ratio as number))
    const dist = new Map(ers.map((i) => [i, Math.abs((cands[i].entrenchment_ratio as number) - med)]))
    const best = Math.min(...dist.values())
    return nearestMiddle(cands, ers.filter((i) => dist.get(i) === best))
  }
  return nearestMiddle(cands, cands.map((_, i) => i))
}
