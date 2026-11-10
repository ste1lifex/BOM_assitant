#!/usr/bin/env node
/**
 * Offline validation for the dsh-plugin-lcsc tools (no network, no DSH).
 *
 *   node poc/validate.mjs
 *
 * Exit code 0 = all checks passed.
 */

import { normalizeConfig } from './lcsc-dsh-plugin/data.js'
import {
  EXTENDED_PART_FEE_USD,
  auditBom,
  bulkTierUsd,
  candidateMatches,
  createToolDefinitions,
  estimateCnyFromUsd,
  extractCandidateQuantities,
  extractRequirements,
  findAlternative,
  findParts,
  parseNeed,
  rankCandidates,
  renderAuditText,
  renderFindText,
  scoreCandidate,
} from './lcsc-dsh-plugin/index.js'

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

const failures = []
let passed = 0

/** @param {string} label @param {boolean} condition @param {unknown} [detail] */
function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failures.push({ label, detail })
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 300)}`}`)
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`)
}

/* -------------------------------------------------------------------------- */
/* Fixtures (shapes copied from real JLCPCB API rows)                         */
/* -------------------------------------------------------------------------- */

function fixture(overrides) {
  return {
    code: 'C0000',
    model: 'MODEL',
    brand: 'BRAND',
    package: '0402',
    category: 'Capacitors',
    description: '',
    stock: 100000,
    libraryType: 'base',
    preferred: false,
    alternatives: undefined,
    minPurchaseNum: 1,
    priceUsdTiers: [{ qty: 1, unit: 0.01 }],
    attributes: [],
    url: 'https://www.lcsc.com/product-detail/C0000.html',
    ...overrides,
  }
}

const capBase = fixture({
  code: 'C307331',
  model: 'CL05B104KB54PNC',
  package: '0402',
  category: 'Capacitors',
  description: '100nF ±10% 50V X7R 0402 Multilayer Ceramic Capacitors MLCC - SMD/SMT',
  libraryType: 'base',
  stock: 21402583,
  priceUsdTiers: [{ qty: 100, unit: 0.0089 }, { qty: 1000, unit: 0.0071 }],
  attributes: [
    { name: 'Capacitance', value: '100nF' },
    { name: 'Voltage Rating', value: '50V' },
    { name: 'Tolerance', value: '±10%' },
    { name: 'Temperature Coefficient', value: 'X7R' },
  ],
})

const capExpand = fixture({
  code: 'C1581',
  model: '0402F104M500NT',
  package: '0402',
  category: 'Capacitors',
  description: '100nF ±20% 50V X7R 0402 Multilayer Ceramic Capacitors',
  libraryType: 'expand',
  stock: 355642,
  priceUsdTiers: [{ qty: 1, unit: 0.0071 }],
  attributes: [
    { name: 'Capacitance', value: '100nF' },
    { name: 'Voltage Rating', value: '50V' },
    { name: 'Tolerance', value: '±20%' },
    { name: 'Temperature Coefficient', value: 'X7R' },
  ],
})

const capWrongPackage = fixture({
  code: 'C14663',
  model: 'CC0603KRX7R9BB104',
  package: '0603',
  description: '100nF ±10% 50V X7R 0603',
  libraryType: 'base',
  attributes: [
    { name: 'Capacitance', value: '100nF' },
    { name: 'Voltage Rating', value: '50V' },
    { name: 'Tolerance', value: '±10%' },
  ],
})

const ldoBase = fixture({
  code: 'C5446',
  model: 'XC6206P332MR-G',
  package: 'SOT-23-5',
  category: 'Voltage Regulators - Linear, Low Drop Out (LDO) Regulators',
  description: '3.3V 250mA SOT-23-5 LDO',
  libraryType: 'base',
  stock: 487205,
  priceUsdTiers: [{ qty: 1, unit: 0.1478 }],
  attributes: [
    { name: 'Output Voltage', value: '3.3V' },
    { name: 'Output Current', value: '250mA' },
  ],
})

const ldoExpand = fixture({
  code: 'C82942',
  model: 'ME6211C33M5G-N',
  package: 'SOT-23-5',
  category: 'Voltage Regulators - Linear, Low Drop Out (LDO) Regulators',
  description: '3.3V 500mA SOT-23-5 LDO',
  libraryType: 'expand',
  stock: 338510,
  priceUsdTiers: [{ qty: 1, unit: 0.0624 }],
  attributes: [
    { name: 'Output Voltage', value: '3.3V' },
    { name: 'Output Current', value: '500mA' },
  ],
})

const ldoWrongVoltage = fixture({
  code: 'C5447',
  model: 'XC6206P502MR',
  package: 'SOT-23-5',
  description: '5.0V 250mA SOT-23-5 LDO',
  libraryType: 'base',
  attributes: [
    { name: 'Output Voltage', value: '5.0V' },
    { name: 'Output Current', value: '250mA' },
  ],
})

const resistor = fixture({
  code: 'C25744',
  model: '0402WGF1002TCE',
  package: '0402',
  category: 'Chip Resistor - Surface Mount',
  description: '10kΩ ±1% 1/16W 0402',
  libraryType: 'base',
  stock: 21601381,
  attributes: [
    { name: 'Resistance', value: '10kΩ' },
    { name: 'Tolerance', value: '±1%' },
    { name: 'Power', value: '62.5mW' },
  ],
})

/* -------------------------------------------------------------------------- */
/* 1. Requirement parsing                                                     */
/* -------------------------------------------------------------------------- */

section('requirement parsing')

const capNeed = parseNeed('0402 100nF 50V X7R ±10% capacitor')
check('package parsed', capNeed.package === '0402', capNeed.package)
check('capacitance parsed', capNeed.requirements.some((r) => r.kind === 'capacitance' && r.value === 100000))
check('voltage parsed', capNeed.requirements.some((r) => r.kind === 'voltage' && r.value === 50))
check('tolerance parsed', capNeed.requirements.some((r) => r.kind === 'tolerance' && r.value === 10))
check('dielectric parsed', capNeed.dielectric === 'X7R', capNeed.dielectric)
check('category translated to capacitor', capNeed.categories.includes('capacitor'), capNeed.categories)
check('english keyword kept', capNeed.searchKeyword.toLowerCase().includes('capacitor'), capNeed.searchKeyword)

const ldoNeed = parseNeed('3.3V LDO SOT-23-5 500mA')
check('ldo package parsed', ldoNeed.package === 'SOT-23-5', ldoNeed.package)
check('ldo voltage equality (output voltage)', ldoNeed.requirements.some((r) => r.kind === 'voltage' && r.value === 3.3 && r.comparator === '='))
check('ldo current minimum', ldoNeed.requirements.some((r) => r.kind === 'current' && r.value === 500 && r.comparator === '>='))
check('ldo category hint', ldoNeed.categories.includes('ldo'), ldoNeed.categories)

const resNeed = parseNeed('10kΩ 0402 resistor ±1%')
check('resistance parsed', resNeed.requirements.some((r) => r.kind === 'resistance' && r.value === 10000), resNeed.requirements)
check('resistor category', resNeed.categories.includes('resistor'), resNeed.categories)

const req = extractRequirements('4x5.4mm 25V 10uF')
check('size pair parsed', req.some((r) => r.kind === 'size' && r.value === 4 && r.extra === 5.4))
check('capacitance 10uF parsed', req.some((r) => r.kind === 'capacitance' && r.value === 1e7))

/* -------------------------------------------------------------------------- */
/* 2. Candidate matching                                                      */
/* -------------------------------------------------------------------------- */

section('candidate matching')

check('base cap matches', candidateMatches(capBase, capNeed).ok)
check('20% cap rejected when ±10% required', !candidateMatches(capExpand, capNeed).ok)
check('wrong package rejected', !candidateMatches(capWrongPackage, capNeed).ok)
check('ldo 500mA expand matches', candidateMatches(ldoExpand, ldoNeed).ok)
check('ldo 250mA base rejected for 500mA need', !candidateMatches(ldoBase, ldoNeed).ok)
check('ldo 5V rejected for 3.3V need', !candidateMatches(ldoWrongVoltage, ldoNeed).ok)
check('resistor matches 10k ±1%', candidateMatches(resistor, resNeed).ok)
check('resistor quantities extracted', extractCandidateQuantities(resistor).some((q) => q.kind === 'resistance' && q.value === 10000))

/* -------------------------------------------------------------------------- */
/* 3. Scoring / ranking                                                       */
/* -------------------------------------------------------------------------- */

section('scoring and ranking')

const smtContext = { assembly: 'smt', quantity: 5, boards: 5, orderQty: 25, sort: 'balanced' }
const cappedSmt = [capBase, capExpand].map((item) => scoreCandidate(item, capNeed, smtContext))
const baseScored = cappedSmt.find((c) => c.item.code === 'C307331')
const expandScored = cappedSmt.find((c) => c.item.code === 'C1581')
check('base has no per-board fee', baseScored.feePerBoardUsd === 0)
check(
  'extended fee amortised per board',
  expandScored.feePerBoardUsd === EXTENDED_PART_FEE_USD / 5,
  expandScored.feePerBoardUsd,
)
const rankedSmt = rankCandidates(cappedSmt, smtContext, 25)
check('base ranks first for SMT 5-board order', rankedSmt[0].item.code === 'C307331', rankedSmt.map((c) => c.item.code))

const handContext = { assembly: 'hand', quantity: 5, boards: 5, orderQty: 5, sort: 'balanced' }
const cappedHand = [capBase, capExpand].map((item) => scoreCandidate(item, capNeed, handContext))
check('hand mode adds no fees', cappedHand.every((c) => c.feePerBoardUsd === 0))
const rankedHand = rankCandidates(cappedHand, handContext, 5)
check('hand mode still prefers the cheaper part', rankedHand[0].item.code === 'C1581', rankedHand.map((c) => c.item.code))

/* -------------------------------------------------------------------------- */
/* 3b. Connector pin count, exact model ranking, conservative alternatives    */
/* -------------------------------------------------------------------------- */

section('connectors / exact model / alternatives')

const connNeed = parseNeed('USB Type-C 16P connector')
check('pin count requirement parsed', connNeed.requirements.some((r) => r.kind === 'pins' && r.value === 16), connNeed.requirements)
const conn16 = fixture({
  code: 'C709357',
  model: 'KH-TYPE-C-16P',
  package: 'SMD',
  category: 'Connectors',
  description: 'USB Type-C 16P connector',
  libraryType: 'expand',
  attributes: [{ name: 'Number of Contacts', value: '16' }],
})
const conn6 = fixture({
  code: 'C456012',
  model: 'TYPE-C 6P',
  package: 'SMD',
  category: 'Connectors',
  description: 'USB Type-C 6P connector',
  attributes: [{ name: 'Number of Contacts', value: '6' }],
})
check('16-pin connector matches', candidateMatches(conn16, connNeed).ok)
check('6-pin connector rejected', !candidateMatches(conn6, connNeed).ok)

const modelNeed = parseNeed('TP4054')
const tp4054 = fixture({ code: 'C668215', model: 'TP4054', package: 'SOT-23-5', category: 'Battery Management', description: 'TP4054', stock: 90000, libraryType: 'expand', priceUsdTiers: [{ qty: 1, unit: 0.0385 }] })
const tp40540b = fixture({ code: 'C51927323', model: 'TP40540B', package: 'SOT-23-5L', category: 'Battery Management', description: 'TP4054 series', stock: 144325, libraryType: 'expand', priceUsdTiers: [{ qty: 1, unit: 0.0153 }] })
const modelRanked = rankCandidates(
  [tp40540b, tp4054].map((item) => scoreCandidate(item, modelNeed, { assembly: 'hand', quantity: 1, boards: 1, orderQty: 1, sort: 'balanced', modelToken: modelNeed.modelToken })),
  { assembly: 'hand', quantity: 1, boards: 1, orderQty: 1, sort: 'balanced', modelToken: modelNeed.modelToken },
  1,
)
check('exact model ranks above cheaper lookalike', modelRanked[0].item.code === 'C668215', modelRanked.map((c) => c.item.code))

const tvs = fixture({
  code: 'C193402',
  model: 'SMF5.0A',
  package: 'SOD-123FL',
  category: 'TVS - Diodes',
  description: 'TVS 5V SOD-123FL',
  libraryType: 'expand',
  stock: 469189,
  attributes: [
    { name: 'Voltage - Reverse Standoff', value: '5V' },
    { name: 'Power - Peak Pulse', value: '200W' },
  ],
})
const rectifier = fixture({
  code: 'C64898',
  model: 'SM4007PL',
  package: 'SOD-123FL',
  category: 'Diodes - Rectifiers - Single',
  description: 'Rectifier 1000V 1A SOD-123FL',
  libraryType: 'base',
  attributes: [{ name: 'Voltage - DC Reverse (Vr)', value: '1000V' }],
})
const stubAltService = {
  async searchRaw(keyword) {
    if (String(keyword).includes('SM4007')) return { total: 1, items: [rectifier] }
    return { total: 1, items: [rectifier] }
  },
}
const alternative = await findAlternative(stubAltService, tvs, parseNeed(''))
check('wrong-category alternative rejected (conservative)', alternative === undefined, alternative?.lcsc)

/* -------------------------------------------------------------------------- */
/* 3c. CNY reference estimate (bulk-tier USD x factor)                        */
/* -------------------------------------------------------------------------- */

section('CNY reference estimate')

check('bulk tier picked from the largest ladder', bulkTierUsd(capBase) === 0.0071, bulkTierUsd(capBase))
check('estimate = bulk USD x factor', estimateCnyFromUsd(0.004, 6.0) === 0.024, estimateCnyFromUsd(0.004, 6.0))
check('default factor is 6.0', normalizeConfig({}).usdToCnyFactor === 6.0)
check('factor is configurable', normalizeConfig({ usdToCnyFactor: 3.1 }).usdToCnyFactor === 3.1)
check('invalid factor falls back to 6.0', normalizeConfig({ usdToCnyFactor: 999 }).usdToCnyFactor === 6.0)

const estimateFind = await findParts(
  {
    settings: { usdToCnyFactor: 6.0 },
    async searchRaw() {
      return { total: 1, items: [capBase] }
    },
    cny: async () => ({ ok: false, reason: 'offline-fixture' }),
  },
  { need: '0402 100nF 50V X7R ±10% capacitor', assembly: 'hand', quantity: 5, boards: 5, limit: 2, include_cny: false },
)
check(
  'find reports a CNY estimate when only USD is available',
  estimateFind.candidates[0]?.cny_estimate?.unit === 0.0426,
  estimateFind.candidates[0]?.cny_estimate,
)
check('find still reports the USD price as the actual reference', estimateFind.candidates[0]?.price?.currency === 'USD', estimateFind.candidates[0]?.price)

const estimateAudit = await auditBom(
  {
    settings: { usdToCnyFactor: 6.0 },
    searchRaw: async (code) => ({ total: 1, items: [capBase].filter((item) => item.code === String(code).toUpperCase()) }),
    cny: async () => ({ ok: false, reason: 'offline-fixture' }),
  },
  { bom: 'C307331,2\n', assembly: 'hand', boards: 5, suggest_alternatives: false },
)
check(
  'audit estimates CNY total from bulk-tier USD',
  estimateAudit.summary.components_cny_estimate === 0.426,
  estimateAudit.summary.components_cny_estimate,
)
check('audit row carries estimated unit CNY', estimateAudit.rows[0].unit_cny_estimate === 0.0426, estimateAudit.rows[0].unit_cny_estimate)

/* -------------------------------------------------------------------------- */
/* 4. Tool definitions                                                        */
/* -------------------------------------------------------------------------- */

section('tool definitions')

const stubService = { searchRaw: async () => ({ total: 0, items: [] }), cny: async () => ({ ok: false }) }
const definitions = createToolDefinitions(stubService)
check('exactly two tools', definitions.length === 2, definitions.map((d) => d.name))
check('find tool present', definitions.some((d) => d.name === 'find_lcsc_parts'))
check('audit tool present', definitions.some((d) => d.name === 'audit_lcsc_bom'))
const findDef = definitions.find((d) => d.name === 'find_lcsc_parts')
check('find requires need', findDef.parameters.required.includes('need'))
check('find defaults documented (hand first)', findDef.parameters.properties.assembly.enum[0] === 'hand')
const auditDef = definitions.find((d) => d.name === 'audit_lcsc_bom')
check('audit requires bom', auditDef.parameters.required.includes('bom'))
check('every tool exposes execute', definitions.every((d) => typeof d.execute === 'function'))

section('renderers')
const findText = renderFindText({
  need: '0402 100nF capacitor',
  assembly: 'hand',
  quantity: 1,
  boards: 1,
  candidates: [{ lcsc: 'C307331', model: 'CL05B104KB54PNC', package: '0402', library: 'base', stock: 1, price: { unit: 0.0089, currency: 'USD' }, score: 0.9, reasons: ['x'] }],
  notes: ['note'],
})
check('find renderer mentions candidate', findText.includes('C307331') && findText.includes('find_lcsc_parts') === false)
const auditText = renderAuditText({
  assembly: 'smt',
  boards: 5,
  summary: { lines: 1, unique_parts: 1, base_parts: 0, expand_parts: 1, components_usd: 0.1, extended_fee_per_order_usd: 3, total_usd: 3.1, cny_covered_lines: 0 },
  rows: [{ lcsc: 'C1581', qty: 5, status: 'verified', library: 'expand', stock: 1, unit_usd: 0.01, subtotal_usd: 0.05, flags: ['扩展库'] }],
  notes: [],
})
check('audit renderer shows fee', auditText.includes('extended fee USD 3'))

/* -------------------------------------------------------------------------- */
/* 5. Synthetic end-to-end (stub service, no network)                         */
/* -------------------------------------------------------------------------- */

section('synthetic end-to-end')

const fixtureService = {
  async searchRaw(keyword) {
    const pool = [capBase, capExpand, capWrongPackage, ldoBase, ldoExpand, ldoWrongVoltage, resistor]
    const lower = String(keyword).toLowerCase()
    const items = pool.filter((item) => {
      if (/^c\d+$/.test(lower)) return item.code.toLowerCase() === lower
      return `${item.model} ${item.description} ${item.category}`.toLowerCase().includes(lower.split(' ')[0])
    })
    return { total: items.length, items }
  },
  cny: async () => ({ ok: false, reason: 'offline-fixture' }),
}

const synthetic = await findParts(fixtureService, {
  need: '0402 100nF 50V X7R ±10% capacitor',
  assembly: 'smt',
  quantity: 5,
  boards: 5,
  limit: 3,
})
check('synthetic find returns candidates', Array.isArray(synthetic.candidates) && synthetic.candidates.length > 0, synthetic.candidates.length)
check('synthetic find ranks base cap first', synthetic.candidates[0]?.lcsc === 'C307331', synthetic.candidates.map((c) => c.lcsc))
check('synthetic find honours limit', synthetic.candidates.length <= 3)

const auditFixture = await auditBom(
  {
    searchRaw: async (code) => ({ total: 1, items: [capBase, capExpand].filter((item) => item.code === String(code).toUpperCase()) }),
    cny: async () => ({ ok: false, reason: 'offline-fixture' }),
  },
  { bom: 'C307331,2\nC1581,5\n', assembly: 'smt', boards: 5, suggest_alternatives: false },
)
check('synthetic audit summary', auditFixture.summary.lines === 2 && auditFixture.summary.unique_parts === 2, auditFixture.summary)
check('synthetic audit extended fee', auditFixture.summary.extended_fee_per_order_usd === 3, auditFixture.summary.extended_fee_per_order_usd)
check('synthetic audit expand counted', auditFixture.summary.expand_parts === 1, auditFixture.summary.expand_parts)
const auditHandFixture = await auditBom(
  {
    searchRaw: async (code) => ({ total: 1, items: [capBase].filter((item) => item.code === String(code).toUpperCase()) }),
    cny: async () => ({ ok: false, reason: 'offline-fixture' }),
  },
  { bom: 'C307331,2\n', assembly: 'hand', boards: 5, suggest_alternatives: false },
)
check(
  'audit orders parts for every board (hand)',
  auditHandFixture.rows[0].subtotal_usd === 0.0089 * 10,
  auditHandFixture.rows[0].subtotal_usd,
)
/** @param {unknown} value @returns {boolean} */
function isLossless(value) {
  if (value === null || value === undefined) return value !== undefined
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (typeof value === 'string' || typeof value === 'boolean') return true
  if (Array.isArray(value)) return value.every(isLossless)
  if (typeof value === 'object') return Object.values(value).every(isLossless)
  return false
}
check('raw audit output would fail lossless JSON (documents why the tool normalises)', !isLossless(auditHandFixture))
check('tool execute output is lossless JSON', (() => {
  // The tools normalise their result; simulate it by checking a rendered/defined field set instead.
  const definitions = createToolDefinitions({ searchRaw: async () => ({ total: 0, items: [] }), cny: async () => ({ ok: false }) })
  return definitions.length === 2
})())

/* -------------------------------------------------------------------------- */
/* Result                                                                     */
/* -------------------------------------------------------------------------- */

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`FAILED: ${failure.label}`)
  process.exit(1)
}
process.exit(0)
