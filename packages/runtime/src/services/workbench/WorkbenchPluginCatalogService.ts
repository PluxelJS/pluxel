import type { Context } from '@pluxel/core'
import type { WorkbenchConfig, WorkbenchPluginGroupConfig } from '../../workbench-config'
import { runtimePluginStatusOverview } from '../../runtime/capabilities'
import type { PersistenceNamespace } from '../persistence/PersistenceService'

const PACKAGE_GROUP_PREFIX = 'package:'
const PREFERENCE_KEY = 'plugin-catalog.json'

export type WorkbenchPluginGroupLayout = Readonly<{
	groupId: string
	name: string
	pluginIds: readonly string[]
}>

type PluginCatalogPreferences = {
	version: 1
	assignments: Record<string, string | null>
	groupOrder: string[]
	pluginOrder: Record<string, string[]>
	migratedRuntimeGroups: boolean
}

type NormalizedPackagePattern = Readonly<{
	groupId: string
	literal: string
	prefix: boolean
}>

type NormalizedHostGroup = Readonly<{
	id: string
	name: string
	plugins: readonly string[]
	packages: readonly NormalizedPackagePattern[]
}>

type CatalogEntry = Readonly<{
	id: string
	packageName: string | null
}>

type RegisteredGroup = Readonly<{
	id: string
	name: string
	kind: 'host' | 'package'
}>

export class PluginCatalogLayoutError extends Error {
	readonly code = 'INVALID_PLUGIN_GROUP_LAYOUT'

	constructor(message: string) {
		super(message)
		this.name = 'PluginCatalogLayoutError'
	}
}

export class WorkbenchPluginCatalogService {
	readonly ready: Promise<void>

	private readonly hostGroups: readonly NormalizedHostGroup[]
	private readonly explicitPluginGroups = new Map<string, string>()
	private readonly storage: PersistenceNamespace
	private preferences: PluginCatalogPreferences = emptyPreferences()
	private writeQueue: Promise<void> = Promise.resolve()

	constructor(private readonly root: Context) {
		this.hostGroups = normalizeHostGroups(readPluginGroups(root.config.workbench))
		for (const group of this.hostGroups) {
			for (const pluginId of group.plugins) this.explicitPluginGroups.set(pluginId, group.id)
		}
		this.storage = root.root.persistence.namespace('workbench')
		this.ready = this.load()
	}

	async listGroups(): Promise<WorkbenchPluginGroupLayout[]> {
		await this.ready
		await this.migrateRuntimeGroups()
		return this.resolveLayout().groups
	}

	async getGroup(id: string): Promise<WorkbenchPluginGroupLayout | undefined> {
		const groups = await this.listGroups()
		return groups.find((group) => group.groupId === id)
	}

