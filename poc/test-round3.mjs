#!/usr/bin/env node
/**
 * Live acceptance test for round-3: USD/CNY separation + 嘉立创国内 SMT CNY.
 *
 *   node poc/test-round3.mjs
 *
 * Verifies:
 *   - cny_jlc_cn requires explicit smt_service_type (economic / standard);
 *   - economic vs standard fee rules differ (工程费/钢网/上料) and never mix;
 *   - CNY SMT totals are in CNY only (USD lives in its own totals block);
 *   - include_usd=false produces CNY-only output (no $ columns/totals);
 *   - CNY retail (立创商城) and CNY SMT (嘉立创国内 SMT) are distinct totals.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createLcscService } from './lcsc-dsh-plugin/data.js'
import { createCnAdapter } from './lcsc-dsh-plugin/cn.js'
import { auditBom, renderAuditText } from './lcsc-dsh-plugin/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const bom = fs.readFileSync('/Users/apple/Developer/Recording_card/data/bom_v0.6.csv', 'utf8')
const service = createLcscService({ timeoutMs: 8000, retries: 2 })
service.cn = createCnAdapter({})

const results = { checks: [], data: {} }
let failed = 0
function check(label, condition, detail) {
  const ok = condition === true
  if (!ok) failed += 1
  results.checks.push({ label, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` :: ${JSON.stringify(detail).slice(0, 500)}`}`)
}
function section(title) { console.log(`\n=== ${title} ===`) }

const baseArgs = { bom, assembly: 'smt', boards: 100, include_cny: true, suggest_alternatives: false }
const economic = await auditBom(service, { ...baseArgs, smt_cost_basis: 'cny_jlc_cn', smt_service_type: 'economic' })
const standard = await auditBom(service, { ...baseArgs, smt_cost_basis: 'cny_jlc_cn', smt_service_type: 'standard' })
results.data.economic = economic
results.data.standard = standard

section('explicit economic vs standard')
console.log(`  economic: ¥${economic.cn_smt?.total_cny}/单 = ¥${economic.cn_smt?.per_board_cny}/片`)
console.log(`  standard: ¥${standard.cn_smt?.total_cny}/单 = ¥${standard.cn_smt?.per_board_cny}/片`)
check('economic is labelled economic', economic.smt_service_type === 'economic' && economic.cn_smt?.service_type === 'economic')
check('standard is labelled standard', standard.smt_service_type === 'standard' && standard.cn_smt?.service_type === 'standard')
check('totals differ (never interchangeable)', economic.cn_smt?.total_cny !== standard.cn_smt?.total_cny, {
  economic: economic.cn_smt?.total_cny, standard: standard.cn_smt?.total_cny,
})
check('economic engineering fee = ¥50', economic.cn_smt?.engineering_fee_cny === 50, economic.cn_smt?.engineering_fee_cny)
check('standard engineering fee = ¥150', standard.cn_smt?.engineering_fee_cny === 150, standard.cn_smt?.engineering_fee_cny)
check('economic stencil = ¥0', economic.cn_smt?.stencil_fee_cny === 0, economic.cn_smt?.stencil_fee_cny)
check('standard stencil = ¥50', standard.cn_smt?.stencil_fee_cny === 50, standard.cn_smt?.stencil_fee_cny)
check('economic feeder ¥20/part', economic.cn_smt?.extended_fee_per_part_cny === 20, economic.cn_smt?.extended_fee_per_part_cny)
check('standard feeder ¥8/part', standard.cn_smt?.extended_fee_per_part_cny === 8, standard.cn_smt?.extended_fee_per_part_cny)
check('feeder total matches parts count', economic.cn_smt?.extended_fee_cny === economic.cn_smt?.extended_parts * 20 &&
  standard.cn_smt?.extended_fee_cny === standard.cn_smt?.extended_parts * 8)
check('joint fee estimated and labelled', economic.cn_smt?.joint_count_estimated === true, economic.cn_smt?.joint_count)
check('CNY components > 0', (economic.cn_smt?.components_cny ?? 0) > 0, economic.cn_smt?.components_cny)
check('CNY retail total is separate', economic.totals?.retail_total_cny !== economic.totals?.smt_total_cny)
check('CNY SMT total = component + fees', Math.abs(
  (economic.cn_smt?.components_cny ?? 0) + (economic.cn_smt?.extended_fee_cny ?? 0) +
  (economic.cn_smt?.engineering_fee_cny ?? 0) + (economic.cn_smt?.stencil_fee_cny ?? 0) +
  (economic.cn_smt?.joint_fee_cny ?? 0) - (economic.cn_smt?.total_cny ?? 0),
) < 0.01)

section('refuses silent defaults')
const missing = await auditBom(service, { ...baseArgs, smt_cost_basis: 'cny_jlc_cn' })
results.data.missing = missing
check('missing service type refused', missing.cn_smt === undefined && (missing.errors ?? []).some((error) => /smt_service_type/.test(error)), missing.errors)
const twoSides = await auditBom(service, { ...baseArgs, smt_cost_basis: 'cny_jlc_cn', smt_service_type: 'economic', smt_sides: 2 })
check('economic + 2 sides refused', twoSides.cn_smt === undefined && (twoSides.errors ?? []).some((error) => /单面/.test(error)), twoSides.errors)

section('USD / CNY separation')
const cnyOnly = await auditBom(service, { ...baseArgs, include_usd: false, smt_cost_basis: 'cny_jlc_cn', smt_service_type: 'standard' })
results.data.cnyOnly = cnyOnly
const text = renderAuditText(cnyOnly)
console.log(`  CNY-only currency=${cnyOnly.currency}; render has $: ${text.includes('$')}`)
check('CNY-only has no USD row fields', cnyOnly.rows.every((row) => row.unit_usd === undefined && row.subtotal_usd === undefined))
check('CNY-only has no USD totals', cnyOnly.summary.total_usd === undefined && cnyOnly.summary.components_usd === undefined)
check('CNY-only render has no $', !text.includes('$'))
check('USD (when included) is a separate block', economic.totals.smt_total_usd > 0 && economic.totals.smt_total_cny > 0 && economic.currency.includes('USD') && economic.currency.includes('CNY'))

const outputDir = path.join(here, 'test-output')
fs.mkdirSync(outputDir, { recursive: true })
fs.writeFileSync(path.join(outputDir, 'round3.json'), JSON.stringify(results, null, 2))
service.cn?.dispose?.()
console.log(failed === 0 ? '\nRESULT: OK' : `\nRESULT: ${failed} failure(s)`)
process.exit(failed === 0 ? 0 : 1)
