import {
	parsePluginNodeAddress,
	type Context,
	type PluginNodeAddressSnapshot,
	type PluginNodeSlot,
} from '@pluxel/core'
import type { WorkbenchConfig, WorkbenchPluginGroupConfig } from '../../workbench-config'
import { runtimePluginStatusOverview } from '../../runtime/capabilities'
import type { PersistenceNamespace } from '../persistence/PersistenceService'

const PACKAGE_GROUP_PREFIX = 'package:'
const PREFERENCE_KEY = 'plugin-catalog.json'

export type WorkbenchPluginGroupLayout = Readonly<{
	groupId: string
	name: string
	nodes: readonly PluginNodeAddressSnapshot[]
}>

type PluginCatalogPreferencesSnapshot = Readonly<{
	version: 2
	assignments: readonly Readonly<{
		owner: PluginNodeAddressSnapshot
		groupId: string | null
	}>[]
	groupOrder: readonly string[]
	pluginOrder: readonly Readonly<{
		groupId: string
		owners: readonly PluginNodeAddressSnapshot[]
	}>[]
}>

type PluginCatalogPreferences = {
	assignments: Map<PluginNodeSlot, string | null>
	groupOrder: string[]
	pluginOrder: Map<string, PluginNodeSlot[]>
}

type NormalizedPackagePattern = Readonly<{
	groupId: string
	literal: string
	prefix: boolean
}>

type NormalizedHostGroup = Readonly<{
	id: string
	name: string
	nodes: readonly PluginNodeSlot[]
	packages: readonly NormalizedPackagePattern[]
}>

