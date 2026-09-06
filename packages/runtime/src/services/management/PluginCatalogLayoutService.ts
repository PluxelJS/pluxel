import {
	formatPluginDefinitionReference,
	parsePluginDefinitionReference,
	parsePluginNodeAddress,
	pluginNodeIndexKey,
	type Context,
	type PluginNodeAddress,
} from '@pluxel/core'
import { PersistenceError, type PersistenceNamespace } from '../persistence/PersistenceService'
import {
	automaticCatalogGroups,
	catalogFamilies,
	type CatalogFamily,
	type CatalogGroup,
	type PluginCatalogLayoutEntry,
} from './catalog-groups'
import type { PluginCatalogSectionBasis } from '../../web/protocol'

export type { PluginCatalogLayoutEntry, PluginCatalogSectionBasis }
export type PluginCatalogSectionLayout = Readonly<CatalogGroup>
export type PluginCatalogSectionInput = Readonly<{
	sectionId: string
	name: string
	nodes: readonly PluginNodeAddress[]
}>

type GroupDocument = {
	version: 1
	groups: { id: string; name: string; plugins: string[] }[]
	ungrouped: string[]
}
const FILE = 'plugin-groups.json'
const emptyDocument = (): GroupDocument => ({ version: 1, groups: [], ungrouped: [] })
const manualId = (id: string) => `manual:${encodeURIComponent(id)}`

export class PluginCatalogLayoutError extends Error {
	readonly code = 'INVALID_PLUGIN_CATALOG_LAYOUT'
	constructor(message: string) {
		super(message)
		this.name = 'PluginCatalogLayoutError'
	}
}

/** Management owns the document; reads never create catalog nodes or write generated defaults. */
export class PluginCatalogLayoutService {
	private readonly storage: PersistenceNamespace
	private document = emptyDocument()
	private source: string | undefined
	private tail: Promise<unknown> = Promise.resolve()

	constructor(root: Context) {
		this.storage = root.root.persistence.namespace('management')
	}

	listSections(
		input: readonly PluginCatalogLayoutEntry[],
	): Promise<readonly PluginCatalogSectionLayout[]> {
		return this.serial(async () => {
			await this.refresh()
			return resolveGroups(this.document, catalogFamilies(input))
		})
	}

	updateSections(
		sections: readonly PluginCatalogSectionInput[] | null,
		input: readonly PluginCatalogLayoutEntry[],
	): Promise<readonly PluginCatalogSectionLayout[]> {
		return this.serial(async () => {
			const families = catalogFamilies(input)
			if (sections === null) {
				const next = emptyDocument()
				await this.persist(next)
				return resolveGroups(next, families)
			}
			await this.refresh()
			const knownNodes = new Set(input.map((entry) => pluginNodeIndexKey(entry.address)))
			const seenNodes = new Set<string>()
			const assigned = new Map<string, string>()
			const seenIds = new Set<string>()
			const previous = new Map(this.document.groups.map((group) => [manualId(group.id), group]))
			if (!Array.isArray(sections)) throw invalid('sections must be an array')
			const groups = sections.map((section) => {
				const sectionId = text(section.sectionId, 'sectionId')
				const old = previous.get(sectionId)
				// Auto sections become explicit groups on save; manually supplied keys remain readable.
				const id =
					old?.id ?? (sectionId.startsWith('manual:') ? decodeManualId(sectionId) : sectionId)
				if (seenIds.has(id)) throw invalid('duplicate section')
				seenIds.add(id)
				const name = text(section.name, 'name')
				if (!Array.isArray(section.nodes)) throw invalid('nodes must be an array')
				const plugins: string[] = []
				for (const rawNode of section.nodes) {
					const node = parsePluginNodeAddress(rawNode)
					const key = pluginNodeIndexKey(node)
					if (!knownNodes.has(key)) throw invalid('unknown Plugin node')
					if (seenNodes.has(key)) throw invalid('duplicate Plugin node')
					seenNodes.add(key)
					const ref = formatPluginDefinitionReference(node.definition)
					const target = assigned.get(ref)
					if (target !== undefined && target !== id)
						throw invalid('fork variants cannot be split across sections')
					if (target === undefined) plugins.push(ref)
					assigned.set(ref, id)
				}
				// A snapshot omits absent plugins. Preserve their placement in surviving groups.
				plugins.push(...(old?.plugins.filter((ref) => !families.has(ref)) ?? []))
				return { id, name, plugins }
			})
			for (const family of families.values()) {
				if (
					assigned.has(family.reference) &&
					family.nodes.some((node) => !seenNodes.has(pluginNodeIndexKey(node)))
				) {
					throw invalid('fork variants cannot be split between a section and ungrouped')
				}
			}
			const ungrouped = [
				...this.document.ungrouped.filter((ref) => !families.has(ref)),
				...[...families.keys()].filter((ref) => !assigned.has(ref)).sort(),
			]
			const next = parseDocument({ version: 1, groups, ungrouped })
			await this.persist(next)
			return resolveGroups(next, families)
		})
	}

