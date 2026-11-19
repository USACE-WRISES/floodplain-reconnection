// Text and bytes for the downloads.

const encoder = new TextEncoder()

/** A text as UTF-8 bytes. */
export function utf8(text: string): Uint8Array {
  return encoder.encode(text)
}

/** Bytes as base64 (the capture mode's copies of each file). */
export function base64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
