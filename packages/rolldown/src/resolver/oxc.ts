import { lstatSync, readFileSync } from 'node:fs'
import { ResolverFactory } from 'oxc-resolver'
import { dirname, resolve } from 'pathe'

export interface OxcToolchainResolveOptions {
	conditionNames?: readonly string[]
	mainFields?: readonly string[] | string
	extensions?: readonly string[]
	tsconfig?: 'auto' | false | { configFile: string; references?: 'auto' }
	preserveSymlinks?: boolean
	aliasFields?: readonly (string | string[])[]
	exportsFields?: readonly (string | string[])[]
	importsFields?: readonly (string | string[])[]
}

export interface OxcResolveHit {
	path: string
	packageJsonPath?: string
	moduleType?: string
}

type OxcResolveResult = {
	path?: string
	error?: string
	packageJsonPath?: string
	moduleType?: string
}

type OxcResolveOptions = {
	tsconfig?: 'auto' | { configFile: string; references?: 'auto' }
	conditionNames?: string[]
	mainFields?: string | string[]
	extensions?: string[]
	symlinks?: boolean
	aliasFields?: (string | string[])[]
	exportsFields?: (string | string[])[]
	importsFields?: (string | string[])[]
	moduleType?: boolean
}

type OxcResolverFactory = {
	sync(directory: string, request: string): OxcResolveResult
}

const DEFAULT_CONDITIONS = ['import', 'module', 'browser', 'default'] as const
const DEFAULT_EXTENSIONS = [
	'.tsx',
	'.ts',
	'.jsx',
	'.js',
	'.mts',
	'.mjs',
	'.cts',
	'.cjs',
	'.json',
] as const

const resolverCache = new Map<string, OxcResolverFactory>()

/** Discard cached package metadata and resolutions after a producer republishes installed packages. */
export function clearOxcResolutionCache(): void {
	resolverCache.clear()
}

export function resolveWithOxc(
	directory: string,
	request: string,
	options: OxcToolchainResolveOptions = {},
): OxcResolveHit | null {
	const importer = resolve(directory)
	const resolver = getOxcResolver(options, importer, request)
	let result: OxcResolveResult
	try {
		result = resolver.sync(importer, request)
	} catch (cause) {
		throw new Error(
			`OXC resolution failed for ${JSON.stringify(request)} from ${importer} with conditions ${JSON.stringify(options.conditionNames ?? DEFAULT_CONDITIONS)}`,
			{ cause },
		)
	}
	if (!result.path) {
		if (result.error) {
			if (request.startsWith('.') || request.startsWith('#')) {
				const ownerManifest = findValidNearestPackageManifest(importer, request)
				if (request.startsWith('#')) {
					throw new Error(
						`OXC could not resolve package import ${JSON.stringify(request)} from ${importer} with conditions ${JSON.stringify(options.conditionNames ?? DEFAULT_CONDITIONS)}; owner manifest: ${ownerManifest?.path ?? '(none)'}`,
						{ cause: new Error(result.error) },
					)
				}
			}
			const installedPackage = findInstalledPackageRoot(importer, request)
			const packageName = getRequestedPackageName(request)
			if (installedPackage) {
				const manifestPath = resolve(installedPackage, 'package.json')
				validatePackageManifest(manifestPath, importer, request)
				throw new Error(
					`OXC could not resolve ${JSON.stringify(request)} from ${importer} with conditions ${JSON.stringify(options.conditionNames ?? DEFAULT_CONDITIONS)}; package directory found at ${installedPackage}; inspect ${manifestPath} and installed files`,
					{ cause: new Error(result.error) },
				)
			}
			if (packageName) {
				const ownerManifest = findValidNearestPackageManifest(importer, request)
				if (ownerManifest?.value.name === packageName) {
					throw new Error(
						`OXC could not resolve self-reference ${JSON.stringify(request)} from ${importer} with conditions ${JSON.stringify(options.conditionNames ?? DEFAULT_CONDITIONS)}; inspect owner manifest ${ownerManifest.path}`,
						{ cause: new Error(result.error) },
					)
				}
			}
		}
		return null
	}
	return {
		path: result.path,
		packageJsonPath: result.packageJsonPath,
		moduleType: result.moduleType,
	}
}

export function resolvePackageJsonPathWithOxc(
	root: string,
	packageName: string,
	options: OxcToolchainResolveOptions = {},
): string | null {
	const entry = resolveWithOxc(root, packageName, options)
	if (entry?.packageJsonPath) return entry.packageJsonPath
	const packageJson = resolveWithOxc(root, `${packageName}/package.json`, options)
	return packageJson?.path ?? null
}

