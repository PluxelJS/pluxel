import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { satisfies } from 'semver'

const hostDirectory = dirname(fileURLToPath(import.meta.url))
const requiredPackages = ['@pluxel/core', '@pluxel/host'] as const

/** @internal Fixed shared selection; only package names, never aliases or internal chunks. */
export function hostSharedPackages(options: {
	root: string
	packages?: readonly string[]
}): ReadonlyMap<string, string> {
	if (!isAbsolute(options.root)) throw new TypeError('[host] shared package root must be absolute')
	if (options.packages !== undefined && !Array.isArray(options.packages))
		throw new TypeError('[host] sharedPackages must be an array')
	const packages = new Map<string, string>(requiredPackages.map((name) => [name, hostDirectory]))
	for (const name of options.packages ?? []) {
		if (
			typeof name !== 'string' ||
			!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)
		)
			throw new TypeError(`[host] sharedPackages requires package names: ${String(name)}`)
		if (!packages.has(name)) packages.set(name, options.root)
	}
	return packages
}

export function importPackageName(specifier: string): string {
	return specifier.startsWith('@')
		? specifier.split('/').slice(0, 2).join('/')
		: specifier.split('/')[0]!
}

/** Node's own exports resolver, forced to ESM conditions, also supports import-only entries. */
export function resolveNativeImport(root: string, specifier: string): string {
	const parentURL = pathToFileURL(join(root, '__pluxel_resolve__.mjs')).href
	const hook = registerHooks({
		resolve(source, context, next) {
			return source === specifier && context.parentURL === parentURL
				? next(source, { ...context, conditions: ['node', 'import', 'default'] })
				: next(source, context)
		},
	})
	try {
		return realpathSync(createRequire(parentURL).resolve(specifier))
	} finally {
		hook.deregister()
	}
}

type InstalledPackageManifest = Readonly<{
	name?: unknown
	version?: unknown
	peerDependencies?: Readonly<Record<string, unknown>>
	dependencies?: Readonly<Record<string, unknown>>
	optionalDependencies?: Readonly<Record<string, unknown>>
	pluxel?: Readonly<{
		artifactRoot?: unknown
		nodeArtifacts?: unknown
		workbenchArtifacts?: unknown
		workbenchCapnweb?: unknown
		modules?: Readonly<{ version?: unknown }>
	}>
}>
export type InstalledPackageFacts = Readonly<{
	root: string
	name?: string
	version?: string
	manifest: InstalledPackageManifest
}>

/** Read actual physical package ownership. Inventory presence never establishes Plugin identity. */
export function installedPackageFacts(file: string): InstalledPackageFacts | undefined {
	let directory = dirname(realpathSync(file))
	for (;;) {
		const path = join(directory, 'package.json')
		if (existsSync(path)) {
			const manifest = JSON.parse(readFileSync(path, 'utf8')) as InstalledPackageManifest
			if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
				throw new TypeError(`[host] invalid package manifest: ${path}`)
			for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
				const ranges = manifest[field]
				if (
					ranges !== undefined &&
					(!ranges ||
						typeof ranges !== 'object' ||
						Array.isArray(ranges) ||
						Object.values(ranges).some((value) => typeof value !== 'string' || !value.trim()))
				)
					throw new TypeError(
						`[host] invalid package manifest: ${path}; ${field} must map package names to non-empty ranges`,
					)
			}
			return Object.freeze({
				root: directory,
				name: typeof manifest.name === 'string' ? manifest.name : undefined,
				version: typeof manifest.version === 'string' ? manifest.version : undefined,
				manifest,
			})
		}
		const parent = dirname(directory)
		if (parent === directory) return undefined
		directory = parent
	}
}

/** Check installed bytes and the importing package's declared requirement before binding identity. */
export function assertSharedPackageVersion(options: {
	specifier: string
	importer?: string
	actual: string
	canonical: string
}): void {
	const name = importPackageName(options.specifier)
	const actual = installedPackageFacts(options.actual)
	const canonical = installedPackageFacts(options.canonical)
	const importer = options.importer ? installedPackageFacts(options.importer) : undefined
	const range =
		importer?.manifest.peerDependencies?.[name] ??
		importer?.manifest.optionalDependencies?.[name] ??
		importer?.manifest.dependencies?.[name]
	if (
		!actual?.version ||
		!canonical?.version ||
		actual.name !== name ||
		canonical.name !== name ||
		(range !== undefined && typeof range !== 'string') ||
		!satisfies(actual.version, `^${canonical.version}`, { includePrerelease: true }) ||
		(typeof range === 'string' &&
			!range.startsWith('workspace:') &&
			!range.startsWith('catalog:') &&
			!satisfies(canonical.version, range, { includePrerelease: true }))
	) {
		throw Object.assign(
			new Error(
				`[host] shared package admission failed: ${options.specifier} imported by ${importer?.name ?? options.importer ?? '<entry>'}; installed ${actual?.version ?? '<missing>'}, Host ${canonical?.version ?? '<missing>'}, requirement ${range ?? '<absent>'}. Correct the installation before starting.`,
			),
			{ code: 'PLUGIN_SHARED_PACKAGE_MISMATCH' },
		)
	}
}
