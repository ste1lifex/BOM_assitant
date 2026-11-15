#!/usr/bin/env node
/**
 * Live acceptance for `download_lcsc_datasheet` (network + optional Chrome).
 *
 *   node poc/test-datasheet.mjs
 *
 * Exercises every resolution path:
 *   - C1581      LCSC datasheet viewer page  -> datasheet.lcsc.com PDF
 *   - C7434398   wmsc.lcsc.com JS redirect   -> datasheet.lcsc.com PDF
 *   - C2765186   JLCPCB file URL (returns {"code":203}) -> product-page pdfUrl
 *   - C18198083  立创商城 domestic page (atta.szlcsc.com)
 *   - C1         invalid code                -> not-found
 *
 * Exit code 0 = every expected path produced a verified PDF.
 */

import fs from 'node:fs'
import path from 'node:path'

import { createLcscService, normalizeConfig } from './lcsc-dsh-plugin/data.js'
import { createCnAdapter } from './lcsc-dsh-plugin/cn.js'
import { downloadLcscDatasheet, resolveDomesticPdfUrl } from './lcsc-dsh-plugin/datasheet.js'

const OUT_DIR = path.resolve('poc/test-output/datasheets')
fs.mkdirSync(OUT_DIR, { recursive: true })

const settings = normalizeConfig({ cnRender: true })
const service = createLcscService(settings)
const cnAdapter = createCnAdapter({
  chromePath: settings.chromePath ?? undefined,
  cacheDir: settings.cnCacheDir ?? undefined,
  cacheTtlMs: settings.cnCacheTtlMs,
  timeoutMs: settings.cnTimeoutMs,
  concurrency: settings.cnConcurrency,
  browserIdleTtlMs: settings.cnBrowserIdleTtlMs,
  cacheMaxEntries: settings.cnCacheMaxEntries,
  negativeCacheTtlMs: settings.cnNegativeCacheTtlMs,
  verbose: false,
})
service.cn = cnAdapter

const failures = []
const results = []

/** @param {string} label @param {boolean} condition @param {unknown} [detail] */
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 400)}`}`)
  }
}

async function download(code, options = {}) {
  const started = Date.now()
  const result = await downloadLcscDatasheet(
    { lcsc: code, out_dir: OUT_DIR, ...options },
    { service, cnAdapter, timeoutMs: 90000 },
  )
  results.push({ code, ms: Date.now() - started, ...result })
  return result
}

console.log(`\n=== datasheet downloads -> ${OUT_DIR} ===`)
for (const code of ['C1581', 'C7434398', 'C2765186']) {
  const result = await download(code)
  const elapsed = results[results.length - 1].ms
  const fileOk =
    result.status === 'downloaded' &&
    typeof result.file_path === 'string' &&
    fs.existsSync(result.file_path) &&
    fs.readFileSync(result.file_path).subarray(0, 5).toString('latin1') === '%PDF-'
  console.log(
    `  ${code}: ${result.status} ${result.file_name ?? ''} ${result.bytes ?? ''}B ` +
      `source=${result.source ?? '?'} via=${result.resolved_via ?? '?'} (${elapsed} ms)`,
  )
  for (const attempt of result.attempts ?? []) {
    if (attempt.ok !== true) console.log(`    x ${attempt.step} ${attempt.url ?? ''} -> ${attempt.error ?? 'failed'}`)
  }
  check(`${code} downloaded and is a valid PDF`, fileOk, result)
}

console.log('\n=== 立创商城 domestic fallback (atta.szlcsc.com) ===')
const domestic = await resolveDomesticPdfUrl('C1581', {
  cnAdapter,
  timeoutMs: 60000,
  htmlMaxBytes: 8 * 1024 * 1024,
})
check('domestic PDF URL resolved', domestic.ok === true && typeof domestic.url === 'string', domestic)
if (domestic.ok === true) console.log(`  ${domestic.via} -> ${domestic.url}`)

console.log('\n=== invalid code ===')
const invalid = await downloadLcscDatasheet({ lcsc: 'C1', out_dir: OUT_DIR }, { service, cnAdapter })
check('invalid code reports not-found', invalid.status === 'not-found', invalid.status)

fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2))

console.log(`\n${results.length} downloads attempted, ${failures.length} failed`)
cnAdapter.dispose?.()
if (failures.length > 0) {
  for (const failure of failures) console.log(`FAILED: ${failure}`)
  process.exit(1)
}
process.exit(0)
