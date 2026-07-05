import { access, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'pathe'
import type { WorkspacePackageJson } from '../workspace/package-json'

const PACKAGE_FIELD_ORDER = [
	'$schema',
	'name',
	'version',
	'private',
	'description',
	'keywords',
	'homepage',
	'bugs',
	'repository',
	'funding',
	'license',
	'author',
	'sideEffects',
	'type',
	'imports',
	'exports',
	'main',
	'module',
	'browser',
	'types',
	'typesVersions',
	'typings',
	'bin',
	'man',
	'files',
	'workspaces',
	'scripts',
	'resolutions',
	'overrides',
	'dependencies',
	'devDependencies',
	'dependenciesMeta',
	'peerDependencies',
	'peerDependenciesMeta',
	'optionalDependencies',
	'bundledDependencies',
	'bundleDependencies',
	'packageManager',
	'engines',
	'publishConfig',
] as const

const SORTED_OBJECT_FIELDS = new Set([
	'dependencies',
	'devDependencies',
	'optionalDependencies',
	'peerDependencies',
	'scripts',
])

export async function resolvePackageJsonPath(start: string): Promise<string> {
	let current = resolve(start)
	while (true) {
		const candidate = resolve(current, 'package.json')
		if (await fileExists(candidate)) return candidate
		const parent = dirname(current)
		if (parent === current) break
		current = parent
	}
	throw new Error(`Unable to find package.json from ${start}`)
}

export async function readWorkspacePackageJson(path: string): Promise<WorkspacePackageJson> {
	return JSON.parse(await readFile(path, 'utf8')) as WorkspacePackageJson
}

export async function writeWorkspacePackageJson(
	path: string,
	pkg: WorkspacePackageJson,
): Promise<void> {
	await writeFile(path, `${JSON.stringify(sortPackageJson(pkg), null, '\t')}\n`)
}

export function sortPackageJson(pkg: WorkspacePackageJson): WorkspacePackageJson {
	const sorted: WorkspacePackageJson = {}
	const originalKeys = Object.keys(pkg)
	const knownKeysPresent = PACKAGE_FIELD_ORDER.filter((key) => Object.hasOwn(pkg, key)) as string[]

	for (const key of originalKeys) {
		const currentIndex = knownKeysPresent.indexOf(key)
		if (currentIndex === -1) {
			sorted[key] = pkg[key]
			continue
		}
		for (let i = 0; i <= currentIndex; i++) {
			const knownKey = knownKeysPresent[i]
			if (knownKey && !Object.hasOwn(sorted, knownKey)) sorted[knownKey] = pkg[knownKey]
		}
	}

	for (const key of SORTED_OBJECT_FIELDS) {
		const value = sorted[key]
		if (isPlainObject(value)) sorted[key] = sortObject(value)
	}
	return sorted
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sortObject(value: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
}