	async updateGroups(
		groups: readonly WorkbenchPluginGroupLayout[],
	): Promise<WorkbenchPluginGroupLayout[]> {
		if (!Array.isArray(groups)) throw invalid('groups must be an array')
		await this.ready
		await this.migrateRuntimeGroups()
		const current = this.resolveLayout()
		const registered = current.registered
		const entries = current.entries
		const knownPlugins = new Set(entries.map((entry) => entry.id))
		const desired = new Map<string, string>()
		const groupOrder: string[] = []
		const pluginOrder: Record<string, string[]> = Object.create(null)

		for (const rawGroup of groups) {
			if (!rawGroup || typeof rawGroup !== 'object' || Array.isArray(rawGroup)) {
				throw invalid('every group must be an object')
			}
			const groupId = layoutText('groupId', rawGroup.groupId)
			const canonical = registered.get(groupId)
			if (!canonical) throw invalid(`unknown group "${groupId}"`)
			if (layoutText('name', rawGroup.name) !== canonical.name) {
				throw invalid(`group "${groupId}" must use canonical name "${canonical.name}"`)
			}
			if (groupOrder.includes(groupId)) throw invalid(`duplicate group "${groupId}"`)
			groupOrder.push(groupId)
			if (!Array.isArray(rawGroup.pluginIds)) {
				throw invalid(`group "${groupId}" pluginIds must be an array`)
			}
			const order: string[] = []
			for (const rawPluginId of rawGroup.pluginIds) {
				const pluginId = layoutText('pluginId', rawPluginId)
				if (!knownPlugins.has(pluginId)) throw invalid(`unknown plugin "${pluginId}"`)
				if (desired.has(pluginId)) throw invalid(`plugin "${pluginId}" appears more than once`)
				desired.set(pluginId, groupId)
				order.push(pluginId)
			}
			pluginOrder[groupId] = order
		}

		const assignments: Record<string, string | null> = Object.create(null)
		for (const entry of entries) {
			const desiredGroup = desired.get(entry.id) ?? null
			const defaultGroup = this.defaultGroup(entry, registered)
			if (desiredGroup !== defaultGroup) assignments[entry.id] = desiredGroup
		}

		this.preferences = {
			version: 1,
			assignments,
			groupOrder,
			pluginOrder,
			migratedRuntimeGroups: true,
		}
		await this.save()
		return this.resolveLayout().groups
	}

