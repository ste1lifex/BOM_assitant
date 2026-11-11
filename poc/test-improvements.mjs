#!/usr/bin/env node
/**
 * Live acceptance test for the 0.3.0 improvements (Recording_card 2026-11-11 review).
 *
 *   node poc/test-improvements.mjs
 *
 * Covers the review's P0 acceptance cases:
 *   - exact model / LCSC code lookup (SMF5.0A / AO3401A / TP4054 / C307331)
 *   - BOM audit on Recording_card data/bom_v0.6.csv (place smt/hand/dnp)
 *   - real CNY prices via headless Chrome (C1581 ¥0.0239, C7434398 ¥1.097)
 *   - duplicate-line merge, BOM CSV export, batch cost table, net-saving swaps
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createLcscService } from './lcsc-dsh-plugin/data.js'
import { createCnAdapter } from './lcsc-dsh-plugin/cn.js'
import { auditBom, findParts } from './lcsc-dsh-plugin/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const recordingCard = '/Users/apple/Developer/Recording_card'
const bomV06 = path.join(recordingCard, 'data', 'bom_v0.6.csv')
const outputDir = path.join(here, 'test-output')

const service = createLcscService({ timeoutMs: 8000, retries: 2, cacheTtlMs: 600000 })
service.cn = createCnAdapter({})

const results = { checks: [], audits: {} }
let failed = 0

function check(label, condition, detail) {
  const ok = condition === true
  if (!ok) failed += 1
  results.checks.push({ label, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 500)}`}`)
}

function section(title) {
  console.log(`\n=== ${title} ===`)
}

async function timed(label, fn) {
  const start = Date.now()
  process.stdout.write(`### ${label} ... `)
  const value = await fn()
  console.log(`${((Date.now() - start) / 1000).toFixed(1)}s`)
  return value
}

/* -------------------------------------------------------------------------- */
/* 1. Exact model / code lookup                                               */
/* -------------------------------------------------------------------------- */

section('exact model / code lookup')
const exactCases = [
  { need: 'SMF5.0A', expect: 'C193402', note: 'TVS' },
  { need: 'AO3401A', expect: 'C347476', note: 'P-MOS' },
  { need: 'TP4054', expect: 'C668215', note: 'charger IC' },
  { need: 'C307331', expect: 'C307331', note: 'LCSC code' },
]
for (const testCase of exactCases) {
  const result = await timed(`find "${testCase.need}"`, () =>
    findParts(service, { need: testCase.need, assembly: 'smt', boards: 100, limit: 6, include_cny: false }),
  )
  const codes = result.candidates.map((candidate) => candidate.lcsc)
  check(`${testCase.need} returns candidates (not 0)`, result.candidates.length > 0, codes)
  check(`${testCase.need} includes ${testCase.expect}`, codes.includes(testCase.expect), codes)
  results.audits[`find_${testCase.need.replace(/[^A-Za-z0-9]/g, '_')}`] = result
}

/* -------------------------------------------------------------------------- */
/* 2. 22 ohm 0402 resistor: base library but LCSC 0 stock                     */
/* -------------------------------------------------------------------------- */

section('22 ohm 0402 resistor (base vs extended, dual stock)')
const resistorResult = await timed('find "22 ohm 0402 resistor 1%" (include_cny)', () =>
  findParts(service, { need: '22 ohm 0402 resistor 1%', assembly: 'smt', boards: 100, limit: 5, include_cny: true }),
)
results.audits.find_22ohm = resistorResult
const resistorBase = resistorResult.candidates.find((candidate) => candidate.library === 'base')
check('finds a base-library 22Ω candidate', resistorBase !== undefined, resistorResult.candidates.map((c) => `${c.lcsc}/${c.library}`))
check(
  'reports stock_lcsc separately from stock_smt',
  resistorResult.candidates.every((candidate) => 'stock_lcsc' in candidate && 'stock_smt' in candidate),
)
if (resistorBase !== undefined) {
  console.log(`    base candidate ${resistorBase.lcsc} stock_smt=${resistorBase.stock_smt} stock_lcsc=${resistorBase.stock_lcsc}`)
  check('base 22Ω reports a dual stock view (lcsc stock may be 0)', resistorBase.stock_lcsc === null || typeof resistorBase.stock_lcsc === 'number', resistorBase.stock_lcsc)
}

