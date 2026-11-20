// Study areas by watershed (the owner, 2026-11-20): HUC12s picked one at a time, or a whole HUC10 or
// HUC8 at a time with the pick-size switch, and shown as one chip per whole HUC8 or HUC10. Pure
// helpers, so the tests can hold them.

/** What a click on the map picks: a HUC12, or the whole HUC10 or HUC8 around it (by digits). */
export type PickSize = 12 | 10 | 8

/** The HUC12s of the unit of `size` that holds `code`, out of `all` (every HUC12 the outlines hold). */
export function unitOf(code: string, size: PickSize, all: readonly string[]): string[] {
  if (size === 12) return [code]
  const prefix = code.slice(0, size)
  const unit = all.filter((c) => c.startsWith(prefix))
  if (!unit.includes(code)) unit.push(code)
  return unit.sort()
}

/** Adds the unit to the picked codes, or takes it out when every code of it is picked already. */
export function toggleUnit(codes: Set<string>, unit: readonly string[]): 'added' | 'removed' {
  const all = unit.every((c) => codes.has(c))
  for (const c of unit) {
    if (all) codes.delete(c)
    else codes.add(c)
  }
  return all ? 'removed' : 'added'
}

/** A chip of the picked watersheds: a whole HUC8 or HUC10 (its code), or one HUC12. */
export interface Chip {
  size: PickSize
  code: string
  codes: string[]
}

/** The picked HUC12s as chips: one per whole HUC8, then one per whole HUC10, then one per HUC12 left.
 * `under(code)` gives every HUC12 of a HUC8 or HUC10, or null while its outlines are not loaded (its
 * HUC12s then show one each). A HUC8 or HUC10 of a single HUC12 stays that HUC12's chip. */
export function chipsOf(codes: Iterable<string>, under: (code: string) => readonly string[] | null): Chip[] {
  const left = new Set(codes)
  const chips: Chip[] = []
  for (const size of [8, 10] as const) {
    for (const code of [...new Set([...left].map((c) => c.slice(0, size)))].sort()) {
      const all = under(code)
      if (!all || all.length < 2 || !all.every((c) => left.has(c))) continue
      chips.push({ size, code, codes: [...all].sort() })
      for (const c of all) left.delete(c)
    }
  }
  for (const c of [...left].sort()) chips.push({ size: 12, code: c, codes: [c] })
  return chips
}
