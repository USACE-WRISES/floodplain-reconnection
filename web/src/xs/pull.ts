// A reach section's profile pulled from USGS 3DEP, on the user's click only (the owner's rule,
// 2026-10-11: never automatic). Loaded as its own chunk the first time a section is pulled, so the
// page's main script carries none of the tile reading.
import type { DataSource } from '../data/source'
import { sectionPulls } from './grid'
import { pullable, type ReachSection } from './reach'
import { pullExact } from './sample'

export interface Pulled {
  z: Float32Array
  /** the samples are the grid's own, bit for bit (the release's checksum matched) */
  verified: boolean
}

export async function pullSection(staf: DataSource, s: ReachSection): Promise<Pulled> {
  if (!s.det || !pullable(s)) throw new Error('the grid recorded no elevation tiles for this section')
  const at = (await sectionPulls(staf, s.vpu, s.id))?.find((p) => p.part === s.num.part && p.k === s.k)
  if (!at) throw new Error("this copy of the grid has no section positions (an older release)")
  const got = await pullExact({ x: at.x, y: at.y, nx: at.nx, ny: at.ny, wide: s.det.wide, nPts: s.det.nPts },
    { res: s.num.res, source: s.det.source, tiles: s.det.tiles }, s.det.reads, at.zCrc)
  return { z: got.z, verified: got.verified }
}