/* -------------------------------------------------------------------------- */
/* 3. BOM v0.6 audit: place smt/hand/dnp + fee + batch table                 */
/* -------------------------------------------------------------------------- */

section('audit Recording_card data/bom_v0.6.csv (100 boards, SMT)')
const bomText = fs.readFileSync(bomV06, 'utf8')
const audit = await timed('audit_lcsc_bom [smt, 100 boards, alternatives, export]', () =>
  auditBom(service, {
    bom: bomText,
    assembly: 'smt',
    boards: 100,
    include_cny: false,
    suggest_alternatives: true,
    export_bom: true,
  }),
)
results.audits.bomV06 = audit
const summary = audit.summary
console.log(
  `  lines=${summary.lines} smt=${summary.smt_lines} hand=${summary.hand_lines} dnp=${summary.dnp_lines} ` +
    `unique=${summary.unique_parts} base=${summary.base_parts} expand=${summary.expand_parts}`,
)
console.log(
  `  components USD ${summary.components_usd} + fee USD ${summary.extended_fee_per_order_usd} ` +
    `= total USD ${summary.total_usd} (per board ${summary.total_per_board_usd})`,
)
check('place column parsed: 6 DNP lines', summary.dnp_lines === 6, summary.dnp_lines)
check('place column parsed: 1 hand line', summary.hand_lines === 1, summary.hand_lines)
check('place column parsed: 25 SMT lines', summary.smt_lines === 25, summary.smt_lines)
check('extended feeder fee is positive', summary.extended_fee_per_order_usd > 0, summary.extended_fee_per_order_usd)
check('components cost within review range ($100-$125 for 100 boards)', summary.components_usd > 100 && summary.components_usd < 125, summary.components_usd)
check('total cost within review range ($135-$160)', summary.total_usd > 135 && summary.total_usd < 160, summary.total_usd)
check('DNP component value excluded and reported', summary.dnp_components_usd_excluded > 0, summary.dnp_components_usd_excluded)
check('hand lines excluded from SMT component total', summary.hand_components_usd_reference > 0)
check('batch table has 20/100/300/1000', [20, 100, 300, 1000].every((boards) => summary.cost_table.some((row) => row.boards === boards)))
check('BOM CSV exported with smt lines', typeof audit.bom_csv === 'string' && audit.bom_csv.split('\n').length >= 20, (audit.bom_csv ?? '').slice(0, 120))
check('optimize saving is reported', typeof audit.optimize.saving_usd_per_order === 'number', audit.optimize.saving_usd_per_order)
const baseSwaps = (audit.optimize.alternatives ?? []).filter((alternative) => alternative.net_saving_usd > 0)
console.log(`    net-saving swaps: ${baseSwaps.length}; actions: ${(audit.optimize.actions ?? []).slice(0, 3).join(' | ')}`)
check('at least one net-saving action suggested', Array.isArray(audit.optimize.actions) && audit.optimize.actions.length > 0, audit.optimize.actions)

/* -------------------------------------------------------------------------- */
/* 4. Same BOM with J4 marked smt: feeder fee increases by $3                */
/* -------------------------------------------------------------------------- */

section('J4 place=hand vs smt (feeder fee difference)')
const bomAllSmt = bomText
  .split('\n')
  .map((line) => (line.startsWith('J4,') ? line.replace(',hand,', ',smt,') : line))
  .join('\n')
