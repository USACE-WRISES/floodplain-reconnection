// Python's rounding, copied from STAF's static web app (apps/staf-web/src/app/pyfmt.ts and
// src/xs/sample.ts): the cross-section math rounds as the grid's Python did, so a section measured
// here at the grid's own stages gives the grid's numbers to the digit.
//
// f"{x:.4f}" rounds the double's exact binary value half to even; JavaScript's toFixed rounds an exact
// tie away from zero. The two agree except on exact ties, which only dyadic values with few decimals
// hit (39.03125 to four places), so pyFixed asks toFixed and fixes the tie case from the exact value.

const view = new DataView(new ArrayBuffer(8))

/** ``x`` as m * 2**e with m an integer (exact); null for 0, infinities and NaN. */
function binary(x: number): { m: bigint, e: number } | null {
  if (!Number.isFinite(x) || x === 0) return null
  view.setFloat64(0, Math.abs(x))
  const hi = view.getUint32(0)
  const lo = view.getUint32(4)
  const exp = (hi >>> 20) & 0x7ff
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo)
  if (exp) m |= 1n << 52n
  return { m, e: (exp || 1) - 1075 }
}

/** The digit string of |x| * 10**digits when that is an exact half (n + 0.5), else null. */
function exactHalf(x: number, digits: number): bigint | null {
  const b = binary(x)
  if (!b || b.e >= 0) return null
  // |x| * 10**(digits+1) = m * 10**(digits+1) / 2**(-e): an integer ending in 5 is a tie
  const num = b.m * 10n ** BigInt(digits + 1)
  const den = 1n << BigInt(-b.e)
  if (num % den !== 0n) return null
  const n = num / den
  return n % 10n === 5n ? n / 10n : null
}

/** f"{x:.{digits}f}" */
export function pyFixed(x: number, digits: number): string {
  if (Object.is(x, -0)) return '-' + (0).toFixed(digits)
  const text = x.toFixed(digits)
  const tie = exactHalf(x, digits)
  if (tie === null || tie % 2n !== 0n) return text   // no tie, or toFixed's away-from-zero is even
  // the tie rounds down to the even neighbor: |x| truncated at ``digits``
  const s = tie.toString().padStart(digits + 1, '0')
  const body = digits ? `${s.slice(0, -digits)}.${s.slice(-digits)}` : s
  return (x < 0 ? '-' : '') + body
}

/** round(x, digits) as a number. */
export function pyRoundTo(x: number, digits: number): number {
  return Number(pyFixed(x, digits))
}

/** round(x): the nearest integer, ties to even. */
export function pyRound(x: number): number {
  const f = Math.floor(x)
  const d = x - f
  if (d > 0.5) return f + 1
  if (d < 0.5) return f
  return f % 2 === 0 ? f : f + 1
}
