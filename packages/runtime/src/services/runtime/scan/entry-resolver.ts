import { normalize, resolve as r } from 'pathe'
import type { PackageJson } from 'pkg-types'
import { PLUXEL_CONDITION_HMR } from '../shared/conditions'
import { toDirectoryURLString } from '../shared/exsolve'
import { getCachedResolver, resolveModulePath } from '../shared/resolution'
import { nodeWorkspaceFs, safeReadManifest, type WorkspaceFs } from './fs'
import type { ModuleResolveCache } from './resolve-cache'
import type { EntryResolution, EntryResolutionOk, ResolvedScanOptions } from './types'

export class EntryResolver {
	private readonly cache = new Map<string, Promise<EntryResolution>>()
	constructor(
		private readonly moduleResolveCache: ModuleResolveCache,
		private readonly fs: WorkspaceFs = nodeWorkspaceFs,
	) {}

	clear() {
		this.cache.clear()
	}

	resolve(
		dir: string,
		options: ResolvedScanOptions,
		manifest?: PackageJson,
	): Promise<EntryResolution> {
		const key = JSON.stringify([
			normalize(dir),
			options.conditions,
			options.conservativeCandidates,
			options.preferHmrExports,
		])
		const cached = this.cache.get(key)
		if (cached) return cached

		const promise = this.resolveUncached(dir, options, manifest).catch((err) => {
			this.cache.delete(key)
			throw err
		})
		this.cache.set(key, promise)
		return promise
	}

	private async resolveUncached(
		dir: string,
		options: ResolvedScanOptions,
		manifest?: PackageJson,
	): Promise<EntryResolution> {
		const pkgJson = manifest ?? (await safeReadManifest(dir, this.fs))

		if (!pkgJson) {
			const tried: string[] = []
			for (const rel of options.conservativeCandidates) {
				tried.push(rel)
				const abs = r(dir, rel)
				if (this.fs.existsSync(abs)) {
					return entryOk(dir, normalize(abs), 'fallback', tried)
				}
			}
			// 若保守候选未命中，尝试任意 .ts 作为兜底入口
			const tsEntry = findFirstTsEntry(dir, this.fs)
			if (tsEntry) {
				tried.push(tsEntry.relative)
				return entryOk(dir, tsEntry.absolute, 'fallback', tried)
			}
			return {
				ok: false,
				dir,
				code: 'NO_PACKAGE_JSON',
				message: 'package.json not found and no fallback candidates exist.',
				tried,
			}
		}

		const hmrExport = options.preferHmrExports ? pickHmrExport(pkgJson?.exports) : undefined
		if (hmrExport) {
			const abs = r(dir, hmrExport)
			if (this.fs.existsSync(abs)) {
				return entryOk(dir, normalize(abs), 'exports', [])
			}
		}

		const base = toDirectoryURLString(dir)
		const resolver = getCachedResolver(this.moduleResolveCache.map, 'scan:pkg-resolver', [base], {
			limit: 256,
		})

		let exportsEntry: string | null = null
		if (pkgJson?.name) {
			exportsEntry = resolveModulePath(resolver, pkgJson.name, { conditions: options.conditions })
		}
		if (!exportsEntry) {
			exportsEntry = resolveModulePath(resolver, '.', { conditions: options.conditions })
		}
		if (exportsEntry) {
			return entryOk(dir, normalize(exportsEntry), 'exports', [])
		}
		const tried: string[] = []
		const candidates: string[] = []

		const { main, module, types } = pkgJson as PackageJson & {
			types?: string
		}

		if (main) {
			candidates.push(main)
			tried.push(main)
		}
		if (module && module !== main) {
			candidates.push(module)
			tried.push(module)
		}
		if (types && types !== main && types !== module) {
			candidates.push(types)
			tried.push(types)
		}

		for (const rel of options.conservativeCandidates) {
			if (!candidates.includes(rel)) {
				candidates.push(rel)
				tried.push(rel)
			}
		}

		for (const rel of candidates) {
			const abs = r(dir, rel)
			if (!this.fs.existsSync(abs)) continue
			const source =
				rel === main ? 'main' : rel === module ? 'module' : rel === types ? 'types' : 'fallback'
			return entryOk(dir, normalize(abs), source, tried)
		}

		return {
			ok: false,
			dir,
			code: 'NO_ENTRY',
			message: 'No entry file resolved from exports/main/module/types/fallback.',
			tried,
		}
	}
}

function entryOk(
	dir: string,
	entry: string,
	source: EntryResolutionOk['source'],
	tried: string[],
): EntryResolutionOk {
	return {
		ok: true,
		dir,
		entry,
		source,
		tried,
	}
}

function findFirstTsEntry(
	dir: string,
	fs: WorkspaceFs,
): { absolute: string; relative: string } | null {
	const candidates = ['index.ts', 'src/index.ts']
	for (const rel of candidates) {
		const abs = r(dir, rel)
		if (fs.existsSync(abs)) {
			return { absolute: normalize(abs), relative: rel }
		}
	}
	return null
}

function pickHmrExport(exportsField: PackageJson['exports']): string | undefined {
	if (!exportsField) return undefined
	const rootExport =
		typeof exportsField === 'object' && exportsField !== null && '.' in exportsField
			? (exportsField as Record<string, unknown>)['.']
			: exportsField

	return resolveHmrTarget(rootExport)
}

function resolveHmrTarget(target: unknown): string | undefined {
	if (!target) return undefined
	if (typeof target === 'string') return target
	if (Array.isArray(target)) {
		for (const item of target) {
			const hit = resolveHmrTarget(item)
			if (hit) return hit
		}
		return undefined
	}
	if (typeof target === 'object') {
		const record = target as Record<string, unknown>
		if (record[PLUXEL_CONDITION_HMR]) {
			return resolveHmrTarget(record[PLUXEL_CONDITION_HMR])
		}
	}
	return undefined
}
