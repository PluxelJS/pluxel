import {
	checkPluginDecorator,
	getClassParams,
	getPluginInfo,
	getRequiredPluginDependencies,
	type PluginIdentifier,
} from '@pluxel/core'
import type {
	StaticRuntimeCatalogEntry,
	StaticRuntimeDefinition,
	StaticRuntimeReportEntry,
} from '../types'

type ConfigShape = {
	plugins: Record<string, Record<string, unknown>>
}

export type StaticRuntimeCatalogEntryInternal = StaticRuntimeCatalogEntry & {
	readonly info: ReturnType<typeof getPluginInfo>
	readonly deps: readonly PluginIdentifier[]
}

export type StaticRuntimeCatalog = {
	readonly entries: readonly StaticRuntimeCatalogEntryInternal[]
	readonly byName: ReadonlyMap<string, StaticRuntimeCatalogEntryInternal>
	readonly byPlugin: ReadonlyMap<PluginIdentifier, StaticRuntimeCatalogEntryInternal>
	readonly diagnostics: readonly StaticRuntimeReportEntry[]
}

export type StaticRuntimeCatalogDiff = {
	readonly added: readonly string[]
	readonly removed: readonly string[]
	readonly replaced: readonly string[]
}

export function buildCatalog(definition: StaticRuntimeDefinition): StaticRuntimeCatalog {
	const entries: StaticRuntimeCatalogEntryInternal[] = []
	const diagnostics: StaticRuntimeReportEntry[] = []
	const byName = new Map<string, StaticRuntimeCatalogEntryInternal>()
	const byPlugin = new Map<PluginIdentifier, StaticRuntimeCatalogEntryInternal>()

	for (const plugin of definition.plugins) {
		if (!checkPluginDecorator(plugin)) {
			diagnostics.push({
				name: plugin.name || '<anonymous>',
				status: 'catalog-drift',
				message: 'plugin constructor is missing @Plugin metadata',
			})
			continue
		}

		const info = getPluginInfo(plugin)
		const name = info.id
		if (byName.has(name)) {
			diagnostics.push({
				name,
				status: 'catalog-drift',
				message: 'duplicate plugin name in static catalog',
			})
			continue
		}

		const deps = uniquePluginDeps([
			...getClassParams<PluginIdentifier>(plugin),
			...getRequiredPluginDependencies(plugin, { inherit: true }),
		])
		const entry = { name, plugin, info, deps }
		entries.push(entry)
		byName.set(name, entry)
		byPlugin.set(plugin, entry)
	}

	return { entries, byName, byPlugin, diagnostics }
}

export function diffCatalog(
	previous: StaticRuntimeCatalog,
	next: StaticRuntimeCatalog,
): StaticRuntimeCatalogDiff {
	const added: string[] = []
	const removed: string[] = []
	const replaced: string[] = []

	for (const [name, entry] of next.byName) {
		const prev = previous.byName.get(name)
		if (!prev) added.push(name)
		else if (prev.plugin !== entry.plugin) replaced.push(name)
	}
	for (const [name] of previous.byName) {
		if (!next.byName.has(name)) removed.push(name)
	}

	return { added, removed, replaced }
}

export function firstMissingDependency(
	entry: StaticRuntimeCatalogEntryInternal,
	catalog: StaticRuntimeCatalog,
	enabled: ReadonlySet<string>,
	blocked: ReadonlySet<string>,
): string | undefined {
	for (const dep of entry.deps) {
		const depEntry = catalog.byPlugin.get(dep)
		if (!depEntry) return describeDependency(dep)
		if (!enabled.has(depEntry.name) || blocked.has(depEntry.name)) return depEntry.name
	}
	return undefined
}

export type ConfigSnapshotReader = {
	getConfigSnapshot?: () => ConfigShape
}

export function readConfigSnapshot(configService: ConfigSnapshotReader): ConfigShape {
	if (typeof configService.getConfigSnapshot === 'function')
		return configService.getConfigSnapshot()
	return {
		plugins: Object.create(null),
	}
}

export function collectUnknownConfigEntries(
	snapshot: ConfigShape,
	known: ReadonlyMap<string, unknown>,
	enabled: Iterable<string> = [],
): string[] {
	const out = new Set<string>()
	for (const name of enabled) {
		if (!known.has(name)) out.add(name)
	}
	for (const name of Object.keys(snapshot.plugins)) {
		if (!known.has(name)) out.add(name)
	}
	return [...out].sort((a, b) => a.localeCompare(b))
}

function uniquePluginDeps(deps: readonly PluginIdentifier[]): readonly PluginIdentifier[] {
	const out: PluginIdentifier[] = []
	const seen = new Set<PluginIdentifier>()
	for (const dep of deps) {
		if (!dep || seen.has(dep)) continue
		seen.add(dep)
		out.push(dep)
	}
	return out
}

function describeDependency(dep: PluginIdentifier): string {
	if (typeof dep !== 'function') return String(dep)
	if (!checkPluginDecorator(dep)) return dep.name || '<anonymous>'
	return getPluginInfo(dep).id
}
