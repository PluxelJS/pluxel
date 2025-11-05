import { type Context, Injectable } from '@pluxel/core'
import { resolvePath as mllyResolvePath } from 'mlly'
import { dirname, isAbsolute, normalize, resolve as r } from 'pathe'
import { EntryResolver } from './scan/entry-resolver'
import { buildScanGraph } from './scan/graph-builder'
import { DEFAULT_SCAN_OPTIONS, resolveScanOptions } from './scan/options'
import type {
	EntryResolution,
	EntryResolutionOk,
	PackageNode,
	ResolvedScanOptions,
	ScanGraph,
	ScanOptionsInput,
} from './scan/types'

const serviceName = 'scanService' as const

declare module '@pluxel/core' {
	interface Context {
		[serviceName]: ScanService
	}
	interface Config {
		[serviceName]?: ScanOptionsInput
	}
}

export type {
	EntryResolution,
	EntryResolutionOk,
	PackageNode,
	ScanDiagnostic,
	ScanGraph,
	ScanOptionsInput,
	ScanStats,
} from './scan/types'

export type PackageSelector = string | { name?: string | null; dir?: string | null }

export interface ScanSnapshot {
	graph: ScanGraph
	packages: PackageNode[]
	entries: string[]
	fallbackEntries: string[]
	byName: ReadonlyMap<string, PackageNode>
	byDir: ReadonlyMap<string, PackageNode>
	findPackage(selector: PackageSelector): PackageNode | undefined
	resolveEntry(selector: PackageSelector): EntryResolution | undefined
}

/**
 * High-level facade that scans monorepo/workspace layouts and resolves package entry files.
 *
 * Typical usage:
 * ```ts
 * const snapshot = await ctx.scanService.snapshot(['packages']);
 * const redis = await ctx.scanService.resolveEntry(['packages'], 'pluxel-plugin-redis');
 * ```
 *
 * The scanner understands pnpm (`pnpm-workspace.yaml`) as well as Yarn/NPM workspaces declared
 * via `package.json#workspaces`, and falls back to conventional `packages/*` / `apps/*` patterns.
 */
@Injectable({ key: serviceName })
export class ScanService {
	private defaults: ResolvedScanOptions
	private readonly entryResolver = new EntryResolver()
	private readonly snapshotCache = new Map<string, Promise<ScanSnapshot>>()

	constructor(_ctx: Context, overrides?: ScanOptionsInput) {
		this.defaults = resolveScanOptions(DEFAULT_SCAN_OPTIONS, overrides)
	}

	/** Update default options at runtime (e.g. after config hot reload). */
	updateDefaults(overrides: ScanOptionsInput) {
		this.defaults = resolveScanOptions(this.defaults, overrides)
		this.clearCaches()
	}

	/** Clear all memoized results (snapshots + entry data). */
	clearCaches() {
		this.snapshotCache.clear()
	}

	/**
	 * Build (or reuse) a memoized snapshot of the discovered packages and their entries.
	 * Snapshots include lookup maps keyed by package name and absolute directory.
	 */
	async snapshot(input: string | string[], overrides: ScanOptionsInput = {}): Promise<ScanSnapshot> {
		const normalizedInputs = normalizeInputs(input)
		const options = resolveScanOptions(this.defaults, overrides)
		const cacheKey = createCacheKey(normalizedInputs, options)

		const cached = this.snapshotCache.get(cacheKey)
		if (cached) return cached

		const promise = this.buildSnapshot(normalizedInputs, options).catch((err) => {
			this.snapshotCache.delete(cacheKey)
			throw err
		})
		this.snapshotCache.set(cacheKey, promise)
		return promise
	}

	/** Compatibility alias with previous API: flattened entries (including TS fallbacks). */
	async scan(input: string | string[], overrides: ScanOptionsInput = {}): Promise<string[]> {
		return this.scanEntries(input, overrides)
	}

	/** Quick helper: entries + fallback TS files as a flat set. */
	async scanEntries(input: string | string[], overrides: ScanOptionsInput = {}): Promise<string[]> {
		const snapshot = await this.snapshot(input, overrides)
		const all = new Set<string>()
		for (const entry of snapshot.entries) all.add(entry)
		for (const file of snapshot.fallbackEntries) all.add(file)
		return Array.from(all)
	}

	/** Full graph with roots/packages/diagnostics. */
	async scanGraph(input: string | string[], overrides: ScanOptionsInput = {}): Promise<ScanGraph> {
		const snapshot = await this.snapshot(input, overrides)
		return snapshot.graph
	}

	/**
	 * Resolve entry for a given package. Accepts names or absolute/relative directories.
	 *
	 * When a selector looks like a package name (e.g. `pluxel-plugin-redis`), it will match against
	 * the manifest `name`. When it resembles a path, it matches normalized absolute directories.
	 */
	async resolveEntry(
		input: string | string[],
		selector: PackageSelector,
		overrides: ScanOptionsInput = {},
	): Promise<EntryResolution> {
		const focusHints = selectorFocusHints(selector)
		const mergedOverrides =
			focusHints.length > 0
				? {
						...overrides,
						focusPackages: mergeFocus(overrides.focusPackages, focusHints),
				  }
				: overrides

		const snapshot = await this.snapshot(input, mergedOverrides)
		const pkg = snapshot.findPackage(selector)
		if (pkg) return pkg.entry

		const fallback = await resolveInstalledPackage(selector, snapshot.graph.options)
		return fallback ?? missingPackageResolution(selector)
	}

	/** Convenience wrapper when callers only care about a package name. */
	async resolveEntryByName(
		input: string | string[],
		packageName: string,
		overrides: ScanOptionsInput = {},
	): Promise<EntryResolution> {
		const trimmed = packageName.trim()
		if (!trimmed) {
			return {
				ok: false,
				dir: packageName,
				code: 'MISSING_PACKAGE',
				message: 'Package name is empty.',
			}
		}
		return this.resolveEntry(input, { name: trimmed }, overrides)
	}

