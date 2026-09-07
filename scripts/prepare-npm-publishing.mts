import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'
import { parse } from 'yaml'
import { isPublishablePackage, repositoryPackages, repositoryRoot } from './repository-packages.mjs'

const repository = 'PluxelJS/pluxel'
const workflow = 'release.yml'

export function parseTrustOutput(output: string): Record<string, unknown>[] {
	const result: Record<string, unknown>[] = []
	let start = -1
	let depth = 0
	let quoted = false
	let escaped = false
	for (let index = 0; index < output.length; index++) {
		const char = output[index]
		if (start < 0) {
			if (/\s/.test(char)) continue
			if (char !== '{') throw new Error('Unexpected npm trust JSON output.')
			start = index
		}
		if (quoted) {
			if (escaped) escaped = false
			else if (char === '\\') escaped = true
			else if (char === '"') quoted = false
		} else if (char === '"') quoted = true
		else if (char === '{') depth++
		else if (char === '}' && --depth === 0) {
			result.push(JSON.parse(output.slice(start, index + 1)))
			start = -1
		}
	}
	if (start >= 0) throw new Error('Incomplete npm trust JSON output.')
	return result
}

export function matchesPublisher(config: Record<string, unknown>): boolean {
	return (
		config.type === 'github' &&
		config.repository === repository &&
		config.file === workflow &&
		(config.environment === undefined || config.environment === '') &&
		Array.isArray(config.permissions) &&
		config.permissions.includes('createPackage')
	)
}

export function validatePublishLock(lock: unknown, names: string[]): void {
	const entries = (lock as Record<string, unknown> | null)?.['npm:packages']
	if (!Array.isArray(entries)) throw new Error('A complete Tegami publish lock is required.')
	const ids = entries.map((entry) => entry?.id)
	if (
		ids.length !== names.length ||
		new Set(ids).size !== ids.length ||
		names.some((name) => !ids.includes(`npm:${name}`))
	)
		throw new Error('Publish lock must contain every public repository package exactly once.')
}

function run(command: string, args: string[], capture = false): string {
	const child = spawnSync(command, args, {
		cwd: repositoryRoot,
		encoding: 'utf8',
		stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
	})
	if (child.error) throw child.error
	if (child.status !== 0)
		throw new Error(`${command} ${args.join(' ')} failed (${child.signal ?? child.status}).`)
	return child.stdout ?? ''
}

export async function preparePublishing(
	apply: boolean,
	names: string[],
	lock: unknown,
	dependencies = { run, wait: (ms: number) => setTimeout(ms), log: console.log },
): Promise<void> {
	validatePublishLock(lock, names)
	const { run: execute, wait, log } = dependencies
	const version = execute('npm', ['--version'], true).trim()
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
	if (!match || Number(match[1]) < 11 || (Number(match[1]) === 11 && Number(match[2]) < 15)) {
		throw new Error('npm >= 11.15.0 is required; run through mise exec.')
	}
	if (apply) execute('npm', ['whoami'])
	log(
		`${apply ? 'Preparing' : 'Dry run:'} ${names.length} public packages for ${repository}/${workflow}.`,
	)
	// Tegami owns placeholder publication and publish-lock updates. If it fails after
	// publishing a placeholder, the next run skips that package and repairs its trust below.
	execute('pnpm', ['tegami', 'npm', 'pretrust', ...(apply ? [] : ['--dry-run'])])
	if (!apply) {
		log(
			'Apply will inspect all package trusts and add only missing publish permissions. Run with --apply after npm login.',
		)
		return
	}
	for (const name of names) {
		const configs = parseTrustOutput(execute('npm', ['trust', 'list', name, '--json'], true))
		if (configs.some(matchesPublisher)) log(`${name}: trusted publisher already configured.`)
		else {
			execute('npm', [
				'trust',
				'github',
				name,
				'--repo',
				repository,
				'--file',
				workflow,
				'--allow-publish',
				'--yes',
			])
			const verified = parseTrustOutput(execute('npm', ['trust', 'list', name, '--json'], true))
			if (!verified.some(matchesPublisher))
				throw new Error(`${name}: publisher configuration was not confirmed.`)
		}
		await wait(2000)
	}
	log(
		'All public packages trust the release workflow. Review and commit Tegami publish-lock changes on the release preparation branch.',
	)
}

if (import.meta.main) {
	try {
		const args = process.argv.slice(2)
		if (
			args.length > 1 ||
			(args.length === 1 && args[0] !== '--apply' && args[0] !== '--dry-run')
		) {
			throw new Error(
				'Usage: mise exec -- node scripts/prepare-npm-publishing.mts [--dry-run | --apply]',
			)
		}
		const names = repositoryPackages
			.filter(isPublishablePackage)
			.map(({ manifest }) => manifest.name)
		const lock = parse(await readFile(`${repositoryRoot}/.tegami/publish-lock.yaml`, 'utf8'))
		await preparePublishing(args[0] === '--apply', names, lock)
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error))
		process.exitCode = 1
	}
}
