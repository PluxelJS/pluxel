#!/usr/bin/env node
// Published Pluxel bundles pncat/sync and does not need this source loader.
import { tsImport } from 'tsx/esm/api'

if (process.argv[2] === 'sync') {
  const args = process.argv.slice(3)
  if (args.some(arg => arg !== '--check')) throw new Error('Usage: pncat sync [--check]')
  const { planCatalogSync, applyCatalogSync } = await tsImport('../src/sync.ts', import.meta.url)
  const plan = await planCatalogSync({ root: process.cwd(), versions: {} })
  for (const change of plan.changes) console.log(`${change.file} ${change.field}.${change.name}: ${change.before ?? '(missing)'} -> ${change.after}`)
  if (plan.conflicts.length) throw new Error(plan.conflicts.join('\n'))
  if (args.includes('--check')) {
    if (plan.changes.length) {
      console.error('Catalog drift found; run pncat sync to apply these changes')
      process.exitCode = 1
    }
  } else {
    await applyCatalogSync(plan)
  }
} else {
  const { runCli } = await tsImport('../src/cli.ts', import.meta.url)
  await runCli()
}