check('J4 line was rewritten to smt', bomAllSmt.includes('J4,') && bomAllSmt !== bomText)
const auditAllSmt = await timed('audit_lcsc_bom [all-smt, 100 boards]', () =>
  auditBom(service, { bom: bomAllSmt, assembly: 'smt', boards: 100, include_cny: false, suggest_alternatives: false }),
)
results.audits.bomV06AllSmt = auditAllSmt
console.log(
  `  hand-in-BOM fee=${summary.extended_fee_per_order_usd} vs all-smt fee=${auditAllSmt.summary.extended_fee_per_order_usd}`,
)
check(
  'J4 as hand avoids exactly one feeder fee ($3)',
  auditAllSmt.summary.extended_fee_per_order_usd === summary.extended_fee_per_order_usd + 3,
  [summary.extended_fee_per_order_usd, auditAllSmt.summary.extended_fee_per_order_usd],
)
check('all-smt total is higher than hand-in-BOM total', auditAllSmt.summary.total_usd > summary.total_usd)

/* -------------------------------------------------------------------------- */
/* 5. Real CNY prices via headless Chrome (golden data from the review)      */
/* -------------------------------------------------------------------------- */

section('real CNY prices (Chrome render, golden data)')
const cnyAudit = await timed('audit [C1581, C7434398] include_cny=true', () =>
  auditBom(service, {
    bom: 'C1581,1\nC7434398,1\n',
    assembly: 'hand',
    boards: 1,
    include_cny: true,
    suggest_alternatives: false,
  }),
)
results.audits.cnyAudit = cnyAudit
const c1581 = cnyAudit.rows.find((row) => row.lcsc === 'C1581')
const ad142 = cnyAudit.rows.find((row) => row.lcsc === 'C7434398')
console.log(`  C1581: CNY=${c1581?.unit_cny} stock_lcsc=${c1581?.stock_lcsc} source=${c1581?.price_cny_source}`)
console.log(`  C7434398: CNY=${ad142?.unit_cny} stock_lcsc=${ad142?.stock_lcsc} source=${ad142?.price_cny_source}`)
check('C1581 real CNY ≈ ¥0.0239 (±8%)', typeof c1581?.unit_cny === 'number' && Math.abs(c1581.unit_cny - 0.0239) / 0.0239 <= 0.08, c1581?.unit_cny)
check('C1581 real domestic stock present', typeof c1581?.stock_lcsc === 'number' && c1581.stock_lcsc > 0, c1581?.stock_lcsc)
check('C7434398 real CNY ≈ ¥1.097 (±8%)', typeof ad142?.unit_cny === 'number' && Math.abs(ad142.unit_cny - 1.097) / 1.097 <= 0.08, ad142?.unit_cny)
check('CNY source labelled lcsc_cn_render', c1581?.price_cny_source === 'lcsc_cn_render', c1581?.price_cny_source)

/* -------------------------------------------------------------------------- */
/* 6. Duplicate LCSC lines: merge + one feeder fee                           */
/* -------------------------------------------------------------------------- */

section('duplicate LCSC lines')
const dupAudit = await timed('audit duplicate C1581 lines', () =>
  auditBom(service, {
    bom: 'C1581,2,smt\nC1581,3,smt\n',
    assembly: 'smt',
    boards: 10,
    include_cny: false,
    suggest_alternatives: false,
  }),
)
results.audits.duplicates = dupAudit
check('duplicate lines merged to one line', dupAudit.summary.lines === 1, dupAudit.summary.lines)
check('merged quantity = 5', dupAudit.rows[0].qty === 5, dupAudit.rows[0].qty)
check('feeder fee counted once', dupAudit.summary.extended_fee_per_order_usd === 3, dupAudit.summary.extended_fee_per_order_usd)

/* -------------------------------------------------------------------------- */
/* persist + result                                                           */
/* -------------------------------------------------------------------------- */

fs.mkdirSync(outputDir, { recursive: true })
service.cn?.dispose?.()
const outputPath = path.join(outputDir, 'improvements.json')
fs.writeFileSync(outputPath, JSON.stringify(results, null, 2))
console.log(`\nfull JSON: ${outputPath}`)
console.log(failed === 0 ? '\nRESULT: OK' : `\nRESULT: ${failed} failure(s)`)
process.exit(failed === 0 ? 0 : 1)