	private async persist(next: GroupDocument): Promise<void> {
		const content = `${JSON.stringify(next, null, 2)}\n`
		if (content.length > 2_000_000) throw invalid('group file exceeds 2 MB')
		try {
			await this.storage.put(FILE, content, { atomic: true })
		} catch (cause) {
			if (cause instanceof PersistenceError) throw cause
			throw new PersistenceError('IO', 'Failed to persist Plugin groups', { cause })
		}
		this.document = next
		this.source = content
	}

	private serial<T>(operation: () => Promise<T>): Promise<T> {
		const task = this.tail.then(operation, operation)
		this.tail = task.then(
			(): void => undefined,
			(): void => undefined,
		)
		return task
	}

	private async refresh(): Promise<void> {
		const source = await this.storage.getText(FILE)
		if (source === this.source) return
		if (source !== undefined && source.length > 2_000_000) throw invalid('group file exceeds 2 MB')
		const next =
			source === undefined ? emptyDocument() : parseDocument(JSON.parse(source) as unknown)
		this.document = next
		this.source = source
	}
}

function resolveGroups(
	document: GroupDocument,
	families: Map<string, CatalogFamily>,
): CatalogGroup[] {
	const remaining = new Map(families)
	for (const ref of document.ungrouped) remaining.delete(ref)
	const groups: CatalogGroup[] = document.groups.map((group) => ({
		sectionId: manualId(group.id),
		name: group.name,
		basis: { kind: 'manual' },
		nodes: group.plugins.flatMap((ref) => {
			remaining.delete(ref)
			return families.get(ref)?.nodes ?? []
		}),
	}))
	return [...groups, ...automaticCatalogGroups(remaining)]
}

function parseDocument(input: unknown): GroupDocument {
	const doc = record(input, ['version', 'groups', 'ungrouped'])
	if (doc.version !== 1) throw invalid('group file version must be 1')
	if (!Array.isArray(doc.groups) || doc.groups.length > 1000)
		throw invalid('groups must be an array of at most 1000 groups')
	const ids = new Set<string>()
	const membership = new Set<string>()
	const references = (values: unknown): string[] => {
		if (!Array.isArray(values)) throw invalid('plugins and ungrouped must be arrays')
		return values.map((value) => {
			const ref = formatPluginDefinitionReference(
				parsePluginDefinitionReference(text(value, 'Plugin reference')),
			)
			if (membership.has(ref)) throw invalid('duplicate Plugin membership')
			membership.add(ref)
			if (membership.size > 10_000) throw invalid('group file exceeds 10000 plugins')
			return ref
		})
	}
	const groups = doc.groups.map((value) => {
		const group = record(value, ['id', 'name', 'plugins'])
		const id = text(group.id, 'group id')
		if (ids.has(id)) throw invalid('duplicate group id')
		ids.add(id)
		return { id, name: text(group.name, 'group name'), plugins: references(group.plugins) }
	})
	return { version: 1, groups, ungrouped: references(doc.ungrouped) }
}
function record(input: unknown, keys: string[]): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input))
		throw invalid('expected an object')
	const result = input as Record<string, unknown>
	if (Object.keys(result).length !== keys.length || keys.some((key) => !Object.hasOwn(result, key)))
		throw invalid(`expected fields: ${keys.join(', ')}`)
	return result
}
function text(input: unknown, label: string): string {
	if (typeof input !== 'string' || !input.trim() || input.length > 16_384)
		throw invalid(`${label} must be non-empty text of at most 16384 characters`)
	return input.trim()
}
function invalid(message: string): PluginCatalogLayoutError {
	return new PluginCatalogLayoutError(`[management.pluginGroups] ${message}`)
}

function decodeManualId(sectionId: string): string {
	try {
		return decodeURIComponent(sectionId.slice(7))
	} catch {
		throw invalid('invalid manual section ID encoding')
	}
}
