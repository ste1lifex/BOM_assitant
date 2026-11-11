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
 *
 * Speed: a single persistent Chrome instance is kept alive and driven over the
 * DevTools protocol (`--remote-debugging-pipe`), opening one tab per product.
 * Cold start/warm-up costs ~4-5 s (WAF challenge), after which each product is
 * ~1-2 s; 4-8 tabs in parallel warm a 28-part BOM in well under a minute.
 * Chrome is started on demand, reused across calls, and auto-closed after an
 * idle TTL. If the pipe/CDP path is unavailable, it falls back to the legacy
 * per-page `--dump-dom` spawn (slower but dependency-free).
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

/** Chrome profile subdirectories that are pure cache/garbage and can be deleted freely. */
const CHROME_PROFILE_JUNK = [
  'Default/Cache',
  'Default/Code Cache',
  'Default/GPUCache',
  'Default/DawnCache',
  'Default/DawnGraphiteCache',
  'Default/DawnWebGPUCache',
  'Default/GraphiteDawnCache',
  'Default/ShaderCache',
  'Default/Service Worker/CacheStorage',
  'Default/Service Worker/ScriptCache',
  'Default/Media Cache',
  'Default/Session Storage',
  'Default/WebStorage',
  'Crashpad',
  'ShaderCache',
  'GrShaderCache',
  'BrowserMetrics',
  'component_crx_cache',
  'extensions_crx_cache',
]

/**
 * Delete cache-only subdirectories from a Chrome profile, keeping cookies and
 * preferences (the WAF challenge cookie lives in the profile).
 * @param {string} profileDir
 */
