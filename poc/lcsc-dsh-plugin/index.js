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
  parseBomCsv,
  pickTierPrice,
} from './data.js'

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
const MAX_AUDIT_CNY_LOOKUPS = 10
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

/** Chinese / mixed category words mapped to English search hints. */
const CATEGORY_TERMS = [
  ['自恢复保险丝', ['ptc resettable fuse']],
  ['贴片电容', ['capacitor']],
  ['贴片电阻', ['resistor']],
  ['电容', ['capacitor']],
  ['电阻', ['resistor']],
  ['电感', ['inductor']],
  ['磁珠', ['ferrite bead']],
  ['二极管', ['diode']],
  ['发光二极管', ['led']],
  ['肖特基', ['schottky']],
  ['三极管', ['transistor']],
  ['场效应管', ['mosfet']],
  ['mos管', ['mosfet']],
  ['稳压器', ['voltage regulator']],
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
  const directCode = text.match(/\bC\d{4,8}\b/i)?.[0]?.toUpperCase()
  const upper = text.toUpperCase()
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
    'adc', 'dac', 'interface', 'antenna',
  ]
  for (const word of ENGLISH_CATEGORIES) {
    const re = new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i')
    if (re.test(text) && !categories.includes(word)) categories.push(word)
  }
  const modelGuess =
    directCode === undefined &&
    !/\s/.test(text) &&
    /[A-Za-z]/.test(text) &&
    text.length >= 3
  const modelToken = modelGuess ? text.replace(/[^A-Za-z0-9]/g, '').toUpperCase() : undefined

  // Translate Chinese category words into English so the JLCPCB keyword search
  // (which is English-oriented) gets a useful query.
  let keyword = text
  for (const [word, hints] of CATEGORY_TERMS) {
    const re = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    keyword = keyword.replace(re, ` ${hints[0]} `)
  }
  keyword = keyword
    .replace(/[，。；、,;:：!！?？]/g, ' ')
    .replace(/需要|一个|帮我|找一下|寻找|找|用来|用于|的|料号|器件|元件/g, ' ')
    .replace(/[\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (keyword === '') keyword = [packageName, dielectric, ...categories].filter(Boolean).join(' ')
  if (keyword === '') keyword = text

  const requirements = extractRequirements(text)
  // Category-aware comparator defaults.
  const isRegulator = categories.some((category) => category === 'ldo' || category === 'voltage regulator')
  for (const requirement of requirements) {
    if (requirement.comparator !== undefined) continue
    if (requirement.kind === 'voltage' && isRegulator) requirement.comparator = '='
    else if (requirement.kind === 'tolerance') requirement.comparator = '<='
    else if (requirement.kind === 'size') requirement.comparator = '='
    else if (requirement.kind === 'capacitance' || requirement.kind === 'resistance' || requirement.kind === 'inductance' || requirement.kind === 'frequency') requirement.comparator = '='
    else requirement.comparator = '>='
  }
  return {
    raw: text,
    searchKeyword: keyword,
    package: packageName,
    directCode,
    modelGuess,
    categories,
    dielectric,
    requirements,
    modelToken,
    upper,
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
export async function findParts(service, args, options = {}) {
  const needText = asString(args.need)
  if (needText === undefined) throw new Error('find_lcsc_parts requires a non-empty `need` string')
  const assembly = args.assembly === 'smt' ? 'smt' : 'hand'
  const quantity = clampInteger(args.quantity, 1, 100000, 1)
  const boards = clampInteger(args.boards, 1, 100000, 1)
  const limit = clampInteger(args.limit, 1, MAX_CANDIDATES, DEFAULT_LIMIT)
  const sort = ['cost', 'stock'].includes(args.sort) ? args.sort : 'balanced'
  const includeCny = args.include_cny !== false && assembly === 'hand'
  const exclude = new Set(
    (Array.isArray(args.exclude_lcsc) ? args.exclude_lcsc : [])
      .map((code) => normalizeCode(code))
      .filter(Boolean),
  )
  const need = parseNeed(needText)
  const context = { assembly, quantity, boards, orderQty: quantity * boards, sort, modelToken: need.modelGuess ? need.modelToken : undefined }
  const usdToCnyFactor = asNumber(service.settings?.usdToCnyFactor) ?? 6.0
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

  const queries = []
  if (need.directCode !== undefined) {
    queries.push({ keyword: need.directCode })
  } else if (need.modelGuess) {
    queries.push({ keyword: need.raw })
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
    if (need.directCode !== undefined || need.modelGuess) break
  }
  if (pool.size === 0 && need.searchKeyword !== need.raw) {
    const fallback = await service.searchRaw(need.raw, { pageSize: SEARCH_PAGE_SIZE, signal: options.signal })
    absorb(fallback)
  }

  let relaxed = false
  let scored = [...pool.values()]
    .filter((item) => !exclude.has(String(item.code)))
    .filter((item) => (asInteger(item.stock) ?? 0) > 0)
    .map((item) => scoreCandidate(item, need, context))
    .filter((candidate) => candidate.match.ok)
  if (scored.length === 0 && pool.size > 0) {
    relaxed = true
    notes.push('没有同时满足全部参数条件的候选；已放宽参数过滤，仅按关键词、库存和价格排序，请人工核对参数。')
    scored = [...pool.values()]
      .filter((item) => !exclude.has(String(item.code)))
      .filter((item) => (asInteger(item.stock) ?? 0) > 0)
      .map((item) => scoreCandidate(item, need, context))
      .map((candidate) => ({ ...candidate, match: { ...candidate.match, ok: true } }))
  }
  let ranked = rankCandidates(scored, context, context.orderQty)

  // Best-effort CNY enrichment for the top candidates in hand mode.
  /** @type {Map<string, { ok: boolean, unit?: number, stock?: number, reason?: string }>} */
  const cnyByCode = new Map()
  if (includeCny && ranked.length > 0) {
    const targets = ranked.slice(0, Math.min(MAX_CNY_LOOKUPS, ranked.length))
    const results = await mapLimit(targets, 2, async (candidate) => {
      try {
        return await service.cny(String(candidate.item.code), options.signal)
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    })
    for (let index = 0; index < targets.length; index += 1) {
      const result = results[index]
      cnyByCode.set(String(targets[index].item.code), result)
      if (index < targets.length - 1) await sleep(120, options.signal)
    }
    const covered = [...cnyByCode.values()].filter((result) => result?.ok === true).length
    if (covered > 0) notes.push(`人民币价来自立创商城国内站（best-effort，可能被限流）：${covered}/${targets.length} 个候选取到 CNY。排序仍以 USD 参考价为基准。`)
    else hints.push('国内站 CNY 价本次不可用（WAF/限流），价格列为 USD 参考；可稍后重试或到立创商城页面确认。')
  }

  const candidates = ranked.slice(0, limit).map((candidate) => {
    const cny = cnyByCode.get(String(candidate.item.code))
    const cnyUnit = cny?.ok === true ? asNumber(cny.unit) : undefined
    const price = cnyUnit !== undefined
      ? { currency: 'CNY', unit: money(cnyUnit), source: 'item.szlcsc.com' }
      : candidate.unitUsd !== undefined
        ? { currency: 'USD', unit: money(candidate.unitUsd), source: 'jlcpcb-smt' }
        : undefined
    const bulkUsd = bulkTierUsd(candidate.item)
    const cnyEstimate = cnyUnit === undefined && assembly === 'hand'
      ? estimateCnyFromUsd(bulkUsd, usdToCnyFactor)
      : undefined
    return {
      lcsc: candidate.item.code,
      model: candidate.item.model,
      brand: candidate.item.brand,
      package: candidate.item.package,
      category: candidate.item.category,
      library: candidate.expand ? 'expand' : 'base',
      preferred: candidate.item.preferred === true ? true : null,
      stock: candidate.stock,
      price,
      effective_unit_usd: candidate.unitEffectiveUsd === undefined ? undefined : money(candidate.unitEffectiveUsd),
      fee_per_board_usd: context.assembly === 'smt' ? money(candidate.feePerBoardUsd) : 0,
      cny_price: cnyUnit === undefined ? null : money(cnyUnit),
      cny_estimate: cnyEstimate === undefined
        ? null
        : {
            unit: cnyEstimate,
            factor: usdToCnyFactor,
            basis: 'highest-volume USD tier × factor',
            note: '参考估算，非实时汇率/非实际报价；以立创商城页面为准',
          },
      specs: pickSpecs(candidate.item),
      score: candidate.score,
      reasons: reasonsFor(candidate, context),
      url: asString(candidate.item.url) ?? `https://www.lcsc.com/product-detail/${candidate.item.code}.html`,
    }
  })

  if (candidates.length === 0) {
    hints.push('没有找到候选。建议：改用型号/LCSC 编号；或减少参数（如去掉精度/尺寸）；或把中文品类换成英文（capacitor / resistor / LDO / connector）。')
  }
  if (need.requirements.length > 0) {
    notes.push(`解析到参数条件：${need.requirements.map((requirement) => `${requirement.kind}${requirement.comparator ?? '='}${requirement.value}`).join(', ')}`)
  }
  if (context.assembly === 'hand') notes.push('assembly=hand：不考虑嘉立创上料费与基础库偏好，价格优先展示立创商城人民币零售价（取不到时回退 USD 参考价）。')
  if (candidates.some((candidate) => candidate.cny_estimate !== null)) {
    notes.push(`CNY 估算 = 该料最高采购量档 USD × ${usdToCnyFactor}（Recording_card 实测中位误差约 1.6%），仅供参考；USD 为实际参考价。`)
  }
  else notes.push(`assembly=smt：扩展库按每料号 $${EXTENDED_PART_FEE_USD}/单摊销；优选扩展库分类接口未暴露，以下单页为准。`)

  return {
    need: needText,
    assembly,
    quantity,
    boards,
    order_qty: context.orderQty,
    currency: includeCny ? 'CNY (best effort) + USD reference' : 'USD',
    candidates,
    hints,
    notes,
    relaxed,
    fetched_at: new Date().toISOString(),
  }
}

/* -------------------------------------------------------------------------- */
/* BOM audit                                                                  */
/* -------------------------------------------------------------------------- */

/** @param {unknown} input @returns {{ line: number, code: string, qty: number, designators?: string, comment?: string }[]} */
function parseBomInput(input) {
  if (typeof input === 'string') {
    const text = input.trim()
    if (text === '') throw new Error('audit_lcsc_bom requires a non-empty BOM string')
    if (text.startsWith('[') || text.startsWith('{')) {
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = undefined
      }
      if (Array.isArray(parsed)) return parseBomRows(parsed)
      if (isRecord(parsed) && Array.isArray(parsed.rows)) return parseBomRows(parsed.rows)
    }
    return parseBomCsv(text).map((row) => ({
      line: row.line,
      code: normalizeCode(row.code) ?? '',
      qty: Math.max(1, asInteger(row.qty) ?? 1),
      designators: row.designators,
      comment: row.comment,
    }))
  }
  if (Array.isArray(input)) return parseBomRows(input)
  throw new Error('audit_lcsc_bom requires `bom` as CSV text or an array of {lcsc/code, qty} rows')
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
      designators: asString(row.designators ?? row.refs),
      comment: asString(row.comment ?? row.description ?? row.model),
    })
  }
  return result
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
 * Find one basic-library substitute for an extended part.
 * @param {ReturnType<typeof createLcscService>} service
 * @param {Record<string, unknown>} item
 * @param {ReturnType<typeof parseNeed>} originalNeed
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function findAlternative(service, item, originalNeed, options = {}) {
  const packageName = asString(item.package)
  const tryCodes = []
  const alternatives = asString(item.alternatives)
  if (alternatives !== undefined) {
    for (const match of alternatives.matchAll(/C\d{4,8}/gi)) tryCodes.push(match[0].toUpperCase())
  }
  const candidates = []
  for (const code of tryCodes.slice(0, 3)) {
    const result = await service.searchRaw(code, { pageSize: 5, signal: options.signal })
    const hit = result.items.find((candidate) => String(candidate.code) === code)
    if (hit !== undefined && String(hit.libraryType).toLowerCase() === 'base') candidates.push(hit)
  }
  if (candidates.length === 0) {
    const need = needFromItem(item, originalNeed)
    const result = await service.searchRaw(need.searchKeyword, {
      pageSize: 50,
      libraryType: 'base',
      signal: options.signal,
    })
    const categoryName = asString(item.category)
    for (const candidate of result.items) {
      if (String(candidate.libraryType).toLowerCase() !== 'base') continue
      if (packageName !== undefined && !packageMatches(asString(candidate.package), packageName)) continue
      // Stay conservative: a substitute must be the same kind of device.
      if (categoryName !== undefined) {
        const candidateCategory = asString(candidate.category)
        if (candidateCategory === undefined || candidateCategory.toLowerCase() !== categoryName.toLowerCase()) continue
      }
      if ((asInteger(candidate.stock) ?? 0) <= 0) continue
      if (candidateMatches(candidate, need).ok) candidates.push(candidate)
    }
  }
  if (candidates.length === 0) return undefined
  const scored = candidates.map((candidate) => scoreCandidate(candidate, originalNeed, { assembly: 'smt', quantity: 1, boards: 1, orderQty: 1, sort: 'cost' }))
  scored.sort((left, right) => (left.unitUsd ?? Number.POSITIVE_INFINITY) - (right.unitUsd ?? Number.POSITIVE_INFINITY))
  const best = scored[0]
  return {
    lcsc: best.item.code,
    model: best.item.model,
    package: best.item.package,
    library: 'base',
    stock: asInteger(best.item.stock) ?? 0,
    unit_usd: best.unitUsd === undefined ? undefined : money(best.unitUsd),
    fee_saved_per_board_usd: undefined,
  }
}

/**
 * Audit an existing BOM.
 * @param {ReturnType<typeof createLcscService>} service
 * @param {Record<string, unknown>} args
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function auditBom(service, args, options = {}) {
  const rows = parseBomInput(args.bom)
  if (rows.length === 0) throw new Error('audit_lcsc_bom parsed 0 rows from the BOM input')
  const assembly = args.assembly === 'smt' ? 'smt' : 'hand'
  const boards = clampInteger(args.boards, 1, 100000, 1)
  const includeCny = args.include_cny === true
  const suggestAlternatives = args.suggest_alternatives !== false
  const notes = []
  const hints = []
  const usdToCnyFactor = asNumber(service.settings?.usdToCnyFactor) ?? 6.0

  const codes = [...new Set(rows.map((row) => row.code).filter((code) => code !== ''))]
  const infoEntries = await mapLimit(codes, 3, async (code) => {
    try {
      const result = await service.searchRaw(code, { pageSize: 5, signal: options.signal })
      const hit = result.items.find((candidate) => String(candidate.code).toUpperCase() === code) ?? result.items[0]
      return [code, hit]
    } catch (error) {
      return [code, undefined, error instanceof Error ? error.message : String(error)]
    }
  })
  /** @type {Map<string, Record<string, unknown> | undefined>} */
  const infoByCode = new Map()
  const errors = []
  for (const entry of infoEntries) {
    const [code, hit, error] = entry
    infoByCode.set(code, hit)
    if (hit === undefined) errors.push(`${code}: ${error ?? 'not found in JLCPCB library'}`)
  }

  const cnyByCode = new Map()
  if (includeCny) {
    const cnyTargets = codes.slice(0, MAX_AUDIT_CNY_LOOKUPS)
    const results = await mapLimit(cnyTargets, 2, async (code) => {
      try {
        return await service.cny(code, options.signal)
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    })
    results.forEach((result, index) => cnyByCode.set(cnyTargets[index], result))
    notes.push(`CNY prices requested for ${cnyTargets.length}/${codes.length} parts (best effort; domestic site is WAF/rate limited).`)
  }

  let extendedUnique = new Set()
  const auditRows = rows.map((row) => {
    const item = infoByCode.get(row.code)
    const qty = row.qty
    const orderQty = qty * boards
    if (item === undefined) {
      return {
        line: row.line,
        lcsc: row.code || '(missing)',
        qty,
        designators: row.designators,
        status: 'NOT-FOUND',
        flags: ['LCSC 编号在嘉立创元件库中未找到'],
      }
    }
    const library = String(item.libraryType ?? '').toLowerCase() === 'base' ? 'base' : 'expand'
    if (library === 'expand') extendedUnique.add(String(item.code))
    const tiers = Array.isArray(item.priceUsdTiers) ? item.priceUsdTiers : []
    const unitUsd = pickTierPrice(tiers, orderQty)
    const stock = asInteger(item.stock) ?? 0
    const flags = []
    if (stock <= 0) flags.push('无库存')
    else if (stock < orderQty) flags.push(`库存不足（需 ${orderQty}）`)
    if (library === 'expand') flags.push(assembly === 'smt' ? '扩展库：$3/料号上料费' : '扩展库（手焊无上料费）')
    if (unitUsd === undefined) flags.push('无价格数据')
    const cny = cnyByCode.get(String(item.code))
    const unitCny = cny?.ok === true ? asNumber(cny.unit) : undefined
    const bulkUsd = bulkTierUsd(item)
    const unitCnyEstimate =
      unitCny === undefined && assembly === 'hand' ? estimateCnyFromUsd(bulkUsd, usdToCnyFactor) : undefined
    return {
      line: row.line,
      lcsc: String(item.code),
      qty,
      designators: row.designators,
      status: stock <= 0 ? 'NO-STOCK' : 'verified',
      model: item.model,
      brand: item.brand,
      package: item.package,
      library,
      stock,
      unit_usd: unitUsd === undefined ? undefined : money(unitUsd),
      subtotal_usd: unitUsd === undefined ? undefined : money(unitUsd * orderQty),
      unit_cny: unitCny === undefined ? undefined : money(unitCny),
      subtotal_cny: unitCny === undefined ? undefined : money(unitCny * orderQty),
      unit_cny_estimate: unitCnyEstimate === undefined ? undefined : money(unitCnyEstimate),
      subtotal_cny_estimate: unitCnyEstimate === undefined ? undefined : money(unitCnyEstimate * orderQty),
      flags,
    }
  })

  // Alternatives for extended parts (bounded, best effort).
  const alternatives = new Map()
  if (suggestAlternatives && assembly === 'smt') {
    const costByCode = new Map()
    for (const row of auditRows) {
      if (row.library !== 'expand') continue
      costByCode.set(row.lcsc, (costByCode.get(row.lcsc) ?? 0) + (row.subtotal_usd ?? 0))
    }
    const expandCodes = [...extendedUnique]
      .sort((left, right) => (costByCode.get(right) ?? 0) - (costByCode.get(left) ?? 0))
      .slice(0, MAX_ALTERNATIVE_LOOKUPS)
    const originalNeed = parseNeed('')
    const pairs = await mapLimit(expandCodes, 2, async (code) => {
      const item = infoByCode.get(code)
      if (item === undefined) return [code, undefined]
      try {
        return [code, await findAlternative(service, item, originalNeed, { signal: options.signal })]
      } catch {
        return [code, undefined]
      }
    })
    for (const [code, alternative] of pairs) {
      if (alternative !== undefined) alternatives.set(code, alternative)
    }
    if (expandCodes.length < extendedUnique.size) {
      notes.push(`替代料建议仅检查了 ${expandCodes.length}/${extendedUnique.size} 个扩展库料号（每次最多 ${MAX_ALTERNATIVE_LOOKUPS} 个）。`)
    }
  }

  const componentUsd = auditRows.reduce((sum, row) => sum + (row.subtotal_usd ?? 0), 0)
  const componentCny = auditRows.reduce((sum, row) => sum + (row.subtotal_cny ?? 0), 0)
  const componentCnyEstimate = auditRows.reduce((sum, row) => sum + (row.subtotal_cny_estimate ?? 0), 0)
  const extendedFee = assembly === 'smt' ? extendedUnique.size * EXTENDED_PART_FEE_USD : 0
  const cnyCovered = auditRows.filter((row) => row.unit_cny !== undefined).length
  const summary = {
    lines: auditRows.length,
    unique_parts: codes.length,
    verified: auditRows.filter((row) => row.status === 'verified').length,
    no_stock: auditRows.filter((row) => row.status === 'NO-STOCK').length,
    not_found: auditRows.filter((row) => row.status === 'NOT-FOUND').length,
    base_parts: codes.length - extendedUnique.size,
    expand_parts: extendedUnique.size,
    extended_fee_per_order_usd: money(extendedFee),
    components_usd: money(componentUsd),
    components_per_board_usd: money(componentUsd / Math.max(1, boards)),
    total_usd: money(componentUsd + extendedFee),
    total_per_board_usd: money((componentUsd + extendedFee) / Math.max(1, boards)),
    cny_covered_lines: cnyCovered,
    components_cny: money(componentCny),
    cny_estimated_lines: auditRows.filter((row) => row.unit_cny_estimate !== undefined).length,
    components_cny_estimate: money(componentCnyEstimate),
  }

  notes.push('USD 为嘉立创 SMT 元件阶梯价（按采购数量取档）；CNY 为立创商城零售参考价，两者从不互相换算。')
  if (assembly === 'smt') notes.push(`扩展库上料费按每唯一料号 $${EXTENDED_PART_FEE_USD}/单估算，未包含工程费、钢网费、焊点费和手焊费。`)
  else {
    notes.push('assembly=hand：不计嘉立创上料费；价格供参考，手焊请以立创商城实际下单页为准。')
    if (componentCnyEstimate > 0) {
      notes.push(`CNY 估算 = 各料最高采购量档 USD × ${usdToCnyFactor}（Recording_card 实测中位误差约 1.6%），仅供参考；USD 为实际参考价。`)
    }
  }
  notes.push('优选扩展库（Preferred Extended）分类未在公开接口暴露，若需免上料费请到嘉立创 SMT 下单页确认。')

  return {
    assembly,
    boards,
    currency: includeCny ? 'USD + CNY (best effort)' : 'USD',
    summary,
    rows: auditRows.map((row) => {
      const alternative = alternatives.get(row.lcsc)
      return alternative === undefined ? row : { ...row, alternative }
    }),
    errors,
    hints,
    notes,
    fetched_at: new Date().toISOString(),
  }
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

/** @param {Record<string, unknown>} value */
export function renderFindText(value) {
  const candidates = Array.isArray(value.candidates) ? value.candidates : []
  const lines = [
    `Find "${value.need}" [${value.assembly}] qty ${value.quantity}/board x ${value.boards} board(s) => ${candidates.length} candidate(s)`,
  ]
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue
    const price = isRecord(candidate.price) ? `${candidate.price.unit} ${candidate.price.currency}` : 'n/a'
    const cnyEstimate = isRecord(candidate.cny_estimate) ? ` | CNY≈${candidate.cny_estimate.unit}(估算)` : ''
    lines.push(
      `- ${candidate.lcsc} | ${candidate.model ?? '?'} | ${candidate.package ?? '?'} | lib ${candidate.library} | stock ${candidate.stock} | ${price}${cnyEstimate} | score ${candidate.score}`,
    )
    if (Array.isArray(candidate.reasons) && candidate.reasons.length > 0) lines.push(`  ${candidate.reasons.join('; ')}`)
  }
  for (const hint of Array.isArray(value.hints) ? value.hints : []) lines.push(`hint: ${hint}`)
  for (const note of Array.isArray(value.notes) ? value.notes : []) lines.push(`note: ${note}`)
  return lines.join('\n')
}

/** @param {Record<string, unknown>} value */
export function renderAuditText(value) {
  const summary = isRecord(value.summary) ? value.summary : {}
  const rows = Array.isArray(value.rows) ? value.rows : []
  const lines = [
    `BOM audit [${value.assembly}] boards=${value.boards}: ${summary.lines ?? 0} lines, ${summary.unique_parts ?? 0} unique | base ${summary.base_parts ?? 0} / expand ${summary.expand_parts ?? 0}`,
    `components USD ${summary.components_usd ?? 0} + extended fee USD ${summary.extended_fee_per_order_usd ?? 0} = USD ${summary.total_usd ?? 0}` +
      (summary.cny_covered_lines > 0 ? ` | CNY ${summary.components_cny ?? 0} (${summary.cny_covered_lines} lines)` : '') +
      (summary.components_cny_estimate > 0 ? ` | CNY est. ≈ ${summary.components_cny_estimate} (估算参考)` : ''),
  ]
  for (const row of rows) {
    if (!isRecord(row)) continue
    const flags = Array.isArray(row.flags) && row.flags.length > 0 ? ` [${row.flags.join('; ')}]` : ''
    const alternative = isRecord(row.alternative) ? ` -> base alt: ${row.alternative.lcsc} (${row.alternative.model ?? '?'})` : ''
    const cnyEstimate = typeof row.unit_cny_estimate === 'number' ? ` | CNY≈${row.unit_cny_estimate}(估算)` : ''
    lines.push(
      `${row.lcsc} x${row.qty} | ${row.status} | lib ${row.library ?? '?'} | stock ${row.stock ?? '?'} | USD ${row.unit_usd ?? '-'} (sub ${row.subtotal_usd ?? '-'})${cnyEstimate}${flags}${alternative}`,
    )
  }
  for (const error of Array.isArray(value.errors) ? value.errors : []) lines.push(`error: ${error}`)
  for (const hint of Array.isArray(value.hints) ? value.hints : []) lines.push(`hint: ${hint}`)
  for (const note of Array.isArray(value.notes) ? value.notes : []) lines.push(`note: ${note}`)
  return lines.join('\n')
}

/* -------------------------------------------------------------------------- */
/* Tool definitions                                                           */
/* -------------------------------------------------------------------------- */

const FIND_DESCRIPTION =
  'Find LCSC / JLCPCB components that match a real requirement (package, capacitance, voltage rating, current, resistance, tolerance, dimensions, …) ' +
  'and return up to 8 candidates ranked by practical cost-effectiveness: unit price at the actual order quantity, stock coverage, parameter match, and ' +
  'basic-vs-extended JLCPCB library. ' +
  'Default assembly="hand" for DIY parts you buy and solder yourself (library type ignored, LCSC domestic CNY retail price used when reachable, USD reference otherwise). ' +
  'Set assembly="smt" only when the board will be assembled by JLCPCB: extended-library parts then add a USD 3 feeder fee per part number per order, amortized per board. ' +
  'Use a precise `need` such as "0402 100nF 50V X7R capacitor", "3.3V LDO SOT-23-5 500mA", "TP4054" or "C1581". ' +
  'When the LCSC domestic CNY price is unavailable in hand mode, a clearly-labelled reference CNY estimate (bulk-tier USD × configurable factor, default 6.0) is included; the USD price stays the actual reference. ' +
  'This is NOT a generic keyword search tool: it parses requirements, filters candidates and explains the ranking.'

const AUDIT_DESCRIPTION =
  'Audit an existing BOM against the JLCPCB parts library: per line price (USD ladder at the order quantity), stock, basic-vs-extended library, ' +
  'and for assembly="smt" the USD 3 extended-part feeder fee amortization, plus basic-library alternative suggestions for extended parts. ' +
  'Input `bom` as CSV/TSV text (LCSC codes required; header optional) or a JSON array like [{"lcsc":"C1581","qty":5}]. ' +
  'Default assembly="hand" (no feeder fees); set assembly="smt" for JLCPCB assembly cost planning. ' +
  'CNY retail prices are optional (include_cny=true, best effort, rate limited) and never mixed into USD totals; in hand mode a reference CNY estimate from bulk-tier USD × the configurable factor is reported when the real CNY price is unavailable.'

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
          include_cny: { type: 'boolean', description: 'hand mode only: try to fetch LCSC domestic CNY retail prices for the top candidates (default true; set false to skip the slower, rate-limited lookups).' },
          exclude_lcsc: { type: 'array', items: { type: 'string' }, description: 'LCSC codes to exclude, e.g. when looking for an alternative to a part you already have.' },
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
          include_cny: { type: 'boolean', description: 'Also try LCSC domestic CNY retail prices (best effort, capped; default false).' },
          suggest_alternatives: { type: 'boolean', description: 'For extended-library parts, suggest a basic-library substitute (default true; only in smt mode).' },
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
            currency: { type: 'string' },
            summary: { type: 'object' },
            rows: { type: 'array', items: { type: 'object' } },
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
  /** @type {{ effect?: (fn: () => (() => void)) => void, tools?: { register: (definition: unknown) => void } }} */
  const context = isRecord(ctx) ? ctx : {}
  context.effect?.(() => () => service.clearCache())
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