	private async buildSnapshot(
		inputs: string[],
		options: ResolvedScanOptions,
	): Promise<ScanSnapshot> {
		const graph = await buildScanGraph(inputs, options, this.entryResolver)
		const byName = new Map<string, PackageNode>()
		const byDir = new Map<string, PackageNode>()

		for (const pkg of graph.packages) {
			const dirKey = normalizePackageDir(pkg.dir)
			if (dirKey && !byDir.has(dirKey)) byDir.set(dirKey, pkg)

			const nameKey = normalizePackageName(pkg.name)
			if (nameKey && !byName.has(nameKey)) byName.set(nameKey, pkg)
		}

		const findPackage = (selector: PackageSelector) => selectPackage(selector, byName, byDir)
		const resolve = (selector: PackageSelector) => findPackage(selector)?.entry

		return {
			graph,
			packages: graph.packages,
			entries: graph.entries,
			fallbackEntries: graph.fallbackEntries,
			byName,
			byDir,
			findPackage,
			resolveEntry: resolve,
		}
	}
}

export const isEntryOk = (entry: EntryResolution): entry is EntryResolutionOk => entry.ok
export const isPackageEntryOk = (pkg: PackageNode): pkg is PackageNode & { entry: EntryResolutionOk } =>
	pkg.entry.ok

function normalizeInputs(input: string | string[]): string[] {
	const list = Array.isArray(input) ? input : [input]
	return list.map((raw) => {
		const trimmed = raw.trim()
		const abs = trimmed && isAbsolute(trimmed) ? trimmed : r(process.cwd(), trimmed || '.')
		return normalize(abs)
	})
}

function createCacheKey(inputs: string[], options: ResolvedScanOptions): string {
	return JSON.stringify([inputs, options])
}

function selectPackage(
	selector: PackageSelector,
	byName: Map<string, PackageNode>,
	byDir: Map<string, PackageNode>,
): PackageNode | undefined {
	if (typeof selector === 'string') {
		const nameKey = normalizePackageName(selector)
		if (nameKey) {
			const match = byName.get(nameKey)
			if (match) return match
		}
		const dirKey = normalizePackageDir(selector)
		if (dirKey) {
			const match = byDir.get(dirKey)
			if (match) return match
		}
		return undefined
	}

	const nameKey = normalizePackageName(selector.name)
	if (nameKey) {
		const match = byName.get(nameKey)
		if (match) return match
	}

	const dirKey = normalizePackageDir(selector.dir)
	if (dirKey) {
		const match = byDir.get(dirKey)
		if (match) return match
	}

	return undefined
}

function normalizePackageName(value?: string | null): string | undefined {
	if (!value) return undefined
	const trimmed = value.trim()
	return trimmed ? trimmed.toLowerCase() : undefined
}

function normalizePackageDir(value?: string | null): string | undefined {
	if (!value) return undefined
	const trimmed = value.trim()
	if (!trimmed) return undefined
	const abs = isAbsolute(trimmed) ? trimmed : r(process.cwd(), trimmed)
	return normalize(abs).toLowerCase()
}

function selectorFocusHints(selector: PackageSelector): string[] {
	const focus = new Set<string>()
	if (typeof selector === 'string') {
		const nameHint = normalizePackageName(selector)
		if (nameHint) focus.add(nameHint)
		const dirHint = normalizePackageDir(selector)
		if (dirHint) focus.add(dirHint)
		return [...focus]
	}

	const nameHint = normalizePackageName(selector.name)
	if (nameHint) focus.add(nameHint)
	const dirHint = normalizePackageDir(selector.dir)
	if (dirHint) focus.add(dirHint)
	return [...focus]
}

function mergeFocus(existing: string[] | undefined, additions: string[]): string[] {
	const merged = new Set(existing ?? [])
	for (const hint of additions) {
		const trimmed = hint.trim()
		if (trimmed) merged.add(trimmed)
	}
	return [...merged]
}

function missingPackageResolution(selector: PackageSelector): EntryResolution {
	const label = selectorLabel(selector)
	return {
		ok: false,
		dir: label ?? '',
		code: 'MISSING_PACKAGE',
		message: label
			? `Package "${label}" not found in provided inputs.`
			: 'Package not found in provided inputs.',
	}
}

function selectorLabel(selector: PackageSelector): string | undefined {
	if (typeof selector === 'string') {
		const trimmed = selector.trim()
		return trimmed || undefined
	}
	const name = selector.name?.toString().trim()
	if (name) return name
	const dir = selector.dir?.toString().trim()
	return dir || undefined
}

async function resolveInstalledPackage(
	selector: PackageSelector,
	options: ResolvedScanOptions,
): Promise<EntryResolution | undefined> {
	const bare = selectorBareName(selector)
	if (!bare) return undefined
	try {
		const entryPath = await mllyResolvePath(bare, { conditions: options.conditions })
		const manifestPath = await mllyResolvePath(`${bare}/package.json`).catch(() => undefined)
		const pkgDir = manifestPath ? dirname(manifestPath) : dirname(entryPath)
		return {
			ok: true,
			dir: normalize(pkgDir),
			entry: normalize(entryPath),
			source: 'exports',
			tried: [],
		}
	} catch {
		return undefined
	}
}

function selectorBareName(selector: PackageSelector): string | undefined {
	if (typeof selector === 'string') {
		const trimmed = selector.trim()
		return trimmed || undefined
	}
	const value = selector.name
	if (typeof value !== 'string') return undefined
	const trimmed = value.trim()
	return trimmed || undefined
}
