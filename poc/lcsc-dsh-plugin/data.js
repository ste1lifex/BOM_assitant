/**
 * dsh-plugin-lcsc — shared data layer for the LCSC/JLC finder plugin.
 *
 * This module holds the HTTP/cache/normalisation layer only:
 *   - JLCPCB SMT parts search (`searchRaw`, `search`)
 *   - LCSC international product page (USD ladder prices)
 *   - LCSC domestic product page (CNY 1-pc price, best effort; WAF-limited)
 *   - EasyEDA product API (C-code -> domestic product id)
 *   - BOM CSV parsing and price-tier helpers
 *
 * The DSH tool surface lives in `index.js`.
 */
/**
 * The plugin description used by the DSH loader.
 *
 * Host-only bundle: exports `apply` + `inject` for the DSH Loader, and three
 * LLM-callable tools through `ctx.tools.register`:
 *
 *   - `lcsc_search(keyword, limit)`   search candidates through JLCPCB's SMT
 *                                     parts API (no login required)
 *   - `lcsc_part(codes[])`            exact price / stock / package lookup
 *   - `bom_check(rows | csv)`         batch BOM verification
 *
 * The same module also exports pure helpers (`createLcscService`,
 * `searchParts`, `getPart`, `checkBom`, `parseBomCsv`, `pickTierPrice`,
 * normalizers, …) so `poc/validate.mjs` can exercise the data layer with plain
 * Node, no DSH runtime required.
 *
 * Design constraints:
 *   - zero third-party runtime dependencies; global `fetch` only (Node >= 20)
 *   - no `@deepseek-ai/*` imports: the tool definition object is registered in
 *     the shape `@deepseek-ai/dsh-tools`'s `ToolsService.register()` accepts
 *     (see `createMcpToolDefinition` in the shipped `dsh-mcp-client`), and the
 *     row `config` is validated by `normalizeConfig()` instead of schemastery.
 *   - prices are never converted between currencies; every price carries the
 *     currency and the source it came from.
 *
 * Data sources (all public, unauthenticated):
 *   1. JLCPCB SMT component search  (USD, assembly pricing)
 *      POST https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList
 *   2. LCSC international product page (USD ladder prices)
 *      GET  https://www.lcsc.com/product-detail/<C-code>.html  → __NEXT_DATA__
 *   3. EasyEDA product API (identity + szlcsc id)
 *      GET  https://easyeda.com/api/products/<C-code>/components
 *   4. LCSC domestic item page (CNY 1-pc price; optional, Aliyun WAF may block)
 *      GET  https://item.szlcsc.com/<szlcsc-id>.html            → __NEXT_DATA__
 */

/* -------------------------------------------------------------------------- */
/* Types (JSDoc)                                                              */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {object} LcscServiceOptions
 * @property {number} [timeoutMs] per-request timeout, default 8000
 * @property {number} [retries] retries after the first attempt, default 3
 * @property {number} [retryBaseMs] exponential backoff base, default 300
 * @property {number} [cacheTtlMs] in-memory cache TTL, default 600000 (10 min)
 * @property {number} [cacheMaxEntries] in-memory cache entries, default 300
 * @property {string} [userAgent]
 * @property {typeof fetch} [fetchImpl] injectable fetch (tests)
 */

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Plugin row name (also used in logs). */
export const name = 'lcsc-bom'

/** Services this plugin needs before it activates. */
export const inject = ['tools']

/** Defaults for the row `config` (see cordis.patch.yml). */
export const DEFAULT_CONFIG = Object.freeze({
  timeoutMs: 8000,
  retries: 3,
  retryBaseMs: 300,
  cacheTtlMs: 600000,
  cacheMaxEntries: 300,
  verbose: false,
  usdToCnyFactor: 6.0,
})

// LCSC codes are normally C + 4–7 digits, but the catalogue also carries
// long-form codes such as C9900021114 (C + 10 digits). A too-narrow bound made
// those parts invisible: normalizeJlcItem dropped them outright, so BOM rows
// referencing them looked like "no LCSC code".
const LCSC_CODE_RE = /^C\d{4,11}$/i
const LCSC_CODE_SEARCH_RE = /\bC\d{4,11}\b/gi

const JLC_SEARCH_URL =
  'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList'
const LCSC_PRODUCT_URL = 'https://www.lcsc.com/product-detail/'
const EASYEDA_PRODUCT_URL = 'https://easyeda.com/api/products/'
const SZLCSC_ITEM_URL = 'https://item.szlcsc.com/'

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const HTML_HEADERS = {
  'User-Agent': DEFAULT_USER_AGENT,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
}

const CN_HTML_HEADERS = {
  ...HTML_HEADERS,
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  Referer: 'https://www.szlcsc.com/',
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

const CURRENCY_NOTES = Object.freeze([
  'USD prices are quoted by the LCSC international site (lcsc.com) or by JLCPCB\'s SMT parts API; CNY prices are quoted by the LCSC domestic site (item.szlcsc.com).',
  'No FX conversion is applied and currencies are never mixed in one total.',
  'These are unofficial, unauthenticated public endpoints; treat prices and stock as indicative and confirm on lcsc.com / jlcpcb.com before ordering.',
])

/* -------------------------------------------------------------------------- */
/* Small utilities                                                            */
/* -------------------------------------------------------------------------- */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} value @returns {number | undefined} */
function asNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** @param {unknown} value @returns {string | undefined} */
function asString(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** @param {unknown} value @returns {number | undefined} */
function asInteger(value) {
  const number = asNumber(value)
  return number !== undefined && Number.isInteger(number) ? number : undefined
}

/**
 * Remove `undefined` object members recursively so a tool result is lossless
 * JSON and matches its declared output schema.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function clean(value) {
  if (Array.isArray(value)) return value.map((item) => clean(item))
  if (isRecord(value)) {
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const [key, member] of Object.entries(value)) {
      if (member === undefined) continue
      out[key] = clean(member)
    }
    return /** @type {T} */ (out)
  }
  return value
}

/**
 * Round a currency amount to six decimals (float noise only; no currency math).
 * @param {number} value
 * @returns {number}
 */
function money(value) {
  return Math.round(value * 1e6) / 1e6
}

/** @param {number} ms @param {AbortSignal} [signal] */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(undefined)
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/* -------------------------------------------------------------------------- */
/* HTTP layer: timeout, retry, JSON/text                                     */
/* -------------------------------------------------------------------------- */

/** A meaningful non-2xx HTTP response. */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} url
   * @param {string} bodySnippet
   */
  constructor(status, url, bodySnippet) {
    super(`HTTP ${status} from ${url}${bodySnippet === '' ? '' : `: ${bodySnippet}`}`)
    this.name = 'HttpError'
    this.status = status
    this.url = url
  }
}

/** A source refused the request in a way that must degrade, not fail the tool. */
export class SourceBlockedError extends Error {
  /**
   * @param {string} source
   * @param {string} reason
   */
  constructor(source, reason) {
    super(`${source}: ${reason}`)
    this.name = 'SourceBlockedError'
    this.source = source
    this.reason = reason
  }
}

/**
 * `fetch` with a per-attempt timeout, bounded retries with exponential
 * backoff, and cooperative cancellation through the caller's signal.
 * @param {string} url
 * @param {object} options
 * @param {string} [options.method]
 * @param {Record<string, string>} [options.headers]
 * @param {string} [options.body]
 * @param {number} options.timeoutMs
 * @param {number} options.retries
 * @param {number} options.retryBaseMs
 * @param {AbortSignal} [options.signal]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ text: string, status: number, url: string }>}
 */
