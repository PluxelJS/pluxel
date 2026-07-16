import { normalize, resolve as r } from 'pathe'
import type { WorkspacePackageJson as PackageJson } from '@pluxel/rolldown/workspace/info'
import {
	getCachedResolver,
	type OxcResolveCache,
	resolveModulePath,
	withPluxelHmrConditions,
} from '@pluxel/runtime/internal'
import { nodeWorkspaceFs, safeReadManifest, type WorkspaceFs } from './fs'
import type { EntryResolution, EntryResolutionOk, ResolvedScanOptions } from './types'

export class EntryResolver {
	private readonly cache = new Map<string, Promise<EntryResolution>>()
	constructor(
		private readonly resolveCache: OxcResolveCache,
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
		const effectiveOptions = withEntryResolveConditions(options)
		const key = JSON.stringify([
			normalize(dir),
			effectiveOptions.conditions,
			effectiveOptions.conservativeCandidates,
			effectiveOptions.preferHmrExports,
		])
		const cached = this.cache.get(key)
		if (cached) return cached

		const promise = this.resolveUncached(dir, effectiveOptions, manifest).catch((err) => {
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

		const resolver = getCachedResolver(this.resolveCache, 'scan:pkg-resolver', [dir], {
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

function withEntryResolveConditions(options: ResolvedScanOptions): ResolvedScanOptions {
	if (!options.preferHmrExports) return options
	const conditions = withPluxelHmrConditions(options.conditions)
	return sameStringList(conditions, options.conditions) ? options : { ...options, conditions }
}

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((item, index) => item === b[index])
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