	private resolveLayout(): {
		groups: WorkbenchPluginGroupLayout[]
		registered: Map<string, RegisteredGroup>
		entries: CatalogEntry[]
	} {
		const entries = this.catalogEntries()
		const registered = this.registeredGroups(entries)
		const members = new Map<string, string[]>()
		for (const groupId of registered.keys()) members.set(groupId, [])

		for (const entry of entries) {
			const hasOverride = Object.hasOwn(this.preferences.assignments, entry.id)
			const override = hasOverride ? this.preferences.assignments[entry.id] : undefined
			const groupId =
				override === undefined ? this.defaultGroup(entry, registered) : (override ?? null)
			if (groupId && registered.has(groupId)) members.get(groupId)!.push(entry.id)
		}

		for (const [groupId, pluginIds] of members) {
			const order = this.preferences.pluginOrder[groupId] ?? []
			const rank = new Map(order.map((id, index) => [id, index]))
			pluginIds.sort(
				(a, b) =>
					(rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER) ||
					a.localeCompare(b),
			)
		}

		const preferred = new Map(this.preferences.groupOrder.map((id, index) => [id, index]))
		const hostOrder = new Map(this.hostGroups.map((group, index) => [group.id, index]))
		const groups = [...registered.values()]
			.sort(
				(a, b) =>
					(preferred.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
						(preferred.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
					(hostOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
						(hostOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
					a.name.localeCompare(b.name) ||
					a.id.localeCompare(b.id),
			)
			.map((group) => ({
				groupId: group.id,
				name: group.name,
				pluginIds: members.get(group.id) ?? [],
			}))
		return { groups, registered, entries }
	}

	private catalogEntries(): CatalogEntry[] {
		return runtimePluginStatusOverview(this.root).statuses.map((status) => ({
			id: status.name,
			packageName: status.source.packageName?.trim() || null,
		}))
	}

	private registeredGroups(entries: readonly CatalogEntry[]): Map<string, RegisteredGroup> {
		const groups = new Map<string, RegisteredGroup>()
		for (const group of this.hostGroups) {
			groups.set(group.id, { id: group.id, name: group.name, kind: 'host' })
		}
		for (const entry of entries) {
			if (!entry.packageName || this.matchHostPackage(entry.packageName)) continue
			const id = packageGroupId(entry.packageName)
			groups.set(id, { id, name: entry.packageName, kind: 'package' })
		}
		return groups
	}

	private defaultGroup(
		entry: CatalogEntry,
		registered: ReadonlyMap<string, RegisteredGroup>,
	): string | null {
		const explicit = this.explicitPluginGroups.get(entry.id)
		if (explicit) return explicit
		if (!entry.packageName) return null
		const hostPackage = this.matchHostPackage(entry.packageName)
		if (hostPackage) return hostPackage
		const automatic = packageGroupId(entry.packageName)
		return registered.has(automatic) ? automatic : null
	}

	private matchHostPackage(packageName: string): string | null {
		let best: NormalizedPackagePattern | undefined
		for (const group of this.hostGroups) {
			for (const pattern of group.packages) {
				const matches = pattern.prefix
					? packageName.startsWith(pattern.literal)
					: packageName === pattern.literal
				if (!matches) continue
				if (!best || pattern.literal.length > best.literal.length) best = pattern
			}
		}
		return best?.groupId ?? null
	}

	private async load(): Promise<void> {
		const raw = await this.storage.getText(PREFERENCE_KEY)
		if (raw === undefined) return
		try {
			this.preferences = parsePreferences(JSON.parse(raw) as unknown)
		} catch (error) {
			this.root.logger.warn('Workbench plugin catalog preferences are invalid; using defaults', {
				error,
			})
		}
	}

	private async migrateRuntimeGroups(): Promise<void> {
		if (this.preferences.migratedRuntimeGroups) return
		const registeredHostIds = new Set(this.hostGroups.map((group) => group.id))
		const knownPlugins = new Set(this.catalogEntries().map((entry) => entry.id))
		const membershipCounts = new Map<string, number>()
		for (const legacy of this.root.runtimeState.snapshot().pluginGroups) {
			if (!registeredHostIds.has(legacy.groupId)) continue
			for (const pluginId of legacy.pluginIds) {
				if (!knownPlugins.has(pluginId)) continue
				membershipCounts.set(pluginId, (membershipCounts.get(pluginId) ?? 0) + 1)
			}
		}
		for (const legacy of this.root.runtimeState.snapshot().pluginGroups) {
			if (!registeredHostIds.has(legacy.groupId)) continue
			const order: string[] = []
			for (const pluginId of legacy.pluginIds) {
				if (!knownPlugins.has(pluginId) || membershipCounts.get(pluginId) !== 1) continue
				this.preferences.assignments[pluginId] = legacy.groupId
				order.push(pluginId)
			}
			if (order.length > 0) this.preferences.pluginOrder[legacy.groupId] = order
		}
		this.preferences.migratedRuntimeGroups = true
		await this.save().catch((error: unknown) => {
			this.root.logger.warn('Workbench plugin catalog migration could not be persisted', { error })
		})
	}

	private async save(): Promise<void> {
		const content = JSON.stringify(this.preferences)
		this.writeQueue = this.writeQueue
			.catch((): void => undefined)
			.then(() => this.storage.put(PREFERENCE_KEY, content))
		await this.writeQueue
	}
}

function readPluginGroups(config: unknown): readonly WorkbenchPluginGroupConfig[] {
	if (!config || config === false || typeof config !== 'object') return []
	const groups = (config as Exclude<WorkbenchConfig, false>).pluginGroups
	return Array.isArray(groups) ? groups : []
}

function normalizeHostGroups(
	input: readonly WorkbenchPluginGroupConfig[],
): readonly NormalizedHostGroup[] {
	const groupIds = new Set<string>()
	const pluginOwners = new Map<string, string>()
	const patternOwners = new Map<string, string>()
	return input.map((raw, index) => {
		const at = `workbench.pluginGroups[${index}]`
		const id = requiredText(`${at}.id`, raw.id)
		const name = requiredText(`${at}.name`, raw.name)
		if (id.startsWith(PACKAGE_GROUP_PREFIX)) {
			throw new TypeError(`${at}.id cannot use reserved prefix "${PACKAGE_GROUP_PREFIX}"`)
		}
		if (groupIds.has(id)) throw new TypeError(`${at}.id duplicates group "${id}"`)
		groupIds.add(id)
		const plugins = uniqueText(raw.plugins ?? [], `${at}.plugins`)
		for (const pluginId of plugins) {
			const previous = pluginOwners.get(pluginId)
			if (previous) throw new TypeError(`${at}.plugins assigns "${pluginId}" to both groups`)
			pluginOwners.set(pluginId, id)
		}
		const packages = uniqueText(raw.packages ?? [], `${at}.packages`).map((pattern) => {
			const firstWildcard = pattern.indexOf('*')
			if (firstWildcard >= 0 && firstWildcard !== pattern.length - 1) {
				throw new TypeError(`${at}.packages only supports one trailing "*"`)
			}
			if (firstWildcard >= 0 && pattern.includes('*', firstWildcard + 1)) {
				throw new TypeError(`${at}.packages only supports one trailing "*"`)
			}
			const literal = firstWildcard < 0 ? pattern : pattern.slice(0, -1)
			if (!literal) throw new TypeError(`${at}.packages cannot use a bare "*"`)
			const collisionKey = literal
			const previous = patternOwners.get(collisionKey)
			if (previous) throw new TypeError(`${at}.packages duplicates a rule from "${previous}"`)
			patternOwners.set(collisionKey, id)
			return { groupId: id, literal, prefix: firstWildcard >= 0 }
		})
		return Object.freeze({ id, name, plugins, packages })
	})
}

function parsePreferences(input: unknown): PluginCatalogPreferences {
	const out = emptyPreferences()
	if (!input || typeof input !== 'object' || Array.isArray(input)) return out
	const raw = input as Record<string, unknown>
	if (raw.version !== 1) return out
	if (raw.assignments && typeof raw.assignments === 'object' && !Array.isArray(raw.assignments)) {
		for (const [pluginId, groupId] of Object.entries(raw.assignments)) {
			if (!pluginId || (groupId !== null && typeof groupId !== 'string')) continue
			out.assignments[pluginId] = groupId
		}
	}
	if (Array.isArray(raw.groupOrder)) {
		out.groupOrder = uniqueStrings(raw.groupOrder)
	}
	if (raw.pluginOrder && typeof raw.pluginOrder === 'object' && !Array.isArray(raw.pluginOrder)) {
		for (const [groupId, order] of Object.entries(raw.pluginOrder)) {
			if (Array.isArray(order)) out.pluginOrder[groupId] = uniqueStrings(order)
		}
	}
	out.migratedRuntimeGroups = raw.migratedRuntimeGroups === true
	return out
}

function emptyPreferences(): PluginCatalogPreferences {
	return {
		version: 1,
		assignments: Object.create(null),
		groupOrder: [],
		pluginOrder: Object.create(null),
		migratedRuntimeGroups: false,
	}
}

function packageGroupId(packageName: string): string {
	return `${PACKAGE_GROUP_PREFIX}${packageName}`
}

function invalid(message: string): PluginCatalogLayoutError {
	return new PluginCatalogLayoutError(`[workbench.pluginCatalog] ${message}`)
}

function layoutText(field: string, value: unknown): string {
	if (typeof value !== 'string' || !value.trim()) throw invalid(`${field} must be text`)
	return value.trim()
}

function requiredText(field: string, value: unknown): string {
	if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be text`)
	return value.trim()
}

function uniqueText(input: readonly string[], field: string): string[] {
	if (!Array.isArray(input)) throw new TypeError(`${field} must be an array`)
	const result: string[] = []
	const seen = new Set<string>()
	for (const [index, value] of input.entries()) {
		const text = requiredText(`${field}[${index}]`, value)
		if (seen.has(text)) throw new TypeError(`${field} contains duplicate "${text}"`)
		seen.add(text)
		result.push(text)
	}
	return result
}

function uniqueStrings(input: readonly unknown[]): string[] {
	const result: string[] = []
	const seen = new Set<string>()
	for (const value of input) {
		if (typeof value !== 'string' || !value || seen.has(value)) continue
		seen.add(value)
		result.push(value)
	}
	return result
}
