/**
 * LCSC domestic (立创商城) CNY price/stock adapter.
 *
 * The domestic store sits behind an Aliyun WAF that challenges plain HTTP
 * requests, but a real browser executes the challenge and then serves the
 * product page with `<script id="__NEXT_DATA__">` containing the official CNY
 * price and domestic stock. This module renders `item.szlcsc.com/<productId>.html`
 * with the locally installed Chrome (`--headless=new --dump-dom`) and caches the
 * result on disk for 24 h.
 *
 * Flow: LCSC code -> EasyEDA / lceda.cn product id -> Chrome render -> parse
 * __NEXT_DATA__ -> cache. Every failure is returned as `{ ok: false, reason }`
 * so callers can fall back to the USD estimate instead of failing the batch.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const EASYEDA_URL = 'https://easyeda.com/api/products/'
const LCEDA_URL = 'https://lceda.cn/api/products/'
const ITEM_URL = 'https://item.szlcsc.com/'

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** Locate a Chrome/Chromium binary. `explicit` wins (e.g. config.chromePath). */
export function findChrome(explicit) {
  if (typeof explicit === 'string' && explicit !== '' && fs.existsSync(explicit)) return explicit
  const env = process.env.CHROME_BIN
  if (typeof env === 'string' && env !== '' && fs.existsSync(env)) return env
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate
  }
  return undefined
}

/** Extract the `__NEXT_DATA__` JSON from an HTML document (or undefined). */
export function extractNextData(html) {
  const match = String(html ?? '').match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (match === null) return undefined
  try {
    return JSON.parse(match[1])
  } catch {
    return undefined
  }
}

/**
 * Parse a rendered `item.szlcsc.com` page into the official domestic record.
 * @param {string} html
 * @returns {{ price?: number, model?: string, brand?: string, package?: string, stock?: number, min_buy?: number, packing?: string, unit?: string, category?: string, desc?: string, product_id?: string } | undefined}
 */
export function parseItemHtml(html) {
  const text = String(html ?? '')
  const nextData = extractNextData(text)
  if (nextData === undefined) {
    // JSON-LD fallback for pages that omit __NEXT_DATA__.
    const fallback = text.match(/"priceCurrency":"CNY","price":([0-9.]+)/)
    if (fallback === null) return undefined
    return { price: Number(fallback[1]) }
  }
  const pageProps = nextData?.props?.pageProps ?? {}
  const webData = pageProps.webData ?? {}
  const productRecord = webData.productRecord ?? {}
  const price = Number(pageProps.price)
  const result = {
    price: Number.isFinite(price) ? price : undefined,
    model: stringOrUndefined(productRecord.productModel),
    brand: stringOrUndefined(productRecord.productGradePlateName),
    package: stringOrUndefined(productRecord.encapsulationModel),
    stock: integerOrUndefined(productRecord.stockNumber),
    min_buy: integerOrUndefined(productRecord.minBuyNumber),
    packing: stringOrUndefined(productRecord.productArrange),
    unit: stringOrUndefined(productRecord.productUnit),
    category: stringOrUndefined(productRecord.productType),
    desc: stringOrUndefined(productRecord.productName) ?? stringOrUndefined(productRecord.remark),
    product_id: productRecord.productId ?? productRecord.productCode,
  }
  if (result.price === undefined) {
    const fallback = text.match(/"priceCurrency":"CNY","price":([0-9.]+)/)
    if (fallback !== null) result.price = Number(fallback[1])
  }
  return result
}

/** @param {unknown} value @returns {string | undefined} */
function stringOrUndefined(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text === '' ? undefined : text
}

