import { ResolverFactory } from 'oxc-resolver'
import { resolve } from 'pathe'

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
	if (!result.path) return null
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
	const packageJson = resolveWithOxc(root, `${packageName}/package.json`, options)
	if (packageJson?.path) return packageJson.path

	const entry = resolveWithOxc(root, packageName, options)
	return entry?.packageJsonPath ?? null
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
