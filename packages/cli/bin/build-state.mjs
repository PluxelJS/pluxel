import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

// Content-based so moving a checkout or restoring a Turbo artifact does not stale the build.
export function cliSourceFingerprint(packageRoot) {
	const hash = createHash('sha256')
	const add = (path) => {
		hash
			.update(path)
			.update('\0')
			.update(readFileSync(resolve(packageRoot, path)))
			.update('\0')
	}
	const walk = (directory) => {
		for (const entry of readdirSync(resolve(packageRoot, directory), { withFileTypes: true }).sort(
			(a, b) => a.name.localeCompare(b.name),
		)) {
			const path = `${directory}/${entry.name}`
			if (entry.isDirectory()) walk(path)
			else if (entry.isFile()) add(path)
		}
	}
	for (const directory of ['src', 'bin', 'scripts', '../../vendor/pncat/src']) walk(directory)
	for (const path of [
		'../../pnpm-workspace.yaml',
		'../../vendor/pncat/package.json',
		'../../tsconfig.cli-build.json',
	])
		add(path)
	for (const path of ['package.json', 'tsdown.config.ts', 'tsconfig.json']) add(path)
	return hash.digest('hex')
}