async function request(url, options) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs,
    retries,
    retryBaseMs,
    signal,
    fetchImpl = globalThis.fetch,
  } = options
  if (typeof fetchImpl !== 'function') {
    throw new Error('global fetch is unavailable: run on Node >= 20 or pass fetchImpl')
  }
  /** @type {unknown} */
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs)
    const attemptSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
    let retryable = true
    try {
      const response = await fetchImpl(url, { method, headers, body, signal: attemptSignal, redirect: 'follow' })
      const text = await response.text()
      if (!response.ok) {
        const error = new HttpError(response.status, url, text.slice(0, 200).replace(/\s+/g, ' '))
        retryable = RETRYABLE_STATUS.has(response.status)
        throw error
      }
      return { text, status: response.status, url }
    } catch (error) {
      lastError = error
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted')
      const isAbort = error instanceof Error && (error.name === 'AbortError' || /aborted|timed out/i.test(error.message))
      if (isAbort && controller.signal.aborted) retryable = true
      if (attempt === retries || !retryable) break
      await sleep(retryBaseMs * 2 ** attempt, signal)
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/**
 * JSON request helper (same retry semantics, plus JSON parse failures retried).
 * @param {string} url
 * @param {Omit<Parameters<typeof request>[1], 'timeoutMs' | 'retries' | 'retryBaseMs'> & {
 *   timeoutMs: number, retries: number, retryBaseMs: number,
 * }} options
 * @returns {Promise<unknown>}
 */
async function requestJson(url, options) {
  let lastError
  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    try {
      const { text } = await request(url, {
        ...options,
        retries: 0,
        timeoutMs: options.timeoutMs,
      })
      return JSON.parse(text)
    } catch (error) {
      lastError = error
      const retryable =
        !(error instanceof HttpError) || RETRYABLE_STATUS.has(error.status) || error.status === 404
      if (attempt === options.retries || !retryable || options.signal?.aborted) break
      await sleep(options.retryBaseMs * 2 ** attempt, options.signal)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/* -------------------------------------------------------------------------- */
/* NEXT_DATA / WAF parsing                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Whether an HTML body is an Aliyun WAF JS challenge (LCSC domestic site uses
 * `acw_sc__v2`; the challenge page has no `__NEXT_DATA__`).
 * @param {string} html
 * @returns {boolean}
 */
export function isWafChallenge(html) {
  return (
    html.includes('acw_sc__v2') ||
    html.includes('aliyun_waf') ||
    (html.includes('id="renderData"') && !html.includes('__NEXT_DATA__'))
  )
}

/**
 * Parse the Next.js `__NEXT_DATA__` JSON embedded in an HTML page.
 *
 * The script tag may carry extra attributes (`crossorigin`, `nonce`), so the
 * regex must not assume `<script id="__NEXT_DATA__" type="application/json">`
 * exactly.
 * @param {string} html
 * @returns {Record<string, unknown> | undefined}
 */
export function parseNextData(html) {
  const match = /<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/.exec(html)
  if (match === null) return undefined
  try {
    const parsed = JSON.parse(match[1])
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** @param {unknown} nextData @returns {Record<string, unknown> | undefined} */
function pagePropsOf(nextData) {
  if (!isRecord(nextData)) return undefined
  const props = nextData.props
  if (!isRecord(props)) return undefined
  const pageProps = props.pageProps
  return isRecord(pageProps) ? pageProps : undefined
}

/* -------------------------------------------------------------------------- */
/* Normalizers (pure, exported for offline validation)                        */
/* -------------------------------------------------------------------------- */

/**
 * Normalize one row of the JLCPCB SMT parts search response.
 * @param {unknown} raw
 * @returns {Record<string, unknown> | undefined}
 */
export function normalizeJlcItem(raw) {
  if (!isRecord(raw)) return undefined
  const code = asString(raw.componentCode)?.toUpperCase()
  if (code === undefined || !LCSC_CODE_RE.test(code)) return undefined
  const prices = Array.isArray(raw.componentPrices) ? raw.componentPrices : []
  /** @type {{ qty: number, unit: number }[]} */
  const priceUsdTiers = []
  for (const tier of prices) {
    if (!isRecord(tier)) continue
    const qty = asInteger(tier.startNumber)
    const unit = asNumber(tier.productPrice)
    if (qty === undefined || unit === undefined) continue
    priceUsdTiers.push({ qty, unit })
  }
  priceUsdTiers.sort((left, right) => left.qty - right.qty)
  const attributes = Array.isArray(raw.attributes)
    ? raw.attributes
        .filter(isRecord)
        .map((attribute) => ({
          name: asString(attribute.attribute_name_en),
          value: asString(attribute.attribute_value_name),
        }))
        .filter((attribute) => attribute.name !== undefined)
    : []
  return clean({
    code,
    model: asString(raw.componentModelEn),
    brand: asString(raw.componentBrandEn),
    package: asString(raw.componentSpecificationEn),
    category: asString(raw.componentTypeEn),
    description: asString(raw.describe) ?? asString(raw.erpComponentName) ?? asString(raw.componentName),
    stock: asInteger(raw.stockCount),
    libraryType: asString(raw.componentLibraryType),
    preferred: raw.preferredComponentFlag === true,
    alternatives: asString(raw.componentAlternativesCode),
    minPurchaseNum: asInteger(raw.minPurchaseNum),
    encapsulationNumber: asInteger(raw.encapsulationNumber),
    priceUsdTiers,
    attributes,
    datasheetUrl: asString(raw.dataManualUrl) ?? asString(raw.dataManualFileAccessIdUrl),
    url: asString(raw.lcscGoodsUrl) ?? `https://www.lcsc.com/product-detail/${code}.html`,
  })
}

/**
 * Normalize the `pageProps.webData` of `https://www.lcsc.com/product-detail/<code>.html`.
 * `webData === null` with `dataIsNull: true` means the part is domestic-only.
 * @param {unknown} pageProps
 * @returns {{ dataIsNull: boolean, webData: Record<string, unknown> | undefined }}
 */
export function normalizeLcscProduct(pageProps) {
  const dataIsNull = isRecord(pageProps) ? pageProps.dataIsNull === true : false
  const webData = isRecord(pageProps) && isRecord(pageProps.webData) ? pageProps.webData : undefined
  return { dataIsNull, webData }
}

/**
 * Extract the USD ladder from lcsc.com `productPriceList`.
 * The international site quotes USD already (`usdPrice`, `currencySymbol: '$'`).
 * @param {unknown} webData
 * @returns {{ qty: number, unit: number }[]}
 */
export function usdTiersFromLcscProduct(webData) {
  if (!isRecord(webData) || !Array.isArray(webData.productPriceList)) return []
  /** @type {{ qty: number, unit: number }[]} */
  const tiers = []
  for (const row of webData.productPriceList) {
    if (!isRecord(row)) continue
    const qty = asInteger(row.ladder)
    const unit = asNumber(row.usdPrice) ?? asNumber(row.productPrice)
    if (qty === undefined || unit === undefined) continue
    tiers.push({ qty, unit })
  }
  tiers.sort((left, right) => left.qty - right.qty)
  return tiers
}

/**
 * Pick the unit price for `qty` from an ascending ladder. Below the first
 * ladder the first (MOQ) price applies; above the last the last applies.
 * @param {{ qty: number, unit: number }[]} tiers
 * @param {number} qty
 * @returns {number | undefined}
 */
export function pickTierPrice(tiers, qty) {
  if (!Array.isArray(tiers) || tiers.length === 0) return undefined
  const sorted = tiers
    .filter((tier) => Number.isFinite(tier?.qty) && Number.isFinite(tier?.unit))
    .sort((left, right) => left.qty - right.qty)
  if (sorted.length === 0) return undefined
  let chosen = sorted[0]
  for (const tier of sorted) {
    if (qty >= tier.qty) chosen = tier
    else break
  }
  return chosen.unit
}

/**
 * Parse a CSV / TSV / semicolon-delimited BOM into normalized rows.
 * Accepts both a header row (JLC / LCSC style, English or Chinese) and a
 * headerless list of `C-code, qty` lines.
 * @param {string} text
 * @returns {{ line: number, code: string, qty: number, designators?: string, comment?: string, footprint?: string }[]}
 */
export function parseBomCsv(text) {
  return parseBomCsvDetailed(text).rows
}

/**
 * Detailed variant of {@link parseBomCsv}: also reports the lines that carried
 * no recognisable LCSC code, so the audit can say "7 of 20 lines were not
 * costed" instead of silently dropping them.
 * @param {string} text
 * @returns {{
 *   rows: { line: number, code: string, qty: number, designators?: string, comment?: string, footprint?: string }[],
 *   skipped: { line: number, raw?: string, comment?: string, designators?: string }[],
 * }}
 */
export function parseBomCsvDetailed(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
  if (lines.length === 0) return { rows: [], skipped: [] }
  const delimiter = pickDelimiter(lines[0])
  const cells = lines.map((line) => splitCsvLine(line, delimiter))
  const header = classifyHeader(cells[0])
  const headerLooksTabular =
    header.qtyIndex !== undefined ||
    header.designatorsIndex !== undefined ||
    header.footprintIndex !== undefined ||
    header.commentIndex !== undefined
  const trustedCodeColumn = header.codeIndex !== undefined
  let codeIndex = header.codeIndex
  let qtyIndex = header.qtyIndex
  if (codeIndex === undefined && headerLooksTabular) {
    // Header names were not enough: fell back to sniffing the columns by content
    // instead of scanning whole rows (which picked up footprints like C0603).
    codeIndex = detectCodeColumn(cells.slice(1))
    if (codeIndex !== undefined && qtyIndex === undefined) {
      qtyIndex = detectQuantityColumn(cells.slice(1), codeIndex)
    }
  }
  /** @type {{ line: number, code: string, qty: number, designators?: string, comment?: string, footprint?: string }[]} */
  const rows = []
  /** @type {{ line: number, raw?: string, comment?: string, designators?: string }[]} */
  const skipped = []
  if (codeIndex !== undefined) {
    for (let index = 1; index < cells.length; index += 1) {
      const row = cells[index]
      const code = normalizeCode(row[codeIndex] ?? '')
      const comment = optionally(header.commentIndex, row[header.commentIndex])
      const designators = optionally(header.designatorsIndex, row[header.designatorsIndex])
      if (code === undefined) {
        skipped.push(clean({ line: index + 1, comment, designators }))
        continue
      }
      const qty = parseQty(qtyIndex === undefined ? undefined : row[qtyIndex])
      rows.push(
        clean({
          line: index + 1,
          code,
          qty,
          designators,
          comment,
          footprint: optionally(header.footprintIndex, row[header.footprintIndex]),
        }),
      )
    }
    if (trustedCodeColumn || rows.length > 0) return { rows, skipped }
  }
  for (let index = 0; index < cells.length; index += 1) {
    const row = cells[index]
    const joined = row.join(' ')
    const found = joined.match(LCSC_CODE_SEARCH_RE)
    if (found === null) {
      // index 0 is assumed to be a header when nothing matched it
      if (index > 0 && joined.trim() !== '') skipped.push(clean({ line: index + 1, raw: joined.slice(0, 160) }))
      continue
    }
    const code = normalizeCode(found[0])
    if (code === undefined) continue
    const rest = row.filter((cell) => !/^C\d{4,11}$/i.test(cell.trim()))
    let qty = 1
    let designators
    for (const cell of rest) {
      const integer = Number(cell)
      if (Number.isInteger(integer) && integer > 0 && cell.trim() !== '') {
        qty = integer
        break
      }
    }
    for (const cell of rest) {
      if (cell.trim() !== '' && !Number.isFinite(Number(cell)) && !/C\d{4,11}/i.test(cell)) {
        designators = cell.trim()
        break
      }
    }
    rows.push(clean({ line: index + 1, code, qty, designators }))
  }
  return { rows, skipped }
}

/** @param {string} line @returns {',' | ';' | '\t'} */
function pickDelimiter(line) {
  const counts = { ',': 0, ';': 0, '\t': 0 }
  let quoted = false
  for (const character of line) {
    if (character === '"') quoted = !quoted
    else if (!quoted && character in counts) counts[/** @type {keyof typeof counts} */ (character)] += 1
  }
  /** @type {keyof typeof counts} */
  let best = ','
  for (const candidate of /** @type {(keyof typeof counts)[]} */ (Object.keys(counts))) {
    if (counts[candidate] > counts[best]) best = candidate
  }
  return /** @type {',' | ';' | '\t'} */ (best)
}

/**
 * @param {string} line
 * @param {string} delimiter
 * @returns {string[]}
 */
function splitCsvLine(line, delimiter) {
  /** @type {string[]} */
  const cells = []
  let current = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        current += '"'
        index += 1
      } else if (character === '"') quoted = false
      else current += character
    } else if (character === '"') quoted = true
    else if (character === delimiter) {
      cells.push(current.trim())
      current = ''
    } else current += character
  }
  cells.push(current.trim())
  return cells
}

/**
 * Locate BOM columns by header name, English or Chinese.
 * @param {string[]} cells
 * @returns {{
 *   hasCode: boolean,
 *   codeIndex?: number,
 *   qtyIndex?: number,
 *   designatorsIndex?: number,
 *   commentIndex?: number,
 *   footprintIndex?: number,
 * }}
 */
function classifyHeader(cells) {
  /** @type {Record<string, number>} */
  const result = {}
  cells.forEach((cell, index) => {
    const key = cell.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ').trim()
    if (key === '') return
    if (result.codeIndex === undefined && /(^| )(lcsc|jlc)( |$)|supplier ?part|part ?(number|no|code)|料号|编号|^c ?号$/.test(key)) result.codeIndex = index
    else if (result.qtyIndex === undefined && /qty|quantity|数量|用量|个数|count/.test(key)) result.qtyIndex = index
    else if (result.designatorsIndex === undefined && /designator|ref ?des|references|位号/.test(key)) result.designatorsIndex = index
    else if (result.commentIndex === undefined && /comment|description|name|名称|注释|value|型号/.test(key)) result.commentIndex = index
    else if (result.footprintIndex === undefined && /footprint|package|封装/.test(key)) result.footprintIndex = index
  })
  return { hasCode: result.codeIndex !== undefined, ...result }
}

/**
 * Pick the column that actually holds LCSC codes when the header names are
 * unrecognised (the standard 立创EDA / JLCPCB BOM export uses "Supplier Part",
 * which older builds did not match — the row scanner then mistook footprints
 * such as `C0603` for part numbers).
 *
 * Scores by share of `/^C\d{4,8}$/` values, breaking ties by the number of
 * distinct codes and then by the right-most column, so a footprint column
 * ("C0603" repeated, few distinct) never wins over the supplier column.
 * @param {string[][]} rows data rows, header excluded
 * @returns {number | undefined}
 */
function detectCodeColumn(rows) {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
  /** @type {{ index: number, ratio: number, distinct: number } | undefined} */
  let best
  for (let index = 0; index < width; index += 1) {
    let matched = 0
    let filled = 0
    const distinct = new Set()
    for (const row of rows) {
      const value = (row[index] ?? '').trim()
      if (value === '') continue
      filled += 1
      if (/^C\d{4,8}$/i.test(value)) {
        matched += 1
        distinct.add(value.toUpperCase())
      }
    }
    if (filled === 0 || matched < 2) continue
    const ratio = matched / filled
    if (ratio < 0.6) continue
    const better =
      best === undefined ||
      ratio > best.ratio + 1e-9 ||
      (Math.abs(ratio - best.ratio) < 1e-9 &&
        (distinct.size > best.distinct || (distinct.size === best.distinct && index > best.index)))
    if (better) best = { index, ratio, distinct: distinct.size }
  }
  return best === undefined ? undefined : best.index
}

/**
 * Pick the quantity column when it is not named recognisably: the right-most
 * column that is almost entirely positive integers. Preferring the right-most
 * match keeps `Quantity` ahead of a leading row-id column.
 * @param {string[][]} rows
 * @param {number} excludeIndex
 * @returns {number | undefined}
 */
function detectQuantityColumn(rows, excludeIndex) {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
  /** @type {{ index: number, ratio: number } | undefined} */
  let best
  for (let index = 0; index < width; index += 1) {
    if (index === excludeIndex) continue
    let positive = 0
    let filled = 0
    for (const row of rows) {
      const value = (row[index] ?? '').trim()
      if (value === '') continue
      filled += 1
      const number = Number(value)
      if (Number.isInteger(number) && number > 0) positive += 1
    }
    if (filled === 0 || positive < 2) continue
    const ratio = positive / filled
    if (ratio < 0.8) continue
    if (best === undefined || ratio > best.ratio || (ratio === best.ratio && index > best.index)) best = { index, ratio }
  }
  return best === undefined ? undefined : best.index
}

/** @param {unknown} value @returns {number} */
function parseQty(value) {
  const number = asNumber(value)
  if (number === undefined || !Number.isFinite(number) || number <= 0) return 1
  return Math.floor(number)
}

/**
 * @param {number | undefined} index
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
function optionally(index, value) {
  if (index === undefined) return undefined
  return asString(value)
}

/**
 * Normalize an LCSC part code: trim, uppercase, accept a bare `668215`.
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function normalizeCode(value) {
  const text = asString(value)?.toUpperCase().replace(/^C/i, 'C').replace(/\s+/g, '')
  if (text === undefined) return undefined
  if (LCSC_CODE_RE.test(text)) return text
  if (/^\d{4,8}$/.test(text)) return `C${text}`
  return undefined
}

/* -------------------------------------------------------------------------- */
/* TTL cache + in-flight de-duplication                                      */
/* -------------------------------------------------------------------------- */

class TtlCache {
  /**
   * @param {{ ttlMs: number, maxEntries: number }} options
   */
  constructor({ ttlMs, maxEntries }) {
    this.ttlMs = ttlMs
    this.maxEntries = maxEntries
    /** @type {Map<string, { expiresAt: number, value: unknown }>} */
    this.entries = new Map()
    /** @type {Map<string, Promise<unknown>>} */
    this.inflight = new Map()
  }

  /** @param {string} key */
  get(key) {
    const hit = this.entries.get(key)
    if (hit === undefined) return undefined
    if (hit.expiresAt < Date.now()) {
      this.entries.delete(key)
      return undefined
    }
    // Refresh recency for LRU-ish eviction.
    this.entries.delete(key)
    this.entries.set(key, hit)
    return hit.value
  }

  /**
   * @param {string} key
   * @param {unknown} value
   */
  set(key, value) {
    this.entries.set(key, { expiresAt: Date.now() + this.ttlMs, value })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
    }
  }

  /**
   * Run `load` once per key even when several callers race (a BOM often lists
   * the same part twice).
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} load
   * @returns {Promise<T>}
   */
  async dedupe(key, load) {
    const cached = this.get(key)
    if (cached !== undefined) return /** @type {T} */ (cached)
    const running = this.inflight.get(key)
    if (running !== undefined) return /** @type {T} */ (running)
    const promise = load()
      .then((value) => {
        this.set(key, value)
        return value
      })
      .finally(() => this.inflight.delete(key))
    this.inflight.set(key, promise)
    return /** @type {Promise<T>} */ (promise)
  }

  clear() {
    this.entries.clear()
    this.inflight.clear()
  }

  get size() {
    return this.entries.size
  }
}

/* -------------------------------------------------------------------------- */
/* Data-layer service                                                        */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {object} LcscService
 * @property {(keyword: string, limit?: number, options?: { signal?: AbortSignal }) => Promise<Record<string, unknown>>} search
 * @property {(code: string, options?: { signal?: AbortSignal, includeCny?: boolean }) => Promise<Record<string, unknown>>} part
 * @property {(input: unknown, options?: { signal?: AbortSignal, includeCny?: boolean }) => Promise<Record<string, unknown>>} checkBom
 * @property {() => void} clearCache
 * @property {() => number} cacheSize
 */

/**
 * Build the LCSC data service. No DSH dependency: usable from plain Node
 * (see `poc/validate.mjs`).
 * @param {LcscServiceOptions} [options]
 * @returns {LcscService}
 */
export function createLcscService(options = {}) {
  const settings = normalizeConfig(options)
  const cache = new TtlCache({ ttlMs: settings.cacheTtlMs, maxEntries: settings.cacheMaxEntries })
  const requestOptions = {
    timeoutMs: settings.timeoutMs,
    retries: settings.retries,
    retryBaseMs: settings.retryBaseMs,
    fetchImpl: settings.fetchImpl,
  }

  /* ------------------------------ JLCPCB search ------------------------------ */

  /**
   * @param {string} keyword
   * @param {number} pageSize
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ total: number, items: Record<string, unknown>[] }>}
   */
  async function jlcSearchRaw(keyword, pageSize, signal) {
    const key = `jlc:search:${pageSize}:${keyword.toLowerCase()}`
    return /** @type {Promise<{ total: number, items: Record<string, unknown>[] }>} */ (
      cache.dedupe(key, async () => {
        const payload = await requestJson(JLC_SEARCH_URL, {
          ...requestOptions,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Origin: 'https://jlcpcb.com',
            Referer: 'https://jlcpcb.com/',
            'User-Agent': settings.userAgent,
          },
          body: JSON.stringify({ keyword, currentPage: 1, pageSize }),
          signal,
        })
        if (!isRecord(payload)) throw new Error('JLCPCB search returned a non-object JSON body')
        const data = payload.data
        const pageInfo = isRecord(data) && isRecord(data.componentPageInfo) ? data.componentPageInfo : undefined
        if (pageInfo === undefined) throw new Error('JLCPCB search response is missing data.componentPageInfo')
        const total = asInteger(pageInfo.total) ?? 0
        const items = Array.isArray(pageInfo.list) ? pageInfo.list.map(normalizeJlcItem).filter(Boolean) : []
        return { total, items: /** @type {Record<string, unknown>[]} */ (items) }
      })
    )
  }

  /**
   * Raw paginated JLCPCB SMT search with an optional basic/extended library
   * filter. Used by the requirement-driven finder, which needs a wide candidate
   * pool (up to 100 per page) instead of the small `search()` preview.
   * @param {string} keyword
   * @param {{ pageSize?: number, currentPage?: number, libraryType?: 'base'|'expand'|'all', signal?: AbortSignal }} [options]
   * @returns {Promise<{ total: number, items: Record<string, unknown>[] }>}
   */
  async function searchRaw(keyword, options = {}) {
    const text = asString(keyword)
    if (text === undefined || text === '') throw new Error('searchRaw requires a non-empty keyword string')
    const pageSize = clampInteger(options.pageSize ?? 100, 1, 100)
    const currentPage = clampInteger(options.currentPage ?? 1, 1, 10)
    const libraryType =
      options.libraryType === 'base' || options.libraryType === 'expand' ? options.libraryType : undefined
    const key = `jlc:raw:${pageSize}:${currentPage}:${libraryType ?? 'all'}:${text.toLowerCase()}`
    return /** @type {Promise<{ total: number, items: Record<string, unknown>[] }>} */ (
      cache.dedupe(key, async () => {
        /** @type {Record<string, unknown>} */
        const body = { keyword: text, currentPage, pageSize }
        if (libraryType !== undefined) body.componentLibraryType = libraryType
        const payload = await requestJson(JLC_SEARCH_URL, {
          ...requestOptions,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Origin: 'https://jlcpcb.com',
            Referer: 'https://jlcpcb.com/',
            'User-Agent': settings.userAgent,
          },
          body: JSON.stringify(body),
          signal: options.signal,
        })
        if (!isRecord(payload)) throw new Error('JLCPCB search returned a non-object JSON body')
        const data = payload.data
        const pageInfo = isRecord(data) && isRecord(data.componentPageInfo) ? data.componentPageInfo : undefined
        if (pageInfo === undefined) throw new Error('JLCPCB search response is missing data.componentPageInfo')
        const total = asInteger(pageInfo.total) ?? 0
        const items = Array.isArray(pageInfo.list) ? pageInfo.list.map(normalizeJlcItem).filter(Boolean) : []
        return { total, items: /** @type {Record<string, unknown>[]} */ (items) }
      })
    )
  }

  /**
   * Search candidates by part number / LCSC code / English keyword.
   * @param {string} keyword
   * @param {number} [limit]
   * @param {{ signal?: AbortSignal }} [callOptions]
   */
  async function search(keyword, limit = 10, callOptions = {}) {
    const text = asString(keyword)
    if (text === undefined) throw new Error('lcsc_search requires a non-empty keyword string')
    const size = clampInteger(limit ?? 10, 1, 50)
    // Over-fetch a little: JLCPCB returns non-LCSC internal codes that we drop.
    const { total, items } = await jlcSearchRaw(text, Math.min(50, size * 3), callOptions.signal)
    const candidates = items.slice(0, size)
    const hints = []
    if (total === 0) {
      hints.push(
        'No component matched. Try an exact part number (e.g. TP4054), an English keyword, or an LCSC code like C668215; Chinese-only keywords often return nothing from this API.',
      )
    }
    if (total > 0 && candidates.length === 0) {
      hints.push('Matches existed but none carried a valid LCSC code; refine the keyword.')
    }
    if (items.length > candidates.length) {
      hints.push(`Showing ${candidates.length} of ${total} matches; raise \`limit\` for more.`)
    }
    const codeMatch = normalizeCode(text)
    if (codeMatch !== undefined) {
      hints.push(`For full stock and price data on ${codeMatch}, call lcsc_part with codes ["${codeMatch}"].`)
    }
    return {
      keyword: text,
      total,
      returned: candidates.length,
      candidates: candidates.map((candidate) => ({
        ...candidate,
        currency: 'USD',
        priceBasis: 'JLCPCB SMT parts API (USD ladder by quantity)',
      })),
      currencyNotes: [...CURRENCY_NOTES],
      hints,
      fetchedAt: new Date().toISOString(),
    }
  }

  /* --------------------------- LCSC international page ---------------------- */

  /**
   * @param {string} code
   * @param {AbortSignal} [signal]
   */
  async function lcscProductPage(code, signal) {
    const key = `lcsc.com:${code}`
    return /** @type {Promise<{ dataIsNull: boolean, webData: Record<string, unknown> | undefined } | undefined>} */ (
      cache.dedupe(key, async () => {
        const { text } = await request(`${LCSC_PRODUCT_URL}${code}.html`, {
          ...requestOptions,
          headers: { ...HTML_HEADERS, 'User-Agent': settings.userAgent },
          signal,
        })
        if (isWafChallenge(text)) throw new SourceBlockedError('lcsc.com', 'waf-challenge')
        const nextData = parseNextData(text)
        if (nextData === undefined) throw new SourceBlockedError('lcsc.com', 'no-next-data')
        const pageProps = pagePropsOf(nextData)
        if (pageProps === undefined) throw new SourceBlockedError('lcsc.com', 'no-page-props')
        return normalizeLcscProduct(pageProps)
      })
    )
  }

  /* --------------------------------- EasyEDA -------------------------------- */

  /**
   * @param {string} code
   * @param {AbortSignal} [signal]
   * @returns {Promise<Record<string, unknown> | undefined>}
   */
  async function easyedaProduct(code, signal) {
    const key = `easyeda:${code}`
    return /** @type {Promise<Record<string, unknown> | undefined>} */ (
      cache.dedupe(key, async () => {
        try {
          const payload = await requestJson(`${EASYEDA_PRODUCT_URL}${code}/components`, {
            ...requestOptions,
            retries: 0,
            headers: { Accept: 'application/json', 'User-Agent': settings.userAgent },
            signal,
          })
          if (!isRecord(payload) || payload.success !== true) {
            const code404 = isRecord(payload) && payload.code === 404
            if (code404) return undefined
            throw new Error(`EasyEDA API error for ${code}: ${JSON.stringify(payload).slice(0, 200)}`)
          }
          return isRecord(payload.result) ? payload.result : undefined
        } catch (error) {
          if (error instanceof HttpError && error.status === 404) return undefined
          throw error
        }
      })
    )
  }

  /* ------------------------- LCSC domestic (CNY, optional) ------------------ */

  /**
   * CNY 1-pc price + domestic stock from item.szlcsc.com, reached through the
   * EasyEDA product API's `szlcsc.id`. Degrades to a blocked/absent result when
   * the Aliyun WAF challenges the request; never throws for that case.
   * @param {string} code
   * @param {AbortSignal} [signal]
   */
  async function cnyQuote(code, signal) {
    const key = `szlcsc:${code}`
    return /** @type {Promise<Record<string, unknown>>} */ (
      cache.dedupe(key, async () => {
        const fallback = {}
        let easyeda
        try {
          easyeda = await easyedaProduct(code, signal)
        } catch (error) {
          return { ok: false, reason: `easyeda-unavailable: ${messageOf(error)}`, ...fallback }
        }
        if (easyeda === undefined) return { ok: false, reason: 'easyeda-not-found', ...fallback }
        const szlcsc = isRecord(easyeda.szlcsc) ? easyeda.szlcsc : undefined
        const productId = szlcsc === undefined ? undefined : asInteger(szlcsc.id)
        const edaPrice = szlcsc === undefined ? undefined : asNumber(szlcsc.price)
        const edaStock = szlcsc === undefined ? undefined : asInteger(szlcsc.stock)
        if (productId === undefined) return { ok: false, reason: 'no-szlcsc-id', ...fallback }
        let challengeSeen = false
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const { text } = await request(`${SZLCSC_ITEM_URL}${productId}.html`, {
              ...requestOptions,
              retries: 0,
              headers: { ...CN_HTML_HEADERS, 'User-Agent': settings.userAgent },
              signal,
            })
            if (isWafChallenge(text)) {
              challengeSeen = true
              await sleep(400, signal)
              continue
            }
            const nextData = parseNextData(text)
            const pageProps = pagePropsOf(nextData)
            if (pageProps === undefined) {
              challengeSeen = true
              await sleep(400, signal)
              continue
            }
            const unit = asNumber(pageProps.price)
            const webData = isRecord(pageProps.webData) ? pageProps.webData : undefined
            const productRecord = webData === undefined ? undefined : webData.productRecord
            const stock =
              (isRecord(productRecord) ? asInteger(productRecord.stockNumber) : undefined) ??
              (isRecord(webData) ? asInteger(webData.totalStockNumber) : undefined)
            const model = isRecord(productRecord) ? asString(productRecord.productModel) : undefined
            const encapsulation =
              isRecord(productRecord) ? asString(productRecord.encapsulationModel) : undefined
            const params = isRecord(webData) && Array.isArray(webData.paramList)
              ? webData.paramList.filter(isRecord).map((param) => ({
                  name: asString(param.parameterName),
                  value: asString(param.parameterValue) ?? asString(param.parameterDetailValue),
                })).filter((param) => param.name !== undefined)
              : []
            return clean({
              ok: true,
              currency: 'CNY',
              unit,
              easyedaUnitPrice: edaPrice,
              stock: stock ?? edaStock,
              szlcscId: productId,
              model,
              package: encapsulation,
              url: `${SZLCSC_ITEM_URL}${productId}.html`,
              params,
              note: 'CNY price is the 1-pc list price shown on the LCSC domestic site (item.szlcsc.com).',
            })
          } catch (error) {
            return {
              ok: false,
              reason: `szlcsc-unavailable: ${messageOf(error)}`,
              szlcscId: productId,
              easyedaUnitPrice: edaPrice,
              easyedaStock: edaStock,
            }
          }
        }
        return {
          ok: false,
          reason: challengeSeen ? 'szlcsc-waf-challenge' : 'szlcsc-unavailable',
          szlcscId: productId,
          easyedaUnitPrice: edaPrice,
          easyedaStock: edaStock,
        }
      })
    )
  }

  /* ------------------------------- Part detail ------------------------------ */

  /**
   * @param {string} code
   * @param {{ signal?: AbortSignal, includeCny?: boolean }} [callOptions]
   */
  async function part(code, callOptions = {}) {
    const normalized = normalizeCode(code)
    if (normalized === undefined) {
      return clean({
        code: String(code ?? ''),
        status: 'NOT-FOUND',
        error: `invalid LCSC code ${JSON.stringify(code)}: expected C followed by 4-8 digits (e.g. C668215)`,
        fetchedAt: new Date().toISOString(),
      })
    }
    const signal = callOptions.signal
    const includeCny = callOptions.includeCny !== false
    const [lcscResult, jlcResult, maybeCny] = await Promise.all([
      settle(lcscProductPage(normalized, signal)),
      settle(exactJlc(normalized, signal)),
      includeCny ? settle(cnyQuote(normalized, signal)) : Promise.resolve({ status: 'skipped' }),
    ])

    /** @type {string[]} */
    const degraded = []
    const cnyState = !includeCny
      ? { ok: false, reason: 'skipped' }
      : maybeCny.status === 'rejected'
        ? { ok: false, reason: messageOf(maybeCny.reason) }
        : isRecord(maybeCny.value) && maybeCny.value.ok === true
          ? { ok: true }
          : { ok: false, reason: isRecord(maybeCny.value) ? String(maybeCny.value.reason ?? 'unavailable') : 'unavailable' }
    const lcscState = lcscResult.status === 'fulfilled'
      ? { ok: true, ...(lcscResult.value?.dataIsNull === true ? { dataIsNull: true, reason: 'domestic-only' } : {}) }
      : { ok: false, reason: messageOf(lcscResult.reason) }
    const sources = {
      'lcsc.com': lcscState,
      jlcpcb: sourceState(jlcResult),
      'item.szlcsc.com': cnyState,
    }
    const intl = lcscResult.status === 'fulfilled' ? lcscResult.value : undefined
    const jlc = jlcResult.status === 'fulfilled' ? jlcResult.value : undefined
    const cny = includeCny && maybeCny.status === 'fulfilled' ? maybeCny.value : undefined

    if (lcscResult.status === 'rejected') degraded.push(`lcsc.com:${messageOf(lcscResult.reason)}`)
    if (jlcResult.status === 'rejected') degraded.push(`jlcpcb:${messageOf(jlcResult.reason)}`)
    if (includeCny && maybeCny.status === 'rejected') degraded.push(`item.szlcsc.com:${messageOf(maybeCny.reason)}`)
    if (intl !== undefined && intl.dataIsNull) degraded.push('lcsc.com:domestic-only')
    if (cny !== undefined && cny.ok === false && cny.reason !== undefined) {
      degraded.push(`item.szlcsc.com:${cny.reason}`)
    }

    const webData = intl?.webData
    const identity = mergeIdentity(webData, jlc, cny, degraded)

    /** @type {{ qty: number, unit: number }[]} */
    const usdTiers = webData !== undefined ? usdTiersFromLcscProduct(webData) : []
    const jlcTiers = Array.isArray(jlc?.priceUsdTiers) ? jlc.priceUsdTiers : []
    const usd = webData !== undefined && usdTiers.length > 0
      ? {
          currency: 'USD',
          source: 'lcsc.com',
          tiers: usdTiers,
          note: 'USD ladder price from the LCSC international site, by order quantity.',
        }
      : jlc !== undefined && jlcTiers.length > 0
        ? {
            currency: 'USD',
            source: 'jlcpcb',
            tiers: jlcTiers,
            note: 'USD ladder price from JLCPCB SMT parts API; used because lcsc.com had no price for this part.',
          }
        : undefined
    const cnyPrice = cny !== undefined && cny.ok === true && cny.unit !== undefined
      ? {
          currency: 'CNY',
          source: 'item.szlcsc.com',
          unit: cny.unit,
          note: 'CNY 1-pc list price from the LCSC domestic site (optional enrichment).',
        }
      : undefined

    const intlStock = webData === undefined ? undefined : asInteger(webData.stockNumber)
    const domesticStock = cny?.ok === true ? asInteger(cny.stock) : undefined
    const jlcStock = jlc === undefined ? undefined : asInteger(jlc.stock)
    const knownStocks = [intlStock, domesticStock, jlcStock].filter((value) => value !== undefined)
    const available = knownStocks.length === 0 ? undefined : Math.min(...knownStocks)

    const stock = {
      available,
      basis:
        knownStocks.length === 0
          ? 'unknown'
          : 'minimum of the stock counts reported by each queried source (conservative)',
      intl: intlStock === undefined ? undefined : { count: intlStock, source: 'lcsc.com' },
      domestic: domesticStock === undefined ? undefined : { count: domesticStock, source: 'item.szlcsc.com' },
      jlcpcb: jlcStock === undefined ? undefined : { count: jlcStock, source: 'jlcpcb-smt' },
    }

    const found =
      webData !== undefined ||
      (jlc !== undefined && jlc.stock !== undefined) ||
      (cny !== undefined && cny.ok === true) ||
      identity.model !== undefined
    let status
    if (!found) status = 'NOT-FOUND'
    else if (available === 0) status = 'OUT-OF-STOCK'
    else if (available === undefined) status = 'UNKNOWN-STOCK'
    else status = 'OK'

    return clean({
      code: normalized,
      status,
      identity,
      package: identity.package,
      stock,
      prices: {
        usd,
        cny: cnyPrice,
        easyedaReference:
          cny !== undefined && (cny.easyedaUnitPrice !== undefined || cny.easyedaStock !== undefined)
            ? {
                note: 'Reference values from the EasyEDA product API; not used for totals.',
                szlcscUnitPrice: cny.easyedaUnitPrice,
                szlcscStock: cny.easyedaStock,
              }
            : undefined,
        currencyNotes: [...CURRENCY_NOTES],
      },
      attributes: mergeAttributes(jlc, cny, webData),
      urls: {
        lcsc: `${LCSC_PRODUCT_URL}${normalized}.html`,
        szlcsc: cny?.szlcscId === undefined ? undefined : `${SZLCSC_ITEM_URL}${cny.szlcscId}.html`,
        jlcpcb: jlc?.url,
      },
      datasheetUrl: asString(jlc?.datasheetUrl) ?? (webData === undefined ? undefined : asString(webData.pdfUrl)),
      libraryType: jlc?.libraryType,
      minPurchaseNum: jlc?.minPurchaseNum,
      sources,
      degraded,
      fetchedAt: new Date().toISOString(),
    })
  }

  /**
   * Exact JLCPCB match for one LCSC code (the search API is fuzzy).
   * @param {string} code
   * @param {AbortSignal} [signal]
   */
  async function exactJlc(code, signal) {
    const key = `jlc:exact:${code}`
    return /** @type {Promise<Record<string, unknown> | undefined>} */ (
      cache.dedupe(key, async () => {
        let payload
        try {
          payload = await jlcSearchRaw(code, 20, signal)
        } catch (error) {
          throw error
        }
        const match = payload.items.find((item) => item.code === code)
        return match === undefined ? undefined : match
      })
    )
  }

  /* --------------------------------- BOM ----------------------------------- */

  /**
   * Verify a BOM: array of `{ code, qty, … }` rows, or CSV / TSV BOM text.
   * @param {unknown} input
   * @param {{ signal?: AbortSignal, includeCny?: boolean, concurrency?: number }} [callOptions]
   */
  async function checkBom(input, callOptions = {}) {
    const { rows, parseError } = parseBomInput(input)
    if (parseError !== undefined) {
      return clean({
        summary: { total: 0, verified: 0, noStock: 0, notFound: 0, unknownStock: 0, failed: 0, totalQty: 0 },
        rows: [],
        errors: [parseError],
        currencyNotes: [...CURRENCY_NOTES],
        fetchedAt: new Date().toISOString(),
      })
    }
    if (rows.length === 0) {
      return clean({
        summary: { total: 0, verified: 0, noStock: 0, notFound: 0, unknownStock: 0, failed: 0, totalQty: 0 },
        rows: [],
        errors: ['no BOM rows were found; pass rows or CSV text with LCSC codes (e.g. C668215,2)'],
        currencyNotes: [...CURRENCY_NOTES],
        fetchedAt: new Date().toISOString(),
      })
    }
    const concurrency = clampInteger(callOptions.concurrency ?? 4, 1, 8)
    /** @type {Record<string, unknown>[]} */
    const outRows = new Array(rows.length)
    let cursor = 0
    /** @type {Promise<void>[]} */
    const workers = []
    for (let worker = 0; worker < Math.min(concurrency, rows.length); worker += 1) {
      workers.push(
        (async () => {
          while (true) {
            const index = cursor
            cursor += 1
            if (index >= rows.length) return
            const row = rows[index]
            try {
              const detail = await part(row.code, {
                signal: callOptions.signal,
                includeCny: callOptions.includeCny !== false,
              })
              outRows[index] = bomRow(row, detail)
            } catch (error) {
              outRows[index] = clean({
                line: row.line,
                code: row.code,
                qty: row.qty,
                designators: row.designators,
                comment: row.comment,
                status: 'CHECK-FAILED',
                messages: [`lookup failed: ${messageOf(error)}`],
              })
            }
          }
        })(),
      )
    }
    await Promise.all(workers)

    const summary = {
      total: outRows.length,
      verified: 0,
      noStock: 0,
      notFound: 0,
      unknownStock: 0,
      failed: 0,
      totalQty: 0,
      estimatedUsd: 0,
      estimatedCny: 0,
      usdCoveredRows: 0,
      cnyCoveredRows: 0,
      currencyNotes: [...CURRENCY_NOTES],
    }
    for (const row of outRows) {
      const status = row.status
      if (status === 'verified') summary.verified += 1
      else if (status === 'NO-STOCK') summary.noStock += 1
      else if (status === 'NOT-FOUND') summary.notFound += 1
      else if (status === 'UNKNOWN-STOCK') summary.unknownStock += 1
      else summary.failed += 1
      summary.totalQty += typeof row.qty === 'number' ? row.qty : 0
      if (typeof row.subtotalUsd === 'number') {
        summary.estimatedUsd = money(summary.estimatedUsd + row.subtotalUsd)
        summary.usdCoveredRows += 1
      }
      if (typeof row.subtotalCny === 'number') {
        summary.estimatedCny = money(summary.estimatedCny + row.subtotalCny)
        summary.cnyCoveredRows += 1
      }
    }
    if (summary.usdCoveredRows === 0) summary.estimatedUsd = undefined
    if (summary.cnyCoveredRows === 0) summary.estimatedCny = undefined
    const notes = []
    if (summary.usdCoveredRows < summary.total) {
      notes.push(`${summary.usdCoveredRows}/${summary.total} rows have a USD price; the USD total covers only those rows.`)
    }
    if (summary.cnyCoveredRows < summary.total) {
      notes.push(`${summary.cnyCoveredRows}/${summary.total} rows have a CNY price; the CNY total covers only those rows.`)
    }
    return clean({
      summary,
      rows: outRows,
      notes,
      currencyNotes: [...CURRENCY_NOTES],
      fetchedAt: new Date().toISOString(),
    })
  }

  /**
   * Normalize a BOM input into rows.
   * @param {unknown} input
   */
  function parseBomInput(input) {
    if (typeof input === 'string') {
      const rows = parseBomCsv(input)
      return { rows }
    }
    if (!Array.isArray(input)) {
      return { rows: [], parseError: 'bom_check expects an array of rows or CSV text' }
    }
    /** @type {{ line: number, code: string, qty: number, designators?: string, comment?: string, footprint?: string }[]} */
    const rows = []
    input.forEach((raw, index) => {
      /** @type {Record<string, unknown>} */
      let record = {}
      if (typeof raw === 'string') record = { code: raw }
      else if (isRecord(raw)) record = raw
      else return
      const lookup = lowerKeyed(record)
      const code = normalizeCode(
        lookup.code ?? lookup.lcsc ?? lookup.lcscpart ?? lookup.lcscpartnumber ?? lookup.partnumber ?? lookup.part ?? lookup['料号'] ?? lookup['编号'],
      )
      if (code === undefined) {
        rows.push({ line: index + 1, code: '', qty: 1, comment: asString(lookup.comment) })
        return
      }
      rows.push(
        clean({
          line: asNumber(lookup.line) !== undefined ? Number(lookup.line) : index + 1,
          code,
          qty: parseQty(lookup.qty ?? lookup.quantity ?? lookup['数量'] ?? lookup['用量'] ?? lookup.count),
          designators: asString(lookup.designators ?? lookup.designator ?? lookup.refdes ?? lookup['位号']),
          comment: asString(lookup.comment ?? lookup.description ?? lookup['名称']),
          footprint: asString(lookup.footprint ?? lookup.package ?? lookup['封装']),
        }),
      )
    })
    return { rows }
  }

  /**
   * @param {{ line: number, code: string, qty: number, designators?: string, comment?: string, footprint?: string }} row
   * @param {Record<string, unknown>} detail
   */
  function bomRow(row, detail) {
    const qty = row.qty ?? 1
    if (row.code === '') {
      return clean({
        line: row.line,
        code: '',
        qty,
        designators: row.designators,
        comment: row.comment,
        status: 'NOT-FOUND',
        messages: ['row has no valid LCSC code'],
      })
    }
    const detailStatus = detail.status
    const usd = isRecord(detail.prices) && isRecord(detail.prices.usd) ? detail.prices.usd : undefined
    const cny = isRecord(detail.prices) && isRecord(detail.prices.cny) ? detail.prices.cny : undefined
    const tiers = usd !== undefined && Array.isArray(usd.tiers) ? usd.tiers : []
    const unitUsd = pickTierPrice(/** @type {{qty:number,unit:number}[]} */ (tiers), qty)
    const unitCny = cny === undefined ? undefined : asNumber(cny.unit)
    const messages = []
    if (detailStatus === 'NOT-FOUND') messages.push('LCSC code was not found in any queried source')
    if (detailStatus === 'OUT-OF-STOCK') messages.push('reported stock is zero')
    if (detailStatus === 'UNKNOWN-STOCK') messages.push('stock count is unknown; confirm before ordering')
    if (detailStatus === 'OK' && detail.stock?.available !== undefined && detail.stock.available < qty) {
      messages.push(`reported stock ${detail.stock.available} is below the required quantity ${qty}`)
    }
    let status = 'verified'
    if (detailStatus === 'NOT-FOUND') status = 'NOT-FOUND'
    else if (detailStatus === 'OUT-OF-STOCK') status = 'NO-STOCK'
    else if (detailStatus === 'UNKNOWN-STOCK') status = 'UNKNOWN-STOCK'
    else if (detail.stock?.available !== undefined && detail.stock.available < qty) status = 'NO-STOCK'
    return clean({
      line: row.line,
      code: row.code,
      qty,
      designators: row.designators,
      comment: row.comment,
      footprint: row.footprint,
      status,
      statusDetail: detailStatus,
      model: isRecord(detail.identity) ? detail.identity.model : undefined,
      availableStock: isRecord(detail.stock) ? detail.stock.available : undefined,
      stockBreakdown: isRecord(detail.stock) ? detail.stock : undefined,
      libraryType: detail.libraryType,
      unitUsd,
      subtotalUsd: unitUsd === undefined ? undefined : money(unitUsd * qty),
      unitCny,
      subtotalCny: unitCny === undefined ? undefined : money(unitCny * qty),
      usdSource: usd === undefined ? undefined : usd.source,
      cnySource: cny === undefined ? undefined : cny.source,
      datasheetUrl: detail.datasheetUrl,
      url: isRecord(detail.urls) ? detail.urls.lcsc : undefined,
      degraded: detail.degraded,
      messages,
    })
  }

  return {
    search,
    searchRaw,
    part,
    cny: cnyQuote,
    checkBom,
    clearCache() {
      cache.clear()
    },
    cacheSize() {
      return cache.size
    },
    settings,
  }
}