type CatalogEntry = Readonly<{
	slot: PluginNodeSlot
	address: PluginNodeAddressSnapshot
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
	private readonly explicitNodeGroups = new Map<PluginNodeSlot, string>()
	private readonly storage: PersistenceNamespace
	private preferences: PluginCatalogPreferences = emptyPreferences()
	private writeQueue: Promise<void> = Promise.resolve()

	constructor(private readonly root: Context) {
		this.hostGroups = normalizeHostGroups(root, readPluginGroups(root.config.workbench))
		for (const group of this.hostGroups) {
			for (const node of group.nodes) this.explicitNodeGroups.set(node, group.id)
		}
		this.storage = root.root.persistence.namespace('workbench')
		this.ready = this.load()
	}

	async listGroups(): Promise<WorkbenchPluginGroupLayout[]> {
		await this.ready
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
		const current = this.resolveLayout()
		const registered = current.registered
		const entries = current.entries
		const knownNodes = new Set(entries.map((entry) => entry.slot))
		const desired = new Map<PluginNodeSlot, string>()
		const groupOrder: string[] = []
		const pluginOrder = new Map<string, PluginNodeSlot[]>()

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
			if (!Array.isArray(rawGroup.nodes)) {
				throw invalid(`group "${groupId}" nodes must be an array`)
			}
			const order: PluginNodeSlot[] = []
			for (const rawOwner of rawGroup.nodes) {
				let owner: PluginNodeAddressSnapshot
				try {
					owner = parsePluginNodeAddress(rawOwner)
				} catch (error) {
					throw invalid(`group "${groupId}" contains an invalid Plugin node address`, error)
				}
				const slot = this.root.registry.internNodeAddress(owner)
				if (!knownNodes.has(slot))
					throw invalid(`group "${groupId}" contains an unknown Plugin node`)
				if (desired.has(slot)) throw invalid('a Plugin node appears more than once')
				desired.set(slot, groupId)
				order.push(slot)
			}
			pluginOrder.set(groupId, order)
		}

		const assignments = new Map<PluginNodeSlot, string | null>()
		for (const entry of entries) {
			const desiredGroup = desired.get(entry.slot) ?? null
			const defaultGroup = this.defaultGroup(entry, registered)
			if (desiredGroup !== defaultGroup) assignments.set(entry.slot, desiredGroup)
		}

		this.preferences = { assignments, groupOrder, pluginOrder }
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
		const members = new Map<string, CatalogEntry[]>()
		for (const groupId of registered.keys()) members.set(groupId, [])

		for (const entry of entries) {
			const hasOverride = this.preferences.assignments.has(entry.slot)
			const override = this.preferences.assignments.get(entry.slot)
			const groupId = hasOverride ? (override ?? null) : this.defaultGroup(entry, registered)
			if (groupId && registered.has(groupId)) members.get(groupId)!.push(entry)
		}

		for (const [groupId, memberEntries] of members) {
			const order = this.preferences.pluginOrder.get(groupId) ?? []
			const rank = new Map(order.map((slot, index) => [slot, index]))
			memberEntries.sort(
				(a, b) =>
					(rank.get(a.slot) ?? Number.MAX_SAFE_INTEGER) -
						(rank.get(b.slot) ?? Number.MAX_SAFE_INTEGER) ||
					addressSortKey(a.address).localeCompare(addressSortKey(b.address)),
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
				nodes: Object.freeze((members.get(group.id) ?? []).map((entry) => entry.address)),
			}))
		return { groups, registered, entries }
	}

	private catalogEntries(): CatalogEntry[] {
		return runtimePluginStatusOverview(this.root).statuses.map((status) => ({
			slot: this.root.registry.internNodeAddress(status.address),
			address: status.address,
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
		const explicit = this.explicitNodeGroups.get(entry.slot)
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
		const snapshot = parsePreferencesSnapshot(JSON.parse(raw) as unknown)
		this.preferences = preferencesFromSnapshot(this.root, snapshot)
	}

	private async save(): Promise<void> {
		const content = JSON.stringify(preferencesSnapshot(this.root, this.preferences))
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
	root: Context,
	input: readonly WorkbenchPluginGroupConfig[],
): readonly NormalizedHostGroup[] {
	const groupIds = new Set<string>()
	const nodeOwners = new Map<PluginNodeSlot, string>()
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
		const nodes = (raw.nodes ?? []).map((owner, ownerIndex) => {
			let address: PluginNodeAddressSnapshot
			try {
				address = parsePluginNodeAddress(owner)
			} catch (error) {
				throw new TypeError(`${at}.nodes[${ownerIndex}] is not a valid Plugin node address`, {
					cause: error,
				})
			}
			const slot = root.registry.internNodeAddress(address)
			const previous = nodeOwners.get(slot)
			if (previous) throw new TypeError(`${at}.nodes assigns one Plugin node to both groups`)
			nodeOwners.set(slot, id)
			return slot
		})
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
			const previous = patternOwners.get(literal)
			if (previous) throw new TypeError(`${at}.packages duplicates a rule from "${previous}"`)
			patternOwners.set(literal, id)
			return { groupId: id, literal, prefix: firstWildcard >= 0 }
		})
		return Object.freeze({ id, name, nodes: Object.freeze(nodes), packages })
	})
}

function parsePreferencesSnapshot(input: unknown): PluginCatalogPreferencesSnapshot {
	if (
		!input ||
		typeof input !== 'object' ||
		Array.isArray(input) ||
		(input as Record<string, unknown>).version !== 2
	) {
		throw new TypeError('[workbench.pluginCatalog] preferences version must be 2')
	}
	const raw = exactRecord(
		input,
		['version', 'assignments', 'groupOrder', 'pluginOrder'],
		'preferences',
	)
	if (!Array.isArray(raw.assignments)) {
		throw new TypeError('[workbench.pluginCatalog] assignments must be an array')
	}
	if (!Array.isArray(raw.groupOrder)) {
		throw new TypeError('[workbench.pluginCatalog] groupOrder must be an array')
	}
	if (!Array.isArray(raw.pluginOrder)) {
		throw new TypeError('[workbench.pluginCatalog] pluginOrder must be an array')
	}
	const assignmentKeys = new Set<string>()
	const assignments = raw.assignments.map((inputAssignment, index) => {
		const assignment = exactRecord(inputAssignment, ['owner', 'groupId'], `assignments[${index}]`)
		const owner = parsePluginNodeAddress(assignment.owner)
		const key = addressSortKey(owner)
		if (assignmentKeys.has(key)) throw new TypeError('duplicate preference assignment owner')
		assignmentKeys.add(key)
		let groupId: string | null
		if (assignment.groupId === null) groupId = null
		else if (typeof assignment.groupId === 'string') groupId = assignment.groupId
		else {
			throw new TypeError(`assignments[${index}].groupId must be string or null`)
		}
		return Object.freeze({ owner, groupId })
	})
	const groupOrder = strictUniqueStrings(raw.groupOrder, 'groupOrder')
	const orderGroups = new Set<string>()
	const pluginOrder = raw.pluginOrder.map((inputOrder, index) => {
		const order = exactRecord(inputOrder, ['groupId', 'owners'], `pluginOrder[${index}]`)
		const groupId = requiredText(`pluginOrder[${index}].groupId`, order.groupId)
		if (orderGroups.has(groupId)) throw new TypeError(`duplicate pluginOrder group "${groupId}"`)
		orderGroups.add(groupId)
		if (!Array.isArray(order.owners)) {
			throw new TypeError(`pluginOrder[${index}].owners must be an array`)
		}
		const ownerKeys = new Set<string>()
		const owners = order.owners.map((owner) => {
			const address = parsePluginNodeAddress(owner)
			const key = addressSortKey(address)
			if (ownerKeys.has(key)) throw new TypeError(`pluginOrder[${index}] has a duplicate owner`)
			ownerKeys.add(key)
			return address
		})
		return Object.freeze({ groupId, owners: Object.freeze(owners) })
	})
	return Object.freeze({
		version: 2,
		assignments: Object.freeze(assignments),
		groupOrder: Object.freeze(groupOrder),
		pluginOrder: Object.freeze(pluginOrder),
	})
}

