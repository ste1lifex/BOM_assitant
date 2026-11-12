/**
 * dsh-plugin-lcsc — requirement-driven LCSC part finder and BOM cost auditor
 * for the DeepSeek Harness (DSH) Host.
 *
 * Two LLM-callable tools, deliberately kept small so the plugin does not crowd
 * the model's context when several plugins are installed:
 *
 *   - find_lcsc_parts  requirement -> ranked candidates (price / stock /
 *                      basic-vs-extended library / parameter match)
 *   - audit_lcsc_bom   existing BOM -> cost, stock, library-type and
 *                      JLCPCB extended-part feeder-fee audit
 *
 * The HTTP/cache/normalisation layer lives in `data.js`.
 *
 * Design rules:
 *   - hand-soldering is the default (`assembly: "hand"`): most DIY users buy
 *     parts and solder themselves, and SMT fee rules change over time.
 *   - `assembly: "smt"` opts into library-type awareness: JLCPCB charges
 *     USD 3 per extended part number per order (feeder loading), base library
 *     parts are free, so the fee is amortised into the unit price.
 *   - prices are never converted between currencies; each price carries its
 *     currency and source.
 */

import {
  createLcscService,
  normalizeConfig,
  normalizeCode,
  parseBomCsvDetailed,
  pickTierPrice,
} from './data.js'
import { createCnAdapter } from './cn.js'

/** Plugin id used by the DSH loader. */
export const name = 'lcsc-parts'
/** Required services. */
export const inject = ['tools']

/** Default JLCPCB extended-part feeder loading fee, USD per unique part per order. */
export const EXTENDED_PART_FEE_USD = 3
/** Query-wide caps that keep a single tool call fast and cheap. */
const MAX_CANDIDATES = 8
const DEFAULT_LIMIT = 5
const SEARCH_PAGE_SIZE = 100
const MAX_CNY_LOOKUPS = 3
const MAX_AUDIT_CNY_LOOKUPS = 32
const MAX_ALTERNATIVE_LOOKUPS = 16

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

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

/** @param {unknown} value @returns {number | undefined} */
function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** @param {unknown} value @returns {number | undefined} */
function asInteger(value) {
  const number = asNumber(value)
  if (number === undefined || !Number.isInteger(number)) return undefined
  return number
}

/** @param {unknown} value @param {number} min @param {number} max @param {number} fallback */
function clampInteger(value, min, max, fallback) {
  const number = asInteger(value)
  if (number === undefined) return fallback
  return Math.min(max, Math.max(min, number))
}

/** Round money-like values to avoid float noise in the tool output. */
function money(value) {
  return Math.round(value * 1e6) / 1e6
}

/**
 * DSH validates tool results for lossless JSON: plain `undefined` properties,
 * NaN and Infinity are rejected. Normalise any result before returning it.
 * @param {unknown} value
 * @returns {unknown}
 */
function toLossless(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return Object.is(value, -0) ? 0 : value
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map((entry) => toLossless(entry))
  if (typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const output = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue
      output[key] = toLossless(entry)
    }
    return output
  }
  return null
}

/**
 * USD unit price of the highest-volume ladder tier (bulk / full-reel price).
 * The Recording_card calibration relates the LCSC retail CNY price to this
 * bulk-tier USD price (× 6.0), not to the small-quantity tier.
 * @param {Record<string, unknown>} item
 * @returns {number | undefined}
 */
export function bulkTierUsd(item) {
  const tiers = Array.isArray(item.priceUsdTiers) ? item.priceUsdTiers : []
  /** @type {{ qty: number, unit: number } | undefined} */
  let best
  for (const tier of tiers) {
    if (!isRecord(tier)) continue
    const qty = asNumber(tier.qty)
    const unit = asNumber(tier.unit)
    if (qty === undefined || unit === undefined) continue
    if (best === undefined || qty > best.qty) best = { qty, unit }
  }
  return best?.unit
}

/**
 * Reference CNY estimate = bulk-tier USD × empirical factor.
 * @param {number | undefined} bulkUsd
 * @param {number | undefined} factor
 * @returns {number | undefined}
 */
export function estimateCnyFromUsd(bulkUsd, factor) {
  const value = asNumber(bulkUsd)
  const calibration = asNumber(factor)
  if (value === undefined || calibration === undefined) return undefined
  return money(value * calibration)
}