export function pruneChromeProfile(profileDir) {
  for (const relative of CHROME_PROFILE_JUNK) {
    try {
      fs.rmSync(path.join(profileDir, relative), { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
}

/**
 * Prune the JSON result cache: drop entries older than `ttlMs`, then keep at
 * most `maxEntries` newest entries. This keeps `~/.cache/dsh-plugin-lcsc/cn`
 * bounded instead of accumulating one file per part ever queried.
 * @param {string} cacheDir
 * @param {{ ttlMs?: number, maxEntries?: number }} [options]
 * @returns {{ removed: number, kept: number }}
 */
export function pruneJsonCache(cacheDir, options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : 24 * 60 * 60 * 1000
  const maxEntries = Number.isFinite(options.maxEntries) ? Math.max(1, Math.floor(options.maxEntries)) : 800
  let names
  try {
    names = fs.readdirSync(cacheDir).filter((name) => name.endsWith('.json'))
  } catch {
    return { removed: 0, kept: 0 }
  }
  const now = Date.now()
  /** @type {{ file: string, fetchedAt: number }[]} */
  const alive = []
  let removed = 0
  for (const name of names) {
    const file = path.join(cacheDir, name)
    let record
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      record = undefined
    }
    const fetchedAt = record === undefined ? Number.NaN : Date.parse(record.fetched_at)
    if (!Number.isFinite(fetchedAt) || now - fetchedAt > ttlMs) {
      try {
        fs.rmSync(file, { force: true })
        removed += 1
      } catch {
        // best effort
      }
      continue
    }
    alive.push({ file, fetchedAt })
  }
  if (alive.length > maxEntries) {
    alive.sort((left, right) => left.fetchedAt - right.fetchedAt)
    for (const entry of alive.slice(0, alive.length - maxEntries)) {
      try {
        fs.rmSync(entry.file, { force: true })
        removed += 1
      } catch {
        // best effort
      }
    }
    return { removed, kept: maxEntries }
  }
  return { removed, kept: alive.length }
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
 *   browserIdleTtlMs?: number,
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
  const profileDir = path.join(cacheDir, 'chrome-profile')
  const cacheTtlMs = Number.isFinite(options.cacheTtlMs) ? options.cacheTtlMs : 24 * 60 * 60 * 1000
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30000
  const concurrency = Math.max(1, Math.min(8, Math.floor(options.concurrency ?? 4)))
  const browserIdleTtlMs = Number.isFinite(options.browserIdleTtlMs) ? options.browserIdleTtlMs : 120000
  const cacheMaxEntries = Number.isFinite(options.cacheMaxEntries) ? Math.max(1, Math.floor(options.cacheMaxEntries)) : 800
  const legacyProfileDir = path.join(cacheDir, 'legacy-profile')
  let lastJsonPruneAt = 0
  let queryCount = 0
  const logger = options.logger
  const memory = new Map()
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

  /* ------------------------- persistent Chrome (CDP) ----------------------- */
  /**
   * @typedef {{
   *   child: import('node:child_process').ChildProcess,
   *   write: NodeJS.WritableStream,
   *   read: NodeJS.ReadableStream,
   *   pending: Map<number, { resolve: (value: any) => void, reject: (reason: Error) => void, timer: NodeJS.Timeout }>,
   *   nextId: number,
   *   buffer: string,
   *   closed: boolean,
   * }} BrowserState
   */
  /** @type {BrowserState | undefined} */
  let browser
  /** @type {NodeJS.Timeout | undefined} */
  let idleTimer
  let cdpBroken = false
  let cdpSessionErrors = 0

  function shutdownBrowser() {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer)
      idleTimer = undefined
    }
    const state = browser
    browser = undefined
    if (state === undefined) return
    state.closed = true
    for (const entry of state.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('chrome-shutdown'))
    }
    state.pending.clear()
    try {
      state.child.kill('SIGKILL')
    } catch {
      // already gone
    }
    // Keep cookies for the WAF challenge, drop HTTP/Code caches so the profile
    // does not silently grow.
    pruneChromeProfile(profileDir)
  }

  function touchIdle() {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    if (browserIdleTtlMs <= 0) return
    idleTimer = setTimeout(() => shutdownBrowser(), browserIdleTtlMs)
    idleTimer.unref?.()
  }

  /** Start Chrome once and resolve when its DevTools pipe answers. */
  async function startBrowser() {
    if (browser !== undefined && browser.closed !== true) return browser
    if (chromePath === undefined) throw new Error('chrome-not-found')
    fs.mkdirSync(profileDir, { recursive: true })
    // Clean caches left behind by an interrupted previous run.
    pruneChromeProfile(profileDir)
    const child = spawn(
      chromePath,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-sync',
        '--mute-audio',
        '--disk-cache-size=52428800', // hard cap: 50 MiB HTTP cache
        '--media-cache-size=10485760', // hard cap: 10 MiB media cache
        '--remote-debugging-pipe',
        `--user-data-dir=${profileDir}`,
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
    )
    const write = /** @type {NodeJS.WritableStream} */ (child.stdio[3])
    const read = /** @type {NodeJS.ReadableStream} */ (child.stdio[4])
    if (write === null || read === null) {
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
      throw new Error('chrome-pipe-unavailable')
    }
    /** @type {BrowserState} */
    const state = { child, write, read, pending: new Map(), nextId: 1, buffer: '', closed: false }
    read.on('data', (chunk) => {
      state.buffer += chunk.toString('utf8')
      const parts = state.buffer.split('\u0000')
      state.buffer = parts.pop() ?? ''
      for (const part of parts) {
        if (part.trim() === '') continue
        let message
        try {
          message = JSON.parse(part)
        } catch {
          continue
        }
        if (message.id === undefined) continue
        const entry = state.pending.get(message.id)
        if (entry === undefined) continue
        state.pending.delete(message.id)
        clearTimeout(entry.timer)
        if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)))
        else entry.resolve(message.result ?? message)
      }
    })
    child.on('error', (error) => {
      state.closed = true
      if (browser === state) browser = undefined
      for (const entry of state.pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(error instanceof Error ? error : new Error(String(error)))
      }
      state.pending.clear()
    })
    child.on('exit', () => {
      state.closed = true
      if (browser === state) browser = undefined
      for (const entry of state.pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(new Error('chrome-exited'))
      }
      state.pending.clear()
    })
    browser = state
    // handshake
    await cdpSend(state, 'Browser.getVersion', {}, undefined, 8000)
    if (options.verbose === true) logger?.info?.(`[lcsc-cn] chrome started (pid ${child.pid})`)
    return state
  }

  /**
   * Send one CDP command over the pipe.
   * @param {BrowserState} state
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {string} [sessionId]
   * @param {number} [timeout]
   */
  function cdpSend(state, method, params = {}, sessionId, timeout = 15000) {
    return new Promise((resolve, reject) => {
      if (state.closed) {
        reject(new Error('chrome-closed'))
        return
      }
      const id = state.nextId
      state.nextId += 1
      const timer = setTimeout(() => {
        state.pending.delete(id)
        reject(new Error(`cdp-timeout:${method}`))
      }, timeout)
      timer.unref?.()
      state.pending.set(id, { resolve, reject, timer })
      const payload = { id, method, params }
      if (sessionId !== undefined) payload.sessionId = sessionId
      state.write.write(`${JSON.stringify(payload)}\u0000`)
    })
  }

  /** Open `url` in a new tab, wait for the rendered DOM, close the tab. */
  async function renderViaCdp(url, timeout = timeoutMs) {
    const state = await startBrowser()
    const deadline = Date.now() + timeout
    let targetId
    let sessionId
    try {
      const created = await cdpSend(state, 'Target.createTarget', { url: 'about:blank' }, undefined, 10000)
      targetId = created.targetId
      const attached = await cdpSend(state, 'Target.attachToTarget', { targetId, flatten: true }, undefined, 10000)
      sessionId = attached.sessionId
      await cdpSend(state, 'Page.enable', {}, sessionId, 5000)
      await cdpSend(state, 'Runtime.enable', {}, sessionId, 5000)
      await cdpSend(state, 'Page.navigate', { url }, sessionId, 10000)
      let html = ''
      while (Date.now() < deadline) {
        await sleep(150)
        try {
          const evaluated = await cdpSend(
            state,
            'Runtime.evaluate',
            { expression: 'document.documentElement.outerHTML', returnByValue: true },
            sessionId,
            5000,
          )
          html = typeof evaluated?.result?.value === 'string' ? evaluated.result.value : ''
        } catch {
          // navigation might still be in flight; retry until the deadline
        }
        if (html.includes('__NEXT_DATA__') && /"price"\s*:/.test(html)) return html
      }
      return html
    } finally {
      if (sessionId !== undefined && state.closed !== true) {
        try {
          await cdpSend(state, 'Target.detachFromTarget', { sessionId }, undefined, 3000)
        } catch {
          // ignore
        }
      }
      if (targetId !== undefined && state.closed !== true) {
        try {
          await cdpSend(state, 'Target.closeTarget', { targetId }, undefined, 3000)
        } catch {
          // ignore
        }
      }
      touchIdle()
    }
  }

  /* ------------------- legacy per-page renderer (fallback) ----------------- */
  /** @param {string} url @param {number} timeout @returns {Promise<string>} */
  function renderViaDumpDom(url, timeout = timeoutMs) {
    if (chromePath === undefined) return Promise.resolve('')
    return new Promise((resolve) => {
      fs.mkdirSync(legacyProfileDir, { recursive: true })
      pruneChromeProfile(legacyProfileDir)
      const args = [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-sync',
        '--mute-audio',
        '--disk-cache-size=52428800',
        '--media-cache-size=10485760',
        `--user-data-dir=${legacyProfileDir}`,
        '--dump-dom',
        '--virtual-time-budget=6000',
        url,
      ]
      let finished = false
      let stdout = ''
      const child = spawn(chromePath, args, { stdio: ['ignore', 'pipe', 'ignore'] })
      const timer = setTimeout(() => {
        if (finished) return
        finished = true
        try {
          child.kill('SIGKILL')
        } catch {
          // ignore
        }
        resolve(stdout)
      }, timeout)
      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString()
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
        pruneChromeProfile(legacyProfileDir)
        resolve(stdout)
      })
    })
  }

  /**
   * Render a URL to DOM: persistent CDP browser first, dump-dom fallback.
   * @param {string} url
   * @param {number} [timeout]
   * @returns {Promise<string>}
   */
  async function renderHtml(url, timeout = timeoutMs) {
    if (chromePath === undefined) return ''
    if (!cdpBroken && cdpSessionErrors < 3) {
      try {
        return await renderViaCdp(url, timeout)
      } catch (error) {
        cdpSessionErrors += 1
        if (options.verbose === true) logger?.warn?.(`[lcsc-cn] cdp render failed: ${error instanceof Error ? error.message : String(error)}`)
        shutdownBrowser()
        if (cdpSessionErrors >= 3) cdpBroken = true
      }
    }
    return renderViaDumpDom(url, timeout)
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
    queryCount += 1
    // Prune expired JSON cache entries lazily (about once per hour / 50 hits).
    if (queryCount === 1 || Date.now() - lastJsonPruneAt > 60 * 60 * 1000 || queryCount % 50 === 0) {
      lastJsonPruneAt = Date.now()
      pruneJsonCache(cacheDir, { ttlMs: cacheTtlMs, maxEntries: cacheMaxEntries })
    }
    const cached = callOptions.refresh === true ? undefined : readCache(normalized)
    if (cached !== undefined && cached.ok !== false) {
      touchIdle()
      return cached
    }
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
    /** Remove this adapter's on-disk caches (JSON results + Chrome profiles). */
    clearCache() {
      shutdownBrowser()
      try {
        fs.rmSync(cacheDir, { recursive: true, force: true })
      } catch {
        // best effort
      }
      memory.clear()
    },
    pruneCaches() {
      const json = pruneJsonCache(cacheDir, { ttlMs: cacheTtlMs, maxEntries: cacheMaxEntries })
      pruneChromeProfile(profileDir)
      pruneChromeProfile(legacyProfileDir)
      return json
    },
    dispose() {
      shutdownBrowser()
      pruneChromeProfile(profileDir)
      pruneChromeProfile(legacyProfileDir)
      pruneJsonCache(cacheDir, { ttlMs: cacheTtlMs, maxEntries: cacheMaxEntries })
    },
  }
}