/** @param {unknown} value @returns {number | undefined} */
function integerOrUndefined(value) {
  const number = typeof value === 'string' ? Number(value) : value
  return typeof number === 'number' && Number.isInteger(number) ? number : undefined
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Create the domestic-CNY adapter.
 * @param {{
 *   chromePath?: string,
 *   cacheDir?: string,
 *   cacheTtlMs?: number,
 *   timeoutMs?: number,
 *   concurrency?: number,
 *   verbose?: boolean,
 *   logger?: { warn?: (message: string) => void, info?: (message: string) => void },
 * }} [options]
 */
export function createCnAdapter(options = {}) {
  const chromePath = findChrome(options.chromePath)
  const cacheDir =
    typeof options.cacheDir === 'string' && options.cacheDir !== ''
      ? options.cacheDir
      : path.join(os.homedir(), '.cache', 'dsh-plugin-lcsc', 'cn')
  const cacheTtlMs = Number.isFinite(options.cacheTtlMs) ? options.cacheTtlMs : 24 * 60 * 60 * 1000
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30000
  const concurrency = Math.max(1, Math.min(4, Math.floor(options.concurrency ?? 2)))
  const logger = options.logger
  const memory = new Map()
  const chromeProfile = path.join(os.tmpdir(), 'dsh-plugin-lcsc-chrome-profile')
  let active = 0
  /** @type {(() => void)[]} */
  const waiting = []

  /** Run `fn` under the adapter concurrency limit. */
  async function withSlot(fn) {
    while (active >= concurrency) {
      await new Promise((resolve) => waiting.push(resolve))
    }
    active += 1
    try {
      return await fn()
    } finally {
      active -= 1
      const next = waiting.shift()
      if (next !== undefined) next()
    }
  }

  /** HTTP GET JSON using the global fetch (host Node >= 20). */
  async function getJson(url) {
    const response = await fetch(url, {
      headers: { 'User-Agent': DEFAULT_USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
    return response.json()
  }

  /**
   * Resolve the domestic product id for an LCSC code.
   * @param {string} code
   * @returns {Promise<string | undefined>}
   */
  async function resolvePid(code) {
    for (const base of [EASYEDA_URL, LCEDA_URL]) {
      try {
        const payload = await getJson(`${base}${encodeURIComponent(code)}/components`)
        const result = payload?.result ?? {}
        const pid = result?.szlcsc?.id ?? result?.lcsc?.id
        if (pid !== undefined && pid !== null && String(pid) !== '') return String(pid)
      } catch {
        // try the next API
      }
    }
    return undefined
  }

  /**
   * Render a URL with headless Chrome and return the DOM.
   * @param {string} url
   * @param {number} [timeout]
   * @returns {Promise<string>}
   */
  function renderHtml(url, timeout = timeoutMs) {
    if (chromePath === undefined) return Promise.resolve('')
    return new Promise((resolve) => {
      fs.mkdirSync(chromeProfile, { recursive: true })
      const args = [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-sync',
        '--mute-audio',
        `--user-data-dir=${chromeProfile}`,
        '--dump-dom',
        '--virtual-time-budget=15000',
        url,
      ]
      let finished = false
      let stdout = ''
      let stderr = ''
      const child = spawn(chromePath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      const timer = setTimeout(() => {
        if (!finished) {
          finished = true
          try {
            child.kill('SIGKILL')
          } catch {
            // ignore
          }
          resolve('')
        }
      }, timeout)
      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString()
      })
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      child.on('error', () => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        resolve('')
      })
      child.on('close', () => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        if (stdout.includes('__NEXT_DATA__') || stdout.includes('priceCurrency')) resolve(stdout)
        else resolve(stdout)
        if (options.verbose === true && stderr !== '') logger?.warn?.(`[lcsc-cn] chrome stderr: ${stderr.slice(0, 200)}`)
      })
    })
  }

  /** @param {string} code */
  function cachePath(code) {
    return path.join(cacheDir, `${code}.json`)
  }

  /** @param {string} code */
  function readCache(code) {
    const inMemory = memory.get(code)
    if (inMemory !== undefined && Date.now() - inMemory.ts < cacheTtlMs) {
      return { ...inMemory.value, cached: true, cache_age_s: Math.round((Date.now() - inMemory.ts) / 1000) }
    }
    try {
      const record = JSON.parse(fs.readFileSync(cachePath(code), 'utf8'))
      const fetchedAt = Date.parse(record.fetched_at)
      if (Number.isFinite(fetchedAt) && Date.now() - fetchedAt < cacheTtlMs) {
        return { ...record, cached: true, cache_age_s: Math.round((Date.now() - fetchedAt) / 1000) }
      }
    } catch {
      // cache miss
    }
    return undefined
  }

  /** @param {string} code @param {Record<string, unknown>} record */
  function writeCache(code, record) {
    try {
      fs.mkdirSync(cacheDir, { recursive: true })
      fs.writeFileSync(cachePath(code), JSON.stringify(record, null, 1), 'utf8')
    } catch {
      // cache write is best effort
    }
    memory.set(code, { ts: Date.now(), value: record })
  }

  /**
   * Query one LCSC code. Never throws; returns `{ok:false, reason}` on failure.
   * @param {string} code
   * @param {{ refresh?: boolean }} [callOptions]
   */
  async function query(code, callOptions = {}) {
    const normalized = String(code ?? '').trim().toUpperCase()
    if (normalized === '') return { ok: false, reason: 'empty-code' }
    if (chromePath === undefined) return { ok: false, reason: 'chrome-not-found' }
    const cached = callOptions.refresh === true ? undefined : readCache(normalized)
    if (cached !== undefined && cached.ok !== false) return cached
    return withSlot(async () => {
      try {
        const pid = await resolvePid(normalized)
        if (pid === undefined) return { ok: false, reason: 'product-id-not-found' }
        const html = await renderHtml(`${ITEM_URL}${pid}.html`)
        if (html === '') return { ok: false, reason: 'chrome-render-empty' }
        const parsed = parseItemHtml(html)
        if (parsed === undefined || parsed.price === undefined) {
          return { ok: false, reason: 'page-parse-failed' }
        }
        const record = {
          ok: true,
          lcsc: normalized,
          product_id: pid,
          unit: parsed.price,
          currency: 'CNY',
          stock: parsed.stock,
          model: parsed.model,
          brand: parsed.brand,
          package: parsed.package,
          min_buy: parsed.min_buy,
          packing: parsed.packing,
          unit_name: parsed.unit,
          category: parsed.category,
          desc: parsed.desc,
          source: 'lcsc_cn_render',
          fetched_at: new Date().toISOString(),
          cache_age_s: 0,
          cached: false,
        }
        writeCache(normalized, record)
        return record
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  return {
    chromePath,
    cacheDir,
    query,
    resolvePid,
    renderHtml,
    clearMemory() {
      memory.clear()
    },
    async warm(codes) {
      const results = []
      for (const code of codes) results.push([code, await query(code)])
      return results
    },
    sleep,
  }
}
