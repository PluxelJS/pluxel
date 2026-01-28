import { realpath } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { type ResolveOptions, resolveModulePath } from 'exsolve'
import { dirname, normalize } from 'pathe'
import { normalizePath } from 'vite'
import type { ScanService } from '../market/ScanService'

const DEFAULT_CONDITIONS = ['@pluxel/hmr', 'import', 'module', 'default']
const DRIVE_PATH_RE = /^[a-zA-Z]:[\\/]/
const CANONICALIZE_CACHE_LIMIT = 2_000
const canonicalizeCache = new Map<string, Promise<string>>()

interface ResolveBareImportArgs {
	specifier: string
	importer?: string | null
	scanService?: ScanService
	conditions?: readonly string[]
	fallbackBaseDirs?: readonly string[]
	/** Only resolve from workspace scan results, skip node_modules fallback. */
	workspaceOnly?: boolean
}

export async function resolveBareImport({
	specifier,
	importer,
	scanService,
	conditions = DEFAULT_CONDITIONS,
	fallbackBaseDirs = [process.cwd()],
	workspaceOnly = false,
}: ResolveBareImportArgs): Promise<string | null> {
	if (!isBareSpecifier(specifier)) return null
	const normalizedConditions = dedupeStrings(conditions)
	// 首先尝试通过 workspace 扫描器解析（可返回 TS 源入口）。
	if (scanService) {
		try {
			const preferHmrExports = normalizedConditions.includes('@pluxel/hmr')
			const resolved = await scanService.resolveEntry(
				{ name: specifier },
				{
					workspaceOnly: true,
					scan: {
						conditions: normalizedConditions as string[],
						...(preferHmrExports ? { preferHmrExports: true } : {}),
					},
				},
			)
			if (resolved?.ok) {
				return await canonicalizePath(resolved.entry)
			}
		} catch {
			// ignore scan failures and fall through to local resolution
		}
	}
	if (workspaceOnly) return null

	const importerBases = resolveImporterBases(importer)
	const searchBases = mergeResolutionBases(importerBases, fallbackBaseDirs)
	for (const base of searchBases) {
		const resolved = tryResolveWithExsolve(specifier, base, normalizedConditions)
		if (resolved) return await canonicalizePath(resolved)
	}

	return null
}

function isBareSpecifier(id: string | undefined) {
	if (!id) return false
	if (id.startsWith('.') || id.startsWith('/') || id.startsWith('\0')) return false
	if (DRIVE_PATH_RE.test(id)) return false
	return true
}

function resolveImporterBases(importer?: string | null): string[] {
	if (!importer) return []
	const asPath = importer.startsWith('file://') ? fileURLToPath(importer) : importer
	const normalized = normalize(asPath)
	const dir = dirname(normalized)
	return dir ? [dir] : []
}

function mergeResolutionBases(importerBases: string[], fallback: readonly string[]) {
	const merged = new Set<string>()
	for (const base of importerBases) if (base) merged.add(base)
	for (const base of fallback) if (base) merged.add(normalize(base))
	return [...merged]
}

function dedupeStrings(values: readonly string[]) {
	return [...new Set(values)]
}

function tryResolveWithExsolve(
	spec: string,
	baseDir: string | undefined,
	conditions: readonly string[],
): string | null {
	if (!baseDir) return null
	try {
		const from = ensureDirectoryURL(baseDir)
		const options: ResolveOptions = {
			from,
			try: true,
		}
		if (conditions.length) options.conditions = [...conditions]
		const resolved = resolveModulePath(spec, options)
		return resolved ? normalizePath(resolved) : null
	} catch {
		return null
	}
}

function ensureDirectoryURL(input: string): URL {
	const normalized = normalize(input)
	const asDir = normalized.endsWith('/') ? normalized : `${normalized}/`
	return pathToFileURL(asDir)
}

async function canonicalizePath(input: string): Promise<string> {
	const cached = canonicalizeCache.get(input)
	if (cached) return await cached

	const p = (async () => {
		try {
			const real = await realpath(input)
			return normalizePath(real)
		} catch {
			return normalizePath(input)
		}
	})()

	canonicalizeCache.set(input, p)
	if (canonicalizeCache.size > CANONICALIZE_CACHE_LIMIT) {
		const first = canonicalizeCache.keys().next().value as string
		canonicalizeCache.delete(first)
	}

	return await p
}
