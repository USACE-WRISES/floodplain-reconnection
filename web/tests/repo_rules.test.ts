// The repository's own rules (CONTRIBUTING.md), after CEICA's: the copy rules over every file people
// read (no em or en dashes, US spelling), the changelog and the version moving together, the page
// loading its styles and fonts from itself, this app's own names for what it keeps in the browser
// (the origin is shared with other apps), and the public repo's hygiene: no AI tool named, no email
// address or machine path, the local-only files untracked. The words it looks for are put together
// from pieces, so this file never matches itself.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { head } from '../site'

const WEB = fileURLToPath(new URL('..', import.meta.url))
const REPO = fileURLToPath(new URL('../..', import.meta.url))
const SELF = fileURLToPath(import.meta.url)
const DASHES = [String.fromCharCode(0x2014), String.fromCharCode(0x2013)]
const piece = (...parts: string[]): string => parts.join('')
const SKIP = new Set(['.git', 'node_modules', 'dist', '__pycache__', '.pytest_cache', '.venv', 'notes', '.claude', 'fixtures'])
const tool = piece('cla', 'ude')
const LOCAL_ONLY = ['notes/', `.${tool}/`, `${tool.toUpperCase()}.md`, piece('AGENTS', '.md')]

const rel = (p: string): string => relative(REPO, p).split('\\').join('/')

function walk(exts: readonly string[], dir = REPO): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return SKIP.has(e.name) ? [] : walk(exts, join(dir, e.name))
    return e.isFile() && exts.includes(extname(e.name).toLowerCase()) ? [join(dir, e.name)] : []
  })
}

describe('copy rules', () => {
  it('no em or en dashes in the app, its pages or its documents', () => {
    const bad = walk(['.ts', '.js', '.css', '.html', '.md', '.py', '.yml', '.cff', '.txt'])
      .filter((p) => !p.includes(`${join('page', 'shiny')}`) && !p.includes(`${join('page', 'leaflet')}`) && !p.endsWith('licenses.txt'))
      .filter((p) => !p.endsWith('THIRD_PARTY_NOTICES.md') && !p.includes(join('page', 'fonts')))
      .filter((p) => DASHES.some((d) => readFileSync(p, 'utf-8').includes(d))).map(rel)
    expect(bad).toEqual([])
  })

  it('US spelling', () => {
    const british = new RegExp(`\\b(${[piece('col', 'our\\w*'), piece('behavi', 'our\\w*'), piece('fav', 'our\\w*'),
      piece('analy', 's(e|ed|es|ing)'), piece('organ', 'is(e|ed|es|ing|ation)\\w*'), piece('cen', 'tre\\w*'),
      piece('model', 'ling'), piece('label', 'led'), piece('cancel', 'led'), piece('travel', 'led'), piece('program', 'mes?'),
      piece('lic', 'ence\\w*'), piece('catal', 'ogue\\w*'), piece('summar', 'is\\w*'), piece('priorit', 'is\\w*'),
      piece('normal', 'is\\w*'), piece('visual', 'is\\w*')].join('|')})\\b`, 'i')
    const hits: string[] = []
    for (const p of walk(['.ts', '.css', '.md', '.html', '.py', '.cff', '.yml'])) {
      if (p === SELF || p.includes(join('page', 'shiny')) || p.includes(join('page', 'leaflet'))) continue
      readFileSync(p, 'utf-8').split('\n').forEach((line, i) => {
        const m = british.exec(line)
        if (m) hits.push(`${rel(p)}:${i + 1}: ${m[0]}`)
      })
    }
    expect(hits).toEqual([])
  })
})

