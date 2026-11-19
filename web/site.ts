// The page as the website serves it: its stylesheets written into index.html, each url() in them made
// relative to the page with a ?v= content hash. Adapted from CEICA's site.ts (itself from STAF's).
//
// The stylesheets are written into the page, not linked: under the USACE network's browser isolation
// (DISA CBII) a linked stylesheet did not apply in STAF's web app (2026-10-12), and the map came up
// without its controls. Bootstrap's import of font.css is replaced by font.css itself. Everything the
// page serves as is lives in page/ (Vite's public folder).
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

/** The page's own files (Vite's public folder). */
export const PAGE = fileURLToPath(new URL('./page', import.meta.url))

/** The first 10 hex digits of a page file's sha256: its ?v= */
export function contentHash(path: string): string {
  return createHash('sha256').update(readFileSync(resolve(PAGE, path))).digest('hex').slice(0, 10)
}

function url(path: string): string {
  return `${path}?v=${contentHash(path)}`
}

/** The stylesheets written into the page, in order (shiny/font.css comes in with Bootstrap). */
export const STYLES = ['shiny/bootstrap.min.css', 'leaflet/leaflet.css', 'fpr.css'] as const

/** A CSS url(), quoted either way or bare */
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s]+))\s*\)/g
/** What filters on managed networks treat as attacks */
const IE_HOOKS = /behavior\s*:\s*url|expression\s*\(|progid\s*:/i

/** A sheet's relative url()s made relative to the page, with the file's ?v= where the page has it. */
export function rebase(css: string, folder: string): string {
  return css.replace(CSS_URL, (all: string, dq?: string, sq?: string, bare?: string) => {
    const ref = dq ?? sq ?? bare ?? ''
    if (/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(ref)) return all
    const cut = ref.search(/[?#]/)
    const path = posix.normalize(folder + (cut < 0 ? ref : ref.slice(0, cut)))
    const rest = cut < 0 ? '' : ref.slice(cut)
    const target = !rest && existsSync(resolve(PAGE, path)) ? url(path) : path + rest
    return `url("${target}")`
  })
}

/** A stylesheet as a style element (font.css written in where Bootstrap imports it). */
export function inlineSheet(path: string): string {
  let css = readFileSync(resolve(PAGE, path), 'utf-8')
  if (path === 'shiny/bootstrap.min.css') {
    const parts = css.split('@import url("font.css");')
    if (parts.length !== 2) throw new Error('Bootstrap should import font.css once')
    css = parts.join(readFileSync(resolve(PAGE, 'shiny/font.css'), 'utf-8'))
  }
  if (/<\/style/i.test(css)) throw new Error(`${path} would end its style element`)
  if (IE_HOOKS.test(css)) throw new Error(`${path} holds an IE hook`)
  const folder = posix.dirname(path) === '.' ? '' : `${posix.dirname(path)}/`
  return `<style data-fpr-src="${path}">${rebase(css, folder)}</style>`
}

/** The head's written-in part. */
export function head(): string[] {
  return [
    ...STYLES.map(inlineSheet),
    `<link rel="icon" href="${url('favicon.svg')}" type="image/svg+xml"/>`,
  ]
}

export function fprSite(): Plugin {
  return {
    name: 'fpr-site',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (!ctx.filename.endsWith('index.html')) return html
        return html.replace('<!--fpr:head-->', head().join('\n    '))
      },
    },
  }
}
