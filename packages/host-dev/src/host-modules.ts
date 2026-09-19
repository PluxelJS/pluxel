import { readFile } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, extname, isAbsolute, parse, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveWithOxc, clearOxcResolutionCache } from '@pluxel/rolldown/resolver/oxc'
import { normalizePath, parseSync, type Plugin, type ViteDevServer } from 'vite'
import { registerViteSsrExternalModuleUrls } from './runner'
import { viteFsPath } from './internal/vite-fs-path'

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
const classifiers = new WeakMap<ViteDevServer, Set<() => void>>()

export function invalidateHostModuleClassifiers(server: ViteDevServer): void {
	clearOxcResolutionCache()
	// Vite 8's resolver retains package.json records independently of its module graph.
	const packageCache = (server.config as unknown as { packageCache?: Map<string, unknown> })
		.packageCache
	packageCache?.clear()
	for (const clear of classifiers.get(server) ?? []) clear()
}

export function createHostModuleClassifier(options: {
	root: string
	cacheLimit?: number
}): HostModuleClassifier {
	const root = resolve(options.root)
	const cacheLimit = resolveCacheLimit(options.cacheLimit)
	const specifierCache = new Map<string, Promise<HostModuleDecision | null>>()
	const fileCache = new Map<string, Promise<HostModuleDecision | null>>()
	const packageCache = new Map<string, Promise<PackageInfo | null>>()

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
			// Package `module` fields are bundler hints and can point at CommonJS. For
			// ambiguous .js files, actual static module syntax is the positive ESM fact.
			const commonjs =
				extension === '.cjs' ||
				extension === '.cts' ||
				(extension === '.js' &&
					pkg?.manifest.type !== 'module' &&
					!parseSync(normalized, await readFile(normalized, 'utf8')).module.hasModuleSyntax)
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
					resolvedPath =
						resolveWithOxc(dirname(base), specifier, {
							conditionNames: ['node', 'import', 'default'],
						})?.path ?? null
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
		},
	}
}

/** Server-only adapter that applies the shared host-module policy before Vite transforms modules. */
export function createHostModuleVitePlugin(): Plugin {
	let classifier: HostModuleClassifier
	let root: string
	let server: ViteDevServer | undefined
	const clear = (): void => {
		classifier?.clear()
		urls.clear()
	}
	const urls = new Map<string, string>()
	let unregister: (() => void) | undefined
	return {
		name: 'pluxel:host-modules',
		enforce: 'pre',
		applyToEnvironment(environment) {
			return environment.name === 'ssr' || environment.config.consumer === 'server'
		},
		configResolved(config) {
			root = config.root
			classifier = createHostModuleClassifier({ root })
		},
		configureServer(value) {
			server = value
			const sessions = classifiers.get(server) ?? new Set()
			sessions.add(clear)
			classifiers.set(server, sessions)
			unregister = registerViteSsrExternalModuleUrls(server, urls)
		},
		async resolveId(source, importer, options) {
			if (!options?.ssr || !classifier || isBuiltin(source) || source.startsWith('\0')) return null
			let decision = isBarePackageSpecifier(source)
				? await classifier.classifySpecifier(source, importer)
				: null
			if (!decision) {
				// Vite owns aliases and tsconfig paths; classify their resolved physical target too.
				const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
				decision = resolved ? await classifier.classifyFile(resolved.id) : null
			}
			if (!decision) return null
			const path = normalizePath(decision.resolvedPath)
			const url = pathToFileURL(decision.resolvedPath).href
			for (const request of [path, `/@fs/${path}`, `/@fs${path}`, url]) urls.set(request, url)
			const local = normalizePath(relative(root, path))
			if (!local.startsWith('../') && !isAbsolute(local)) urls.set(`/${local}`, url)
			return { id: path, external: true }
		},
		closeBundle() {
			unregister?.()
			unregister = undefined
			clear()
			if (server) classifiers.get(server)?.delete(clear)
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
	const fsPath = viteFsPath(clean)
	if (fsPath !== undefined) return fsPath
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