describe('the changelog and the version move together', () => {
  const changelog = readFileSync(join(REPO, 'CHANGELOG.md'), 'utf-8')
  const sections = [...changelog.matchAll(/^## v(\d+\.\d+\.\d+) \((\d{4}-\d{2}-\d{2})\)$/gm)].map((m) => ({ version: m[1], date: m[2] }))
  const top = sections[0]
  const versionTs = readFileSync(join(WEB, 'src', 'version.ts'), 'utf-8')
  it('sections are well formed, each bullet one line of at most 80 characters', () => {
    expect(changelog.startsWith('# Changelog\n')).toBe(true)
    expect(sections.length).toBeGreaterThan(0)
    for (const line of changelog.split('\n')) {
      if (line.startsWith('- ')) expect(line.length - 2, line).toBeLessThanOrEqual(80)
      else if (line.trim()) expect(line.startsWith('#'), `prose or a wrapped bullet: ${line}`).toBe(true)
    }
  })
  it('the top section is the version in version.ts, package.json and its lock, and CITATION.cff', () => {
    expect(/APP_VERSION = '([^']*)'/.exec(versionTs)?.[1]).toBe(top.version)
    const pkg = JSON.parse(readFileSync(join(WEB, 'package.json'), 'utf-8')) as { version: string }
    expect(pkg.version).toBe(top.version)
    const lock = JSON.parse(readFileSync(join(WEB, 'package-lock.json'), 'utf-8')) as { version: string, packages: Record<string, { version?: string }> }
    expect([lock.version, lock.packages[''].version]).toEqual([top.version, top.version])
    const cff = readFileSync(join(REPO, 'CITATION.cff'), 'utf-8')
    expect(cff).toMatch(new RegExp(`^version: ${top.version.replace(/\./g, '\\.')}$`, 'm'))
    expect(cff).toContain(`date-released: ${top.date}`)
  })
})

describe('the page', () => {
  const page = join(WEB, 'page')
  it('writes its stylesheets in (no linked stylesheet: USACE browser isolation)', () => {
    const h = head().join('\n')
    expect(h).not.toMatch(/<link[^>]+stylesheet/i)
    expect((h.match(/<style data-fpr-src=/g) ?? []).length).toBe(3)
    expect(h).not.toContain('@import')
  })
  it("every stylesheet's url() is a file of the page", () => {
    const bad: string[] = []
    for (const css of ['fpr.css', 'shiny/bootstrap.min.css', 'shiny/font.css', 'leaflet/leaflet.css']) {
      const path = join(page, css)
      for (const m of readFileSync(path, 'utf-8').matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
        const u = m[1]
        if (u.startsWith('data:') || u.startsWith('#') || u.includes('glyphicons')) continue
        if (/^[a-z]+:|^\/\//i.test(u) || u.startsWith('/') || !existsSync(resolve(dirname(path), u.split(/[?#]/)[0]))) bad.push(`${css}: ${u}`)
      }
    }
    expect(bad).toEqual([])
  })
  it('the fonts are WOFF2 files, with their licenses in the notices', () => {
    const fonts = walk(['.woff2'], page)
    expect(fonts.length).toBeGreaterThan(0)
    for (const f of fonts) expect(readFileSync(f).subarray(0, 4).toString('latin1'), rel(f)).toBe('wOF2')
    const notices = readFileSync(join(page, 'licenses.txt'), 'utf-8')
    for (const name of ['Open Sans', 'Source Code Pro', 'Instrument Sans', 'Space Grotesk', 'Leaflet', 'Bootstrap', 'hyparquet', 'zstddec',
      'geotiff', 'float16', 'lerc', 'pako', 'parse-headers', 'quick-lru', 'xml-utils', 'SIL OPEN FONT LICENSE']) expect(notices).toContain(name)
    const md = readFileSync(join(REPO, 'THIRD_PARTY_NOTICES.md'), 'utf-8')
    expect(/```text\n([\s\S]*?)```/.exec(md)?.[1]).toBe(notices)
  })
  it("keeps this app's own names in the browser (the origin is shared)", () => {
    const files = [...walk(['.ts'], join(WEB, 'src')), join(page, 'download-sw.js')]
    const other = new RegExp(`['"\`](${piece('st', 'af')}|${piece('ce', 'ica')})-[a-z]`)
    const bad = files.filter((p) => other.test(readFileSync(p, 'utf-8'))).map(rel)
    expect(bad).toEqual([])
  })
})

function git(args: string[]): string | null {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf-8', maxBuffer: 1 << 28 })
  return r.status === 0 ? r.stdout : null
}

const inGit = git(['rev-parse', '--is-inside-work-tree'])?.trim() === 'true'
const BINARY = new Set(['.png', '.ico', '.woff2', '.pdf', '.parquet', '.gz', '.tif'])

describe.skipIf(!inGit)('the public repository', () => {
  const files = (git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']) ?? '').split('\0').filter(Boolean)
  const texts: [string, string][] = files
    .filter((p) => !LOCAL_ONLY.some((l) => p === l || p.startsWith(l)) && !BINARY.has(extname(p).toLowerCase()))
    .map((p) => join(REPO, p)).filter((p) => existsSync(p) && p !== SELF).map((p) => [rel(p), readFileSync(p, 'utf-8')])
  const AI = [tool, piece('anthro', 'pic'), piece('chat', 'gpt'), piece('open', 'ai'), piece('co', 'pilot'),
    piece('co', 'dex'), piece('gem', 'ini'), piece('co-author', 'ed-by'), piece('agents', '.md')]
  it('no file names an AI tool or vendor', () => {
    const hits = texts.flatMap(([path, text]) => AI.filter((n) => text.toLowerCase().includes(n)).map((n) => `${path}: ${n}`))
    expect(hits).toEqual([])
  })
  it('no commit message names one, and the local files are not tracked', () => {
    const messages = (git(['log', '--format=%B%x00']) ?? '').split('\0')
    const hits = messages.flatMap((m) => AI.filter((n) => m.toLowerCase().includes(n)).map((n) => `${n}: ${m.trim().split('\n')[0]}`))
    expect(hits).toEqual([])
    const tracked = (git(['ls-files', '-z']) ?? '').split('\0').filter(Boolean)
    expect(tracked.filter((p) => LOCAL_ONLY.some((l) => p === l || p.startsWith(l)))).toEqual([])
  })
  it("no email address, and no path on a person's machine", () => {
    const email = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}(?![A-Za-z0-9-])/
    const machine = new RegExp(`${piece('C', ':')}[\\\\/]+${piece('Us', 'ers')}\\b|${piece('D', ':')}[\\\\/]+(${piece('Co', 'de')}|${piece('Da', 'ta')})\\b`, 'i')
    const hits = texts.flatMap(([path, text]) => [text.includes('@') ? email.exec(text)?.[0] : undefined, machine.exec(text)?.[0]]
      .filter((x): x is string => x !== undefined).map((x) => `${path}: ${x}`))
    expect(hits).toEqual([])
  })
})