function preferencesFromSnapshot(
	root: Context,
	snapshot: PluginCatalogPreferencesSnapshot,
): PluginCatalogPreferences {
	return {
		assignments: new Map(
			snapshot.assignments.map(({ owner, groupId }) => [
				root.registry.internNodeAddress(owner),
				groupId,
			]),
		),
		groupOrder: [...snapshot.groupOrder],
		pluginOrder: new Map(
			snapshot.pluginOrder.map(({ groupId, owners }) => [
				groupId,
				owners.map((owner) => root.registry.internNodeAddress(owner)),
			]),
		),
	}
}

function preferencesSnapshot(
	root: Context,
	preferences: PluginCatalogPreferences,
): PluginCatalogPreferencesSnapshot {
	return {
		version: 2,
		assignments: [...preferences.assignments].map(([owner, groupId]) => ({
			owner: root.registry.nodeAddressOf(owner),
			groupId,
		})),
		groupOrder: [...preferences.groupOrder],
		pluginOrder: [...preferences.pluginOrder].map(([groupId, owners]) => ({
			groupId,
			owners: owners.map((owner) => root.registry.nodeAddressOf(owner)),
		})),
	}
}

function emptyPreferences(): PluginCatalogPreferences {
	return { assignments: new Map(), groupOrder: [], pluginOrder: new Map() }
}

function exactRecord(
	input: unknown,
	keys: readonly string[],
	label: string,
): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError(`[workbench.pluginCatalog] ${label} must be an object`)
	}
	const record = input as Record<string, unknown>
	const expected = new Set(keys)
	for (const key of Object.keys(record)) {
		if (!expected.has(key))
			throw new TypeError(`[workbench.pluginCatalog] ${label} has unknown field ${key}`)
	}
	for (const key of keys) {
		if (!(key in record))
			throw new TypeError(`[workbench.pluginCatalog] ${label} is missing ${key}`)
	}
	return record
}

function addressSortKey(address: PluginNodeAddressSnapshot): string {
	const entry = address.definition.entry
	return JSON.stringify([
		entry.kind,
		entry.kind === 'package-root' ? entry.packageName : entry.source,
		address.definition.exportName,
		address.instance,
		address.instance === 'fork' ? address.forkId : null,
	])
}

function packageGroupId(packageName: string): string {
	return `${PACKAGE_GROUP_PREFIX}${packageName}`
}

function invalid(message: string, cause?: unknown): PluginCatalogLayoutError {
	return new PluginCatalogLayoutError(
		`[workbench.pluginCatalog] ${message}${cause instanceof Error ? `: ${cause.message}` : ''}`,
	)
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

function strictUniqueStrings(input: readonly unknown[], field: string): string[] {
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
