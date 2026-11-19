// The reach layer's index (`web-index.json.gz`, its `fpr` block): what was built, from which grid
// release, and for each HUC8 its name, extent, counts, status and neighbors (data/README.md).
import type { WebManifest } from './source'

export interface Huc8Info {
  name: string
  /** west, south, east, north (degrees) */
  bbox: [number, number, number, number]
  rows: number
  units: number
  /** sampled stream length, km */
  km: number
  status: 'built' | 'partial'
  regions: string[]
  /** HUC8 files whose rows point into this one (upstream) and that this one points into */
  up: string[]
  dn: string[]
}

export interface FprIndex {
  rule: { unit_sections: number, da_break: number, quality: string }
  grid: { tag?: string, packed?: string, regions?: number, pending?: string[] }
  lines: { built?: string }
  regions: string[]
  huc8: Record<string, Huc8Info>
  huc4: string[]
}

export function fprIndex(m: WebManifest): FprIndex {
  const f = (m.fpr ?? {}) as Partial<FprIndex>
  return {
    rule: f.rule ?? { unit_sections: 10, da_break: 0.5, quality: '' },
    grid: f.grid ?? {},
    lines: f.lines ?? {},
    regions: f.regions ?? [],
    huc8: f.huc8 ?? {},
    huc4: f.huc4 ?? [],
  }
}

/** The data version a saved screening names. */
export function dataVersion(m: WebManifest | null): string {
  return m?.data_version ?? 'unknown'
}

/** HUC8s whose extent meets a box (degrees). */
export function huc8sInBox(idx: FprIndex, w: number, s: number, e: number, n: number): string[] {
  const out: string[] = []
  for (const [code, h] of Object.entries(idx.huc8)) {
    const [a, b, c, d] = h.bbox
    if (a <= e && c >= w && b <= n && d >= s) out.push(code)
  }
  return out.sort()
}
