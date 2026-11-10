#!/usr/bin/env node
/**
 * Live test against the Recording_card project BOM (2026-11-10).
 *
 *   node poc/test-recording-card.mjs
 *
 * Exercises both tools with the real network:
 *   - audit_lcsc_bom on Recording_card/data/bom_v0.5.csv (SMT + hand)
 *   - find_lcsc_parts on several requirements taken from that BOM
 *
 * Writes the full JSON responses to poc/test-output/recording-card.json.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createLcscService } from './lcsc-dsh-plugin/data.js'
import { auditBom, findParts } from './lcsc-dsh-plugin/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const recordingCard = '/Users/apple/Developer/Recording_card'
const bomPath = path.join(recordingCard, 'data', 'bom_v0.5.csv')
const outputDir = path.join(here, 'test-output')

if (!fs.existsSync(bomPath)) {
  console.error(`BOM not found: ${bomPath}`)
  process.exit(1)
}

const service = createLcscService({ timeoutMs: 8000, retries: 2, cacheTtlMs: 600000 })
const results = {}
let failures = 0

function printLine(text) {
  console.log(text)
}

async function timed(label, fn) {
  const start = Date.now()
  process.stdout.write(`\n### ${label} ... `)
  const value = await fn()
  console.log(`${((Date.now() - start) / 1000).toFixed(1)}s`)
  return value
}

/* -------------------------------------------------------------------------- */
/* 1. audit_lcsc_bom on the real BOM                                          */
/* -------------------------------------------------------------------------- */

const bomCsv = fs.readFileSync(bomPath, 'utf8')
printLine(`BOM: ${bomPath} (${bomCsv.split('\n').length - 1} lines)`)

const auditSmt = await timed('audit_lcsc_bom [smt, 5 boards, alternatives]', () =>
  auditBom(service, { bom: bomCsv, assembly: 'smt', boards: 5, suggest_alternatives: true, include_cny: false }),
)
results.auditSmt = auditSmt

const summary = auditSmt.summary
printLine(
  `lines ${summary.lines} | unique ${summary.unique_parts} | verified ${summary.verified} | no-stock ${summary.no_stock} | not-found ${summary.not_found}`,
)
printLine(
  `base ${summary.base_parts} / expand ${summary.expand_parts} | components USD ${summary.components_usd} + extended fee USD ${summary.extended_fee_per_order_usd} = USD ${summary.total_usd}`,
)
printLine('\nExtended-library lines (SMT, 5 boards):')
for (const row of auditSmt.rows) {
  if (row.library !== 'expand') continue
  const alternative = row.alternative === undefined ? '' : ` -> base alt ${row.alternative.lcsc} ${row.alternative.model ?? ''} (USD ${row.alternative.unit_usd ?? '?'})`
  printLine(`  ${row.lcsc} x${row.qty} ${row.model ?? ''} | stock ${row.stock} | fee/board $${(3 / 5).toFixed(2)}${alternative}`)
}
if (auditSmt.errors.length > 0) printLine(`errors: ${auditSmt.errors.join('; ')}`)
for (const note of auditSmt.notes) printLine(`note: ${note}`)

const auditHand = await timed('audit_lcsc_bom [hand, 5 boards]', () =>
  auditBom(service, { bom: bomCsv, assembly: 'hand', boards: 5, suggest_alternatives: false, include_cny: false }),
)
results.auditHand = auditHand
printLine(
  `hand: components USD ${auditHand.summary.components_usd} | extended fee USD ${auditHand.summary.extended_fee_per_order_usd} | base ${auditHand.summary.base_parts}/expand ${auditHand.summary.expand_parts}`,
)

/* -------------------------------------------------------------------------- */
/* 2. find_lcsc_parts on real requirements                                    */
/* -------------------------------------------------------------------------- */

const finds = [
  {
    label: 'find: 0402 100nF 50V X7R ±10% capacitor [smt, 5 boards]',
    args: { need: '0402 100nF 50V X7R ±10% capacitor', assembly: 'smt', quantity: 5, boards: 5, limit: 5 },
  },
  {
    label: 'find: 3.3V LDO SOT-23-5 500mA [hand, with CNY attempt]',
    args: { need: '3.3V LDO SOT-23-5 500mA', assembly: 'hand', quantity: 1, boards: 5, limit: 3, include_cny: true },
  },
  {
    label: 'find: TP4054 [hand]',
    args: { need: 'TP4054', assembly: 'hand', quantity: 1, boards: 5, limit: 3, include_cny: false },
  },
  {
    label: 'find: USB Type-C 16P connector [smt, 5 boards]',
    args: { need: 'USB Type-C 16P 母座 connector', assembly: 'smt', quantity: 1, boards: 5, limit: 3, include_cny: false },
  },
]
results.finds = []
for (const entry of finds) {
  try {
    const result = await timed(entry.label, () => findParts(service, entry.args))
    results.finds.push({ label: entry.label, args: entry.args, result })
    if (result.relaxed) printLine('  (参数过滤已放宽)')
    for (const candidate of result.candidates) {
      const price = candidate.price === undefined ? 'n/a' : `${candidate.price.unit} ${candidate.price.currency}`
      printLine(
        `  #${candidate.lcsc} ${candidate.brand ?? ''} ${candidate.model} | ${candidate.package} | lib ${candidate.library} | stock ${candidate.stock} | ${price} | score ${candidate.score}`,
      )
      if (Array.isArray(candidate.reasons)) printLine(`      ${candidate.reasons.slice(0, 3).join(' ; ')}`)
    }
    for (const hint of result.hints) printLine(`  hint: ${hint}`)
    for (const note of result.notes.filter((item) => /CNY|人民币|香港|WAF/i.test(item))) printLine(`  note: ${note}`)
  } catch (error) {
    failures += 1
    printLine(`  ERROR: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/* -------------------------------------------------------------------------- */
/* 3. Persist full output                                                     */
/* -------------------------------------------------------------------------- */

fs.mkdirSync(outputDir, { recursive: true })
const outputPath = path.join(outputDir, 'recording-card.json')
fs.writeFileSync(outputPath, JSON.stringify(results, null, 2))
printLine(`\nfull JSON: ${outputPath}`)
printLine(failures === 0 ? '\nRESULT: OK' : `\nRESULT: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
