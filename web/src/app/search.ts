// Place search (Photon, as STAF's web app uses): a type-ahead under the box, US places only; or a
// typed "lat, lon".
import { esc } from './html'

export interface Place { name: string, meta: string, lat: number, lon: number, zoom: number }

const PHOTON = 'https://photon.komoot.io/api/'

function placeOf(f: any): Place | null {
  const p = f?.properties ?? {}
  const c = f?.geometry?.coordinates
  if (!Array.isArray(c) || p.countrycode !== 'US') return null
  const name = p.name ?? p.street ?? p.city ?? 'Place'
  const meta = [p.city !== name ? p.city : '', p.county, p.state].filter(Boolean).join(', ')
  const kind = String(p.osm_value ?? '')
  const zoom = ['state', 'county'].includes(kind) ? 8 : ['city', 'town'].includes(kind) ? 12 : ['river', 'stream'].includes(kind) ? 12 : 14
  return { name, meta, lat: Number(c[1]), lon: Number(c[0]), zoom }
}

/** "lat, lon" typed into the box. */
export function coordinates(text: string): Place | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text)
  if (!m) return null
  const lat = Number(m[1])
  const lon = Number(m[2])
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  return { name: `${lat}, ${lon}`, meta: 'Coordinates', lat, lon, zoom: 14 }
}

/** Wires a search box: `input` and the menu under it; `pick` moves the map. */
export function wireSearch(input: HTMLInputElement, menu: HTMLElement, pick: (p: Place) => void): void {
  let timer = 0
  let seq = 0
  let places: Place[] = []
  let at = -1
  const close = () => {
    menu.hidden = true
    menu.innerHTML = ''
    at = -1
  }
  const show = () => {
    if (!places.length) {
      close()
      return
    }
    menu.innerHTML = places.map((p, i) => `<div class="fpr-ac-item${i === at ? ' on' : ''}" data-i="${i}" role="option">
      <span class="fpr-ac-name">${esc(p.name)}</span><span class="fpr-ac-meta">${esc(p.meta)}</span></div>`).join('')
    menu.hidden = false
  }
  const choose = (p: Place) => {
    close()
    input.value = p.name
    pick(p)
  }
  input.addEventListener('input', () => {
    clearTimeout(timer)
    const q = input.value.trim()
    const c = coordinates(q)
    if (c) {
      places = [c]
      show()
      return
    }
    if (q.length < 3) {
      close()
      return
    }
    timer = window.setTimeout(async () => {
      const mine = ++seq
      try {
        const url = `${PHOTON}?q=${encodeURIComponent(q)}&limit=6&lang=en&lat=38.5&lon=-95.5`
        const res = await fetch(url)
        const data = await res.json()
        if (mine !== seq) return
        places = (data.features ?? []).map(placeOf).filter(Boolean) as Place[]
        at = -1
        show()
      } catch {
        if (mine === seq) close()
      }
    }, 250)
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && places.length) {
      at = Math.min(places.length - 1, at + 1)
      show()
      e.preventDefault()
    } else if (e.key === 'ArrowUp' && places.length) {
      at = Math.max(0, at - 1)
      show()
      e.preventDefault()
    } else if (e.key === 'Enter') {
      const p = places[at >= 0 ? at : 0] ?? coordinates(input.value)
      if (p) choose(p)
      e.preventDefault()
    } else if (e.key === 'Escape') close()
  })
  menu.addEventListener('mousedown', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('.fpr-ac-item')
    if (!item) return
    e.preventDefault()
    choose(places[Number(item.dataset.i)])
  })
  input.addEventListener('blur', () => setTimeout(close, 150))
}
