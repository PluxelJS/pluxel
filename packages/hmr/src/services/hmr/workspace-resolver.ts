import { realpath } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, normalize } from 'pathe'
import { normalizePath } from 'vite'
import { resolveModulePath, type ResolveOptions } from 'exsolve'
import type { ScanService } from '../market/ScanService'

const DEFAULT_CONDITIONS = ['@pluxel/hmr', '@pluxel/source', 'import', 'module', 'default']

interface ResolveBareImportArgs {
	specifier: string
	importer?: string | null
	scanService?: ScanService
	conditions?: readonly string[]
	fallbackBaseDirs?: readonly string[]
}

export async function resolveBareImport({
	specifier,
	importer,
	scanService,
	conditions = DEFAULT_CONDITIONS,
	fallbackBaseDirs = [process.cwd()],
}: ResolveBareImportArgs): Promise<string | null> {
	// 首先尝试通过 workspace 扫描器解析（可返回 TS 源入口）。
	if (scanService) {
		try {
			const resolved = await scanService.resolveEntry({ name: specifier }, { workspaceOnly: true })
			if (resolved?.ok) {
				return await canonicalizePath(resolved.entry)
			}
		} catch {
			// ignore scan failures and fall through to local resolution
		}
	}

	const importerBases = resolveImporterBases(importer)
	for (const base of new Set([...importerBases, ...fallbackBaseDirs])) {
		const resolved = tryResolveWithExsolve(specifier, base, conditions)
		if (resolved) return await canonicalizePath(resolved)
	}

	return null
}

function resolveImporterBases(importer?: string | null): string[] {
	if (!importer) return []
	const asPath = importer.startsWith('file://') ? fileURLToPath(importer) : importer
	const normalized = normalize(asPath)
	const dir = dirname(normalized)
	return dir ? [dir] : []
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
			conditions: [...new Set(conditions)],
		}
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
	try {
		const real = await realpath(input)
		return normalizePath(real)
	} catch {
		return normalizePath(input)
	}
}
