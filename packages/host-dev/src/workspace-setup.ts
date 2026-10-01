import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

/** Ask the project CLI to validate setup before starting a real development host. */
export async function checkDevelopmentWorkspace(start: string): Promise<void> {
	let root = resolve(start)
	for (;;) {
		const manifestPath = resolve(root, 'package.json')
		const manifest = existsSync(manifestPath)
			? JSON.parse(readFileSync(manifestPath, 'utf8'))
			: undefined
		const configured =
			existsSync(resolve(root, '.pluxel/development.json')) ||
			existsSync(resolve(root, 'pluxel.sources.jsonc'))
		const declaresCli =
			manifest?.dependencies?.['@pluxel/cli'] || manifest?.devDependencies?.['@pluxel/cli']
		if (configured || declaresCli) {
			const require = createRequire(manifestPath)
			let cli: string
			try {
				cli = require.resolve('@pluxel/cli/package.json')
			} catch {
				throw new Error(
					`Pluxel development setup missing at ${root}. Git users: run the upstream CLI's source install --root ${root}; npm users: install dependencies then run pluxel workspace setup.`,
				)
			}
			const statePath = resolve(root, '.pluxel/development.json')
			const source = existsSync(statePath)
				? JSON.parse(readFileSync(statePath, 'utf8')).source
				: undefined
			const command =
				source?.kind === 'git' || existsSync(resolve(root, 'pluxel.sources.jsonc'))
					? 'source'
					: 'workspace'
			try {
				await promisify(execFile)(
					process.execPath,
					[resolve(dirname(cli), 'bin/pluxel.mjs'), command, 'doctor', '--root', root],
					{ cwd: root, timeout: 30000, maxBuffer: 1024 * 1024 },
				)
			} catch (error) {
				const failure = error as Error & { stdout?: string; stderr?: string }
				throw new Error(
					`Pluxel development setup check failed at ${root}:\n${failure.stdout ?? ''}${failure.stderr ?? failure.message}`,
					{ cause: error },
				)
			}
			return
		}
		if (existsSync(resolve(root, '.git')) || existsSync(resolve(root, 'pnpm-workspace.yaml')))
			return
		const parent = dirname(root)
		if (parent === root) return
		root = parent
	}
}
