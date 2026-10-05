import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { safeReadManifest } from '@pluxel/rolldown/workspace/fs'

// The project CLI uses these boundaries for installed executable lookup.
const projectBoundaries = [
	'.git',
	'pnpm-workspace.yaml',
	'pnpm-lock.yaml',
	'package-lock.json',
	'yarn.lock',
	'bun.lock',
	'bun.lockb',
]

/** Ask the project CLI to validate setup before starting a real development host. */
export async function checkDevelopmentWorkspace(start: string): Promise<void> {
	let directory = resolve(start)
	let root: string | undefined
	let cliOwner: string | undefined
	let boundary: string | undefined
	for (;;) {
		const manifest = await safeReadManifest(directory)
		const configured =
			existsSync(resolve(directory, '.pluxel/development.json')) ||
			existsSync(resolve(directory, 'pluxel.sources.jsonc'))
		if (configured) root ??= directory
		const declaresCli =
			Object.hasOwn(manifest?.dependencies ?? {}, '@pluxel/cli') ||
			Object.hasOwn(manifest?.devDependencies ?? {}, '@pluxel/cli')
		if (declaresCli) cliOwner ??= directory
		if (projectBoundaries.some((marker) => existsSync(resolve(directory, marker)))) {
			boundary = directory
			break
		}
		const parent = dirname(directory)
		if (parent === directory) break
		directory = parent
	}
	if (!root && !cliOwner) return
	// A CLI dependency selects an executable; only a configured root or project boundary
	// selects doctor inputs. A standalone declaration still requires its own valid setup.
	root ??= boundary ?? cliOwner!
	const owner = cliOwner ?? root
	let cli: string | undefined
	for (let installed = owner; ; installed = dirname(installed)) {
		const candidate = resolve(installed, 'node_modules/@pluxel/cli/package.json')
		if (existsSync(candidate)) {
			cli = candidate
			break
		}
		if (installed === (boundary ?? owner)) break
	}
	if (!cli)
		throw new Error(
			`Pluxel development setup missing at ${root}. Git users: run the upstream CLI's source install --root ${root}; npm users: install dependencies then run pluxel workspace setup.`,
		)
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
}
