import { readFile } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, extname, isAbsolute, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	getCachedResolver,
	getOxcResolveCache,
	resolveModulePath,
	type OxcResolver,
} from '@pluxel/runtime/internal'
import type { Plugin } from 'vite'

export type HostModuleDecision = Readonly<{
	packageName: string | null
	resolvedPath: string
	format: 'module' | 'commonjs'
	reason: 'native' | 'commonjs'
}>

export type HostModuleClassifier = Readonly<{
	classifySpecifier(specifier: string, importer?: string): Promise<HostModuleDecision | null>
	classifyFile(filePath: string): Promise<HostModuleDecision | null>
	clear(): void
}>

type PackageManifest = {
	name?: unknown
	type?: unknown
	module?: unknown
	esnext?: unknown
	exports?: unknown
	napi?: unknown
	binary?: unknown
	gypfile?: unknown
}

type PackageInfo = Readonly<{
	name: string | null
	root: string
	manifest: PackageManifest
}>

const DEFAULT_CACHE_LIMIT = 2_000
const VITE_FS_PREFIX = '/@fs/'

export function createHostModuleClassifier(options: {
	root: string
	cacheLimit?: number
}): HostModuleClassifier {
	const root = resolve(options.root)
	const cacheLimit = resolveCacheLimit(options.cacheLimit)
	const specifierCache = new Map<string, Promise<HostModuleDecision | null>>()
	const fileCache = new Map<string, Promise<HostModuleDecision | null>>()
	const packageCache = new Map<string, Promise<PackageInfo | null>>()
	const resolvers = new Set<OxcResolver>()

	const classifyFile = async (filePath: string): Promise<HostModuleDecision | null> => {
		const normalized = normalizeFilePath(root, filePath)
		if (!normalized) return null
		return await cached(fileCache, normalized, cacheLimit, async () => {
			const extension = extname(normalized).toLowerCase()
			const packageDirectory = dirname(normalized)
			const pkg = await cached(packageCache, packageDirectory, cacheLimit, () =>
				findPackageInfo(normalized),
			)
			const native =
				extension === '.node' ||
				Boolean(pkg?.manifest.napi) ||
				Boolean(pkg?.manifest.binary) ||
				pkg?.manifest.gypfile === true
			const explicitEsm =
				extension !== '.cjs' && extension !== '.cts' && isExplicitEsmFile(normalized, pkg)
			const commonjs =
				extension === '.cjs' ||
				extension === '.cts' ||
				(!explicitEsm &&
					((extension === '.js' && pkg?.manifest.type !== 'module') ||
						pkg?.manifest.type === 'commonjs' ||
						hasRequireOnlyRootExport(pkg?.manifest.exports)))
			if (!native && !commonjs) return null

			return {
				packageName: pkg?.name ?? null,
				resolvedPath: normalized,
				format: inferFormat(normalized, pkg?.manifest, native || commonjs),
				reason: native ? 'native' : 'commonjs',
			}
		})
	}

	return {
		async classifySpecifier(specifier, importer) {
			if (!isBarePackageSpecifier(specifier) || isBuiltin(specifier)) return null
			const base = resolveImporterBase(root, importer)
			const key = `${base}\u0000${specifier}`
			return await cached(specifierCache, key, cacheLimit, async () => {
				let resolvedPath: string | null = null
				try {
					const resolver = getCachedResolver(
						getOxcResolveCache(),
						'runtime-dev:host-module-classifier',
						[dirname(base)],
						{ limit: 32 },
					)
					resolvers.add(resolver)
					resolvedPath = resolveModulePath(resolver, specifier, {
						mode: 'distPreferEsm',
						conditions: ['node', 'import', 'require', 'default'],
					})
				} catch {}
				if (!resolvedPath) {
					try {
						resolvedPath = createRequire(base).resolve(specifier)
					} catch {
						return null
					}
				}
				return await classifyFile(resolvedPath)
			})
		},
		classifyFile,
		clear() {
			specifierCache.clear()
			fileCache.clear()
			packageCache.clear()
			for (const resolver of resolvers) resolver.clearCache()
			resolvers.clear()
		},
	}
}

