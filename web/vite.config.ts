/// <reference types="vitest/config" />
// The Floodplain Reconnection Decision Tool's build, dev server and tests.
//
// GitHub Pages serves the built app (web/dist) at https://usace-wrises.github.io/floodplain-reconnection/,
// deployed by .github/workflows/pages.yml. The page (index.html) gets its stylesheets written in by
// site.ts; page/ is the public folder, the files the page serves as they are.
//
// In development `/data/...` serves a local copy of the data folder the deployed app reads from the
// Hugging Face dataset (FPR_DATA: the folder that holds `floodplain-reconnection/`), with HTTP range
// support. `/staf-data/...` likewise serves a local copy of STAF's browser data (FPR_STAF_DATA), for the
// stored cross-sections. Neither has a default: the paths are this computer's, never the repository's.
import { createReadStream, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { normalize, resolve, sep } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { PAGE, fprSite } from './site.ts'

/** The path the built app is served under. */
export const SITE_PATH = '/floodplain-reconnection/'

/** A folder served with range reads (dev server and preview only). */
function folder(dir: string | undefined) {
  const root = dir ? resolve(dir) : null
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    if (!root) {
      next()
      return
    }
    const rel = decodeURIComponent((req.url ?? '/').split('?')[0])
    const path = normalize(resolve(root, '.' + rel))
    if (path !== root && !path.startsWith(root + sep)) {
      res.statusCode = 403
      res.end()
      return
    }
    let size: number
    try {
      const st = statSync(path)
      if (!st.isFile()) throw new Error('not a file')
      size = st.size
    } catch {
      next()
      return
    }
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Access-Control-Allow-Origin', '*')
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
    if (range) {
      const start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1])
      const end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), size - 1) : size - 1
      if (start > end || start >= size) {
        res.statusCode = 416
        res.setHeader('Content-Range', `bytes */${size}`)
        res.end()
        return
      }
      res.statusCode = 206
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
      res.setHeader('Content-Length', String(end - start + 1))
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      createReadStream(path, { start, end }).pipe(res)
      return
    }
    res.statusCode = 200
    res.setHeader('Content-Length', String(size))
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(path).pipe(res)
  }
}

function localData(): Plugin {
  const data = folder(process.env.FPR_DATA)
  const staf = folder(process.env.FPR_STAF_DATA)
  return {
    name: 'fpr-local-data',
    configureServer(server) {
      server.middlewares.use('/data', data)
      server.middlewares.use('/staf-data', staf)
    },
    configurePreviewServer(server) {
      server.middlewares.use('/data', data)
      server.middlewares.use('/staf-data', staf)
    },
  }
}

export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? SITE_PATH : '/',
  publicDir: PAGE,
  plugins: [localData(), fprSite()],
  server: { port: 5200, strictPort: true },
  preview: { port: 5201, strictPort: true },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 60_000 },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/chunk-[hash].js',
        assetFileNames: 'assets/asset-[hash][extname]',
      },
    },
  },
}))
