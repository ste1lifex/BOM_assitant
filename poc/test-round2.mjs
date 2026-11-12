#!/usr/bin/env node
/**
 * Live acceptance test for the Round-2 review (Recording_card 2026-11-12).
 *
 *   node poc/test-round2.mjs
 *
 * Covers:
 *   - colloquial Chinese recall (MEMS 麦克风 / USB Type-C 16P 母座 / 充电 IC)
 *   - stock scopes: stock_retail vs stock_smt + stock_asof + data_warnings (C25744)
 *   - stock-aware substitution suggestions (require_stock=lcsc must not suggest C25092)
 *   - CNY total basis: per_board vs per_order
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createLcscService } from './lcsc-dsh-plugin/data.js'
import { createCnAdapter } from './lcsc-dsh-plugin/cn.js'
import { auditBom, findParts } from './lcsc-dsh-plugin/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const recordingCard = '/Users/apple/Developer/Recording_card'
const bomPath = path.join(recordingCard, 'data', 'bom_v0.6.csv')
const service = createLcscService({ timeoutMs: 8000, retries: 2 })
service.cn = createCnAdapter({})

const results = { checks: [], data: {} }
let failed = 0

function check(label, condition, detail) {
  const ok = condition === true
  if (!ok) failed += 1
  results.checks.push({ label, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 400)}`}`)
}

function section(title) {
  console.log(`\n=== ${title} ===`)
}

/* 1. Chinese recall ------------------------------------------------------- */
section('colloquial Chinese recall')
const recallCases = [
  { need: 'MEMS 麦克风 模拟输出', expectCategory: 'MEMS Microphones' },
  { need: 'USB Type-C 16P 母座', expectModel: /16P|16PIN/i },
  { need: '单节锂电池线性充电 IC', expectCategory: 'Battery Management' },
  { need: '自恢复保险丝 PTC', expectCategory: 'Resettable Fuses' },
]
for (const testCase of recallCases) {
  const started = Date.now()
  const result = await findParts(service, { need: testCase.need, assembly: 'smt', boards: 100, limit: 8, include_cny: false })
  results.data[`recall_${testCase.need}`] = result
  console.log(`  [${testCase.need}] ${result.candidates.length} candidates (${((Date.now() - started) / 1000).toFixed(1)}s)`)
  check(`${testCase.need} returns candidates`, result.candidates.length > 0, result.candidates.map((candidate) => candidate.lcsc))
  check(
    `${testCase.need} matches expected category/model`,
    result.candidates.some((candidate) =>
      testCase.expectCategory !== undefined
        ? String(candidate.category ?? candidate.specs ?? '').includes(testCase.expectCategory)
        : testCase.expectModel.test(String(candidate.model ?? '')),
    ),
    result.candidates.slice(0, 4).map((candidate) => `${candidate.lcsc}/${candidate.model}/${candidate.category}`),
  )
}

/* 2. stock scopes --------------------------------------------------------- */
section('stock scopes (C25744 retail=0 / SMT≈2.06e7)')
const c25744 = await findParts(service, { need: 'C25744', assembly: 'hand', boards: 1, limit: 1, include_cny: true })
const row = c25744.candidates[0]
results.data.c25744 = c25744
console.log(`  C25744 stock_retail=${row?.stock_retail} stock_smt=${row?.stock_smt} asof=${row?.stock_asof} warnings=${JSON.stringify(row?.data_warnings)}`)
check('C25744 retail stock is 0', row?.stock_retail === 0, row?.stock_retail)
check('C25744 SMT stock is available', (row?.stock_smt ?? 0) > 1e6, row?.stock_smt)
check('stock_asof timestamp present', typeof row?.stock_asof === 'string' && row.stock_asof.length > 10, row?.stock_asof)
check('retail-0 warning emitted', (row?.data_warnings ?? []).includes('retail_out_of_stock_smt_ok'), row?.data_warnings)

/* 3. stock-aware suggestions ---------------------------------------------- */
section('stock-aware substitution suggestions')
const bom = fs.readFileSync(bomPath, 'utf8')
const strict = await auditBom(service, {
  bom, assembly: 'smt', boards: 100, include_cny: false,
  suggest_alternatives: true, require_stock: 'lcsc',
})
results.data.auditStrict = strict
const suggestedCodes = (strict.optimize.alternatives ?? []).map((alternative) => alternative.lcsc)
const blockedCodes = (strict.optimize.blocked ?? []).map((item) => item.from)
console.log(`  require_stock=lcsc: alternatives=${suggestedCodes.join(',') || '(none)'} blocked=${blockedCodes.join(',') || '(none)'}`)
check('strict suggestions do not include retail-0 C25092', !suggestedCodes.includes('C25092'), suggestedCodes)
check('retail-0 candidate reported as skipped', (strict.optimize.blocked ?? []).some((item) => (item.skipped ?? []).some((skip) => skip.lcsc === 'C25092')), strict.optimize.blocked)
check('optimize reports stock scope', strict.optimize.require_stock === 'lcsc' && strict.optimize.stock_scope === 'lcsc')

/* 4. CNY basis ------------------------------------------------------------ */
section('CNY total basis (per board vs per order)')
const handAudit = await auditBom(service, { bom, assembly: 'hand', boards: 100, include_cny: true, suggest_alternatives: false })
results.data.auditHand = handAudit
const summary = handAudit.summary
console.log(`  CNY/board=${summary.components_cny_per_board} CNY/order=${summary.components_cny_per_order} basis=${summary.cny_total_basis} tier=${summary.cny_price_tier}`)
check('CNY basis labelled per_order', summary.cny_total_basis === 'per_order', summary.cny_total_basis)
check('CNY per board ≈ ¥4.08', Math.abs(summary.components_cny_per_board - 4.08) <= 0.3, summary.components_cny_per_board)
check('CNY per order ≈ per-board × 100', Math.abs(summary.components_cny_per_order - summary.components_cny_per_board * 100) < 1, {
  perOrder: summary.components_cny_per_order,
  perBoard: summary.components_cny_per_board,
})
check('CNY price tier labelled', summary.cny_price_tier === 'retail_1pc')

/* persist + result -------------------------------------------------------- */
const outputDir = path.join(here, 'test-output')
fs.mkdirSync(outputDir, { recursive: true })
const outputPath = path.join(outputDir, 'round2.json')
fs.writeFileSync(outputPath, JSON.stringify(results, null, 2))
service.cn?.dispose?.()
console.log(`\nfull JSON: ${outputPath}`)
console.log(failed === 0 ? '\nRESULT: OK' : `\nRESULT: ${failed} failure(s)`)
process.exit(failed === 0 ? 0 : 1)
