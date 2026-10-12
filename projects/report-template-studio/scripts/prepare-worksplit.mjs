import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPnpm } from './run-pnpm.mjs'

// Keep the existing Pluxel workbench's checkout and dependencies untouched.
const revision = '7768656250cea1e6c32d04373e3eccd5ad49f4fa'
const destination = fileURLToPath(new URL('../vendor/', import.meta.url))
const checkout = mkdtempSync(resolve(tmpdir(), 'studio-worksplit-'))
const run = (command, args) =>
	command === 'pnpm'
		? runPnpm(args, { cwd: checkout, stdio: 'inherit' })
		: execFileSync(command, args, { cwd: checkout, stdio: 'inherit' })
try {
	run('git', ['init'])
	run('git', ['remote', 'add', 'origin', 'https://github.com/PluxelJS/split-like-vscode.git'])
	run('git', ['fetch', '--depth', '1', 'origin', revision])
	run('git', ['checkout', '--detach', 'FETCH_HEAD'])
	run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'])
	run('pnpm', ['--filter', '@worksplit/core', '--filter', '@worksplit/react', 'build'])
	// These unpublished same-version packages must share the consumer's explicit core.
	const manifestPath = resolve(checkout, 'packages/react/package.json')
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
	delete manifest.dependencies['@worksplit/core']
	manifest.peerDependencies['@worksplit/core'] = '0.1.0'
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
	mkdirSync(destination, { recursive: true })
	for (const name of ['core', 'react']) {
		run('pnpm', [
			'--filter',
			`@worksplit/${name}`,
			'pack',
			'--out',
			resolve(destination, `worksplit-${name}.tgz`),
		])
	}
} finally {
	rmSync(checkout, { recursive: true, force: true })
}
