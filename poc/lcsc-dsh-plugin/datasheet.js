/**
 * dsh-plugin-lcsc — LCSC datasheet (数据手册) resolver and downloader.
 *
 * The public datasheet PDF for an LCSC part is reachable through several
 * different URL shapes, depending on where the link came from:
 *
 *   - JLCPCB SMT API `dataManualUrl` may point at
 *       * https://www.lcsc.com/datasheet/lcsc_datasheet_<stamp>_<brand>-<model>_C1234.pdf
 *         → an HTML *viewer* page (Next.js). The real PDF sits in its
 *           `__NEXT_DATA__.props.pageProps.previewPdfUrl`.
 *       * https://wmsc.lcsc.com/wmsc/upload/file/pdf/v2/lcsc/<...>.pdf
 *         → a 142-byte JS redirect to https://datasheet.lcsc.com/...
 *       * https://datasheet.lcsc.com/datasheet/pdf/<hash>.pdf?productCode=C1234
 *         → the PDF itself.
 *       * https://jlcpcb.com/api/file/downloadByFileSystemAccessId/<id>
 *         → can answer `{"code":203,...}` instead of a PDF (link rot).
 *   - The LCSC international product page exposes
 *       `__NEXT_DATA__.props.pageProps.webData.pdfUrl`
 *     which is the canonical direct `datasheet.lcsc.com` PDF URL.
 *   - The domestic store (item.szlcsc.com) product page embeds a
 *       https://atta.szlcsc.com/upload/public/pdf/source/<date>/<hash>.pdf
 *     link. It is only needed for parts that have no international page.
 *
 * This module therefore treats every candidate as "fetch it and look at the
 * bytes": a PDF is accepted immediately, an HTML/JS wrapper is scanned for the
 * next hop (bounded depth), and a non-PDF answer moves on to the next source.
 * No invented URL is ever requested and no PDF bytes are returned to the model;
 * the file is written to disk and only its path/size/hash are reported.
 *
 * Zero dependencies, Node >= 20 (global fetch + Buffer).
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { normalizeCode, parseNextData } from './data.js'

/** Defaults for one datasheet download; overridable through plugin config. */
export const DEFAULT_DATASHEET_OPTIONS = Object.freeze({
  timeoutMs: 60000,
  maxBytes: 64 * 1024 * 1024,
  htmlMaxBytes: 8 * 1024 * 1024,
  maxHops: 3,
  domesticFallback: true,
})

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const PDF_HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
}

const HTML_HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
}

const CN_HTML_HEADERS = {
  ...HTML_HEADERS,
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
}

const LCSC_PRODUCT_URL = 'https://www.lcsc.com/product-detail/'
const SZLCSC_ITEM_URL = 'https://item.szlcsc.com/'
const DATASHEET_CDN_HOST = 'datasheet.lcsc.com'
const SZLCSC_CDN_HOST = 'atta.szlcsc.com'
const PDF_CDN_HOSTS = new Set([DATASHEET_CDN_HOST, SZLCSC_CDN_HOST])

/** Windows-forbidden file name characters plus control characters. */
const INVALID_FILENAME_CHARS = /[\u0000-\u001f<>:"/\\|?*]/g
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} value @returns {string | undefined} */
function asString(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text === '' ? undefined : text
}

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Human-readable byte size. @param {number} bytes @returns {string} */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/**
 * True when `buffer` starts like a PDF. The spec allows a small amount of
 * leading junk, but every real LCSC/JLC/atta file starts with `%PDF-`.
 * @param {Buffer} buffer
 */
export function isPdfBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5) return false
  const head = buffer.subarray(0, Math.min(buffer.length, 1024))
  return head.includes('%PDF-')
}

/**
 * Sanitize one file-stem/name for the local filesystem. Keeps unicode letters
 * (Chinese model names exist) but removes path separators, control characters
 * and the characters Windows rejects; appends no extension.
 * @param {unknown} input
 * @param {string} fallback
 * @returns {string}
 */
export function sanitizeFilename(input, fallback = 'datasheet') {
  let text = asString(input) ?? fallback
  text = text.replace(INVALID_FILENAME_CHARS, '_')
  text = text.replace(/^[. ]+/, '').replace(/[. ]+$/g, '')
  if (text === '' || text === '.' || text === '..') text = fallback
  if (WINDOWS_RESERVED_NAMES.test(text)) text = `_${text}`
  if (text.length > 120) {
    const extension = path.extname(text).slice(0, 10)
    text = `${text.slice(0, 120 - extension.length)}${extension}`
  }
  return text
}

