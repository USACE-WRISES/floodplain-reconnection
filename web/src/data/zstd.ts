// Zstandard for the data's files: zstddec (WebAssembly) once it has started, ten to twenty times faster
// than the pure-JS fzstd hyparquet-compressors carries, which answers until then. Both give the same
// bytes. Copied from STAF's web app (apps/staf-web/src/data/zstd.ts); the reach files and STAF's stored
// cross-sections are Zstandard only, so the other codecs stay out of the bundle.
import { decompressZstd } from 'hyparquet-compressors'
import { ZSTDDecoder } from 'zstddec'

let decoder: ZSTDDecoder | null = null
let starting: Promise<void> | null = null

/** Starts the WebAssembly decoder (once); reads wait for it, and a failure leaves fzstd answering. */
export function zstdReady(): Promise<void> {
  starting ??= (async () => {
    const d = new ZSTDDecoder()
    await d.init()
    decoder = d
  })().catch(() => {})
  return starting
}

/** Decompress a zstd frame of known size. */
export function zstd(input: Uint8Array, outputLength: number): Uint8Array {
  if (decoder) return decoder.decode(input, outputLength)
  return decompressZstd(input, new Uint8Array(outputLength))
}

/** The codec hyparquet needs here (it decodes Snappy and uncompressed pages itself). */
export const compressors = { ZSTD: zstd }