/** @param {number} ms @param {AbortSignal} [signal] */
function sleep(ms, signal) {
  if (signal?.aborted === true) return Promise.reject(new Error('aborted'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * Run `fn` over items with bounded concurrency; results keep input order.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/* -------------------------------------------------------------------------- */
/* Requirement parsing                                                        */
/* -------------------------------------------------------------------------- */

/** Chinese / mixed category words mapped to English search hints (longest first). */
const CATEGORY_TERMS = [
  ['自恢复保险丝', ['ptc resettable fuse']],
  ['贴片电容', ['capacitor']],
  ['贴片电阻', ['resistor']],
  ['发光二极管', ['led']],
  ['锂电池充电', ['battery management', 'battery charger']],
  ['单节锂电池', ['battery management', 'battery charger']],
  ['充电ic', ['battery management', 'battery charger']],
  ['充电 ic', ['battery management', 'battery charger']],
  ['充电芯片', ['battery management', 'battery charger']],
  ['静态保护', ['esd']],
  ['静电保护', ['esd']],
  ['硅麦', ['microphone']],
  ['type-c母座', ['usb type-c receptacle']],
  ['type-c 母座', ['usb type-c receptacle']],
  ['type c母座', ['usb type-c receptacle']],
  ['母座', ['receptacle']],
  ['贴片', []],
  ['电容', ['capacitor']],
  ['电阻', ['resistor']],
  ['电感', ['inductor']],
  ['磁珠', ['ferrite bead']],
  ['二极管', ['diode']],
  ['肖特基', ['schottky']],
  ['三极管', ['transistor']],
  ['场效应管', ['mosfet']],
  ['mos管', ['mosfet']],
  ['稳压器', ['ldo', 'voltage regulator']],
  ['ldo', ['ldo']],
  ['连接器', ['connector']],
  ['插座', ['connector']],
  ['排针', ['pin header']],
  ['排母', ['pin header']],
  ['按键', ['tactile switch']],
  ['轻触开关', ['tactile switch']],
  ['开关', ['switch']],
  ['晶振', ['crystal']],
  ['谐振器', ['resonator']],
  ['保险丝', ['fuse']],
  ['麦克风', ['microphone']],
  ['咪头', ['microphone']],
  ['蜂鸣器', ['buzzer']],
  ['电池座', ['battery holder']],
  ['电池连接器', ['battery connector']],
  ['光耦', ['optocoupler']],
  ['运放', ['operational amplifier']],
  ['比较器', ['comparator']],
  ['单片机', ['microcontroller']],
  ['存储器', ['memory']],
  ['电平转换', ['level shifter']],
  ['tvs', ['tvs']],
  ['esd', ['esd']],
  ['type-c', ['type-c']],
  ['tf卡座', ['microsd']],
  ['sd卡座', ['microsd']],
  ['microsd', ['microsd']],
  ['usb', ['usb']],
]

/** Extra search keywords per category (JLCPCB keyword search is literal). */
const CATEGORY_SEARCH_VARIANTS = {
  microphone: ['MEMS', 'MEMS microphone', 'microphone'],
  'ptc resettable fuse': ['PTC', 'resettable fuse', 'fuse'],
  fuse: ['PTC', 'resettable fuse'],
  'usb type-c receptacle': ['USB Type-C', 'Type-C receptacle', 'Type-C'],
  'type-c': ['USB Type-C', 'Type-C'],
  usb: ['USB Type-C', 'USB'],
  'battery management': ['battery management', 'charging IC', 'battery charger'],
  'battery charger': ['battery management', 'charging IC', 'battery charger'],
  tvs: ['TVS', 'ESD'],
  esd: ['ESD', 'TVS'],
  ldo: ['LDO', 'voltage regulator'],
  'voltage regulator': ['LDO', 'voltage regulator'],
  'ferrite bead': ['ferrite bead', 'ferrite'],
  connector: ['connector'],
  'pin header': ['pin header', 'header'],
  'tactile switch': ['tactile switch', 'tact switch'],
  crystal: ['crystal', 'oscillator'],
  'battery holder': ['battery holder', 'battery connector'],
  'battery connector': ['battery connector', 'battery holder'],
  optocoupler: ['optocoupler'],
  'operational amplifier': ['operational amplifier', 'op amp'],
  microcontroller: ['microcontroller', 'MCU'],
  memory: ['memory', 'flash'],
  'level shifter': ['level shifter'],
}

/** ASCII-only remainder of the requirement, useful for `USB Type-C 16P` / `MEMS`. */
function asciiRequirement(text) {
  return String(text ?? '')
    .replace(/[\u4e00-\u9fff]+/g, ' ')
    .replace(/[，。；、,;:：!！?？]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Tokens in the ASCII remainder that are meaningful (not a bare value/unit/package). */
function asciiSearchTokens(text) {
  return asciiRequirement(text)
    .split(/\s+/)
    .map((token) => token.replace(/^[\(（"']+|["'）)]+$/g, ''))
    .filter((token) => token.length >= 3)
    .filter((token) => /[A-Za-z]/.test(token))
    .filter((token) => !VALUE_UNIT_TOKEN_RE.test(token))
    .filter((token) => extractPackage(token) !== token.toUpperCase())
}

/**
 * Recall keyword variants, in order, for the staged degradation chain.
 * @param {ReturnType<typeof parseNeed>} need
 * @returns {string[]}
 */
function recallFallbackKeywords(need) {
  const keywords = []
  const push = (value) => {
    const text = String(value ?? '').trim()
    if (text !== '' && !keywords.includes(text) && text !== need.searchKeyword) keywords.push(text)
  }
  // 1) Simplified category phrases (e.g. "PTC", "USB Type-C", "MEMS")
  for (const category of need.categories ?? []) {
    for (const variant of CATEGORY_SEARCH_VARIANTS[category] ?? []) push(variant)
  }
  // 2) English tokens that survived the Chinese text (e.g. "MEMS", "USB Type-C 16P")
  const ascii = asciiRequirement(need.raw)
  if (ascii !== '') push(ascii)
  const tokens = asciiSearchTokens(need.raw)
  if (tokens.length > 0) push(tokens.join(' '))
  // 3) Package + category, then the untouched raw text
  push([need.package, ...(need.categories ?? [])].filter(Boolean).join(' '))
  push(need.raw)
  return keywords
}

/** A single token that is a value+unit (e.g. "100nF", "3.3V", "10kΩ") is not a part number. */
const VALUE_UNIT_TOKEN_RE =
  /^\d+(?:\.\d+)?\s*(?:pf|nf|uf|µf|mf|f|v|kv|ma|ua|µa|a|w|mw|ω|kω|mω|ohm|kohm|mm|nh|uh|µh|mh|hz|khz|mhz|ghz|k|r|m|%|p|pin|pins|针|脚)$/i

/** Normalised model string used for exact-model matching. */
export function normalizeModelToken(text) {
  return String(text ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/**
 * Detect an exact part query (LCSC code or manufacturer part number) before any
 * numeric parameter parsing. This is the fix for "SMF5.0A" being read as
 * current>=5A / "TP4054" as 4054: those strings are part numbers, not values.
 * @param {string} text
 * @returns {{ type: 'code' | 'model', value: string, token?: string } | undefined}
 */
export function detectExactQuery(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return undefined
  const wholeCode = raw.match(/^C\d{4,11}$/i)
  if (wholeCode !== null) return { type: 'code', value: wholeCode[0].toUpperCase() }
  const tokens = raw.split(/[\s,;，；、]+/).filter((token) => token !== '')
  if (tokens.length === 0) return undefined
  // Only treat the input as a part number when it is a single token, or when
  // one token is a strong part number and the rest are category words. Mixed
  // requirement strings ("22 ohm 0402 resistor") must keep their value parsing.
  const strong = []
  for (const token of tokens) {
    const clean = token.replace(/^[\(（"'`]+|[)'"`”）]+$/g, '')
    if (clean.length < 4) continue
    if (/^C\d{4,11}$/i.test(clean)) return { type: 'code', value: clean.toUpperCase() }
    if (VALUE_UNIT_TOKEN_RE.test(clean)) continue
    if (extractPackage(clean) === clean.toUpperCase()) continue
    if (!/^[A-Za-z0-9._/+\-]+$/.test(clean)) continue
    if (!/\d/.test(clean) || !/[A-Za-z]/.test(clean)) continue
    const startsWithLetters = /^[A-Za-z]{2,}/.test(clean)
    const hasSeparator = /[-._/+]/.test(clean)
    const longPartNumber = clean.length >= 8
    if (startsWithLetters || hasSeparator || longPartNumber) strong.push(clean)
  }
  if (strong.length === 1) return { type: 'model', value: strong[0], token: normalizeModelToken(strong[0]) }
  if (strong.length > 1 && tokens.length === strong.length) {
    // A single part number split by separators is already covered by one token;
    // multiple independent part numbers are ambiguous, so keep parameter parsing.
    return undefined
  }
  return undefined
}

/** Package / footprint tokens, longest first so SOT-23-5 wins over SOT-23. */
const PACKAGE_PATTERNS = [
  'SOT-23-6', 'SOT-23-5', 'SOT-23-3', 'SOT-23', 'SOD-123FL', 'SOD-123', 'SOD-323',
  'DO-214AC', 'DO-214AA', 'DO-214AB', 'ESOP-8', 'SOP-16', 'SOP-8', 'SOP-4',
  'TSSOP-16', 'TSSOP-20', 'MSOP-8', 'MSOP-10', 'QFN-16', 'QFN-20', 'QFN-24',
  'DFN-6', 'DFN-8', 'SMA', 'SMB', 'SMC', 'TO-220', 'TO-92', 'TO-252', 'TO-263',
  '0201', '0402', '0603', '0805', '1206', '1210', '1812', '2010', '2512', '3225', '5032',
]

const VOLTAGE_UNIT = /(kv|v)/i
const CURRENT_UNIT = /(ma|ua|µa|a)/i
const CAP_UNIT = /(mf|uf|µf|nf|pf|f)/i
const RES_UNIT = /(mω|kω|mohm|kohm|ω|ohm|meg|m|k|r)/i

/** Normalise a comparator token to one of '>=', '<=', '='. */
function normalizeComparator(raw) {
  if (raw === undefined) return undefined
  const text = String(raw).toLowerCase()
  if (['>=', '≥', '>', '至少', '不小于', '大于', 'min', 'minimum'].includes(text)) return '>='
  if (['<=', '≤', '<', '最多', '不超过', '小于', 'max', 'maximum'].includes(text)) return '<='
  return '='
}

/** @param {string} text @returns {string | undefined} */
function extractPackage(text) {
  const upper = text.toUpperCase()
  for (const pattern of PACKAGE_PATTERNS) {
    if (upper.includes(pattern)) return pattern
  }
  const inch = upper.match(/\b(0201|0402|0603|0805|1206|1210|1812|2010|2512)\b/)
  return inch === null ? undefined : inch[1]
}

/**
 * Extract numeric requirements from free text.
 * @param {string} text
 * @returns {{ kind: string, value: number, unit: string, comparator: string | undefined, raw: string }[]}
 */
export function extractRequirements(text) {
  /** @type {{ kind: string, value: number, unit: string, comparator: string | undefined, raw: string }[]} */
  const requirements = []
  const cleaned = text
    .replace(/\b(0201|0402|0603|0805|1206|1210|1812|2010|2512)\b/g, ' ')
    .replace(/\b(x7r|x5r|x6s|x7s|c0g|np0|y5v|z5u)\b/gi, ' ')
  const push = (kind, value, unit, comparator, raw) => {
    if (!Number.isFinite(value)) return
    requirements.push({ kind, value, unit, comparator: normalizeComparator(comparator), raw })
  }

  // Capacitance
  for (const match of cleaned.matchAll(/(>=|≥|>|<=|≤|<|=|至少|不小于|大于|最多|不超过|小于)?\s*(\d+(?:\.\d+)?)\s*(pf|nf|uf|µf|mf|f)\b/gi)) {
    const unit = match[3].toLowerCase()
    const scale = { pf: 1, nf: 1e3, uf: 1e6, 'µf': 1e6, mf: 1e9, f: 1e12 }[unit]
    push('capacitance', Number(match[2]) * scale, unit, match[1], match[0].trim())
  }
  // Resistance ("10kΩ", "5.1k", "100Ω", "0R")
  for (const match of cleaned.matchAll(/(?<![A-Za-z0-9])(>=|≥|>|<=|≤|<|=|至少|不小于|大于|最多|不超过|小于)?\s*(\d+(?:\.\d+)?)\s*(kω|kohm|mω|mohm|meg|mω|ω|ohm|k|m|r)(?![A-Za-z0-9])/gi)) {
    const unitRaw = match[3]
    const unit = unitRaw === undefined ? undefined : unitRaw.toLowerCase()
    if (unit === undefined) continue
    const value = Number(match[2])
    const scale = { 'ω': 1, ohm: 1, r: 1, k: 1e3, 'kω': 1e3, kohm: 1e3, m: 1e6, meg: 1e6, 'mω': 1e-3, mohm: 1e-3 }[unit]
    if (scale === undefined) continue
    push('resistance', value * scale, unit, match[1], match[0].trim())
  }
  // Inductance
  for (const match of cleaned.matchAll(/(>=|≥|>|<=|≤|<|=|至少|不小于|大于|最多|不超过|小于)?\s*(\d+(?:\.\d+)?)\s*(nh|uh|µh|mh|h)\b/gi)) {
    const unit = match[3].toLowerCase()
    const scale = { nh: 1, uh: 1e3, 'µh': 1e3, mh: 1e6, h: 1e9 }[unit]
    push('inductance', Number(match[2]) * scale, unit, match[1], match[0].trim())
  }
  // Voltage
  for (const match of cleaned.matchAll(/(>=|≥|>|<=|≤|<|=|至少|不小于|大于|最多|不超过|小于)?\s*(\d+(?:\.\d+)?)\s*(kv|v)\b/gi)) {
    const unit = match[3].toLowerCase()
    push('voltage', Number(match[2]) * (unit === 'kv' ? 1000 : 1), unit, match[1], match[0].trim())
  }
  // Current
  for (const match of cleaned.matchAll(/(>=|≥|>|<=|≤|<|=|至少|不小于|大于|最多|不超过|小于)?\s*(\d+(?:\.\d+)?)\s*(ma|ua|µa|a)\b/gi)) {
    const unit = match[3].toLowerCase()
    const scale = { ma: 1, ua: 1e-3, 'µa': 1e-3, a: 1e3 }[unit]
    push('current', Number(match[2]) * scale, unit, match[1], match[0].trim())
  }
  // Power
  for (const match of cleaned.matchAll(/(>=|≥|>|<=|≤|<|=|至少|不小于|大于|最多|不超过|小于)?\s*(\d+(?:\.\d+)?)\s*(mw|w)\b/gi)) {
    const unit = match[3].toLowerCase()
    push('power', Number(match[2]) * (unit === 'mw' ? 1 : 1000), unit, match[1], match[0].trim())
  }
  // Tolerance (percent) - tighter is better, so default comparator is <=
  for (const match of cleaned.matchAll(/(>=|≥|>|<=|≤|<|=|至少|不小于|大于|最多|不超过|小于)?\s*±?\s*(\d+(?:\.\d+)?)\s*%/g)) {
    push('tolerance', Number(match[2]), '%', match[1], match[0].trim())
  }
  // Frequency
  for (const match of cleaned.matchAll(/(>=|≥|>|<=|≤|<|=|至少|不小于|大于|最多|不超过|小于)?\s*(\d+(?:\.\d+)?)\s*(khz|mhz|ghz|hz)\b/gi)) {
    const unit = match[3].toLowerCase()
    const scale = { hz: 1, khz: 1e3, mhz: 1e6, ghz: 1e9 }[unit]
    push('frequency', Number(match[2]) * scale, unit, match[1], match[0].trim())
  }
  // Footprint dimensions like 2.0x1.2mm
  for (const match of cleaned.matchAll(/(\d+(?:\.\d+)?)\s*(?:x|×|\*)\s*(\d+(?:\.\d+)?)\s*mm/gi)) {
    requirements.push({ kind: 'size', value: Number(match[1]), unit: 'mm', comparator: '=', raw: match[0], extra: Number(match[2]) })
  }
  // Pin / contact count ("16P", "16 pin", "16针")
  for (const match of cleaned.matchAll(/(?<![A-Za-z0-9])(\d{1,3})\s*(?:p|pin|pins|针|脚)(?![A-Za-z0-9])/gi)) {
    push('pins', Number(match[1]), 'pins', '=', match[0].trim())
  }
  return requirements
}

/**
 * Parse a free-form requirement (Chinese or English) into a structured need.
 * @param {string} raw
 * @returns {{ raw: string, searchKeyword: string, package?: string, directCode?: string, modelGuess: boolean, categories: string[], dielectric?: string, requirements: ReturnType<typeof extractRequirements> }}
 */
export function parseNeed(raw) {
  const text = String(raw ?? '').trim()
  const exact = detectExactQuery(text)
  if (exact !== undefined) {
    // Exact part query: return the code/model directly and DO NOT parse numeric
    // requirements. Part numbers such as SMF5.0A / AO3401A / TP4054 contain
    // digit+letter patterns that would otherwise be misread as value/unit.
    return {
      raw: text,
      searchKeyword: exact.value,
      package: extractPackage(text),
      directCode: exact.type === 'code' ? exact.value : undefined,
      modelGuess: exact.type === 'model',
      modelToken: exact.type === 'model' ? exact.token : undefined,
      categories: [],
      dielectric: undefined,
      requirements: [],
      exact: true,
      exactValue: exact.value,
      upper: text.toUpperCase(),
    }
  }

  const packageName = extractPackage(text)
  const categories = []
  const dielectricMatch = text.match(/\b(X7R|X5R|X6S|X7S|C0G|NP0|Y5V|Z5U)\b/i)
  const dielectric = dielectricMatch === null ? undefined : dielectricMatch[1].toUpperCase()
  for (const [word, hints] of CATEGORY_TERMS) {
    if (text.toLowerCase().includes(word)) {
      for (const hint of hints) if (!categories.includes(hint)) categories.push(hint)
    }
  }
  // English category words are used as-is by the JLCPCB search, so keep them.
  const ENGLISH_CATEGORIES = [
    'capacitor', 'resistor', 'inductor', 'ferrite bead', 'diode', 'schottky', 'led',
    'transistor', 'mosfet', 'ldo', 'voltage regulator', 'connector', 'pin header',
    'tactile switch', 'switch', 'crystal', 'resonator', 'fuse', 'ptc resettable fuse',
    'microphone', 'buzzer', 'battery holder', 'battery connector', 'optocoupler',
    'operational amplifier', 'comparator', 'microcontroller', 'memory', 'level shifter',
    'tvs', 'esd', 'type-c', 'microsd', 'usb', 'relay', 'sensor', 'motor driver',
    'adc', 'dac', 'interface', 'antenna', 'receptacle', 'battery charger', 'battery management', 'pin header',
  ]
  for (const word of ENGLISH_CATEGORIES) {
    const re = new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i')
    if (re.test(text) && !categories.includes(word)) categories.push(word)
  }

  // Translate Chinese category words into English so the JLCPCB keyword search
  // (which is English-oriented) gets a useful query.
  let keyword = text
  for (const [word, hints] of CATEGORY_TERMS) {
    if (hints.length === 0) continue
    const re = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    keyword = keyword.replace(re, ` ${hints[0]} `)
  }
  keyword = keyword
    .replace(/[，。；、,;:：!！?？]/g, ' ')
    .replace(/需要|一个|帮我|找一下|寻找|找|用来|用于|的|料号|器件|元件|请|帮我选|推荐/g, ' ')
    .replace(/[\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // If the user already wrote English/ASCII terms, prefer them: translating
  // 母座 -> receptacle or 麦克风 -> microphone can otherwise dilute a literal
  // keyword search (e.g. "USB Type-C 16P receptacle" vs "USB Type-C 16P").
  const ascii = asciiRequirement(text)
  const meaningfulAscii = asciiSearchTokens(text)
  if (meaningfulAscii.length > 0 && ascii !== '') keyword = ascii
  if (keyword === '') keyword = [packageName, dielectric, ...categories].filter(Boolean).join(' ')
  if (keyword === '') keyword = text
  // Collapse repeated tokens produced by overlapping Chinese synonyms.
  const seenTokens = new Set()
  keyword = keyword
    .split(/\s+/)
    .filter((token) => {
      const key = token.toLowerCase()
      if (seenTokens.has(key)) return false
      seenTokens.add(key)
      return true
    })
    .join(' ')

  const requirements = extractRequirements(text)
  // Category-aware comparator defaults.
  const isRegulator = categories.some((category) => category === 'ldo' || category === 'voltage regulator' || category === 'battery charger')
  for (const requirement of requirements) {
    if (requirement.comparator !== undefined) continue
    if (requirement.kind === 'voltage' && isRegulator) requirement.comparator = '='
    else if (requirement.kind === 'tolerance') requirement.comparator = '<='
    else if (requirement.kind === 'size') requirement.comparator = '='
    else if (requirement.kind === 'capacitance' || requirement.kind === 'resistance' || requirement.kind === 'inductance' || requirement.kind === 'frequency' || requirement.kind === 'pins') requirement.comparator = '='
    else requirement.comparator = '>='
  }
  return {
    raw: text,
    searchKeyword: keyword,
    package: packageName,
    directCode: undefined,
    modelGuess: false,
    modelToken: undefined,
    categories,
    dielectric,
    requirements,
    exact: false,
    exactValue: undefined,
    upper: text.toUpperCase(),
  }
}

/* -------------------------------------------------------------------------- */
/* Candidate extraction / matching                                            */
/* -------------------------------------------------------------------------- */

/** @param {Record<string, unknown>} item */
function attributesOf(item) {
  return Array.isArray(item.attributes)
    ? item.attributes.filter(isRecord).map((attribute) => ({
        name: asString(attribute.name) ?? '',
        value: asString(attribute.value) ?? '',
      }))
    : []
}

/** Full searchable text of a JLCPCB candidate row. */
function candidateText(item) {
  const parts = [
    asString(item.model),
    asString(item.package),
    asString(item.category),
    asString(item.description),
  ]
  for (const attribute of attributesOf(item)) parts.push(`${attribute.name} ${attribute.value}`)
  return parts.filter(Boolean).join(' ').toLowerCase()
}

/** Infer quantity kinds from an attribute name. */
function kindsFromAttributeName(name) {
  const kinds = []
  if (/capacitance|^cap\b/i.test(name)) kinds.push('capacitance')
  if (/resistance|resistor/i.test(name)) kinds.push('resistance')
  if (/inductance/i.test(name)) kinds.push('inductance')
  if (/voltage|vds|vgs|reverse|vrm|vrr|supply/i.test(name)) kinds.push('voltage')
  if (/current|amp/i.test(name)) kinds.push('current')
  if (/\bpower\b/i.test(name)) kinds.push('power')
  if (/tolerance/i.test(name)) kinds.push('tolerance')
  if (/frequency/i.test(name)) kinds.push('frequency')
  return kinds
}

/**
 * Extract candidate numeric values for matching.
 * @param {Record<string, unknown>} item
 * @returns {{ kind: string, value: number }[]}
 */
export function extractCandidateQuantities(item) {
  /** @type {{ kind: string, value: number }[]} */
  const result = []
  const add = (kind, value) => {
    if (Number.isFinite(value)) result.push({ kind, value })
  }
  for (const attribute of attributesOf(item)) {
    if (/number of (contacts|positions|pins)|contacts|positions|pin count|number of pins|pin number/i.test(attribute.name)) {
      const pinMatch = attribute.value.match(/\d{1,3}/)
      if (pinMatch !== null) add('pins', Number(pinMatch[0]))
    }
    const kinds = kindsFromAttributeName(attribute.name)
    const valueText = `${attribute.value}`
    if (kinds.length === 0) continue
    for (const kind of kinds) {
      for (const parsed of parseQuantitiesOfKind(valueText, kind)) add(kind, parsed)
    }
    // "10k" / "0R" style resistance values without a unit letter.
    if (kinds.includes('resistance')) {
      const bare = valueText.trim().match(/^(\d+(?:\.\d+)?)\s*(k|m)?$/i)
      if (bare !== null) {
        const multiplier = bare[2] === undefined ? 1 : bare[2].toLowerCase() === 'k' ? 1e3 : 1e6
        add('resistance', Number(bare[1]) * multiplier)
      }
    }
  }
  // Generic scan over the description as a fallback.
  const description = asString(item.description)
  if (description !== undefined) {
    for (const match of description.matchAll(/(\d+(?:\.\d+)?)\s*(pf|nf|uf|µf|mf|f)\b/gi)) {
      add('capacitance', Number(match[1]) * ({ pf: 1, nf: 1e3, uf: 1e6, 'µf': 1e6, mf: 1e9, f: 1e12 }[match[2].toLowerCase()] ?? 0))
    }
    for (const match of description.matchAll(/(\d+(?:\.\d+)?)\s*(kv|v)\b/gi)) {
      add('voltage', Number(match[1]) * (match[2].toLowerCase() === 'kv' ? 1000 : 1))
    }
    for (const match of description.matchAll(/(\d+(?:\.\d+)?)\s*(ma|ua|µa|a)\b/gi)) {
      add('current', Number(match[1]) * ({ ma: 1, ua: 1e-3, 'µa': 1e-3, a: 1e3 }[match[2].toLowerCase()] ?? 0))
    }
    for (const match of description.matchAll(/(\d+(?:\.\d+)?)\s*(mw|w)\b/gi)) {
      add('power', Number(match[1]) * (match[2].toLowerCase() === 'mw' ? 1 : 1000))
    }
    for (const match of description.matchAll(/±\s*(\d+(?:\.\d+)?)\s*%/g)) add('tolerance', Number(match[1]))
    for (const match of description.matchAll(/(\d+(?:\.\d+)?)\s*(nh|uh|µh|mh|h)\b/gi)) {
      add('inductance', Number(match[1]) * ({ nh: 1, uh: 1e3, 'µh': 1e3, mh: 1e6, h: 1e9 }[match[2].toLowerCase()] ?? 0))
    }
    for (const match of description.matchAll(/(\d+(?:\.\d+)?)\s*(?:x|×|\*)\s*(\d+(?:\.\d+)?)\s*mm/gi)) {
      add('size', Number(match[1]))
      add('size', Number(match[2]))
    }
  }
  return result
}

/** Parse values of one kind from a text fragment. */
function parseQuantitiesOfKind(text, kind) {
  const values = []
  const add = (value) => {
    if (Number.isFinite(value)) values.push(value)
  }
  if (kind === 'capacitance') {
    for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(pf|nf|uf|µf|mf|f)\b/gi)) {
      const scale = { pf: 1, nf: 1e3, uf: 1e6, 'µf': 1e6, mf: 1e9, f: 1e12 }[match[2].toLowerCase()]
      if (scale !== undefined) add(Number(match[1]) * scale)
    }
  } else if (kind === 'resistance') {
    for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(kω|kohm|mω|mohm|meg|ω|ohm|m|k|r)?\b/gi)) {
      const unit = match[2] === undefined ? undefined : match[2].toLowerCase()
      const scale = unit === undefined
        ? 1
        : { 'ω': 1, ohm: 1, r: 1, k: 1e3, 'kω': 1e3, kohm: 1e3, m: 1e6, meg: 1e6, 'mω': 1e-3, mohm: 1e-3 }[unit]
      if (scale !== undefined) add(Number(match[1]) * scale)
    }
  } else if (kind === 'inductance') {
    for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(nh|uh|µh|mh|h)\b/gi)) {
      const scale = { nh: 1, uh: 1e3, 'µh': 1e3, mh: 1e6, h: 1e9 }[match[2].toLowerCase()]
      if (scale !== undefined) add(Number(match[1]) * scale)
    }
  } else if (kind === 'voltage') {
    for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(kv|v)\b/gi)) {
      add(Number(match[1]) * (match[2].toLowerCase() === 'kv' ? 1000 : 1))
    }
  } else if (kind === 'current') {
    for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(ma|ua|µa|a)\b/gi)) {
      const scale = { ma: 1, ua: 1e-3, 'µa': 1e-3, a: 1e3 }[match[2].toLowerCase()]
      if (scale !== undefined) add(Number(match[1]) * scale)
    }
  } else if (kind === 'power') {
    for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(mw|w)\b/gi)) {
      add(Number(match[1]) * (match[2].toLowerCase() === 'mw' ? 1 : 1000))
    }
  } else if (kind === 'tolerance') {
    for (const match of text.matchAll(/±?\s*(\d+(?:\.\d+)?)\s*%/g)) add(Number(match[1]))
  } else if (kind === 'frequency') {
    for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(khz|mhz|ghz|hz)\b/gi)) {
      const scale = { hz: 1, khz: 1e3, mhz: 1e6, ghz: 1e9 }[match[2].toLowerCase()]
      if (scale !== undefined) add(Number(match[1]) * scale)
    }
  } else if (kind === 'size') {
    for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(?:x|×|\*)\s*(\d+(?:\.\d+)?)\s*mm/gi)) {
      add(Number(match[1]))
      add(Number(match[2]))
    }
  }
  return values
}

/** Does a candidate value satisfy a parsed requirement? */
function satisfies(value, requirement) {
  const target = requirement.value
  const comparator = requirement.comparator ?? '>='
  const tolerance = Math.max(Math.abs(target) * 0.05, 1e-9)
  if (comparator === '=') return Math.abs(value - target) <= tolerance
  if (comparator === '>=') return value >= target - tolerance
  if (comparator === '<=') return value <= target + tolerance
  return false
}

/** Package comparison tolerant to spacing/case differences. */
function packageMatches(candidatePackage, wantedPackage) {
  if (candidatePackage === undefined) return true
  const normal = (value) => String(value).toUpperCase().replace(/[\s_]/g, '')
  return normal(candidatePackage) === normal(wantedPackage)
}

/**
 * Check whether a JLCPCB candidate satisfies a parsed requirement.
 * @param {Record<string, unknown>} item
 * @param {ReturnType<typeof parseNeed>} need
 * @returns {{ ok: boolean, matched: string[], missing?: string }}
 */
export function candidateMatches(item, need) {
  if (need.directCode !== undefined && String(item.code).toUpperCase() !== need.directCode) {
    return { ok: false, matched: [] }
  }
  if (need.modelGuess === true) {
    const candidate = normalizeModelToken(item.model)
    if (need.modelToken === undefined || !candidate.includes(need.modelToken)) {
      return { ok: false, matched: [] }
    }
    return { ok: true, matched: [`model=${item.model ?? need.exactValue}`] }
  }
  if (need.package !== undefined && item.package !== undefined && !packageMatches(item.package, need.package)) {
    return { ok: false, matched: [] }
  }
  const text = candidateText(item)
  if (need.dielectric !== undefined && !text.includes(need.dielectric.toLowerCase())) {
    return { ok: false, matched: [] }
  }
  if (need.categories.length > 0) {
    const hit = need.categories.some((category) => text.includes(category.toLowerCase()))
    if (!hit) return { ok: false, matched: [] }
  }
  const quantities = extractCandidateQuantities(item)
  const matched = []
  for (const requirement of need.requirements) {
    if (requirement.kind === 'size') {
      const values = quantities.filter((quantity) => quantity.kind === 'size').map((quantity) => quantity.value)
      if (values.length >= 1) {
        const wanted = requirement.value
        const wantedExtra = Number(requirement.extra ?? wanted)
        const pairMatch = values.some((value, index) => {
          if (index + 1 >= values.length) return false
          const other = values[index + 1]
          return (Math.abs(value - wanted) <= wanted * 0.2 && Math.abs(other - wantedExtra) <= wantedExtra * 0.25) ||
            (Math.abs(value - wantedExtra) <= wantedExtra * 0.2 && Math.abs(other - wanted) <= wanted * 0.25)
        })
        if (!pairMatch) return { ok: false, matched }
      }
      matched.push(`size=${requirement.raw}`)
      continue
    }
    const values = quantities.filter((quantity) => quantity.kind === requirement.kind).map((quantity) => quantity.value)
    if (values.length === 0) return { ok: false, matched }
    if (!values.some((value) => satisfies(value, requirement))) return { ok: false, matched }
    matched.push(`${requirement.kind}=${requirement.raw}`)
  }
  return { ok: true, matched }
}

/**
 * Explain why a candidate fails the parsed requirement (used by the relaxed
 * fallback, so the agent can tell the user which constraint could not be met).
 * @param {Record<string, unknown>} item
 * @param {ReturnType<typeof parseNeed>} need
 * @returns {string[]}
 */
export function mismatchReasons(item, need) {
  const reasons = []
  if (need.directCode !== undefined && String(item.code).toUpperCase() !== need.directCode) {
    reasons.push(`LCSC 编号为 ${item.code}，不是 ${need.directCode}`)
  }
  if (need.modelGuess === true && !normalizeModelToken(item.model).includes(need.modelToken ?? '')) {
    reasons.push(`型号 ${item.model ?? '?'} 与 ${need.exactValue ?? '?'} 不完全一致`)
  }
  if (need.package !== undefined && item.package !== undefined && !packageMatches(item.package, need.package)) {
    reasons.push(`封装 ${item.package} ≠ ${need.package}`)
  }
  const text = candidateText(item)
  if (need.dielectric !== undefined && !text.includes(need.dielectric.toLowerCase())) {
    reasons.push(`介质/温度特性不含 ${need.dielectric}`)
  }
  if (need.categories.length > 0 && !need.categories.some((category) => text.includes(category.toLowerCase()))) {
    reasons.push(`品类不匹配（期望 ${need.categories.slice(0, 2).join(' / ')}）`)
  }
  const quantities = extractCandidateQuantities(item)
  for (const requirement of need.requirements) {
    if (requirement.kind === 'size') continue
    const values = quantities.filter((quantity) => quantity.kind === requirement.kind).map((quantity) => quantity.value)
    if (values.length === 0) {
      reasons.push(`缺少参数 ${requirement.kind}`)
    } else if (!values.some((value) => satisfies(value, requirement))) {
      reasons.push(`参数 ${requirement.kind} 不满足 ${requirement.comparator ?? '='} ${requirement.raw ?? requirement.value}`)
    }
    if (reasons.length >= 4) break
  }
  return reasons
}

/** Pick the ladder tier for `qty`, returning both the used threshold and price. */
export function pickTier(tiers, qty) {
  if (!Array.isArray(tiers) || tiers.length === 0) return undefined
  const sorted = tiers
    .filter((tier) => isRecord(tier) && Number.isFinite(asNumber(tier.qty)) && Number.isFinite(asNumber(tier.unit)))
    .map((tier) => ({ qty: Number(tier.qty), unit: Number(tier.unit) }))
    .sort((left, right) => left.qty - right.qty)
  if (sorted.length === 0) return undefined
  let chosen = sorted[0]
  for (const tier of sorted) {
    if (qty >= tier.qty) chosen = tier
    else break
  }
  return { qty: chosen.qty, unit: chosen.unit, label: `${chosen.qty}+` }
}

/**
 * Compare footprints for a substitution: same package = drop-in, otherwise the
 * PCB needs a change.
 * @param {string | undefined} left
 * @param {string | undefined} right
 */
export function footprintCompatible(left, right) {
  if (left === undefined || right === undefined) return undefined
  return packageMatches(left, right)
}

/* -------------------------------------------------------------------------- */
/* Scoring                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {object} ScoreContext
 * @property {'hand' | 'smt'} assembly
 * @property {number} quantity  components per board
 * @property {number} boards    board count
 * @property {number} orderQty  total parts to buy
 * @property {'balanced' | 'cost' | 'stock'} sort
 */

/**
 * Score one candidate.
 * @param {Record<string, unknown>} item
 * @param {ReturnType<typeof parseNeed>} need
 * @param {ScoreContext} context
 */
export function scoreCandidate(item, need, context) {
  const match = candidateMatches(item, need)
  const tiers = Array.isArray(item.priceUsdTiers) ? item.priceUsdTiers : []
  const unitUsd = pickTierPrice(tiers, context.orderQty)
  const expand = String(item.libraryType ?? '').toLowerCase() !== 'base'
  const modelExact =
    context.modelToken === undefined
      ? false
      : String(item.model ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase() === context.modelToken
  const extendedFeeUsd = context.assembly === 'smt' && expand ? EXTENDED_PART_FEE_USD : 0
  const feePerBoardUsd = extendedFeeUsd === 0 ? 0 : extendedFeeUsd / Math.max(1, context.boards)
  const unitEffectiveUsd =
    unitUsd === undefined
      ? undefined
      : unitUsd + (context.assembly === 'smt' ? feePerBoardUsd / Math.max(1, context.quantity) : 0)
  return { item, match, unitUsd, unitEffectiveUsd, extendedFeeUsd, feePerBoardUsd, expand, modelExact }
}

/** @param {number} stock */
function stockScore(stock) {
  if (!Number.isFinite(stock) || stock <= 0) return 0
  return Math.min(1, Math.max(0, Math.log10(stock + 1) / 7))
}

/**
 * Rank scored candidates (already filtered by `match.ok`).
 * @param {ReturnType<typeof scoreCandidate>[]} candidates
 * @param {ScoreContext} context
 * @param {number} neededQty
 */
export function rankCandidates(candidates, context, neededQty) {
  const priced = candidates.filter((candidate) => candidate.unitEffectiveUsd !== undefined)
  const unitValues = priced.map((candidate) => candidate.unitEffectiveUsd)
  const minUnit = unitValues.length > 0 ? Math.min(...unitValues) : 0
  const maxUnit = unitValues.length > 0 ? Math.max(...unitValues) : 0
  const weights =
    context.sort === 'cost'
      ? { cost: 0.75, stock: 0.1, cover: 0.05, library: 0.05, params: 0.05 }
      : context.sort === 'stock'
        ? { cost: 0.2, stock: 0.55, cover: 0.15, library: 0.05, params: 0.05 }
        : context.assembly === 'smt'
          ? { cost: 0.4, stock: 0.25, cover: 0.15, library: 0.1, params: 0.1 }
          : { cost: 0.5, stock: 0.3, cover: 0.1, library: 0.0, params: 0.1 }
  const scored = candidates.map((candidate) => {
    const unit = candidate.unitEffectiveUsd
    const costScore = unit === undefined
      ? 0.2
      : maxUnit === minUnit
        ? 1
        : 1 - (unit - minUnit) / (maxUnit - minUnit)
    const stock = asInteger(candidate.item.stock) ?? 0
    const cover = neededQty <= 0 ? 1 : Math.min(1, stock / Math.max(1, neededQty * 1.5))
    const library =
      context.assembly === 'smt' ? (candidate.expand ? 0 : 1) : 0.5
    const params = needParamScore(candidate.match)
    const score =
      weights.cost * costScore +
      weights.stock * stockScore(stock) +
      weights.cover * cover +
      weights.library * library +
      weights.params * params
    return { ...candidate, score: Math.round(score * 1000) / 1000, stock, cover }
  })
  scored.sort((left, right) => {
    if (left.modelExact !== right.modelExact) return left.modelExact ? -1 : 1
    if (right.score !== left.score) return right.score - left.score
    const leftUnit = left.unitEffectiveUsd ?? Number.POSITIVE_INFINITY
    const rightUnit = right.unitEffectiveUsd ?? Number.POSITIVE_INFINITY
    if (leftUnit !== rightUnit) return leftUnit - rightUnit
    return right.stock - left.stock
  })
  return scored
}

/** @param {{ matched: string[] }} match */
function needParamScore(match) {
  return match.matched !== undefined && match.matched.length > 0 ? 1 : 0.5
}

/* -------------------------------------------------------------------------- */
/* Suggestion / output helpers                                                */
/* -------------------------------------------------------------------------- */

/** Pick the attributes worth showing to the model (max 6). */
function pickSpecs(item) {
  const preferred = /capacitance|resistance|inductance|voltage rating|output voltage|output current|current - output|tolerance|temperature coefficient|drain-source|forward current|power|package|size|dimension/i
  const specs = []
  for (const attribute of attributesOf(item)) {
    if (!preferred.test(attribute.name)) continue
    specs.push({ name: attribute.name, value: attribute.value })
    if (specs.length >= 6) break
  }
  return specs
}

/** @param {ReturnType<typeof scoreCandidate>} candidate @param {ScoreContext} context */
function reasonsFor(candidate, context) {
  const reasons = []
  if (context.assembly === 'smt') {
    reasons.push(
      candidate.expand
        ? `扩展库：每片板摊 $${money(candidate.feePerBoardUsd)} 上料费（每料号 $${EXTENDED_PART_FEE_USD}/单）`
        : '基础库：无上料费',
    )
  }
  if (candidate.unitUsd !== undefined) {
    reasons.push(`阶梯价 $${candidate.unitUsd}（按采购量 ${context.orderQty}）`)
  }
  reasons.push(`库存 ${candidate.stock}`)
  if (candidate.cover >= 1) reasons.push(`库存覆盖需求（${Math.round(candidate.cover * 100)}%）`)
  else if (candidate.cover < 1) reasons.push(`库存仅覆盖需求的 ${Math.round(candidate.cover * 100)}%`)
  if (candidate.modelExact === true) reasons.push('型号精确匹配')
  if (candidate.match.matched.length > 0) reasons.push(`参数匹配：${candidate.match.matched.slice(0, 4).join(', ')}`)
  return reasons
}

/**
 * Find requirement-matching parts.
 * @param {ReturnType<typeof createLcscService>} service
 * @param {Record<string, unknown>} args
 * @param {{ signal?: AbortSignal }} [options]
 */
/** Identity constraints that must not be relaxed when looking for substitutes. */
const IDENTITY_REQUIREMENT_KINDS = new Set(['capacitance', 'resistance', 'inductance', 'pins'])

/** Pin/contact count reported by the JLCPCB attributes, if available. */
function candidatePinCount(item) {
  for (const attribute of attributesOf(item)) {
    if (/number of (contacts|positions|pins)|contacts|positions|pin count|number of pins/i.test(attribute.name)) {
      const match = attribute.value.match(/\d{1,3}/)
      if (match !== null) return Number(match[0])
    }
  }
  const pins = extractCandidateQuantities(item).find((quantity) => quantity.kind === 'pins')
  return pins === undefined ? undefined : pins.value
}

/**
 * Find requirement-matching parts.
 * @param {ReturnType<typeof createLcscService>} service
 * @param {Record<string, unknown>} args
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function findParts(service, args, options = {}) {
  const needText = asString(args.need)
  if (needText === undefined) throw new Error('find_lcsc_parts requires a non-empty `need` string')
  const assembly = args.assembly === 'smt' ? 'smt' : 'hand'
  const quantity = clampInteger(args.quantity, 1, 100000, 1)
  const boards = clampInteger(args.boards, 1, 100000, 1)
  const limit = clampInteger(args.limit, 1, MAX_CANDIDATES, DEFAULT_LIMIT)
  const sort = ['cost', 'stock'].includes(args.sort) ? args.sort : 'balanced'
  const baseOnly = args.base_only === true
  const requireStock = ['lcsc', 'smt'].includes(args.require_stock) ? args.require_stock : 'any'
  const includeCny = args.include_cny === true || (args.include_cny === undefined && assembly === 'hand') || requireStock === 'lcsc'
  const exclude = new Set(
    (Array.isArray(args.exclude_lcsc) ? args.exclude_lcsc : [])
      .map((code) => normalizeCode(code))
      .filter(Boolean),
  )
  const need = parseNeed(needText)
  const orderQty = quantity * boards
  const feeUsd = asNumber(service.settings?.extendedPartFeeUsd) ?? EXTENDED_PART_FEE_USD
  const usdToCnyFactor = asNumber(service.settings?.usdToCnyFactor) ?? 6.0
  const context = {
    assembly,
    quantity,
    boards,
    orderQty,
    sort,
    modelToken: need.modelGuess ? need.modelToken : undefined,
    feeUsd,
  }
  const notes = []
  const hints = []

  /** @type {Map<string, Record<string, unknown>>} */
  const pool = new Map()
  /** @param {{ total: number, items: Record<string, unknown>[] }} result */
  const absorb = (result) => {
    for (const item of result.items) {
      if (!pool.has(String(item.code))) pool.set(String(item.code), item)
    }
    return pool.size
  }

  // ---- Phase 1: candidate recall -------------------------------------------
  const queries = []
  if (need.exact) {
    queries.push({ keyword: need.searchKeyword })
  } else if (assembly === 'smt') {
    // Search the base library first so free-to-load parts are not drowned out.
    queries.push({ keyword: need.searchKeyword, libraryType: 'base' })
    queries.push({ keyword: need.searchKeyword })
  } else {
    queries.push({ keyword: need.searchKeyword })
  }
  for (const query of queries) {
    const result = await service.searchRaw(query.keyword, {
      pageSize: SEARCH_PAGE_SIZE,
      libraryType: query.libraryType,
      signal: options.signal,
    })
    absorb(result)
  }
  // Degradation chain for recall: simplified category terms -> English tokens
  // in the raw text -> package+category -> raw text. This keeps Chinese
  // colloquial requirements ("MEMS 麦克风", "USB Type-C 16P 母座") searchable.
  if (pool.size === 0 && !need.exact) {
    for (const fallbackKeyword of recallFallbackKeywords(need)) {
      if (pool.size > 0) break
      notes.push(`关键词「${need.searchKeyword}」无结果，回退到「${fallbackKeyword}」。`)
      absorb(await service.searchRaw(fallbackKeyword, { pageSize: SEARCH_PAGE_SIZE, signal: options.signal }))
    }
  }
  if (pool.size === 0 && need.exact) {
    // The code/model search found nothing; the text may still be a model with
    // punctuation that the API search does not match verbatim.
    absorb(await service.searchRaw(need.raw, { pageSize: SEARCH_PAGE_SIZE, signal: options.signal }))
  }

  // ---- Phase 2: strict filter, then staged relaxation ----------------------
  const usablePool = () =>
    [...pool.values()]
      .filter((item) => !exclude.has(String(item.code)))
      .filter((item) => (asInteger(item.stock) ?? 0) > 0)
  const scoreWith = (needForFilter) =>
    usablePool()
      .map((item) => scoreCandidate(item, needForFilter, context))
      .filter((candidate) => candidate.match.ok)

  let relaxed = false
  let relaxStage = 0
  let droppedRequirements = []
  let scored = scoreWith(need)
  if (scored.length === 0 && !need.exact && need.requirements.length > 0) {
    // Stage 1: keep identity (value/package) constraints, relax ratings.
    const identity = need.requirements.filter((requirement) => IDENTITY_REQUIREMENT_KINDS.has(requirement.kind))
    if (identity.length !== need.requirements.length) {
      const stageScored = scoreWith({ ...need, requirements: identity })
      if (stageScored.length > 0) {
        scored = stageScored
        relaxed = true
        relaxStage = 1
        droppedRequirements = need.requirements
          .filter((requirement) => !IDENTITY_REQUIREMENT_KINDS.has(requirement.kind))
          .map((requirement) => requirement.raw ?? requirement.kind)
        notes.push(`严格匹配无结果：已放宽非核心参数（${droppedRequirements.join('、')}），保留容值/阻值/感值/引脚数等身份参数。`)
      }
    }
    // Stage 2: drop the remaining requirements, keep package/category.
    if (scored.length === 0) {
      const stageScored = scoreWith({ ...need, requirements: [] })
      if (stageScored.length > 0) {
        scored = stageScored
        relaxed = true
        relaxStage = 2
        droppedRequirements = need.requirements.map((requirement) => requirement.raw ?? requirement.kind)
        notes.push('严格匹配无结果：已仅按封装/品类筛候选，参数需人工核对（见每行 mismatch_reasons）。')
      }
    }
    // Stage 3: last resort, everything in the recall pool.
    if (scored.length === 0) {
      scored = usablePool().map((item) => ({
        ...scoreCandidate(item, need, context),
        match: { ok: true, matched: [] },
      }))
      if (scored.length > 0) {
        relaxed = true
        relaxStage = 3
        notes.push('没有满足条件的候选；以下为最接近的候选，不匹配原因见 mismatch_reasons。')
      }
    }
  }

  if (baseOnly) {
    const baseCandidates = scored.filter((candidate) => !candidate.expand)
    if (baseCandidates.length === 0) {
      hints.push('该品类没有找到基础库（base library）候选；可去掉 base_only 或接受扩展库（SMT 每料号有上料费）。')
    } else {
      scored = baseCandidates
    }
  }
  if (assembly === 'smt' && !baseOnly) {
    const hasBase = scored.some((candidate) => !candidate.expand) ||
      [...pool.values()].some((item) => String(item.libraryType).toLowerCase() === 'base')
    if (!hasBase && scored.length > 0) {
      hints.push(`该品类未找到基础库候选（均为扩展库，$${feeUsd}/料号上料费）；请到下单页确认优选扩展库分类。`)
    }
  }

  let ranked = rankCandidates(scored, context, orderQty)

  // ---- Phase 3: real CNY prices (domestic store via Chrome) ----------------
  /** @type {Map<string, Record<string, unknown>>} */
  const cnyByCode = new Map()
  if (includeCny && ranked.length > 0) {
    const cnyLookupCount = requireStock === 'lcsc' ? Math.min(10, ranked.length) : Math.min(MAX_CNY_LOOKUPS, ranked.length)
    const targets = ranked.slice(0, cnyLookupCount)
    const results = await mapLimit(targets, 2, async (candidate) => {
      const code = String(candidate.item.code)
      try {
        if (typeof service.cn?.query === 'function') {
          const cn = await service.cn.query(code)
          // Keep the adapter's own failure reason (chrome-not-found, WAF, …) so
          // the caller can see WHY real CNY is missing and how to fix it.
          if (cn !== undefined && cn !== null) return cn
        }
        if (typeof service.cny === 'function') return await service.cny(code, options.signal)
        return { ok: false, reason: 'cny-adapter-unavailable' }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    })
    for (let index = 0; index < targets.length; index += 1) {
      cnyByCode.set(String(targets[index].item.code), results[index])
    }
    const covered = [...cnyByCode.values()].filter((result) => result?.ok === true).length
    if (covered > 0) {
      notes.push(`人民币价来自立创商城国内站（Chrome 渲染，${covered}/${targets.length} 个候选取到 CNY，24h 缓存）。USD 与 CNY 并列，不混算。`)
    }
    const cnyFailure = cnFailureHint(results, service.cn)
    if (cnyFailure !== undefined) hints.push(cnyFailure)
  }

  // require_stock: DIY defaults to the retail warehouse; PCBA can ask for SMT.
  if (requireStock !== 'any' && ranked.length > 0) {
    const kept = []
    const dropped = []
    for (const candidate of ranked) {
      const code = String(candidate.item.code)
      const smtStock = asInteger(candidate.item.stock) ?? 0
      const cn = cnyByCode.get(code)
      const retailStock = cn?.ok === true ? asInteger(cn.stock) : undefined
      if (requireStock === 'smt') {
        if (smtStock > 0) kept.push(candidate)
        else dropped.push(code)
      } else if (retailStock !== undefined && retailStock > 0) {
        kept.push(candidate)
      } else {
        dropped.push(code)
      }
    }
    if (kept.length < ranked.length) {
      notes.push(`require_stock=${requireStock}：${dropped.length} 个候选因库存口径不满足被跳过${dropped.length > 0 ? `（如 ${dropped.slice(0, 4).join(', ')}）` : ''}。`)
    }
    if (kept.length === 0) hints.push(`require_stock=${requireStock} 时没有库存满足的候选；可改用 require_stock="any" 查看全部。`)
    ranked = kept
  }

  // ---- Phase 4: build output ----------------------------------------------
  const candidates = ranked.slice(0, limit).map((candidate) => {
    const code = String(candidate.item.code)
    const cny = cnyByCode.get(code)
    const cnyUnit = cny?.ok === true ? asNumber(cny.unit) : undefined
    const cnyStock = cny?.ok === true ? asInteger(cny.stock) : undefined
    const tier = pickTier(candidate.item.priceUsdTiers, orderQty)
    const bulkUsd = bulkTierUsd(candidate.item)
    const cnyEstimate = cnyUnit === undefined ? estimateCnyFromUsd(bulkUsd, usdToCnyFactor) : undefined
    const stockSmt = asInteger(candidate.item.stock) ?? 0
    const stockLcsc = cnyStock ?? null
    const stock = assembly === 'smt' ? stockSmt : (stockLcsc ?? stockSmt)
    const stockAsOf = cny?.ok === true ? (cny.fetched_at ?? new Date().toISOString()) : new Date().toISOString()
    const dataWarnings = []
    if (stockLcsc === 0 && stockSmt > 0) dataWarnings.push('retail_out_of_stock_smt_ok')
    if (stockLcsc !== null && stockLcsc > 0 && stockSmt === 0) dataWarnings.push('smt_out_of_stock_retail_ok')
    const priceUsd = tier === undefined
      ? null
      : {
          currency: 'USD',
          unit: money(tier.unit),
          tier: tier.label,
          source: 'jlcpcb-smt',
          tiers: (candidate.item.priceUsdTiers ?? []).slice(0, 8).map((entry) => ({ qty: entry.qty, unit: money(entry.unit) })),
        }
    const priceCny = cnyUnit !== undefined
      ? {
          currency: 'CNY',
          unit: money(cnyUnit),
          source: cny.source ?? 'lcsc_cn_render',
          estimated: false,
          cached: cny.cached === true,
          fetched_at: cny.fetched_at,
        }
      : cnyEstimate === undefined
        ? null
        : {
            currency: 'CNY',
            unit: cnyEstimate,
            source: 'usd_x_factor',
            estimated: true,
            factor: usdToCnyFactor,
            note: '参考估算（批量档 USD × 系数），非实际报价',
          }
    // The primary `price` field is the actual reference price. In hand mode a
    // real CNY price wins; when CNY is only an estimate, USD stays primary (the
    // estimate is still exposed in price_cny/cny_estimate and clearly labelled).
    const primaryPrice = assembly === 'smt'
      ? priceUsd
      : (priceCny !== null && priceCny.estimated !== true ? priceCny : (priceUsd ?? priceCny))
    return {
      lcsc: candidate.item.code,
      model: candidate.item.model,
      brand: candidate.item.brand,
      package: candidate.item.package,
      category: candidate.item.category,
      pin_count: candidatePinCount(candidate.item),
      library: candidate.expand ? 'expand' : 'base',
      preferred: candidate.item.preferred === true ? true : null,
      stock,
      stock_retail: stockLcsc,
      stock_smt: stockSmt,
      stock_global: null,
      stock_lcsc: stockLcsc,
      stock_asof: stockAsOf,
      stock_scope: assembly,
      stock_scope_note: assembly === 'smt'
        ? 'SMT 库存（嘉立创 PCBA 备料仓），与立创商城零售库存独立'
        : '立创商城零售库存（DIY 配单）；SMT 库存另列',
      data_warnings: dataWarnings.length === 0 ? undefined : dataWarnings,
      coverage: orderQty > 0 ? Math.min(1, Math.round((stock / orderQty) * 100) / 100) : undefined,
      price: primaryPrice === null ? undefined : { currency: primaryPrice.currency, unit: primaryPrice.unit, source: primaryPrice.source },
      price_usd: priceUsd,
      price_cny: priceCny,
      used_tier: tier?.label ?? null,
      effective_unit_usd: candidate.unitEffectiveUsd === undefined ? undefined : money(candidate.unitEffectiveUsd),
      fee_per_board_usd: assembly === 'smt' ? money(candidate.feePerBoardUsd) : 0,
      cny_price: cnyUnit === undefined ? null : money(cnyUnit),
      cny_estimate: priceCny === null || priceCny.estimated !== true
        ? null
        : { unit: priceCny.unit, factor: usdToCnyFactor, basis: 'highest-volume USD tier × factor', note: '参考估算，非实时汇率/非实际报价' },
      specs: pickSpecs(candidate.item),
      score: candidate.score,
      reasons: reasonsFor(candidate, context),
      mismatch_reasons: relaxStage >= 2 && need.requirements.length > 0 ? mismatchReasons(candidate.item, need) : undefined,
      url: asString(candidate.item.url) ?? `https://www.lcsc.com/product-detail/${candidate.item.code}.html`,
    }
  })

  if (candidates.length === 0) {
    hints.push(
      '没有找到候选。建议：改用型号/LCSC 编号（如 SMF5.0A / TP4054 / C307331）；或减少参数；或把中文品类换成英文（capacitor / resistor / LDO / connector）。',
    )
  }
  if (need.exact) {
    notes.push(`按${need.directCode !== undefined ? ' LCSC 编号' : '型号'}精确查询（${need.exactValue}），未做参数解析。`)
  } else if (need.requirements.length > 0) {
    notes.push(`解析到参数条件：${need.requirements.map((requirement) => `${requirement.kind}${requirement.comparator ?? '='}${requirement.value}`).join(', ')}`)
  }
  if (assembly === 'hand') {
    notes.push('assembly=hand：不考虑嘉立创上料费与基础库偏好；价格优先展示立创商城人民币零售价，USD 并列参考。')
  } else {
    notes.push(`assembly=smt：扩展库按每料号 $${feeUsd}/单上料费摊销；基础库优先度体现在排序里。`)
  }

  const allWarnings = [...new Set(candidates.flatMap((candidate) => candidate.data_warnings ?? []))]
  if (allWarnings.includes('retail_out_of_stock_smt_ok')) {
    notes.push('注意：部分候选「立创零售仓缺货、嘉立创 SMT 仓有货」——不是停产；DIY 配单需看 stock_retail，PCBA 可看 stock_smt。')
  }
  return {
    need: needText,
    exact: need.exact,
    assembly,
    quantity,
    boards,
    order_qty: orderQty,
    require_stock: requireStock,
    stock_scope_note: assembly === 'smt'
      ? '默认按嘉立创 SMT 库存；DIY 配单请传 require_stock="lcsc"'
      : '默认按立创商城零售库存；PCBA 请传 require_stock="smt"',
    currency: includeCny ? 'USD + CNY（并列，不混算）' : 'USD（CNY 为参考估算）',
    relaxed,
    relax_stage: relaxStage,
    candidates,
    data_warnings: allWarnings,
    hints,
    notes,
    fetched_at: new Date().toISOString(),
  }
}

/* -------------------------------------------------------------------------- */
/* BOM audit                                                                  */
/* -------------------------------------------------------------------------- */

/** @param {unknown} input @returns {{ line: number, code: string, qty: number, designators?: string, comment?: string }[]} */
/**
 * Normalise a per-line placement value to `smt` | `hand` | `dnp`.
 * A BOM without a placement column inherits the audit's assembly mode: a hand
 * audit must not label every line `smt` (that contradicted the summary).
 * @param {unknown} value
 * @param {'smt' | 'hand'} [fallback]
 */
export function normalizePlace(value, fallback = 'smt') {
  const defaultPlace = fallback === 'hand' ? 'hand' : 'smt'
  const text = String(value ?? '').trim().toLowerCase()
  if (text === '') return defaultPlace
  if (/dnp|do ?not|不贴|未贴|不焊|no ?populate|不上件/.test(text)) return 'dnp'
  if (/hand|手焊|手工|烙铁|manual/.test(text)) return 'hand'
  if (/smt|贴片|机贴|回流|reflow/.test(text)) return 'smt'
  return defaultPlace
}

/**
 * Explain why real CNY prices were missing and tell the calling agent how to
 * fix the local Chrome configuration. Without this the tool silently degrades
 * to USD estimates and nobody knows a one-line config change would fix it.
 * @param {Record<string, unknown>[]} results per-code CNY query results
 * @param {{ chrome?: { path?: string, source?: string, tried?: string[], hint?: string } } | undefined} adapter
 * @returns {string | undefined}
 */
function cnFailureHint(results, adapter) {
  const total = results.length
  if (total === 0) return undefined
  const failed = results.filter((result) => result?.ok !== true)
  if (failed.length === 0) return undefined
  const counts = new Map()
  for (const result of failed) {
    const reason = String(result?.reason ?? 'unknown')
    counts.set(reason, (counts.get(reason) ?? 0) + 1)
  }
  const breakdown = [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([reason, count]) => `${reason}×${count}`)
    .join('，')
  const parts = [`国内站人民币价 ${total - failed.length}/${total} 成功，失败原因：${breakdown}。`]
  const transient = ['szlcsc-waf-challenge', 'chrome-render-empty', 'page-parse-failed'].filter((reason) => counts.has(reason))
  if (counts.has('chrome-not-found')) {
    parts.push(
      typeof adapter?.chrome?.hint === 'string'
        ? adapter.chrome.hint
        : '未找到 Chrome/Chromium：请配置 chromePath 或设置环境变量 CHROME_BIN 后重试。',
    )
  } else if (transient.length > 0) {
    parts.push(
      '以上失败属阵发问题（阿里云 WAF 限流或页面渲染为空），已自动重试 1 次；' +
        '稍后重试即可，不需要改配置。成功的料号已写入 24h 缓存，重跑只补失败项。' +
        '若频繁出现，可把 cnConcurrency 降到 1（默认 2）以减少触发。',
    )
  }
  if (counts.has('product-id-not-found')) {
    parts.push('部分料号在 EasyEDA 查不到商品 id 映射（常见于新料或国内专属料），重试无效，只能参考 USD 价。')
  }
  if (counts.has('cny-adapter-unavailable')) {
    parts.push('人民币适配器未初始化（Chrome 渲染器未挂载），请检查插件是否完整安装及宿主日志。')
  }
  if (counts.has('cn-budget-exceeded')) {
    parts.push('部分料号超出时间预算未查完；结果已写入 24h 缓存，再调用一次会更快补齐。')
  }
  if (adapter?.chrome?.path !== undefined && counts.has('chrome-not-found') === false) {
    parts.push(`当前 Chrome：${adapter.chrome.path}（来源 ${adapter.chrome.source ?? 'auto'}）。`)
  }
  return parts.join('')
}

/** @param {unknown} input @returns {{ rows: { line: number, code: string, qty: number, designators?: string, comment?: string, place?: string }[], skipped: { line: number, raw?: string, comment?: string, designators?: string }[] }} */
function parseBomInput(input) {
  if (typeof input === 'string') {
    const head = input.slice(0, 8)
    if (head.startsWith('PK\u0003\u0004') || head.startsWith('PK\u0005\u0006') || head.startsWith('<?xml')) {
      throw new Error(
        'audit_lcsc_bom 收到的是 xlsx/二进制内容而不是 BOM 文本：请先在 Excel 里「另存为」CSV/TSV（或转成 CSV 文本）再传入',
      )
    }
    const text = input.trim()
    if (text === '') throw new Error('audit_lcsc_bom requires a non-empty BOM string')
    if (text.startsWith('[') || text.startsWith('{')) {
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = undefined
      }
      if (Array.isArray(parsed)) return { rows: parseBomRows(parsed), skipped: [] }
      if (isRecord(parsed) && Array.isArray(parsed.rows)) return { rows: parseBomRows(parsed.rows), skipped: [] }
    }
    const detailed = parseBomCsvDetailed(text)
    return {
      skipped: detailed.skipped,
      rows: detailed.rows.map((row) => ({
        line: row.line,
        code: normalizeCode(row.code) ?? '',
        qty: Math.max(1, asInteger(row.qty) ?? 1),
        designators: row.designators,
        comment: row.comment,
        place: row.place,
      })),
    }
  }
  if (Array.isArray(input)) return { rows: parseBomRows(input), skipped: [] }
  throw new Error('audit_lcsc_bom requires `bom` as CSV text or an array of {lcsc/code, qty, place} rows')
}

/** @param {unknown[]} rows */
function parseBomRows(rows) {
  const result = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const code = normalizeCode(row.lcsc ?? row.code ?? row.LCSC)
    const qty = Math.max(1, asInteger(row.qty ?? row.quantity ?? 1) ?? 1)
    result.push({
      line: result.length + 1,
      code: code ?? '',
      qty,
      designators: asString(row.designators ?? row.refs ?? row.ref),
      comment: asString(row.comment ?? row.description ?? row.model),
      place: asString(row.place ?? row.mount ?? row.assembly),
    })
  }
  return result
}

/**
 * Merge BOM rows that reference the same LCSC code: quantities and designators
 * are combined, the feeder fee is charged once per unique part, and the price
 * tier is taken at the combined order quantity.
 */
function mergeBomRows(rows, assembly = 'smt') {
  /** @type {Map<string, { code: string, qty: number, designators: string[], comments: string[], places: string[], lines: { line: number, qty: number, designators?: string, place: string }[] }>} */
  const byCode = new Map()
  const fallbackPlace = assembly === 'hand' ? 'hand' : 'smt'
  for (const row of rows) {
    const place = normalizePlace(row.place, fallbackPlace)
    const key = `${row.code}|${place}`
    const entry = byCode.get(key)
    if (entry === undefined) {
      byCode.set(key, {
        code: row.code,
        qty: row.qty,
        designators: row.designators === undefined ? [] : [row.designators],
        comments: row.comment === undefined ? [] : [row.comment],
        places: [place],
        lines: [{ line: row.line, qty: row.qty, designators: row.designators, place }],
      })
      continue
    }
    entry.qty += row.qty
    if (row.designators !== undefined) entry.designators.push(row.designators)
    if (row.comment !== undefined) entry.comments.push(row.comment)
    entry.places.push(place)
    entry.lines.push({ line: row.line, qty: row.qty, designators: row.designators, place })
  }
  for (const entry of byCode.values()) {
    // groups are keyed by code|place, so every entry has a single place
    entry.place = entry.places[0] ?? 'smt'
  }
  return [...byCode.values()]
}

/**
 * Build a synthetic need from an existing part so we can search for a base
 * library alternative with the same identity parameters.
 * @param {Record<string, unknown>} item
 * @param {ReturnType<typeof parseNeed>} originalNeed
 */
function needFromItem(item, originalNeed) {
  const requirements = []
  for (const attribute of attributesOf(item)) {
    const name = attribute.name
    const value = attribute.value
    const pushParsed = (kind, comparator) => {
      for (const parsed of parseQuantitiesOfKind(value, kind)) {
        requirements.push({ kind, value: parsed, unit: '', comparator, raw: `${name}=${value}` })
      }
    }
    if (/^capacitance$/i.test(name)) pushParsed('capacitance', '=')
    else if (/^resistance$/i.test(name)) pushParsed('resistance', '=')
    else if (/^inductance$/i.test(name)) pushParsed('inductance', '=')
    else if (/^output voltage$/i.test(name)) pushParsed('voltage', '=')
    else if (/voltage rating|reverse voltage|drain-source voltage|maximum input voltage/i.test(name)) pushParsed('voltage', '>=')
    else if (/output current|forward current|current - output/i.test(name)) pushParsed('current', '>=')
  }
  return {
    ...originalNeed,
    requirements,
    directCode: undefined,
    modelGuess: false,
    categories: originalNeed.categories,
    package: originalNeed.package ?? asString(item.package),
    searchKeyword: [
      asString(item.package),
      ...attributesOf(item)
        .filter((attribute) => /capacitance|resistance|voltage rating|output voltage|output current|inductance/i.test(attribute.name))
        .slice(0, 3)
        .map((attribute) => attribute.value),
    ].filter(Boolean).join(' ') || String(item.model ?? item.code ?? ''),
  }
}

/**
 * Find one basic-library substitute for an extended part, with the net saving
 * (feeder fee avoided minus component price delta at the order quantity).
 * "换成基础库不一定更便宜" is why the caller needs the net number, not just
 * "free feeder loading".
 * @param {ReturnType<typeof createLcscService>} service
 * @param {Record<string, unknown>} item
 * @param {ReturnType<typeof parseNeed>} originalNeed
 * @param {{ signal?: AbortSignal, orderQty?: number, feeUsd?: number }} [options]
 */
export async function findAlternative(service, item, originalNeed, options = {}) {
  const packageName = asString(item.package)
  const orderQty = Math.max(1, asInteger(options.orderQty) ?? 1)
  const feeUsd = asNumber(options.feeUsd) ?? EXTENDED_PART_FEE_USD
  const originalTier = pickTier(item.priceUsdTiers, orderQty)
  const originalUnit = originalTier?.unit
  const tryCodes = []
  const alternatives = asString(item.alternatives)
  if (alternatives !== undefined) {
    for (const match of alternatives.matchAll(/C\d{4,11}/gi)) tryCodes.push(match[0].toUpperCase())
  }
  const candidates = []
  for (const code of tryCodes.slice(0, 3)) {
    const result = await service.searchRaw(code, { pageSize: 5, signal: options.signal })
    const hit = result.items.find((candidate) => String(candidate.code) === code)
    if (hit !== undefined && String(hit.libraryType).toLowerCase() === 'base') candidates.push(hit)
  }
  if (candidates.length === 0) {
    const need = needFromItem(item, originalNeed)
    const categoryName = asString(item.category)
    /** @param {Record<string, unknown>[]} items */
    const collect = (items) => {
      for (const candidate of items) {
        if (String(candidate.libraryType).toLowerCase() !== 'base') continue
        // A substitute must be the same kind of device; a different package is
        // allowed but flagged (footprint_compatible=false means a PCB respin).
        if (categoryName !== undefined) {
          const candidateCategory = asString(candidate.category)
          if (candidateCategory === undefined || candidateCategory.toLowerCase() !== categoryName.toLowerCase()) continue
        }
        if ((asInteger(candidate.stock) ?? 0) <= 0) continue
        if (candidateMatches(candidate, need).ok) candidates.push(candidate)
      }
    }
    // First try same package + identity values, then relax the package prefix so
    // e.g. 0603 ferrite beads can surface an 0805 base part (flagged as needing
    // a footprint change) instead of reporting "no alternative" wrongly.
    const withPackage = await service.searchRaw(need.searchKeyword, {
      pageSize: 50,
      libraryType: 'base',
      signal: options.signal,
    })
    collect(withPackage.items)
    if (candidates.length === 0) {
      const withoutPackageKeyword = attributesOf(item)
        .filter((attribute) => /capacitance|resistance|voltage rating|output voltage|output current|inductance|impedance/i.test(attribute.name))
        .slice(0, 3)
        .map((attribute) => attribute.value)
        .filter(Boolean)
        .join(' ')
      if (withoutPackageKeyword !== '' && withoutPackageKeyword !== need.searchKeyword) {
        const withoutPackage = await service.searchRaw(withoutPackageKeyword, {
          pageSize: 50,
          libraryType: 'base',
          signal: options.signal,
        })
        collect(withoutPackage.items)
      }
    }
  }
  if (candidates.length === 0) return undefined
  const scored = candidates.map((candidate) => {
    const context = { assembly: 'smt', quantity: 1, boards: 1, orderQty, sort: 'cost', feeUsd }
    return scoreCandidate(candidate, originalNeed, context)
  })
  /** @type {{ score: ReturnType<typeof scoreCandidate>, net: number, componentDelta: number }[]} */
  const evaluated = []
  for (const candidate of scored) {
    const tier = pickTier(candidate.item.priceUsdTiers, orderQty)
    const unit = tier?.unit
    const componentDelta = originalUnit !== undefined && unit !== undefined ? (unit - originalUnit) * orderQty : 0
    const net = feeUsd - componentDelta
    evaluated.push({ score: candidate, net, componentDelta })
  }
  evaluated.sort((left, right) => right.net - left.net)
  const requireStock = ['lcsc', 'smt'].includes(options.requireStock) ? options.requireStock : 'any'
  const includeCny = options.includeCny === true || requireStock === 'lcsc'
  /** @param {string} code */
  const queryRetail = async (code) => {
    try {
      if (typeof service.cn?.query === 'function') {
        const cn = await service.cn.query(code)
        if (cn !== undefined && cn !== null) return cn
      }
      if (typeof service.cny === 'function') return await service.cny(code, options.signal)
    } catch {
      // ignore
    }
    return undefined
  }
  /** @type {{ lcsc: string, reason: string }[]} */
  const skipped = []
  /** @type {ReturnType<typeof scoreCandidate> | undefined} */
  let best
  for (const entry of evaluated.slice(0, requireStock === 'lcsc' ? 4 : 1)) {
    const code = String(entry.score.item.code)
    if (requireStock === 'lcsc') {
      const cn = await queryRetail(code)
      const retail = cn?.ok === true ? asInteger(cn.stock) : undefined
      if (retail === undefined || retail <= 0) {
        skipped.push({ lcsc: code, reason: retail === 0 ? 'lcsc-stock-0' : 'lcsc-stock-unknown' })
        continue
      }
    }
    best = entry.score
    break
  }
  if (best === undefined) {
    return { blocked: true, require_stock: requireStock, skipped }
  }
  const retail = includeCny ? await queryRetail(String(best.item.code)) : undefined
  return {
    lcsc: best.item.code,
    model: best.item.model,
    package: best.item.package,
    library: 'base',
    stock: asInteger(best.item.stock) ?? 0,
    stock_smt: asInteger(best.item.stock) ?? 0,
    stock_retail: retail?.ok === true ? asInteger(retail.stock) : null,
    stock_asof: retail?.ok === true ? retail.fetched_at : new Date().toISOString(),
    stock_scope_note: requireStock === 'lcsc'
      ? '按立创零售库存筛选（DIY 配单）'
      : 'SMT 库存；立创零售库存见 stock_retail',
    require_stock: requireStock,
    skipped,
    unit_usd: best.unitUsd === undefined ? undefined : money(best.unitUsd),
    fee_saved_usd: money(feeUsd),
    component_delta_usd: money(best.componentDelta),
    net_saving_usd: money(best.net),
    footprint_compatible: footprintCompatible(packageName, asString(best.item.package)),
  }
}

/**
 * Audit an existing BOM.
 * @param {ReturnType<typeof createLcscService>} service
 * @param {Record<string, unknown>} args
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function auditBom(service, args, options = {}) {
  const { rows, skipped } = parseBomInput(args.bom)
  if (rows.length === 0) {
    throw new Error(
      `audit_lcsc_bom parsed 0 rows from the BOM input${skipped.length > 0 ? `（其中 ${skipped.length} 行缺少可识别的 LCSC 编号）` : ''}`,
    )
  }
  const assembly = args.assembly === 'smt' ? 'smt' : 'hand'
  const boards = clampInteger(args.boards, 1, 100000, 1)
  let includeCny = args.include_cny === true
  const requireStock = ['lcsc', 'smt', 'any'].includes(args.require_stock) ? args.require_stock : 'any'
  const stockScope = requireStock === 'any' ? (assembly === 'smt' ? 'smt' : 'lcsc') : requireStock
  const suggestAlternatives = args.suggest_alternatives !== false
  const exportBom = args.export_bom === true
  const region = args.region === 'cn' ? 'cn' : 'global'
  const settings = service.settings ?? {}
  const feeUsd = asNumber(settings.extendedPartFeeUsd) ?? EXTENDED_PART_FEE_USD
  const setupFeeUsd = asNumber(settings.setupFeeUsd) ?? 0
  const stencilFeeUsd = asNumber(settings.stencilFeeUsd) ?? 0
  const usdToCnyFactor = asNumber(settings.usdToCnyFactor) ?? 6.0
  const notes = []
  const hints = []
  const errors = []

  const merged = mergeBomRows(rows, assembly)
  const codes = [...new Set(merged.map((entry) => entry.code).filter((code) => code !== ''))]
  if (args.include_cny === undefined && assembly === 'hand' && merged.length <= 8) includeCny = true
  if (args.include_cny === undefined && assembly === 'hand' && merged.length > 8) {
    hints.push('BOM 较大，默认跳过 Chrome 逐料取人民币价（较慢）：设 include_cny=true 可强制获取真实 CNY（有 24h 缓存）。')
  }

  // ---- JLCPCB library data (one exact lookup per unique code) --------------
  const jlcEntries = await mapLimit(codes, 3, async (code) => {
    try {
      const result = await service.searchRaw(code, { pageSize: 5, signal: options.signal })
      const hit = result.items.find((candidate) => String(candidate.code).toUpperCase() === code)
      return [code, hit, hit === undefined ? 'not found in JLCPCB library' : undefined]
    } catch (error) {
      return [code, undefined, error instanceof Error ? error.message : String(error)]
    }
  })
  /** @type {Map<string, Record<string, unknown> | undefined>} */
  const jlcByCode = new Map()
  for (const entry of jlcEntries) {
    const [code, hit, error] = entry
    jlcByCode.set(code, hit)
    if (hit === undefined && error !== undefined) errors.push(`${code}: ${error}`)
  }

  // ---- LCSC domestic CNY data (Chrome adapter, capped) ----------------------
  /** @type {Map<string, Record<string, unknown>>} */
  const cnyByCode = new Map()
  if (includeCny && codes.length > 0) {
    const targets = codes.slice(0, MAX_AUDIT_CNY_LOOKUPS)
    const budgetMs = asNumber(settings.cnQueryBudgetMs) ?? 90000
    const deadline = budgetMs > 0 ? Date.now() + budgetMs : Number.POSITIVE_INFINITY
    const results = await mapLimit(targets, 2, async (code) => {
      if (Date.now() > deadline) return { ok: false, reason: 'cn-budget-exceeded' }
      try {
        if (typeof service.cn?.query === 'function') {
          const cn = await service.cn.query(code)
          // Keep the adapter's own failure reason (chrome-not-found, WAF, …) so
          // the caller can see WHY real CNY is missing and how to fix it.
          if (cn !== undefined && cn !== null) return cn
        }
        if (typeof service.cny === 'function') return await service.cny(code, options.signal)
        return { ok: false, reason: 'cny-adapter-unavailable' }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    })
    results.forEach((result, index) => cnyByCode.set(targets[index], result))
    const covered = [...cnyByCode.values()].filter((result) => result?.ok === true).length
    const budgetHit = results.some((result) => result?.reason === 'cn-budget-exceeded')
    if (budgetHit) {
      hints.push(`人民币价查询达到时间预算（${Math.round(budgetMs / 1000)}s）后提前返回；已取到的结果已写入 24h 缓存，直接再调用一次会更快补齐剩余料号。`)
    }
    notes.push(
      `国内站人民币价：${covered}/${targets.length} 个料取到真实 CNY（Chrome 渲染 + 24h 缓存）；未取到的行回退为批量档 USD×${usdToCnyFactor} 估算并标 estimated=true。`,
    )
    const cnyFailure = cnFailureHint(results, service.cn)
    if (cnyFailure !== undefined) hints.push(cnyFailure)
    if (targets.length < codes.length) {
      notes.push(`CNY 查询上限 ${MAX_AUDIT_CNY_LOOKUPS} 个料号，其余行只有 USD 参考；可用 include_cny 配合缓存分批复核。`)
    }
  }

  // ---- Build rows -----------------------------------------------------------
  const auditRows = merged.map((entry) => {
    const jlc = jlcByCode.get(entry.code)
    const cn = cnyByCode.get(entry.code)
    const place = entry.place
    const qty = entry.qty
    const orderQty = qty * boards
    const rawLibrary = jlc === undefined ? undefined : String(jlc.libraryType ?? '').toLowerCase()
    const library = rawLibrary === 'base' ? 'base' : rawLibrary === 'expand' ? 'expand' : undefined
    const tier = jlc === undefined ? undefined : pickTier(jlc.priceUsdTiers, orderQty)
    const unitUsd = tier?.unit
    const cnOk = cn?.ok === true
    const unitCny = cnOk ? asNumber(cn.unit) : undefined
    const stockSmt = jlc === undefined ? undefined : asInteger(jlc.stock)
    const stockLcsc = cnOk ? asInteger(cn.stock) : undefined
    const bulkUsd = jlc === undefined ? undefined : bulkTierUsd(jlc)
    const unitCnyEstimate = unitCny === undefined ? estimateCnyFromUsd(bulkUsd, usdToCnyFactor) : undefined
    const billableSmt = assembly === 'smt' && place === 'smt' && jlc !== undefined
    const billableHand = place !== 'dnp' && (assembly === 'hand' || place === 'hand')
    const countsForUsd = assembly === 'hand' ? billableHand : billableSmt
    const subtotalUsd = countsForUsd && unitUsd !== undefined ? unitUsd * orderQty : undefined
    const subtotalCny = unitCny !== undefined && (billableSmt || billableHand) ? unitCny * orderQty : undefined
    const flags = []
    if (place === 'dnp') flags.push('DNP：不贴/不计元件与上料费')
    else if (assembly === 'smt' && place === 'hand') flags.push('手焊：不计入 SMT 贴片与上料费')
    if (jlc === undefined && cnOk) flags.push('不在嘉立创 SMT 库，但立创商城有货（手焊可买）')
    if (library === 'expand' && billableSmt) flags.push(`扩展库：$${feeUsd}/料号上料费`)
    if (library === 'expand' && !billableSmt) flags.push('扩展库（手焊/DNP 无上料费）')
    const stockForMode = assembly === 'smt' ? stockSmt : (stockLcsc ?? stockSmt)
    if (place !== 'dnp' && stockForMode !== undefined) {
      if (stockForMode <= 0) flags.push('无库存')
      else if (stockForMode < orderQty) flags.push(`库存不足（需 ${orderQty}）`)
    }
    if (tier === undefined && jlc !== undefined) flags.push('无价格数据')
    if (place !== 'dnp' && jlc === undefined && !cnOk) flags.push('嘉立创/立创均未查到')
    let status = 'verified'
    if (place === 'dnp') status = 'DNP'
    else if (jlc === undefined && !cnOk) status = 'NOT-FOUND'
    else if (assembly === 'smt' && place !== 'smt') status = place === 'hand' ? 'HAND' : 'DNP'
    else if (stockForMode === 0) status = 'NO-STOCK'
    return {
      lcsc: entry.code || '(missing)',
      designators: entry.designators.length > 0 ? entry.designators : undefined,
      qty,
      lines: entry.lines,
      place,
      status,
      model: jlc === undefined ? (cnOk ? cn.model : undefined) : jlc.model,
      brand: jlc === undefined ? (cnOk ? cn.brand : undefined) : jlc.brand,
      package: jlc === undefined ? (cnOk ? cn.package : undefined) : jlc.package,
      library,
      billable_smt: billableSmt,
      billable: countsForUsd,
      stock: stockForMode,
      stock_retail: stockLcsc,
      stock_smt: stockSmt,
      stock_global: null,
      stock_lcsc: stockLcsc,
      stock_asof: cnOk ? (cn.fetched_at ?? new Date().toISOString()) : new Date().toISOString(),
      stock_scope: assembly,
      stock_scope_note: assembly === 'smt'
        ? (requireStock === 'lcsc' ? '按立创零售库存约束；SMT 库存另列' : 'SMT 库存（嘉立创 PCBA 备料仓）')
        : '立创商城零售库存（DIY 配单）；SMT 库存另列',
      data_warnings: (() => {
        const warnings = []
        if (stockLcsc === 0 && stockSmt !== undefined && stockSmt > 0) warnings.push('retail_out_of_stock_smt_ok')
        if (stockLcsc !== undefined && stockLcsc > 0 && stockSmt === 0) warnings.push('smt_out_of_stock_retail_ok')
        return warnings.length === 0 ? undefined : warnings
      })(),
      stock_source: assembly === 'smt' ? 'jlcpcb-smt' : (stockLcsc !== undefined ? 'lcsc_cn_render' : 'jlcpcb-smt'),
      coverage: orderQty > 0 && stockForMode !== undefined ? Math.min(1, Math.round((stockForMode / orderQty) * 100) / 100) : undefined,
      price_source: jlc === undefined ? (cnOk ? 'lcsc_cn_render' : undefined) : 'jlcpcb-smt',
      unit_usd: unitUsd === undefined ? undefined : money(unitUsd),
      price_usd_tier: tier?.label,
      price_usd_ladder: jlc === undefined ? undefined : (jlc.priceUsdTiers ?? []).slice(0, 8).map((item) => ({ qty: item.qty, unit: money(item.unit) })),
      subtotal_usd: subtotalUsd === undefined ? undefined : money(subtotalUsd),
      unit_cny: unitCny === undefined ? undefined : money(unitCny),
      price_cny_source: unitCny === undefined ? undefined : (cn.source ?? 'lcsc_cn_render'),
      price_cny_estimated: false,
      subtotal_cny: subtotalCny === undefined ? undefined : money(subtotalCny),
      unit_cny_estimate: unitCnyEstimate === undefined ? undefined : money(unitCnyEstimate),
      subtotal_cny_estimate: unitCnyEstimate === undefined ? undefined : money(unitCnyEstimate * orderQty),
      fetched_at: new Date().toISOString(),
      flags,
    }
  })

  // ---- Summary --------------------------------------------------------------
  const smtRows = auditRows.filter((row) => row.billable_smt)
  const handRows = auditRows.filter((row) => row.billable_smt !== true && row.place !== 'dnp' && row.status !== 'NOT-FOUND')
  const dnpRows = auditRows.filter((row) => row.place === 'dnp')
  const extendedUnique = new Set(smtRows.filter((row) => row.library === 'expand').map((row) => row.lcsc))
  const costRows = assembly === 'hand' ? handRows : smtRows
  const componentUsd = costRows.reduce((sum, row) => sum + (row.subtotal_usd ?? 0), 0)
  const componentCny = costRows.reduce((sum, row) => sum + (row.subtotal_cny ?? 0), 0)
  const componentCnyEstimate = costRows.reduce((sum, row) => sum + (row.subtotal_cny_estimate ?? 0), 0)
  const handUsd = handRows.reduce((sum, row) => sum + (row.unit_usd ?? 0) * row.qty * boards, 0)
  const handCny = handRows.reduce((sum, row) => sum + (row.subtotal_cny ?? 0), 0)
  const dnpUsd = dnpRows.reduce((sum, row) => sum + (row.unit_usd ?? 0) * (row.qty * boards), 0)
  const extendedFee = assembly === 'smt' ? extendedUnique.size * feeUsd : 0
  const setupFees = setupFeeUsd + stencilFeeUsd
  const totalUsd = componentUsd + extendedFee + setupFees
  const cnyCovered = auditRows.filter((row) => row.unit_cny !== undefined).length

  // Batch amortisation table: price tiers are re-evaluated per scenario.
  const scenarioBoards = [...new Set([20, 100, 300, 1000, boards])].filter((value) => value <= 100000).sort((left, right) => left - right)
  const costTable = scenarioBoards.map((scenario) => {
    let scenarioComponents = 0
    for (const row of costRows) {
      const jlc = jlcByCode.get(row.lcsc)
      if (jlc === undefined) continue
      const tier = pickTier(jlc.priceUsdTiers, row.qty * scenario)
      if (tier !== undefined) scenarioComponents += tier.unit * row.qty * scenario
    }
    const scenarioFee = extendedUnique.size * feeUsd
    const scenarioTotal = scenarioComponents + scenarioFee + setupFees
    return {
      boards: scenario,
      components_usd: money(scenarioComponents),
      extended_fee_usd: money(scenarioFee),
      setup_fees_usd: money(setupFees),
      total_usd: money(scenarioTotal),
      per_board_usd: money(scenarioTotal / scenario),
      extended_fee_per_board_usd: money(scenarioFee / scenario),
    }
  })

  // ---- Alternatives & net-saving optimisation ------------------------------
  const optimize = {
    require_stock: requireStock,
    stock_scope: stockScope,
    stock_scope_note: requireStock === 'any'
      ? `未限制库存口径；建议按 assembly=${assembly} 看 ${assembly === 'smt' ? 'stock_smt' : 'stock_retail'}。DIY 配单请传 require_stock="lcsc"。`
      : `建议已按 ${stockScope === 'lcsc' ? '立创零售库存' : '嘉立创 SMT 库存'}（require_stock=${requireStock}）筛选。`,
    extended_parts_before: extendedUnique.size,
    extended_parts_after: extendedUnique.size,
    fee_before_usd: money(assembly === 'smt' ? extendedUnique.size * feeUsd : 0),
    fee_after_usd: money(assembly === 'smt' ? extendedUnique.size * feeUsd : 0),
    saving_usd_per_order: 0,
    actions: [],
    alternatives: [],
    blocked: [],
  }
  if (suggestAlternatives && assembly === 'smt') {
    const originalNeed = parseNeed('')
    const expandCodes = [...extendedUnique].slice(0, MAX_ALTERNATIVE_LOOKUPS)
    const pairs = await mapLimit(expandCodes, 2, async (code) => {
      const item = jlcByCode.get(code)
      const entry = smtRows.find((candidate) => candidate.lcsc === code)
      if (item === undefined || entry === undefined) return [code, undefined]
      const orderQty = entry.qty * boards
      try {
        return [code, await findAlternative(service, item, originalNeed, {
          signal: options.signal,
          orderQty,
          feeUsd,
          requireStock,
          includeCny,
        })]
      } catch {
        return [code, undefined]
      }
    })
    let saving = 0
    let replaced = 0
    const alternativesByCode = new Map()
    for (const [code, alternative] of pairs) {
      if (alternative === undefined) continue
      if (alternative.blocked === true) {
        optimize.blocked.push({ from: code, ...alternative })
        optimize.actions.push(
          `${code}：按 require_stock=${requireStock} 未找到有库存的基础库替代（跳过 ${(alternative.skipped ?? []).map((item) => `${item.lcsc}:${item.reason}`).join(', ')}）`,
        )
        continue
      }
      alternativesByCode.set(code, alternative)
      optimize.alternatives.push({ from: code, ...alternative })
      if (alternative.net_saving_usd > 0) {
        saving += alternative.net_saving_usd
        replaced += 1
        const packageNote = alternative.footprint_compatible === false
          ? `封装不同（${jlcByCode.get(code)?.package ?? '?'}→${alternative.package ?? '?'}，需改 PCB）`
          : '封装兼容'
        const stockNote = stockScope === 'lcsc'
          ? `立创零售 ${alternative.stock_retail ?? '?'}`
          : `SMT 库存 ${alternative.stock_smt ?? '?'}${alternative.stock_retail === 0 ? '；⚠ 立创零售 0' : ''}`
        const skippedNote = Array.isArray(alternative.skipped) && alternative.skipped.length > 0
          ? `（已跳过 ${alternative.skipped.map((item) => `${item.lcsc}:${item.reason}`).join(', ')}）`
          : ''
        optimize.actions.push(
          `${code}→${alternative.lcsc}：${packageNote}，${stockNote}，上料费省 $${feeUsd}，元件成本变化 $${alternative.component_delta_usd}，净省 $${alternative.net_saving_usd}${skippedNote}`,
        )
      }
    }
    optimize.extended_parts_after = extendedUnique.size - replaced
    optimize.fee_after_usd = money(Math.max(0, optimize.extended_parts_after * feeUsd))
    optimize.fee_before_usd = money(extendedUnique.size * feeUsd)
    optimize.saving_usd_per_order = money(saving)
    for (const row of auditRows) {
      if (row.place === 'hand' && assembly === 'smt') optimize.actions.push(`${row.lcsc} place=hand：不占上料费（已从 SMT 费用中剔除）`)
    }
    for (const row of dnpRows) optimize.actions.push(`${row.lcsc} DNP：不贴片、不计元件与上料费`)
    if (optimize.blocked.length > 0) {
      notes.push(`${optimize.blocked.length} 个扩展库料号在 require_stock=${requireStock} 下没有有库存的替代；可用 require_stock="any" 查看候选并按 stock_retail/stock_smt 人工判断。`)
    }
    if (expandCodes.length < extendedUnique.size) {
      notes.push(`替代料建议仅检查了 ${expandCodes.length}/${extendedUnique.size} 个扩展库料号（每次最多 ${MAX_ALTERNATIVE_LOOKUPS} 个）。`)
    }
    if (alternativesByCode.size > 0) {
      for (const row of auditRows) {
        const alternative = alternativesByCode.get(row.lcsc)
        if (alternative !== undefined) row.alternative = alternative
      }
    }
  }

  // ---- Optional JLCPCB BOM CSV export ---------------------------------------
  let bomCsv
  if (exportBom) {
    const lines = ['Comment,Designator,Footprint,LCSC Part #']
    for (const row of smtRows) {
      if (row.lcsc === '(missing)') continue
      const designators = Array.isArray(row.designators) ? row.designators.join(',') : ''
      const comment = row.model ?? row.lcsc
      const footprint = row.package ?? ''
      lines.push([comment, designators, footprint, row.lcsc].map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(','))
    }
    bomCsv = lines.join('\n')
  }

  // ---- Notes ---------------------------------------------------------------
  notes.push(
    assembly === 'smt'
      ? 'assembly=smt：价格与库存取嘉立创 SMT 元件库（USD 阶梯价按采购数量取档）；上料费只计 smt 且为扩展库的唯一料号。'
      : 'assembly=hand：不计嘉立创上料费；价格优先取立创商城国内站人民币价（Chrome 渲染），未取到的行给 estimated 估算。',
  )
  notes.push('USD 与 CNY 并列展示、不互相换算；每行带 price_source / fetched_at / estimated。')
  notes.push(
    assembly === 'smt'
      ? `上料费按每唯一扩展库料号 $${feeUsd}/单估算；工程费 $${setupFeeUsd}、钢网费 $${stencilFeeUsd} 已单列（默认 0，可在插件 config 配置）。`
      : `上料费 0；工程费 $${setupFeeUsd}、钢网费 $${stencilFeeUsd} 可配置。`,
  )
  if (region === 'cn') {
    notes.push('region=cn：国内嘉立创 SMT 的费用规则以官方计价页为准；本工具仍按 USD 上料费估算并显式标注。')
  }
  notes.push('优选扩展库（Preferred Extended）分类未在公开接口暴露，若需免上料费请到嘉立创 SMT 下单页确认。')
  if (skipped.length > 0) {
    const list = skipped
      .slice(0, 30)
      .map((row) => {
        const label = asString(row.comment) ?? asString(row.raw) ?? ''
        return `${row.designators === undefined ? '' : `${row.designators} `}${label}`.trim()
      })
      .filter((text) => text !== '')
      .join('；')
    notes.push(`BOM 中有 ${skipped.length} 行没有可识别的 LCSC 编号，未计入成本：${list}${skipped.length > 30 ? ' 等' : ''}`)
    hints.push('以上行需先选型（补上 LCSC 编号）再重新审计，否则单板成本会偏低。')
  }
  if (costTable.length > 0) {
    const scenario = costTable.find((row) => row.boards === 100) ?? costTable[costTable.length - 1]
    notes.push(`批量摊销参考：${scenario.boards} 片时约 $${scenario.per_board_usd}/片（含上料费 $${scenario.extended_fee_per_board_usd}/片 + 工程/钢网 $${money(setupFees / scenario.boards)}/片）。`)
  }

  const summary = {
    lines: auditRows.length,
    lines_in_bom: rows.length,
    skipped_lines: skipped.length,
    smt_lines: smtRows.length,
    hand_lines: handRows.length,
    dnp_lines: dnpRows.length,
    unique_parts: codes.length,
    verified: auditRows.filter((row) => row.status === 'verified').length,
    no_stock: auditRows.filter((row) => row.status === 'NO-STOCK').length,
    not_found: auditRows.filter((row) => row.status === 'NOT-FOUND').length,
    base_parts: costRows.filter((row) => row.library === 'base').length,
    expand_parts: new Set(costRows.filter((row) => row.library === 'expand').map((row) => row.lcsc)).size,
    expanded_fee_parts: extendedUnique.size,
    library_unknown: costRows.filter((row) => row.library === undefined).length,
    extended_fee_per_order_usd: money(extendedFee),
    setup_fee_usd: money(setupFeeUsd),
    stencil_fee_usd: money(stencilFeeUsd),
    components_usd: money(componentUsd),
    components_per_board_usd: money(componentUsd / Math.max(1, boards)),
    total_usd: money(totalUsd),
    total_per_board_usd: money(totalUsd / Math.max(1, boards)),
    hand_components_usd_reference: money(handUsd),
    hand_components_cny: money(handCny),
    dnp_components_usd_excluded: money(dnpUsd),
    cny_covered_lines: cnyCovered,
    cny_total_basis: 'per_order',
    cny_price_tier: 'retail_1pc',
    components_cny: money(componentCny),
    components_cny_per_order: money(componentCny),
    components_cny_per_board: money(componentCny / Math.max(1, boards)),
    cny_estimated_lines: auditRows.filter((row) => row.unit_cny_estimate !== undefined).length,
    components_cny_estimate: money(componentCnyEstimate),
    cost_table: costTable,
    require_stock: requireStock,
    stock_scope: stockScope,
  }

  const dataWarnings = [...new Set(auditRows.flatMap((row) => row.data_warnings ?? []))]
  if (dataWarnings.includes('retail_out_of_stock_smt_ok')) {
    notes.push('注意：有料号「立创零售仓缺货、嘉立创 SMT 仓有货」——不是停产；DIY 配单看 stock_retail，PCBA 看 stock_smt。')
  }
  return {
    assembly,
    boards,
    region,
    require_stock: requireStock,
    stock_scope: stockScope,
    currency: includeCny ? 'USD + CNY（并列，不混算）' : 'USD（CNY 为参考估算）',
    summary,
    rows: auditRows,
    optimize,
    bom_csv: bomCsv,
    skipped: skipped.slice(0, 50),
    errors,
    hints,
    notes,
    data_warnings: dataWarnings,
    fetched_at: new Date().toISOString(),
  }
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

/** @param {Record<string, unknown>} value */
export function renderFindText(value) {
  const candidates = Array.isArray(value.candidates) ? value.candidates : []
  const header =
    `Find "${value.need}" [${value.assembly}${value.require_stock && value.require_stock !== 'any' ? `/stock=${value.require_stock}` : ''}] qty ${value.quantity}/board x ${value.boards} board(s)` +
    (value.exact === true ? ' (exact part query)' : '') +
    (value.relaxed === true ? ` (relaxed stage ${value.relax_stage})` : '') +
    ` => ${candidates.length} candidate(s)`
  const lines = [header]
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue
    const priceUsd = isRecord(candidate.price_usd) ? `USD ${candidate.price_usd.unit} @${candidate.price_usd.tier}` : 'USD n/a'
    const priceCny = isRecord(candidate.price_cny)
      ? `CNY ${candidate.price_cny.unit}${candidate.price_cny.estimated === true ? '(est.)' : ''}`
      : 'CNY n/a'
    lines.push(
      `- ${candidate.lcsc} | ${candidate.model ?? '?'} | ${candidate.package ?? '?'} | lib ${candidate.library} | ` +
      `stock smt ${candidate.stock_smt ?? '?'} / retail ${candidate.stock_retail ?? '?'} | ${priceUsd} | ${priceCny} | score ${candidate.score}`,
    )
    if (Array.isArray(candidate.data_warnings) && candidate.data_warnings.length > 0) {
      lines.push(`  ⚠ ${candidate.data_warnings.join(', ')}`)
    }
    if (Array.isArray(candidate.reasons) && candidate.reasons.length > 0) lines.push(`  ${candidate.reasons.join('; ')}`)
    if (Array.isArray(candidate.mismatch_reasons) && candidate.mismatch_reasons.length > 0) {
      lines.push(`  不匹配原因: ${candidate.mismatch_reasons.join('; ')}`)
    }
  }
  for (const hint of Array.isArray(value.hints) ? value.hints : []) lines.push(`hint: ${hint}`)
  for (const note of Array.isArray(value.notes) ? value.notes : []) lines.push(`note: ${note}`)
  return lines.join('\n')
}

/** @param {Record<string, unknown>} value */
export function renderAuditText(value) {
  const summary = isRecord(value.summary) ? value.summary : {}
  const rows = Array.isArray(value.rows) ? value.rows : []
  const optimize = isRecord(value.optimize) ? value.optimize : {}
  const lines = [
    `BOM audit [${value.assembly}] region=${value.region ?? 'global'} boards=${value.boards}: ` +
      `${summary.lines ?? 0} lines (${summary.smt_lines ?? 0} smt / ${summary.hand_lines ?? 0} hand / ${summary.dnp_lines ?? 0} dnp), ` +
      `${summary.unique_parts ?? 0} unique | base ${summary.base_parts ?? 0} / expand ${summary.expand_parts ?? 0}`,
    `components USD ${summary.components_usd ?? 0} + extended fee USD ${summary.extended_fee_per_order_usd ?? 0}` +
      ` + setup USD ${money((summary.setup_fee_usd ?? 0) + (summary.stencil_fee_usd ?? 0))} = USD ${summary.total_usd ?? 0}` +
      ` (USD ${summary.total_per_board_usd ?? 0}/board)` +
      (summary.cny_covered_lines > 0
        ? ` | CNY retail: ¥${summary.components_cny_per_order ?? summary.components_cny ?? 0}/order = ¥${summary.components_cny_per_board ?? '?'}/board (${summary.cny_covered_lines} lines)`
        : '') +
      (summary.components_cny_estimate > 0 ? ` | CNY est. ≈ ${summary.components_cny_estimate}` : ''),
  ]
  for (const row of rows) {
    if (!isRecord(row)) continue
    const flags = Array.isArray(row.flags) && row.flags.length > 0 ? ` [${row.flags.join('; ')}]` : ''
    const designators = Array.isArray(row.designators) && row.designators.length > 0 ? ` {${row.designators.join(',')}}` : ''
    const priceUsd = row.unit_usd === undefined ? 'USD -' : `USD ${row.unit_usd}@${row.price_usd_tier ?? '?'}`
    const priceCny = row.unit_cny !== undefined
      ? `CNY ${row.unit_cny}`
      : row.unit_cny_estimate !== undefined ? `CNY≈${row.unit_cny_estimate}(est.)` : 'CNY -'
    const alternative = isRecord(row.alternative) && typeof row.alternative.lcsc === 'string'
      ? ` -> base alt: ${row.alternative.lcsc} (${row.alternative.model ?? '?'}, net $${row.alternative.net_saving_usd ?? '?'})`
      : ''
    lines.push(
      `${row.lcsc} x${row.qty}${designators} | ${row.place ?? '?'} | ${row.status} | lib ${row.library ?? '?'} | ` +
      `stock smt ${row.stock_smt ?? '?'} / retail ${row.stock_retail ?? '?'} | ${priceUsd} | ${priceCny}${flags}${alternative}`,
    )
  }
  const costTable = Array.isArray(summary.cost_table) ? summary.cost_table : []
  if (costTable.length > 0) {
    lines.push('批量摊销: ' + costTable.map((row) => `${row.boards}片≈$${row.per_board_usd}/片`).join(' | '))
  }
  if (Array.isArray(value.data_warnings) && value.data_warnings.length > 0) {
    lines.push(`⚠ data_warnings: ${value.data_warnings.join(', ')}`)
  }
  if (isRecord(optimize) && (optimize.require_stock !== undefined || optimize.stock_scope !== undefined)) {
    lines.push(`优化建议库存口径: require_stock=${optimize.require_stock ?? 'any'} / scope=${optimize.stock_scope ?? '?'}`)
  }
  if (Array.isArray(optimize.actions) && optimize.actions.length > 0) {
    lines.push(`优化建议（净省 $${optimize.saving_usd_per_order ?? 0}/单，扩展库 ${optimize.extended_parts_before}→${optimize.extended_parts_after}）:`)
    for (const action of optimize.actions) lines.push(`  * ${action}`)
  }
  for (const error of Array.isArray(value.errors) ? value.errors : []) lines.push(`error: ${error}`)
  for (const hint of Array.isArray(value.hints) ? value.hints : []) lines.push(`hint: ${hint}`)
  for (const note of Array.isArray(value.notes) ? value.notes : []) lines.push(`note: ${note}`)
  if (typeof value.bom_csv === 'string' && value.bom_csv !== '') lines.push('BOM CSV: 已生成（bom_csv 字段，可直接用于嘉立创 BOM 下单）')
  return lines.join('\n')
}

/* -------------------------------------------------------------------------- */
/* Tool definitions                                                           */
/* -------------------------------------------------------------------------- */

const FIND_DESCRIPTION =
  'Find LCSC / JLCPCB components that match a real requirement (package, capacitance, voltage rating, current, resistance, tolerance, dimensions, …) ' +
  'and return up to 8 candidates ranked by practical cost-effectiveness: unit price at the actual order quantity, stock coverage, parameter match, and ' +
  'basic-vs-extended JLCPCB library. ' +
  'Part numbers and LCSC codes are detected first and queried exactly (e.g. "SMF5.0A", "AO3401A", "TP4054", "C307331"), so digit-letter patterns are never misread as values; ' +
  'otherwise the requirement is parsed, filtered, and relaxed in stages when nothing matches (each relaxed candidate carries mismatch reasons). ' +
  'Default assembly="hand" for DIY parts you buy and solder yourself (library type ignored; LCSC domestic CNY retail price via Chrome render when reachable, USD reference otherwise). ' +
  'Set assembly="smt" only when the board will be assembled by JLCPCB: extended-library parts then add a USD 3 feeder fee per part number per order, amortized per board. ' +
  'Every candidate reports stock_smt AND stock_lcsc, price_usd AND price_cny side by side (never mixed), the used price tier, and package/pin count. ' +
  'When the real CNY price is unavailable, a clearly-labelled reference CNY estimate (bulk-tier USD × configurable factor, default 6.0) is included; USD stays the actual reference. ' +
  'This is NOT a generic keyword search tool: it parses requirements, filters candidates and explains the ranking.'

const AUDIT_DESCRIPTION =
  'Audit an existing BOM against the JLCPCB parts library and the LCSC domestic store: per line USD price (tier shown, taken at qty x boards), stock_smt, stock_lcsc, ' +
  'basic-vs-extended library, placement (smt / hand / dnp), and for assembly="smt" the USD 3 extended-part feeder fee, plus basic-library alternative suggestions with NET saving. ' +
  'Input `bom` as CSV/TSV text (LCSC codes required; header optional; optional place/mount column) or a JSON array like [{"lcsc":"C1581","qty":5,"place":"smt"}]. ' +
  'Duplicate LCSC lines are merged (feeder fee charged once, tier taken at the combined quantity). DNP and hand lines are excluded from the SMT component/fee totals and reported separately. ' +
  'Default assembly="hand" (no feeder fees); set assembly="smt" for JLCPCB assembly cost planning. ' +
  'Outputs a batch amortisation table (20/100/300/1000 boards), an optimisation summary of net savings, and optionally a JLCPCB BOM CSV for ordering (export_bom=true). ' +
  'Real CNY retail prices are fetched via headless Chrome (24h cache) when include_cny=true; otherwise a reference estimate from bulk-tier USD × the configurable factor is reported and marked estimated=true. ' +
  'USD and CNY are never mixed into one total.'

/** Build the two DSH tool definitions bound to a service instance. */
export function createToolDefinitions(service) {
  return [
    {
      name: 'find_lcsc_parts',
      description: FIND_DESCRIPTION,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['need'],
        properties: {
          need: {
            type: 'string',
            description: 'Requirement in natural language (Chinese or English), e.g. "0402 100nF 50V X7R capacitor", "3.3V LDO SOT-23-5 500mA", "10kΩ 0402 resistor", "TP4054", "C1581".',
          },
          assembly: {
            type: 'string',
            enum: ['hand', 'smt'],
            description: 'hand = you buy parts and solder yourself (default; library type ignored); smt = JLCPCB assembly (basic library preferred, USD 3 extended-part feeder fee amortized).',
          },
          quantity: { type: 'integer', minimum: 1, maximum: 100000, description: 'Parts needed per board (default 1).' },
          boards: { type: 'integer', minimum: 1, maximum: 100000, description: 'Number of boards to build (default 1; used for price tiers and SMT fee amortization).' },
          sort: { type: 'string', enum: ['balanced', 'cost', 'stock'], description: 'Ranking preference (default balanced).' },
          limit: { type: 'integer', minimum: 1, maximum: 8, description: 'Candidates to return (default 5, max 8).' },
          include_cny: { type: 'boolean', description: 'Fetch real LCSC domestic CNY retail prices for the top candidates via headless Chrome (default true in hand mode, false in smt mode; 24h cache). When unavailable, a marked reference estimate is shown.' },
          exclude_lcsc: { type: 'array', items: { type: 'string' }, description: 'LCSC codes to exclude, e.g. when looking for an alternative to a part you already have.' },
          base_only: { type: 'boolean', description: 'Only return JLCPCB basic-library parts (no feeder fee). If none exist the tool says so instead of silently returning extended parts.' },
          require_stock: { type: 'string', enum: ['any', 'lcsc', 'smt'], description: 'Stock scope filter. any = no filter (default); lcsc = 立创商城零售仓有货 (DIY 配单); smt = 嘉立创 SMT 仓有货 (PCBA). lcsc forces a real CNY/stock lookup.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['need', 'assembly', 'candidates', 'notes'],
          properties: {
            need: { type: 'string' },
            assembly: { type: 'string' },
            quantity: { type: 'integer' },
            boards: { type: 'integer' },
            order_qty: { type: 'integer' },
            currency: { type: 'string' },
            candidates: { type: 'array', items: { type: 'object' } },
            hints: { type: 'array', items: { type: 'string' } },
            notes: { type: 'array', items: { type: 'string' } },
            relaxed: { type: 'boolean' },
            relax_stage: { type: 'integer' },
            exact: { type: 'boolean' },
            require_stock: { type: 'string' },
            stock_scope_note: { type: 'string' },
            data_warnings: { type: 'array', items: { type: 'string' } },
            fetched_at: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderFindText(value) }],
      },
      presentCall: (args) => ({ card: 'generic', title: 'Find LCSC parts', kind: 'read', rawInput: args }),
      async execute(args, exec) {
        return toLossless(await findParts(service, args, { signal: exec?.signal }))
      },
    },
    {
      name: 'audit_lcsc_bom',
      description: AUDIT_DESCRIPTION,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['bom'],
        properties: {
          bom: {
            type: 'string',
            description: 'BOM as CSV/TSV text with LCSC codes and quantities (header optional), or a JSON array string like [{"lcsc":"C1581","qty":5}].',
          },
          assembly: {
            type: 'string',
            enum: ['hand', 'smt'],
            description: 'hand = no JLCPCB feeder fees (default); smt = include USD 3 per extended part number per order.',
          },
          boards: { type: 'integer', minimum: 1, maximum: 100000, description: 'Number of boards the BOM is for (default 1).' },
          include_cny: { type: 'boolean', description: 'Fetch real LCSC domestic CNY prices via headless Chrome (24h cache, capped; default true in hand mode for small BOMs, false for large BOMs — pass true to force).' },
          require_stock: { type: 'string', enum: ['any', 'lcsc', 'smt'], description: 'Stock scope for basic-library substitution suggestions. any = no filter (default); lcsc = only suggest parts with 立创零售仓库存 (DIY 配单); smt = only suggest parts with 嘉立创 SMT 仓库存 (PCBA). Each suggestion always reports stock_retail and stock_smt.' },
          suggest_alternatives: { type: 'boolean', description: 'For extended-library parts, suggest a basic-library substitute with net saving (default true; only in smt mode).' },
          export_bom: { type: 'boolean', description: 'Also return a JLCPCB BOM CSV (Comment/Designator/Footprint/LCSC Part) for the smt-placed lines (default false).' },
          region: { type: 'string', enum: ['global', 'cn'], description: 'Fee/currency context label. global = JLCPCB international (USD); cn = 嘉立创国内 (fee rules shown as assumptions, always labelled). Default global.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['assembly', 'summary', 'rows', 'notes'],
          properties: {
            assembly: { type: 'string' },
            boards: { type: 'integer' },
            region: { type: 'string' },
            require_stock: { type: 'string' },
            stock_scope: { type: 'string' },
            currency: { type: 'string' },
            summary: { type: 'object' },
            data_warnings: { type: 'array', items: { type: 'string' } },
            optimize: { type: 'object' },
            bom_csv: { type: 'string' },
            rows: { type: 'array', items: { type: 'object' } },
            skipped: { type: 'array', items: { type: 'object' } },
            errors: { type: 'array', items: { type: 'string' } },
            hints: { type: 'array', items: { type: 'string' } },
            notes: { type: 'array', items: { type: 'string' } },
            fetched_at: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderAuditText(value) }],
      },
      presentCall: (args) => ({ card: 'generic', title: 'Audit LCSC BOM', kind: 'read', rawInput: args }),
      async execute(args, exec) {
        return toLossless(await auditBom(service, args, { signal: exec?.signal }))
      },
    },
  ]
}

/* -------------------------------------------------------------------------- */
/* Plugin entry                                                               */
/* -------------------------------------------------------------------------- */

/**
 * DSH plugin entry: called by the Loader once the `tools` service is available.
 * @param {unknown} ctx
 * @param {unknown} [config] row `config` from cordis.patch.yml
 */
export function apply(ctx, config) {
  const warnings = []
  const settings = normalizeConfig(config, { onWarning: (message) => warnings.push(message) })
  const logger = safeLogger(ctx)
  for (const warning of warnings) logger?.warn?.(`[lcsc] ${warning}`)
  const service = createLcscService(settings)
  // Domestic CNY adapter: headless Chrome + 24h cache. Kept optional so the
  // plugin still works on hosts without Chrome (falls back to USD estimates).
  let cnAdapter
  if (settings.cnRender !== false) {
    try {
      cnAdapter = createCnAdapter({
        chromePath: settings.chromePath ?? undefined,
        cacheDir: settings.cnCacheDir ?? undefined,
        cacheTtlMs: settings.cnCacheTtlMs,
        timeoutMs: settings.cnTimeoutMs,
        concurrency: settings.cnConcurrency,
        browserIdleTtlMs: settings.cnBrowserIdleTtlMs,
        cacheMaxEntries: settings.cnCacheMaxEntries,
        verbose: settings.verbose,
        logger,
      })
      service.cn = cnAdapter
      if (settings.verbose) {
        logger?.info?.(cnAdapter.chromePath === undefined
          ? '[lcsc] Chrome not found: CNY prices will fall back to USD estimates'
          : `[lcsc] CNY adapter ready (chrome: ${cnAdapter.chromePath})`)
      }
    } catch (error) {
      logger?.warn?.(`[lcsc] CNY adapter init failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  /** @type {{ effect?: (fn: () => (() => void)) => void, tools?: { register: (definition: unknown) => void } }} */
  const context = isRecord(ctx) ? ctx : {}
  context.effect?.(() => () => {
    service.clearCache()
    cnAdapter?.dispose?.()
    cnAdapter?.clearMemory?.()
  })
  for (const definition of createToolDefinitions(service)) {
    context.tools?.register(definition)
  }
  if (settings.verbose) logger?.info?.('[lcsc] tools registered: find_lcsc_parts, audit_lcsc_bom')
}

/** @param {unknown} ctx */
function safeLogger(ctx) {
  try {
    if (!isRecord(ctx)) return undefined
    const logger = ctx.logger
    if (typeof logger !== 'function') return undefined
    const named = logger('lcsc')
    return isRecord(named) ? named : undefined
  } catch {
    return undefined
  }
}