/**
 * Filename for one part: `<code>_<model>.pdf`, or `<code>.pdf` without a model.
 * @param {string} code
 * @param {unknown} model
 * @returns {string}
 */
export function datasheetFilename(code, model) {
  const modelText = asString(model)
  const stem = modelText === undefined ? code : `${code}_${modelText}`
  return sanitizeFilename(`${stem}.pdf`, `${code}.pdf`)
}

/**
 * Ensure a caller-provided file name is a plain `*.pdf` basename.
 * Returns `{ ok: true, name }` or `{ ok: false, error }`.
 * @param {unknown} input
 * @returns {{ ok: true, name: string } | { ok: false, error: string }}
 */
export function normalizePdfFilename(input) {
  const text = asString(input)
  if (text === undefined) return { ok: false, error: 'filename must be a non-empty string' }
  if (text.includes('/') || text.includes('\\') || text === '.' || text === '..') {
    return { ok: false, error: 'filename must be a bare file name (no directory separators)' }
  }
  const withExtension = /\.pdf$/i.test(text) ? text : `${text}.pdf`
  const safe = sanitizeFilename(withExtension, 'datasheet.pdf')
  if (!/\.pdf$/i.test(safe)) return { ok: false, error: 'filename must end with .pdf' }
  return { ok: true, name: safe }
}

/**
 * Resolve (and create) the directory that will receive the PDF.
 * `~` expands to the user's home; a relative path resolves against the DSH
 * session cwd when the Host provides one, otherwise against `process.cwd()`.
 * @param {unknown} outDir
 * @param {{ sessionCwd?: string }} [options]
 * @returns {string} absolute directory path
 */
export function resolveOutDir(outDir, options = {}) {
  const raw = asString(outDir)
  if (raw === undefined) throw new Error('out_dir is required (absolute directory path)')
  let expanded = raw
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    expanded = path.join(os.homedir(), raw === '~' ? '' : raw.slice(2))
  }
  const base = asString(options.sessionCwd) ?? process.cwd()
  const absolute = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(base, expanded)
  fs.mkdirSync(absolute, { recursive: true })
  const stat = fs.statSync(absolute)
  if (!stat.isDirectory()) throw new Error(`out_dir is not a directory: ${absolute}`)
  return absolute
}

/**
 * Classify a datasheet/PDF URL by the site that serves it.
 * @param {unknown} url
 * @returns {'lcsc.com' | 'szlcsc.com' | 'jlcpcb.com' | 'other'}
 */
export function sourceOfUrl(url) {
  const text = asString(url)
  if (text === undefined) return 'other'
  let host
  try {
    host = new URL(text).hostname.toLowerCase()
  } catch {
    return 'other'
  }
  if (host === SZLCSC_CDN_HOST || host.endsWith('.szlcsc.com') || host === 'szlcsc.com') return 'szlcsc.com'
  if (host === 'jlcpcb.com' || host.endsWith('.jlcpcb.com')) return 'jlcpcb.com'
  if (host === 'lcsc.com' || host.endsWith('.lcsc.com')) return 'lcsc.com'
  return 'other'
}

/**
 * Decode the JSON / HTML escaping used inside Next.js payloads and JS
 * redirects (`\/`, `\u0026`, `&amp;`).
 * @param {string} text
 * @returns {string}
 */
