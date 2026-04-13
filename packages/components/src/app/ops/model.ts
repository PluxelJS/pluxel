import type { OpsToolset, RuntimeOpCatalogEntry } from '@pluxel/runtime/web'

export type RuntimeOpInputMode = 'none' | 'json-object' | 'unsupported'

export type OpsExplorerSelection =
	| { kind: 'all' }
	| { kind: 'toolset'; toolsetId: string }
	| { kind: 'ungrouped' }
	| { kind: 'runtime' }
	| { kind: 'owner'; owner: string }

export type OpsExplorerSidebarData = {
	counts: {
		all: number
		runtime: number
	}
	owners: Array<{
		owner: string
		label: string
		count: number
	}>
}

export type OpsExplorerToolsetSummary = {
	toolsetId: string
	name: string
	description?: string
	availableCount: number
	missingCount: number
}

export type OpsExplorerCatalogView = {
	missingOpIds: string[]
	entries: RuntimeOpCatalogEntry[]
}

export const createOpsToolsetId = () =>
	globalThis.crypto?.randomUUID?.() ??
	`ops_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

export function normalizeOpsToolsetName(value: string): string {
	return value.trim()
}

export function getRuntimeOpInputMode(entry: RuntimeOpCatalogEntry): RuntimeOpInputMode {
	const schema = entry.descriptor.schemas.input as {
		type?: unknown
		properties?: Record<string, unknown>
		required?: unknown
	} | null
	if (!schema || schema.type !== 'object') return 'unsupported'
	const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {}
	const required = Array.isArray(schema.required) ? schema.required : []
	if (Object.keys(properties).length === 0 && required.length === 0) return 'none'
	return 'json-object'
}

export function createInitialRuntimeOpInput(
	entry: RuntimeOpCatalogEntry,
	opts?: { pluginName?: string },
): string {
	const schema = entry.descriptor.schemas.input as {
		type?: unknown
		properties?: Record<string, { type?: unknown }>
		required?: unknown
	} | null
	if (!schema || schema.type !== 'object') return ''

	const required = new Set(
		Array.isArray(schema.required)
			? schema.required.filter((value): value is string => typeof value === 'string')
			: [],
	)
	const properties =
		schema.properties && typeof schema.properties === 'object' ? schema.properties : {}
	const draft: Record<string, unknown> = {}
	const pluginName = opts?.pluginName ?? entry.pluginId

	if (required.has('name') && properties.name?.type === 'string' && pluginName) {
		draft.name = pluginName
	}

	return JSON.stringify(draft, null, 2)
}

function compareEntries(left: RuntimeOpCatalogEntry, right: RuntimeOpCatalogEntry): number {
	const leftTitle = left.descriptor.doc.title ?? left.id
	const rightTitle = right.descriptor.doc.title ?? right.id
	return leftTitle.localeCompare(rightTitle) || left.id.localeCompare(right.id)
}

export function sortRuntimeOpCatalogEntries(
	entries: RuntimeOpCatalogEntry[],
): RuntimeOpCatalogEntry[] {
	return [...entries].sort(compareEntries)
}

function matchesSearch(entry: RuntimeOpCatalogEntry, search: string): boolean {
	if (!search) return true
	const title = entry.descriptor.doc.title ?? ''
	const description = entry.descriptor.doc.description ?? ''
	const triggerText = entry.descriptor.transports.cli?.triggers.join(' ') ?? ''
	const inputKeys = entry.descriptor.params?.map((param) => param.inputKey).join(' ') ?? ''
	const haystack = [entry.id, entry.owner, title, description, triggerText, inputKeys]
		.join(' ')
		.toLowerCase()
	return haystack.includes(search)
}

function ownerLabel(owner: string): string {
	return owner.startsWith('plugin:') ? owner.slice('plugin:'.length) : owner
}

export function getOwnerLabel(owner: string): string {
	return ownerLabel(owner)
}

export function buildOpsExplorerSidebarData(entries: RuntimeOpCatalogEntry[]): OpsExplorerSidebarData {
	let runtime = 0
	const ownerCounts = new Map<string, number>()

	for (const entry of entries) {
		if (entry.ownerKind === 'runtime') runtime += 1
		if (entry.ownerKind !== 'plugin') continue
		ownerCounts.set(entry.owner, (ownerCounts.get(entry.owner) ?? 0) + 1)
	}

	return {
		counts: {
			all: entries.length,
			runtime,
		},
		owners: [...ownerCounts.entries()]
			.map(([owner, count]) => ({ owner, label: ownerLabel(owner), count }))
			.sort((left, right) => left.label.localeCompare(right.label) || left.owner.localeCompare(right.owner)),
	}
}

export function buildOpsToolsetSummaries(
	toolsets: OpsToolset[],
	entries: RuntimeOpCatalogEntry[],
): OpsExplorerToolsetSummary[] {
	const known = new Set(entries.map((entry) => entry.id))
	return toolsets
		.map((toolset) => {
			let availableCount = 0
			let missingCount = 0
			for (const opId of toolset.opIds) {
				if (known.has(opId)) {
					availableCount += 1
					continue
				}
				missingCount += 1
			}
			return {
				toolsetId: toolset.toolsetId,
				name: toolset.name,
				description: toolset.description,
				availableCount,
				missingCount,
			}
		})
		.sort((left, right) => left.name.localeCompare(right.name) || left.toolsetId.localeCompare(right.toolsetId))
}

function buildToolsetCatalogView(
	entries: RuntimeOpCatalogEntry[],
	toolset: OpsToolset,
	search: string,
): OpsExplorerCatalogView {
	const normalizedSearch = search.trim().toLowerCase()
	const byId = new Map(entries.map((entry) => [entry.id, entry]))
	const missingOpIds: string[] = []
	const visibleEntries: RuntimeOpCatalogEntry[] = []

	for (const opId of toolset.opIds) {
		const entry = byId.get(opId)
		if (!entry) {
			missingOpIds.push(opId)
			continue
		}
		if (!matchesSearch(entry, normalizedSearch)) continue
		visibleEntries.push(entry)
	}

	return {
		missingOpIds,
		entries: sortRuntimeOpCatalogEntries(visibleEntries),
	}
}

export function buildOpsToolsetMembershipMap(
	toolsets: OpsToolset[],
): Map<string, OpsToolset[]> {
	const membership = new Map<string, OpsToolset[]>()
	for (const toolset of toolsets) {
		for (const opId of toolset.opIds) {
			const current = membership.get(opId) ?? []
			current.push(toolset)
			membership.set(opId, current)
		}
	}
	for (const [opId, owned] of membership) {
		membership.set(
			opId,
			[...owned].sort((left, right) => left.name.localeCompare(right.name) || left.toolsetId.localeCompare(right.toolsetId)),
		)
	}
	return membership
}

export function buildOpsExplorerCatalogView(
	entries: RuntimeOpCatalogEntry[],
	options: {
		selection: OpsExplorerSelection
		search: string
		toolsets: OpsToolset[]
	},
): OpsExplorerCatalogView {
	const normalizedSearch = options.search.trim().toLowerCase()
	const selection = options.selection
	if (selection.kind === 'toolset') {
		const target = options.toolsets.find((toolset) => toolset.toolsetId === selection.toolsetId)
		return target ? buildToolsetCatalogView(entries, target, normalizedSearch) : { entries: [], missingOpIds: [] }
	}

	const groupedOpIds = new Set(options.toolsets.flatMap((toolset) => toolset.opIds))
	return {
		missingOpIds: [],
		entries: sortRuntimeOpCatalogEntries(
			entries.filter((entry) => {
				if (!matchesSearch(entry, normalizedSearch)) return false
				switch (selection.kind) {
					case 'all':
						return true
					case 'ungrouped':
						return !groupedOpIds.has(entry.id)
					case 'runtime':
						return entry.ownerKind === 'runtime'
					case 'owner':
						return entry.owner === selection.owner
				}
			}),
		),
	}
}