/** Server-only adapter that applies the shared host-module policy before Vite transforms modules. */
export function createHostModuleVitePlugin(): Plugin {
	let classifier: HostModuleClassifier | null = null
	return {
		name: 'pluxel:host-modules',
		enforce: 'pre',
		applyToEnvironment(environment) {
			return environment.name === 'ssr' || environment.config.consumer === 'server'
		},
		configResolved(config) {
			classifier = createHostModuleClassifier({ root: config.root })
		},
		resolveId(source, importer, options) {
			if (!options?.ssr || !classifier || !isBarePackageSpecifier(source) || isBuiltin(source))
				return null
			return classifier
				.classifySpecifier(source, importer)
				.then((decision) => (decision ? { id: decision.resolvedPath, external: true } : null))
		},
	}
}

function resolveImporterBase(root: string, importer?: string): string {
	const normalized = importer ? normalizeFilePath(root, importer) : null
	return normalized ?? resolve(root, 'package.json')
}

function normalizeFilePath(root: string, value: string): string | null {
	const clean = value.split(/[?#]/, 1)[0] ?? value
	if (clean.startsWith('file://')) {
		try {
			return fileURLToPath(clean)
		} catch {
			return null
		}
	}
	if (clean.startsWith(VITE_FS_PREFIX)) return clean.slice(VITE_FS_PREFIX.length - 1)
	if (isAbsolute(clean)) return clean
	if (clean.startsWith('/')) return resolve(root, clean.slice(1))
	return null
}

async function findPackageInfo(filePath: string): Promise<PackageInfo | null> {
	let current = dirname(filePath)
	const filesystemRoot = parse(current).root
	while (current !== filesystemRoot) {
		try {
			const manifest = JSON.parse(await readFile(resolve(current, 'package.json'), 'utf8'))
			return {
				name: typeof manifest?.name === 'string' ? manifest.name : null,
				root: current,
				manifest,
			}
		} catch {}
		const parent = dirname(current)
		if (parent === current) break
		current = parent
	}
	return null
}

function isExplicitEsmFile(filePath: string, pkg: PackageInfo | null): boolean {
	if (!pkg) return false
	return [pkg.manifest.module, pkg.manifest.esnext].some((entry) => {
		if (typeof entry !== 'string') return false
		const entryPath = resolve(pkg.root, entry)
		const fromEntryDirectory = relative(dirname(entryPath), filePath)
		return (
			filePath === entryPath ||
			(!isAbsolute(fromEntryDirectory) &&
				fromEntryDirectory !== '..' &&
				!fromEntryDirectory.startsWith(`..${sep}`))
		)
	})
}

function hasRequireOnlyRootExport(exportsField: unknown): boolean {
	if (!exportsField || typeof exportsField !== 'object' || Array.isArray(exportsField)) return false
	const root = '.' in exportsField ? (exportsField as Record<string, unknown>)['.'] : exportsField
	if (!root || typeof root !== 'object' || Array.isArray(root)) return false
	const conditions = root as Record<string, unknown>
	return 'require' in conditions && !('import' in conditions) && !('default' in conditions)
}

function inferFormat(
	resolvedPath: string,
	manifest: PackageManifest | undefined,
	fallbackCommonjs: boolean,
): 'module' | 'commonjs' {
	const extension = extname(resolvedPath).toLowerCase()
	if (extension === '.mjs' || extension === '.mts') return 'module'
	if (extension === '.cjs' || extension === '.cts' || extension === '.node') return 'commonjs'
	if (manifest?.type === 'module') return 'module'
	if (manifest?.type === 'commonjs') return 'commonjs'
	return fallbackCommonjs ? 'commonjs' : 'module'
}

function isBarePackageSpecifier(specifier: string): boolean {
	return (
		Boolean(specifier) &&
		!specifier.startsWith('.') &&
		!specifier.startsWith('/') &&
		!specifier.startsWith('file:') &&
		!specifier.startsWith('\0')
	)
}

function resolveCacheLimit(value: number | undefined) {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0
		? Math.floor(value)
		: DEFAULT_CACHE_LIMIT
}

function cached<K, V>(
	map: Map<K, Promise<V>>,
	key: K,
	limit: number,
	create: () => Promise<V>,
): Promise<V> {
	const existing = map.get(key)
	if (existing) return existing
	const value = create()
	if (limit > 0) {
		if (map.size >= limit) map.delete(map.keys().next().value!)
		map.set(key, value)
	}
	return value
}
