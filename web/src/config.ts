// Where the data comes from. The deployed app reads the reach layer from its folder of the Hugging
// Face dataset (`floodplain-reconnection/`, built by data/ in this repository) and STAF's stored
// cross-sections from the same dataset's root (STAF's browser layout). In development the Vite server
// serves local copies at /data and /staf-data (vite.config.ts). `?data=<url>` and `?staf=<url>`
// point a page at other copies.

const HUB = 'https://huggingface.co/datasets/gtmenichino/staf-data/resolve/main/'
/** The reach layer's folder in the dataset. */
export const DATA_FOLDER = 'floodplain-reconnection/'

function slash(u: string): string {
  return u.endsWith('/') ? u : u + '/'
}

/** The reach layer's base address. */
export function dataBase(params: URLSearchParams = new URLSearchParams(location.search)): string {
  const given = params.get('data')
  if (given) return slash(new URL(given, location.href).href)
  return import.meta.env.DEV ? `${location.origin}/data/${DATA_FOLDER}` : HUB + DATA_FOLDER
}

/** STAF's browser layout (its `web-index.json.gz` at this address), for the stored cross-sections. */
export function stafBase(params: URLSearchParams = new URLSearchParams(location.search)): string {
  const given = params.get('staf')
  if (given) return slash(new URL(given, location.href).href)
  return import.meta.env.DEV ? `${location.origin}/staf-data/` : HUB
}
