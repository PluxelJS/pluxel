import { existsSync } from 'node:fs'
import { resolveModulePath } from 'exsolve'
import { normalize, resolve as r } from 'pathe'
import { pathToFileURL } from 'node:url'
import type { PackageJson } from 'pkg-types'
import { safeReadManifest } from './package'
import type { EntryResolution, EntryResolutionOk, ResolvedScanOptions } from './types'
import type { ResolveOptions } from 'exsolve'
import { ModuleResolveCache } from './resolve-cache'

export class EntryResolver {
	private readonly cache = new Map<string, Promise<EntryResolution>>()
	constructor(private readonly moduleResolveCache: ModuleResolveCache) {}

	clear() {
		this.cache.clear()
	}

	async resolve(
		dir: string,
		options: ResolvedScanOptions,
		manifest?: PackageJson,
	): Promise<EntryResolution> {
		const key = JSON.stringify([normalize(dir), options.conditions, options.conservativeCandidates])
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
		const entry = resolveModulePath(
			'.',
			resolveOptionsFor(dir, options.conditions, this.moduleResolveCache),
		)
		if (entry) {
			return entryOk(dir, normalize(entry), 'exports', [])
		}

		const pkgJson = manifest ?? (await safeReadManifest(dir))
		const tried: string[] = []
		const candidates: string[] = []

		if (!pkgJson) {
			for (const rel of options.conservativeCandidates) {
				tried.push(rel)
				const abs = r(dir, rel)
				if (existsSync(abs)) {
					return entryOk(dir, normalize(abs), 'fallback', tried)
				}
			}
			return {
				ok: false,
				dir,
				code: 'NO_PACKAGE_JSON',
				message: 'package.json not found and no fallback candidates exist.',
				tried,
			}
		}

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
			if (!existsSync(abs)) continue
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

function resolveOptionsFor(
	dir: string,
	conditions: string[] | undefined,
	cache: ModuleResolveCache,
): ResolveOptions {
	const options: ResolveOptions = {
		from: packageBaseURL(dir),
		try: true,
		cache: cache.map,
	}
	if (conditions && conditions.length > 0) {
		options.conditions = [...conditions]
	}
	return options
}

function packageBaseURL(dir: string): URL {
	const normalized = normalize(dir)
	const asDir = normalized.endsWith('/') ? normalized : `${normalized}/`
	return pathToFileURL(asDir)
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
