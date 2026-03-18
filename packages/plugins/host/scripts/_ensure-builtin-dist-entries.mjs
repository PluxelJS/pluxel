import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

import { resolve } from 'pathe'

import { repoRoot } from './_runtime-dist.mjs'

const builtinPackages = ['@pluxel/snapshot', 'pluxel-plugin-market-ui']

async function loadManifest(packageName) {
	const candidates = [
		resolve(repoRoot, 'packages/plugins/snapshot/package.json'),
		resolve(repoRoot, 'packages/plugins/market/package.json'),
	]

	for (const path of candidates) {
		const raw = await readFile(path, 'utf8')
		const json = JSON.parse(raw)
		if (json.name === packageName) {
			return { path, json }
		}
	}

	throw new Error(`builtin package manifest not found: ${packageName}`)
}

function resolveDistEntry(manifest) {
	const dot = manifest?.exports?.['.']
	if (typeof dot === 'string' && dot.endsWith('.mjs')) return dot
	if (!dot || typeof dot !== 'object') return null
	for (const key of ['import', 'default', 'module']) {
		const value = dot[key]
		if (typeof value === 'string' && value.endsWith('.mjs')) return value
	}
	return null
}

const missing = []

for (const packageName of builtinPackages) {
	const { path, json } = await loadManifest(packageName)
	const rel = resolveDistEntry(json)
	if (!rel) throw new Error(`builtin package missing .mjs dist export: ${packageName}`)
	const entry = resolve(path, '..', rel)
	if (!existsSync(entry)) missing.push(packageName)
}

if (!missing.length) process.exit(0)

for (const packageName of missing) {
	const res = spawnSync('pnpm', ['--filter', packageName, 'build:lib'], {
		cwd: repoRoot,
		stdio: 'inherit',
	})
	if (res.status !== 0) process.exit(res.status ?? 1)
}