/* -------------------------------------------------------------------------- */
/* Service helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Validate/normalize the row `config`. Without a schemastery `Config` export
 * (zero dependencies), invalid values fall back to defaults and are reported
 * to the caller.
 * @param {unknown} raw
 * @param {{ onWarning?: (message: string) => void }} [options]
 * @returns {Required<Omit<LcscServiceOptions, 'fetchImpl'>> & { fetchImpl?: typeof fetch }}
 */
export function normalizeConfig(raw, options = {}) {
  const warn = options.onWarning ?? (() => {})
  const source = isRecord(raw) ? raw : {}
  if (raw !== undefined && raw !== null && !isRecord(raw)) warn('config must be an object; using defaults')
  const known = new Set(Object.keys(DEFAULT_CONFIG))
  for (const key of Object.keys(source)) {
    if (key === 'fetchImpl') continue
    if (!known.has(key)) warn(`unknown config key ${JSON.stringify(key)} is ignored`)
  }
  /**
   * @param {string} key
   * @param {number} fallback
   * @param {number} min
   * @param {number} max
   * @param {boolean} [integer]
   */
  const number = (key, fallback, min, max, integer = true) => {
    const value = asNumber(source[key])
    if (source[key] === undefined) return fallback
    if (value === undefined || value < min || value > max || (integer && !Number.isInteger(value))) {
      warn(`config.${key}=${JSON.stringify(source[key])} is invalid; using ${fallback}`)
      return fallback
    }
    return value
  }
  const verbose = typeof source.verbose === 'boolean' ? source.verbose : DEFAULT_CONFIG.verbose
  const userAgent = asString(source.userAgent) ?? DEFAULT_USER_AGENT
  const fetchImpl = typeof source.fetchImpl === 'function' ? source.fetchImpl : undefined
  const factorValue = asNumber(source.usdToCnyFactor)
  let usdToCnyFactor = DEFAULT_CONFIG.usdToCnyFactor
  if (source.usdToCnyFactor !== undefined) {
    if (factorValue === undefined || factorValue < 0.5 || factorValue > 20) {
      warn(`config.usdToCnyFactor=${JSON.stringify(source.usdToCnyFactor)} is invalid; using ${DEFAULT_CONFIG.usdToCnyFactor}`)
    } else {
      usdToCnyFactor = factorValue
    }
  }
  return {
    timeoutMs: number('timeoutMs', DEFAULT_CONFIG.timeoutMs, 100, 60000),
    retries: number('retries', DEFAULT_CONFIG.retries, 0, 10),
    retryBaseMs: number('retryBaseMs', DEFAULT_CONFIG.retryBaseMs, 0, 10000),
    cacheTtlMs: number('cacheTtlMs', DEFAULT_CONFIG.cacheTtlMs, 0, 24 * 60 * 60 * 1000),
    cacheMaxEntries: number('cacheMaxEntries', DEFAULT_CONFIG.cacheMaxEntries, 1, 10000),
    verbose,
    userAgent,
    fetchImpl,
    usdToCnyFactor,
  }
}