function decodeEmbedded(text) {
  return text
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\u002f/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .replace(/&#38;/g, '&')
}

/**
 * Turn a possibly-relative / escaped link into an absolute http(s) URL.
 * @param {unknown} link
 * @param {string} [baseUrl]
 * @returns {string | undefined}
 */
function absoluteUrl(link, baseUrl) {
  const text = asString(link)
  if (text === undefined) return undefined
  const decoded = decodeEmbedded(text)
  if (!/^https?:\/\//i.test(decoded)) return undefined
  try {
    return new URL(decoded, baseUrl).toString()
  } catch {
    return undefined
  }
}

/**
 * Extract the next PDF hop from a viewer page, a JS redirect, a meta refresh or
 * a product page. Returns the first *strong* match (previewPdfUrl or a known CDN
 * PDF) before falling back to generic `.pdf` links.
 * @param {string} html
 * @param {string} [baseUrl]
 * @returns {{ url: string, via: string } | undefined}
 */
export function extractPdfLink(html, baseUrl) {
  const text = typeof html === 'string' ? html : ''
  if (text === '') return undefined

  /** @param {RegExp} pattern @param {string} via */
  const find = (pattern, via) => {
    const match = text.match(pattern)
    if (match === null) return undefined
    const url = absoluteUrl(match[1], baseUrl)
    return url === undefined ? undefined : { url, via }
  }

  // 1. LCSC datasheet viewer (Next.js): the canonical direct PDF.
  const preview = text.match(/"previewPdfUrl"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  if (preview !== null) {
    let decoded
    try {
      decoded = JSON.parse(`"${preview[1]}"`)
    } catch {
      decoded = preview[1]
    }
    const url = absoluteUrl(decoded, baseUrl)
    if (url !== undefined) return { url, via: 'viewer-preview' }
  }

  // 2. Known CDN hosts embedded anywhere in the page (datasheet / atta).
  const cdn = text.match(/(https?:\/\/(?:datasheet\.lcsc\.com|atta\.szlcsc\.com)\/[^"'\s<>]+?\.pdf[^"'\s<>]*)/i)
  if (cdn !== null) {
    const url = absoluteUrl(cdn[1], baseUrl)
    if (url !== undefined) return { url, via: 'cdn-link' }
  }

  // 3. wmsc.lcsc.com / other JS redirects (`window.top.location.href='…'`).
  const redirect =
    text.match(/(?:window\.)?(?:top\.)?location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i) ??
    text.match(/location\.replace\(\s*['"]([^'"]+)['"]\s*\)/i)
  if (redirect !== null) {
    const url = absoluteUrl(redirect[1], baseUrl)
    if (url !== undefined) return { url, via: 'js-redirect' }
  }

  // 4. Meta refresh (`<meta http-equiv="refresh" content="0;url=…">`).
  const meta = text.match(/http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"'>\s]+)/i)
  if (meta !== null) {
    const url = absoluteUrl(meta[1], baseUrl)
    if (url !== undefined) return { url, via: 'meta-refresh' }
  }

  // 5. PDF.js viewer wrapper.
  const pdfjs = text.match(/viewer\.html\?file=([^"'&\s]+)/i)
  if (pdfjs !== null) {
    let decoded
    try {
      decoded = decodeURIComponent(pdfjs[1])
    } catch {
      decoded = pdfjs[1]
    }
    const url = absoluteUrl(decoded, baseUrl)
    if (url !== undefined) return { url, via: 'pdfjs-viewer' }
  }

  // 6. Generic structured `pdfUrl` field (product pages, other JSON APIs).
  const jsonUrl = find(/"pdfUrl"\s*:\s*"((?:[^"\\]|\\.)*)"/, 'json-pdf-url')
  if (jsonUrl !== undefined) return jsonUrl

  // 7. Last resort: any absolute .pdf link on the page.
  const anyPdf = text.match(/(https?:\/\/[^"'\s<>]+?\.pdf(?:\?[^"'\s<>]*)?)/i)
  if (anyPdf !== null) {
    const url = absoluteUrl(anyPdf[1], baseUrl)
    if (url !== undefined) return { url, via: 'page-link' }
  }

  return undefined
}

/**
 * `fetch` with a timeout fused to the caller's abort signal and a hard byte cap.
 * Returns `{ ok, bytes, contentType, finalUrl, status }` or a failure object;
 * it never throws for HTTP/network problems (only for caller cancellation).
 * @param {string} url
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   headers?: Record<string, string>,
 *   timeoutMs: number,
 *   maxBytes: number,
 *   signal?: AbortSignal,
 * }} options
 * @returns {Promise<{
 *   ok: boolean, status?: number, bytes?: Buffer, contentType?: string,
 *   finalUrl?: string, error?: string, tooLarge?: boolean,
 * }>}
 */
export async function fetchBytes(url, options) {
  const { fetchImpl = globalThis.fetch, headers = PDF_HEADERS, timeoutMs, maxBytes, signal } = options
  if (typeof fetchImpl !== 'function') throw new Error('global fetch is unavailable: run on Node >= 20')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs} ms`)), timeoutMs)
  const attemptSignal = signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal])
  try {
    const response = await fetchImpl(url, { headers, redirect: 'follow', signal: attemptSignal })
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
    const declared = Number(response.headers.get('content-length') ?? NaN)
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, status: response.status, error: `file too large (${formatBytes(declared)} > cap ${formatBytes(maxBytes)})`, tooLarge: true }
    }
    /** @type {Buffer[]} */
    const chunks = []
    let total = 0
    if (response.body !== null && typeof response.body?.getReader === 'function') {
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value === undefined) continue
        total += value.byteLength
        if (total > maxBytes) {
          try {
            await reader.cancel()
          } catch {
            // already closed
          }
          return { ok: false, status: response.status, error: `file stopped at the ${formatBytes(maxBytes)} cap`, tooLarge: true }
        }
        chunks.push(Buffer.from(value))
      }
    } else {
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length > maxBytes) {
        return { ok: false, status: response.status, error: `file too large (${formatBytes(buffer.length)} > cap ${formatBytes(maxBytes)})`, tooLarge: true }
      }
      chunks.push(buffer)
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `HTTP ${response.status}${response.statusText === '' ? '' : ` ${response.statusText}`}`,
      }
    }
    return {
      ok: true,
      status: response.status,
      bytes: Buffer.concat(chunks),
      contentType,
      finalUrl: response.url === '' ? url : response.url,
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted')
    return { ok: false, error: messageOf(error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Follow one datasheet URL through up to `maxHops` wrappers until PDF bytes are
 * found. Every hop is recorded so the tool can explain where the file came from.
 * @param {string} url
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   timeoutMs: number,
 *   maxBytes: number,
 *   htmlMaxBytes: number,
 *   maxHops: number,
 *   signal?: AbortSignal,
 * }} options
 * @returns {Promise<{
 *   ok: boolean,
 *   bytes?: Buffer,
 *   contentType?: string,
 *   finalUrl: string,
 *   sourceUrl: string,
 *   hops: { url: string, via: string }[],
 *   error?: string,
 * }>}
 */
export async function resolvePdfBytes(url, options) {
  const { fetchImpl, timeoutMs, maxBytes, htmlMaxBytes, maxHops, signal } = options
  /** @type {{ url: string, via: string }[]} */
  const hops = []
  let current = url
  for (let hop = 0; hop <= maxHops; hop += 1) {
    const isLikelyPdf = PDF_CDN_HOSTS.has(safeHost(current)) && /\.pdf(?:$|[?#])/i.test(current)
    const headResult = await fetchBytes(current, {
      fetchImpl,
      headers: isLikelyPdf ? PDF_HEADERS : HTML_HEADERS,
      timeoutMs,
      // A PDF is capped by maxBytes; an HTML wrapper only needs a small slice.
      maxBytes: isLikelyPdf ? maxBytes : Math.max(htmlMaxBytes, 64 * 1024),
      signal,
    })
    if (!headResult.ok) {
      return { ok: false, finalUrl: current, sourceUrl: url, hops, error: headResult.error }
    }
    if (isPdfBuffer(headResult.bytes)) {
      if (headResult.bytes.length > maxBytes) {
        return { ok: false, finalUrl: current, sourceUrl: url, hops, error: `PDF exceeds the ${formatBytes(maxBytes)} cap` }
      }
      return {
        ok: true,
        bytes: headResult.bytes,
        contentType: headResult.contentType,
        finalUrl: current,
        sourceUrl: url,
        hops,
      }
    }
    const html = headResult.bytes.toString('utf8')
    const next = extractPdfLink(html, current)
    if (next === undefined) {
      const snippet = html.replace(/\s+/g, ' ').slice(0, 120)
      return {
        ok: false,
        finalUrl: current,
        sourceUrl: url,
        hops,
        error: `not a PDF and no PDF link found (content-type ${headResult.contentType || 'unknown'}; starts: ${JSON.stringify(snippet)})`,
      }
    }
    if (next.url === current) {
      return { ok: false, finalUrl: current, sourceUrl: url, hops, error: 'PDF link loop detected' }
    }
    hops.push({ url: next.url, via: next.via })
    current = next.url
  }
  return { ok: false, finalUrl: current, sourceUrl: url, hops, error: `PDF wrapper depth exceeded (${maxHops} hops)` }
}

/** @param {string} url @returns {string} */
function safeHost(url) {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * Fetch `https://www.lcsc.com/product-detail/<code>.html` and return its
 * `pageProps.webData` (used only when the long-lived service did not already
 * cache the product page).
 * @param {string} code
 * @param {{ fetchImpl?: typeof fetch, timeoutMs: number, htmlMaxBytes: number, signal?: AbortSignal }} options
 * @returns {Promise<Record<string, unknown> | undefined>}
 */
async function fetchProductWebData(code, options) {
  const url = `${LCSC_PRODUCT_URL}${code}.html`
  const result = await fetchBytes(url, {
    fetchImpl: options.fetchImpl,
    headers: HTML_HEADERS,
    timeoutMs: options.timeoutMs,
    maxBytes: options.htmlMaxBytes,
    signal: options.signal,
  })
  if (!result.ok) throw new Error(result.error ?? 'product page fetch failed')
  const nextData = parseNextData(result.bytes.toString('utf8'))
  const pageProps = isRecord(nextData) && isRecord(nextData.props) && isRecord(nextData.props.pageProps)
    ? nextData.props.pageProps
    : undefined
  const webData = pageProps !== undefined && isRecord(pageProps.webData) ? pageProps.webData : undefined
  return webData
}

/**
 * Domestic-store fallback: C-code → szlcsc product id → product page → atta PDF
 * link. Plain HTTP is tried first; a WAF challenge falls back to the plugin's
 * headless-Chrome adapter when one is available.
 * @param {string} code
 * @param {{
 *   cnAdapter?: Record<string, unknown>,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs: number,
 *   htmlMaxBytes: number,
 *   signal?: AbortSignal,
 * }} options
 * @returns {Promise<{
 *   ok: boolean,
 *   url?: string,
 *   productId?: string,
 *   htmlBytes?: number,
 *   via?: string,
 *   error?: string,
 *   reason?: string,
 * }>}
 */
export async function resolveDomesticPdfUrl(code, options) {
  const { cnAdapter, fetchImpl, timeoutMs, htmlMaxBytes, signal } = options
  if (cnAdapter === undefined || cnAdapter === null) {
    return { ok: false, reason: 'chrome-adapter-unavailable', error: 'domestic fallback skipped: no Chrome adapter' }
  }
  const resolvePid = cnAdapter.resolvePid
  if (typeof resolvePid !== 'function') {
    return { ok: false, reason: 'chrome-adapter-unavailable', error: 'domestic fallback skipped: adapter has no resolvePid()' }
  }
  let productId
  try {
    productId = await resolvePid(code)
  } catch (error) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted')
    return { ok: false, reason: 'product-id-lookup-failed', error: `domestic product id lookup failed: ${messageOf(error)}` }
  }
  if (productId === undefined || productId === null || String(productId) === '') {
    return { ok: false, reason: 'product-id-not-found', error: 'no 立创商城 domestic product id for this code (EasyEDA/lceda data gap)' }
  }
  const pageUrl = `${SZLCSC_ITEM_URL}${productId}.html`
  /** @type {{ url: string, via: string, htmlBytes: number } | undefined} */
  let found

  // 1. Plain HTTP first: usually allowed and much faster than a Chrome render.
  const plain = await fetchBytes(pageUrl, {
    fetchImpl,
    headers: CN_HTML_HEADERS,
    timeoutMs: Math.min(timeoutMs, 30000),
    maxBytes: htmlMaxBytes,
    signal,
  })
  if (plain.ok) {
    const html = plain.bytes.toString('utf8')
    const atta = html.match(/(https?:\/\/atta\.szlcsc\.com\/upload\/public\/pdf\/[^"'\s<>]+?\.pdf)/i)
    if (atta !== null) {
      const url = absoluteUrl(atta[1], pageUrl)
      if (url !== undefined) found = { url, via: 'szlcsc-plain', htmlBytes: plain.bytes.length }
    }
  }

  // 2. WAF challenge (or a page without the link): render with Chrome if possible.
  if (found === undefined && typeof cnAdapter.renderHtml === 'function') {
    try {
      const html = await cnAdapter.renderHtml(pageUrl, Math.max(5000, Math.min(timeoutMs, 45000)))
      if (typeof html === 'string' && html !== '') {
        const atta = html.match(/(https?:\/\/atta\.szlcsc\.com\/upload\/public\/pdf\/[^"'\s<>]+?\.pdf)/i)
        if (atta !== null) {
          const url = absoluteUrl(atta[1], pageUrl)
          if (url !== undefined) found = { url, via: 'szlcsc-chrome', htmlBytes: html.length }
        }
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted')
      return { ok: false, reason: 'chrome-render-failed', error: messageOf(error) }
    }
  }

  if (found === undefined) {
    return {
      ok: false,
      reason: 'szlcsc-pdf-link-not-found',
      productId: String(productId),
      error: `domestic page for product id ${productId} has no atta.szlcsc.com PDF link`,
    }
  }
  return { ok: true, url: found.url, productId: String(productId), via: found.via, htmlBytes: found.htmlBytes }
}

/**
 * Atomic file write in the destination directory (write temp, then rename).
 * @param {string} filePath
 * @param {Buffer} bytes
 */
function writeFileAtomic(filePath, bytes) {
  const directory = path.dirname(filePath)
  const tmp = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)
  fs.writeFileSync(tmp, bytes)
  try {
    fs.renameSync(tmp, filePath)
  } catch (error) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // best effort
    }
    throw error
  }
}

/** @param {Buffer} bytes @returns {string} */
function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

/**
 * Download the datasheet of one LCSC part number into `out_dir`.
 *
 * Never throws for data/network problems — it returns a structured result with
 * `status: 'downloaded' | 'already-exists' | 'not-found' | 'failed'` so the
 * model can decide what to do next. Caller cancellation is propagated.
 *
 * @param {{ lcsc: string, out_dir: string, filename?: string, overwrite?: boolean, domestic_fallback?: boolean }} input
 * @param {{
 *   service?: Record<string, unknown>,
 *   cnAdapter?: Record<string, unknown>,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   maxBytes?: number,
 *   htmlMaxBytes?: number,
 *   maxHops?: number,
 *   domesticFallback?: boolean,
 *   sessionCwd?: string,
 *   signal?: AbortSignal,
 * }} [dependencies]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function downloadLcscDatasheet(input, dependencies = {}) {
  const options = {
    timeoutMs: DEFAULT_DATASHEET_OPTIONS.timeoutMs,
    maxBytes: DEFAULT_DATASHEET_OPTIONS.maxBytes,
    htmlMaxBytes: DEFAULT_DATASHEET_OPTIONS.htmlMaxBytes,
    maxHops: DEFAULT_DATASHEET_OPTIONS.maxHops,
    ...dependencies,
  }
  const domFallbackAllowed = input.domestic_fallback !== false && options.domesticFallback !== false
  const signal = options.signal
  const fetchImpl = options.fetchImpl

  /** @type {{ step: string, url?: string, ok: boolean, source?: string, via?: string, error?: string, status?: number }[]} */
  const attempts = []
  /** @type {string[]} */
  const notes = []
  /** @type {string[]} */
  const hints = []
  /** @type {Record<string, unknown>} */
  const result = {
    status: 'failed',
    lcsc: String(input.lcsc ?? '').trim(),
    out_dir: '',
    attempts,
    notes,
    hints,
    fetched_at: new Date().toISOString(),
  }

  const code = normalizeCode(input.lcsc)
  if (code === undefined) {
    result.status = 'not-found'
    notes.push(`invalid LCSC code ${JSON.stringify(input.lcsc)}: expected C + 4–11 digits, e.g. C1581`)
    hints.push('Use the C-number printed on the LCSC / JLCPCB product page (e.g. C1581), or bare digits (1581).')
    return result
  }
  result.lcsc = code

  let outDir
  try {
    outDir = resolveOutDir(input.out_dir, { sessionCwd: options.sessionCwd })
  } catch (error) {
    notes.push(`out_dir rejected: ${messageOf(error)}`)
    hints.push('Pass an absolute directory path, e.g. "F:/deepseek_harness/LCSC/datasheets" or "~/.cache/lcsc-datasheets".')
    return result
  }
  result.out_dir = outDir

  // Resolve identity + the first candidate URL. `service.part()` already
  // queries both JLCPCB and the LCSC product page (cached), so this is cheap.
  /** @type {Record<string, unknown> | undefined} */
  let part
  try {
    if (options.service !== undefined && typeof options.service.part === 'function') {
      part = await options.service.part(code, { includeCny: false, signal })
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted')
    notes.push(`part lookup failed: ${messageOf(error)}`)
  }
  const identity = isRecord(part?.identity) ? part.identity : undefined
  const model = asString(identity?.model)
  const brand = asString(identity?.brand)
  if (model !== undefined) result.model = model
  if (brand !== undefined) result.brand = brand
  const packageText = asString(identity?.package)
  if (packageText !== undefined) result.package = packageText
  const productUrl = isRecord(part?.urls) ? asString(part.urls.lcsc) : undefined
  result.datasheet_page = productUrl ?? `${LCSC_PRODUCT_URL}${code}.html`
  if (part?.status === 'NOT-FOUND') {
    notes.push('the part is not in the JLCPCB/LCSC lookup (it may be obsolete, domestic-only or a typo); still trying the public datasheet paths')
  }

  // File name and early exit.
  let fileName
  if (input.filename !== undefined && input.filename !== null && String(input.filename).trim() !== '') {
    const normalized = normalizePdfFilename(input.filename)
    if (!normalized.ok) {
      notes.push(`filename rejected: ${normalized.error}`)
      return result
    }
    fileName = normalized.name
  } else {
    fileName = datasheetFilename(code, model)
  }
  const targetPath = path.join(outDir, fileName)
  result.file_name = fileName
  if (fs.existsSync(targetPath)) {
    const stat = fs.statSync(targetPath)
    if (stat.isFile() && input.overwrite !== true) {
      result.status = 'already-exists'
      result.file_path = targetPath
      result.bytes = stat.size
      notes.push('file already exists; pass overwrite=true to download it again')
      return result
    }
  }

  // Candidate URLs, in preference order.
  /** @type {{ url: string, from: string }[]} */
  const candidates = []
  const partDatasheet = asString(part?.datasheetUrl)
  if (partDatasheet !== undefined) candidates.push({ url: partDatasheet, from: 'jlc-part' })
  try {
    let webData
    if (options.service !== undefined && typeof options.service.productPage === 'function') {
      const page = await options.service.productPage(code, { signal })
      webData = isRecord(page) && isRecord(page.webData) ? page.webData : undefined
    } else {
      webData = await fetchProductWebData(code, {
        fetchImpl,
        timeoutMs: options.timeoutMs,
        htmlMaxBytes: options.htmlMaxBytes,
        signal,
      })
    }
    const pagePdf = asString(webData?.pdfUrl)
    if (pagePdf !== undefined) candidates.push({ url: pagePdf, from: 'lcsc-product-page' })
  } catch (error) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted')
    attempts.push({ step: 'lcsc-product-page', ok: false, error: messageOf(error) })
  }

  /** @type {{ bytes: Buffer, contentType?: string, finalUrl: string, sourceUrl: string, from: string, hops: { url: string, via: string }[], source: string }} | undefined} */
  let downloaded
  for (const candidate of candidates) {
    const attempt = {
      step: 'pdf-fetch',
      url: candidate.url,
      from: candidate.from,
      source: sourceOfUrl(candidate.url),
      ok: false,
    }
    try {
      const resolved = await resolvePdfBytes(candidate.url, {
        fetchImpl,
        timeoutMs: options.timeoutMs,
        maxBytes: options.maxBytes,
        htmlMaxBytes: options.htmlMaxBytes,
        maxHops: options.maxHops,
        signal,
      })
      if (resolved.ok && resolved.bytes !== undefined) {
        attempt.ok = true
        attempt.via = resolved.hops.length === 0 ? 'direct' : resolved.hops.map((hop) => hop.via).join('>')
        attempts.push(attempt)
        downloaded = {
          bytes: resolved.bytes,
          contentType: resolved.contentType,
          finalUrl: resolved.finalUrl,
          sourceUrl: resolved.sourceUrl,
          from: candidate.from,
          hops: resolved.hops,
          source: sourceOfUrl(resolved.finalUrl),
        }
        break
      }
      attempt.error = resolved.error
      attempts.push(attempt)
    } catch (error) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted')
      attempt.error = messageOf(error)
      attempts.push(attempt)
    }
  }

  // Domestic fallback: only when every international candidate failed.
  if (downloaded === undefined && domFallbackAllowed) {
    const domestic = await resolveDomesticPdfUrl(code, {
      cnAdapter: options.cnAdapter,
      fetchImpl,
      timeoutMs: options.timeoutMs,
      htmlMaxBytes: options.htmlMaxBytes,
      signal,
    })
    attempts.push({
      step: 'domestic-lookup',
      url: domestic.productId === undefined ? undefined : `${SZLCSC_ITEM_URL}${domestic.productId}.html`,
      ok: domestic.ok === true,
      source: 'szlcsc.com',
      via: domestic.via,
      error: domestic.ok === true ? undefined : domestic.error,
    })
    if (domestic.ok === true && domestic.url !== undefined) {
      const attempt = { step: 'pdf-fetch', url: domestic.url, from: 'szlcsc-domestic', source: 'szlcsc.com', ok: false }
      try {
        const resolved = await resolvePdfBytes(domestic.url, {
          fetchImpl,
          timeoutMs: options.timeoutMs,
          maxBytes: options.maxBytes,
          htmlMaxBytes: options.htmlMaxBytes,
          maxHops: options.maxHops,
          signal,
        })
        if (resolved.ok && resolved.bytes !== undefined) {
          attempt.ok = true
          attempt.via = resolved.hops.length === 0 ? 'direct' : resolved.hops.map((hop) => hop.via).join('>')
          attempts.push(attempt)
          downloaded = {
            bytes: resolved.bytes,
            contentType: resolved.contentType,
            finalUrl: resolved.finalUrl,
            sourceUrl: resolved.sourceUrl,
            from: 'szlcsc-domestic',
            hops: resolved.hops,
            source: 'szlcsc.com',
          }
        } else {
          attempt.error = resolved.error
          attempts.push(attempt)
        }
      } catch (error) {
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted')
        attempt.error = messageOf(error)
        attempts.push(attempt)
      }
    } else if (domestic.ok !== true && domestic.reason === 'chrome-adapter-unavailable') {
      hints.push('立创商城 domestic fallback is unavailable: no Chrome adapter (set cnRender:true and a valid chromePath to enable it).')
    } else if (domestic.ok !== true && domestic.reason === 'product-id-not-found') {
      hints.push('This code has no 立创商城 domestic product id in EasyEDA/lceda (new/domestic-only/non-retail part); retrying will not help.')
    } else if (domestic.ok !== true && domestic.reason === 'szlcsc-pdf-link-not-found') {
      hints.push('The 立创商城 domestic page exists but carries no atta.szlcsc.com PDF link; the part may simply have no public datasheet.')
    }
  } else if (downloaded === undefined && !domFallbackAllowed) {
    notes.push('domestic fallback disabled by domestic_fallback=false / datasheetChromeFallback=false')
  }

  if (downloaded === undefined) {
    result.status = 'not-found'
    if (candidates.length === 0 && attempts.every((attempt) => attempt.step !== 'domestic-lookup')) {
      notes.push('no datasheet URL was found from JLCPCB, the LCSC product page or the domestic store')
    }
    hints.push(`Open the product page to check manually: ${String(result.datasheet_page)}`)
    if (part?.status === 'NOT-FOUND') {
      hints.push('The LCSC code itself was not found in the public part data; double-check the code before retrying.')
    }
    return result
  }

  // Write the file (atomically) and report only metadata.
  try {
    if (input.overwrite === true && fs.existsSync(targetPath)) fs.unlinkSync(targetPath)
    writeFileAtomic(targetPath, downloaded.bytes)
  } catch (error) {
    result.status = 'failed'
    notes.push(`could not write ${targetPath}: ${messageOf(error)}`)
    hints.push('Check that the directory is writable and that the file is not open in another program.')
    return result
  }

  result.status = 'downloaded'
  result.file_path = targetPath
  result.file_name = fileName
  result.bytes = downloaded.bytes.length
  result.sha256 = sha256(downloaded.bytes)
  result.content_type = downloaded.contentType
  result.pdf_url = downloaded.finalUrl
  result.datasheet_url = downloaded.sourceUrl
  result.source = downloaded.source
  result.resolved_via = downloaded.hops.length === 0 ? 'direct' : downloaded.hops.map((hop) => hop.via).join(' > ')
  notes.push(`PDF verified: ${formatBytes(downloaded.bytes.length)}, sha256 ${result.sha256.slice(0, 16)}…`)
  notes.push(`source: ${downloaded.source}${downloaded.hops.length === 0 ? '' : ` (${downloaded.hops.map((hop) => hop.via).join(' > ')})`}`)
  return result
}
