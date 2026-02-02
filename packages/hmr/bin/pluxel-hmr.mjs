#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distCli = resolve(__dirname, '../dist/cli.mjs')
const srcCli = resolve(__dirname, '../src/cli.ts')
const forceSource = process.env.PLUXEL_HMR_CLI_SOURCE === '1' || process.env.PLUXEL_HMR_CLI_SOURCE === 'true'

if (forceSource) {
	const args = ['--conditions=@pluxel/source', srcCli, ...process.argv.slice(2)]
	const res = spawnSync('bun', args, { stdio: 'inherit' })
	if (res.error) {
		console.error('[pluxel-hmr] PLUXEL_HMR_CLI_SOURCE=1 but bun fallback failed.')
		console.error('Install bun, or unset PLUXEL_HMR_CLI_SOURCE and run `pnpm --filter @pluxel/hmr build`.')
		process.exit(1)
	}
	process.exit(res.status ?? 1)
}

if (existsSync(distCli)) {
	await import(pathToFileURL(distCli).href)
} else {
	const args = ['--conditions=@pluxel/source', srcCli, ...process.argv.slice(2)]
	const res = spawnSync('bun', args, { stdio: 'inherit' })
	if (res.error) {
		console.error('[pluxel-hmr] CLI build missing and bun fallback failed.')
		console.error('Run `pnpm --filter @pluxel/hmr build` first, or install bun.')
		process.exit(1)
	}
	process.exit(res.status ?? 1)
}