function findValidNearestPackageManifest(
	importer: string,
	request: string,
): { path: string; value: Record<string, unknown> } | null {
	let current = importer
	for (;;) {
		const manifestPath = resolve(current, 'package.json')
		const value = validatePackageManifest(manifestPath, importer, request)
		if (!value) {
			const parent = dirname(current)
			if (parent === current) return null
			current = parent
			continue
		}
		return { path: manifestPath, value }
	}
}

function validatePackageManifest(
	manifestPath: string,
	importer: string,
	request: string,
): Record<string, unknown> | null {
	let contents: string
	try {
		contents = readFileSync(manifestPath, 'utf8')
	} catch (cause) {
		if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') {
			// A dangling package.json symlink is a broken manifest, not an absent one.
			try {
				lstatSync(manifestPath)
			} catch (statCause) {
				if (statCause instanceof Error && 'code' in statCause && statCause.code === 'ENOENT')
					return null
			}
		}
		throw new Error(
			`Cannot read package manifest ${manifestPath} while resolving ${JSON.stringify(request)} from ${importer}`,
			{ cause },
		)
	}
	let value: unknown
	try {
		value = JSON.parse(contents)
		if (!value || typeof value !== 'object' || Array.isArray(value))
			throw new Error('Expected a JSON object')
	} catch (cause) {
		throw new Error(
			`Invalid package manifest ${manifestPath} while resolving ${JSON.stringify(request)} from ${importer}`,
			{ cause },
		)
	}
	return value as Record<string, unknown>
}

function getRequestedPackageName(request: string): string | null {
	const segments = request.split('/')
	const packageName = request.startsWith('@')
		? segments.length >= 2 && segments[1]
			? `${segments[0]}/${segments[1]}`
			: null
		: segments[0]
	if (!packageName || !/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(packageName))
		return null
	return packageName
}

/** OXC exposes one string error for misses and malformed installed packages. A physical
 * package directory proves this is an installed-package failure, not an absent package. */
function findInstalledPackageRoot(importer: string, request: string): string | null {
	if (request.startsWith('.') || request.startsWith('/') || request.startsWith('#')) return null
	const packageName = getRequestedPackageName(request)
	if (!packageName) return null
	let current = importer
	for (;;) {
		const candidate = resolve(current, 'node_modules', packageName)
		try {
			lstatSync(candidate)
			return candidate
		} catch (cause) {
			if (
				!(
					cause instanceof Error &&
					'code' in cause &&
					(cause.code === 'ENOENT' || cause.code === 'ENOTDIR')
				)
			) {
				throw new Error(
					`Cannot inspect installed package ${candidate} while resolving ${JSON.stringify(request)} from ${importer}`,
					{ cause },
				)
			}
		}
		const parent = dirname(current)
		if (parent === current) return null
		current = parent
	}
}

function getOxcResolver(
	options: OxcToolchainResolveOptions,
	importer: string,
	request: string,
): OxcResolverFactory {
	const normalized = normalizeOxcOptions(options)
	const key = JSON.stringify(normalized)
	const cached = resolverCache.get(key)
	if (cached) return cached

	try {
		const resolver = new ResolverFactory(normalized)
		resolverCache.set(key, resolver)
		return resolver
	} catch (cause) {
		throw new Error(
			`Cannot initialize OXC resolver for ${JSON.stringify(request)} from ${importer} with conditions ${JSON.stringify(normalized.conditionNames)}`,
			{ cause },
		)
	}
}

function normalizeOxcOptions(options: OxcToolchainResolveOptions): OxcResolveOptions {
	const out: OxcResolveOptions = {
		conditionNames: [...(options.conditionNames ?? DEFAULT_CONDITIONS)],
		extensions: [...(options.extensions ?? DEFAULT_EXTENSIONS)],
		mainFields: options.mainFields
			? [...toArray(options.mainFields)]
			: ['browser', 'module', 'main'],
		symlinks: options.preserveSymlinks !== true,
		moduleType: true,
	}
	if (options.tsconfig !== false) {
		out.tsconfig = options.tsconfig ?? 'auto'
	}
	if (options.aliasFields) out.aliasFields = options.aliasFields.map((item) => toFieldPath(item))
	if (options.exportsFields)
		out.exportsFields = options.exportsFields.map((item) => toFieldPath(item))
	if (options.importsFields)
		out.importsFields = options.importsFields.map((item) => toFieldPath(item))
	return out
}

function toArray(value: readonly string[] | string): string[] {
	return typeof value === 'string' ? [value] : [...value]
}

function toFieldPath(value: string | string[]): string | string[] {
	return Array.isArray(value) ? [...value] : value
}
