import { readFile } from 'node:fs/promises'
import { dirname, extname, parse, resolve } from 'node:path'
import { parseSync } from 'vite'

type HostModuleDecision = Readonly<{
	resolvedPath: string
	format: 'module' | 'commonjs'
	reason: 'native' | 'commonjs'
}>

type PackageManifest = {
	name?: unknown
	type?: unknown
	napi?: unknown
	binary?: unknown
	gypfile?: unknown
}

type PackageInfo = Readonly<{
	name: string | null
	manifest: PackageManifest
}>

const CACHE_LIMIT = 2_000

/** Classify only physical files already selected by Vite; this owns no resolver. */
export function createHostModuleClassifier() {
	const fileCache = new Map<string, Promise<HostModuleDecision | null>>()
	const packageCache = new Map<string, Promise<PackageInfo | null>>()
	return {
		classifyFile(filePath: string): Promise<HostModuleDecision | null> {
			return cached(fileCache, filePath, async () => {
				const extension = extname(filePath).toLowerCase()
				const pkg = await cached(packageCache, dirname(filePath), () => findPackageInfo(filePath))
				const native =
					extension === '.node' ||
					Boolean(pkg?.manifest.napi) ||
					Boolean(pkg?.manifest.binary) ||
					pkg?.manifest.gypfile === true
				// Legacy bundler ESM sometimes lives in a package without type: module.
				const commonjs =
					extension === '.cjs' ||
					extension === '.cts' ||
					(extension === '.js' &&
						pkg?.manifest.type !== 'module' &&
						!parseSync(filePath, await readFile(filePath, 'utf8')).module.hasModuleSyntax)
				if (!native && !commonjs) return null
				return {
					resolvedPath: filePath,
					format: inferFormat(filePath, pkg?.manifest),
					reason: native ? 'native' : 'commonjs',
				}
			})
		},
		clear() {
			fileCache.clear()
			packageCache.clear()
		},
	}
}

async function findPackageInfo(filePath: string): Promise<PackageInfo | null> {
	let current = dirname(filePath)
	const filesystemRoot = parse(current).root
	while (current !== filesystemRoot) {
		const manifestPath = resolve(current, 'package.json')
		let source: string
		try {
			source = await readFile(manifestPath, 'utf8')
		} catch (cause) {
			if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') {
				const parent = dirname(current)
				if (parent === current) break
				current = parent
				continue
			}
			throw new Error(
				`Cannot read package manifest ${manifestPath} while classifying ${filePath}`,
				{ cause },
			)
		}
		let manifest: unknown
		try {
			manifest = JSON.parse(source)
		} catch (cause) {
			throw new Error(`Invalid package manifest ${manifestPath} while classifying ${filePath}`, {
				cause,
			})
		}
		if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
			throw new Error(
				`Invalid package manifest ${manifestPath} while classifying ${filePath}: expected a JSON object`,
			)
		}
		const packageManifest = manifest as PackageManifest
		return {
			name: typeof packageManifest.name === 'string' ? packageManifest.name : null,
			manifest: packageManifest,
		}
	}
	return null
}

function inferFormat(
	resolvedPath: string,
	manifest: PackageManifest | undefined,
): 'module' | 'commonjs' {
	const extension = extname(resolvedPath).toLowerCase()
	if (extension === '.mjs' || extension === '.mts') return 'module'
	if (extension === '.cjs' || extension === '.cts' || extension === '.node') return 'commonjs'
	if (manifest?.type === 'module') return 'module'
	if (manifest?.type === 'commonjs') return 'commonjs'
	return 'commonjs'
}

function cached<K, V>(map: Map<K, Promise<V>>, key: K, create: () => Promise<V>): Promise<V> {
	const existing = map.get(key)
	if (existing) return existing
	const value = create()
	if (map.size >= CACHE_LIMIT) map.delete(map.keys().next().value!)
	map.set(key, value)
	return value
}