/** @param {unknown} reason @returns {string} */
function messageOf(reason) {
  if (reason instanceof Error) return reason.message
  return String(reason)
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @returns {Promise<PromiseSettledResult<T>>}
 */
function settle(promise) {
  return promise.then(
    (value) => /** @type {PromiseFulfilledResult<T>} */ ({ status: 'fulfilled', value }),
    (reason) => /** @type {PromiseRejectedResult} */ ({ status: 'rejected', reason }),
  )
}

/**
 * @param {{ status: 'fulfilled' | 'rejected', value?: unknown, reason?: unknown }} settled
 */
function sourceState(settled) {
  if (settled.status === 'fulfilled') {
    return settled.value === undefined
      ? { ok: false, reason: 'not-found' }
      : { ok: true }
  }
  return { ok: false, reason: messageOf(settled.reason) }
}

/**
 * @param {unknown} webData
 * @param {Record<string, unknown> | undefined} jlc
 * @param {Record<string, unknown> | undefined} cny
 * @param {string[]} degraded
 */
function mergeIdentity(webData, jlc, cny, degraded) {
  const fromLcsc = isRecord(webData)
    ? {
        model: asString(webData.productModel),
        brand: asString(webData.brandNameEn),
        package: asString(webData.encapStandard),
        category: asString(webData.catalogName),
        description: asString(webData.productNameEn),
        minBuyNumber: asInteger(webData.minBuyNumber),
        unit: asString(webData.productUnit),
      }
    : {}
  const fromJlc = isRecord(jlc)
    ? {
        model: asString(jlc.model),
        brand: asString(jlc.brand),
        package: asString(jlc.package),
        category: asString(jlc.category),
        description: asString(jlc.description),
        libraryType: asString(jlc.libraryType),
      }
    : {}
  const fromCny = isRecord(cny) && cny.ok === true
    ? {
        model: asString(cny.model),
        package: asString(cny.package),
      }
    : {}
  const identity = clean({
    model: fromLcsc.model ?? fromJlc.model ?? fromCny.model,
    brand: fromLcsc.brand ?? fromJlc.brand,
    package: fromLcsc.package ?? fromJlc.package ?? fromCny.package,
    category: fromLcsc.category ?? fromJlc.category,
    description: fromLcsc.description ?? fromJlc.description,
    libraryType: fromJlc.libraryType,
    unit: fromLcsc.unit,
    minBuyNumber: fromLcsc.minBuyNumber,
  })
  if (identity.model === undefined) degraded.push('identity:model-missing')
  return identity
}

/**
 * @param {Record<string, unknown> | undefined} jlc
 * @param {Record<string, unknown> | undefined} cny
 * @param {unknown} webData
 */
function mergeAttributes(jlc, cny, webData) {
  const english = isRecord(jlc) && Array.isArray(jlc.attributes)
    ? jlc.attributes.filter(isRecord).map((attribute) => ({
        name: attribute.name,
        value: attribute.value,
      })).filter((attribute) => attribute.name !== undefined)
    : []
  const chinese = isRecord(cny) && Array.isArray(cny.params)
    ? cny.params.filter(isRecord).map((param) => ({ name: param.name, value: param.value })).filter((param) => param.name !== undefined)
    : []
  const keyAttributes = isRecord(webData) && Array.isArray(webData.productKeyAttributes)
    ? webData.productKeyAttributes.filter(isRecord).map((attribute) => ({
        name: asString(attribute.attributeNameEn) ?? asString(attribute.attributeName),
        value: asString(attribute.attributeValueEn) ?? asString(attribute.attributeValue),
      })).filter((attribute) => attribute.name !== undefined)
    : []
  return clean({ en: english.length > 0 ? english : keyAttributes, zh: chinese })
}

/** @param {number} value @param {number} min @param {number} max */
function clampInteger(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/**
 * @param {Record<string, unknown>} record
 * @returns {Record<string, unknown>}
 */
function lowerKeyed(record) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [key, value] of Object.entries(record)) {
    out[key.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '')] = value
    out[key.toLowerCase()] = value
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* Convenience standalone functions (used by validate.mjs)                    */
/* -------------------------------------------------------------------------- */

/** Lazily created default service for the exported one-shot helpers. */
let defaultService

/** @returns {LcscService} */
function getDefaultService() {
  defaultService ??= createLcscService()
  return defaultService
}

/**
 * @param {string} keyword
 * @param {number} [limit]
 * @param {{ signal?: AbortSignal, service?: LcscService }} [options]
 */
export function searchParts(keyword, limit, options = {}) {
  return (options.service ?? getDefaultService()).search(keyword, limit, options)
}

/**
 * @param {string} code
 * @param {{ signal?: AbortSignal, includeCny?: boolean, service?: LcscService }} [options]
 */
export function getPart(code, options = {}) {
  return (options.service ?? getDefaultService()).part(code, options)
}

/**
 * @param {unknown} input rows or CSV text
 * @param {{ signal?: AbortSignal, includeCny?: boolean, service?: LcscService }} [options]
 */
export function checkBom(input, options = {}) {
  return (options.service ?? getDefaultService()).checkBom(input, options)
}

