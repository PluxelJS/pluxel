import {
	formatPluginDefinitionReference,
	parsePluginDefinitionAddress,
	parsePluginNodeAddress,
	pluginDefinitionIndexKey,
	pluginNodeIndexKey,
	type Context,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import { PersistenceError, type PersistenceNamespace } from '../persistence/PersistenceService'

const PREFERENCE_KEY = 'plugin-catalog.json'

export type PluginCatalogSectionBasis =
	| Readonly<{ kind: 'provider'; definition: PluginDefinitionAddress }>
	| Readonly<{ kind: 'package'; packageName: string }>
	| Readonly<{ kind: 'source-directory'; sourceSpace: string; path: string }>

export type PluginCatalogSectionLayout = Readonly<{
	sectionId: string
	name: string
	basis: PluginCatalogSectionBasis
	nodes: readonly PluginNodeAddress[]
}>

export type PluginCatalogLayoutEntry = Readonly<{
	address: PluginNodeAddress
	provides?: PluginDefinitionAddress
}>

export type PluginCatalogSectionInput = Readonly<{
	sectionId: string
	nodes: readonly PluginNodeAddress[]
}>

type PluginCatalogPreferencesSnapshot = Readonly<{
	version: 4
	placements: readonly Readonly<{
		definition: PluginDefinitionAddress
		sectionId: string | null
	}>[]
	sectionOrder: readonly string[]
	definitionOrder: readonly Readonly<{
		sectionId: string
		definitions: readonly PluginDefinitionAddress[]
	}>[]
}>

type PluginCatalogPreferences = {
	placements: Map<
		string,
		Readonly<{ definition: PluginDefinitionAddress; sectionId: string | null }>
	>
	sectionOrder: string[]
	definitionOrder: Map<string, PluginDefinitionAddress[]>
}

type CatalogEntry = Readonly<{
	address: PluginNodeAddress
	nodeKey: string
	definition: PluginDefinitionAddress
	definitionKey: string
	section: RegisteredSection
}>

type RegisteredSection = Readonly<{
	id: string
	name: string
	basis: PluginCatalogSectionBasis
}>

export class PluginCatalogLayoutError extends Error {
	readonly code = 'INVALID_PLUGIN_CATALOG_LAYOUT'

	constructor(message: string) {
		super(message)
		this.name = 'PluginCatalogLayoutError'
	}
}

/** Management-owned preferences over sections derived exclusively from immutable catalog facts. */
export class PluginCatalogLayoutService {
	readonly ready: Promise<void>

	private readonly storage: PersistenceNamespace
	private preferences: PluginCatalogPreferences = emptyPreferences()
	private mutationTail: Promise<void> = Promise.resolve()

	constructor(root: Context) {
		this.storage = root.root.persistence.namespace('management')
		this.ready = this.load()
	}

	async listSections(
		input: readonly PluginCatalogLayoutEntry[],
	): Promise<readonly PluginCatalogSectionLayout[]> {
		await this.ready
		await this.mutationTail
		return this.resolveLayout(normalizeEntries(input)).sections
	}

	updateSections(
		sections: readonly PluginCatalogSectionInput[],
		input: readonly PluginCatalogLayoutEntry[],
	): Promise<readonly PluginCatalogSectionLayout[]> {
		const task = this.mutationTail
			.catch((): void => undefined)
			.then(async () => {
				await this.ready
				return await this.applyUpdate(sections, normalizeEntries(input))
			})
		this.mutationTail = task.then(
			(): void => undefined,
			(): void => undefined,
		)
		return task
	}

	private async applyUpdate(
		sections: readonly PluginCatalogSectionInput[],
		entries: CatalogEntry[],
	): Promise<readonly PluginCatalogSectionLayout[]> {
		if (!Array.isArray(sections)) throw invalid('sections must be an array')
		const current = this.resolveLayout(entries)
		const knownNodes = new Set(entries.map((entry) => entry.nodeKey))
		const seenNodes = new Set<string>()
		const desired = new Map<string, string>()
		const sectionOrder: string[] = []
		const definitionOrder = new Map<string, PluginDefinitionAddress[]>()

		for (const rawSection of sections) {
			if (!rawSection || typeof rawSection !== 'object' || Array.isArray(rawSection)) {
				throw invalid('every section must be an object')
			}
			const sectionId = layoutText('sectionId', rawSection.sectionId)
			if (!current.registered.has(sectionId)) throw invalid(`unknown section "${sectionId}"`)
			if (sectionOrder.includes(sectionId)) throw invalid(`duplicate section "${sectionId}"`)
			sectionOrder.push(sectionId)
			if (!Array.isArray(rawSection.nodes)) {
				throw invalid(`section "${sectionId}" nodes must be an array`)
			}

			const order: PluginDefinitionAddress[] = []
			for (const rawNode of rawSection.nodes) {
				let node: PluginNodeAddress
				try {
					node = parsePluginNodeAddress(rawNode)
				} catch (error) {
					throw invalid(`section "${sectionId}" contains an invalid Plugin node address`, error)
				}
				const nodeKey = pluginNodeIndexKey(node)
				if (!knownNodes.has(nodeKey)) {
					throw invalid(`section "${sectionId}" contains an unknown Plugin node`)
				}
				if (seenNodes.has(nodeKey)) throw invalid('a Plugin node cannot appear more than once')
				seenNodes.add(nodeKey)

				const definitionKey = pluginDefinitionIndexKey(node.definition)
				const previousSection = desired.get(definitionKey)
				if (previousSection && previousSection !== sectionId) {
					throw invalid('fork variants of one Plugin definition cannot be split across sections')
				}
				if (!previousSection) {
					desired.set(definitionKey, sectionId)
					order.push(node.definition)
				}
			}
			definitionOrder.set(sectionId, order)
		}

		const placements = new Map(this.preferences.placements)
		for (const entry of uniqueDefinitionEntries(entries)) {
			placements.delete(entry.definitionKey)
			const desiredSection = desired.get(entry.definitionKey) ?? null
			const defaultSection = entry.section.id
			if (desiredSection !== defaultSection) {
				placements.set(entry.definitionKey, {
					definition: entry.definition,
					sectionId: desiredSection,
				})
			}
		}

		this.preferences = { placements, sectionOrder, definitionOrder }
		await this.save()
		return this.resolveLayout(entries).sections
	}

	private resolveLayout(entries: CatalogEntry[]): {
		sections: readonly PluginCatalogSectionLayout[]
		registered: Map<string, RegisteredSection>
	} {
		const registered = registeredSections(entries)
		const members = new Map<string, CatalogEntry[]>()
		for (const sectionId of registered.keys()) members.set(sectionId, [])

		for (const entry of entries) {
			const override = this.preferences.placements.get(entry.definitionKey)
			const preferredSection = override?.sectionId
			const sectionId =
				preferredSection === null
					? null
					: preferredSection && registered.has(preferredSection)
						? preferredSection
						: entry.section.id
			if (sectionId) members.get(sectionId)!.push(entry)
		}

		for (const [sectionId, memberEntries] of members) {
			const order = this.preferences.definitionOrder.get(sectionId) ?? []
			const rank = new Map(
				order.map((definition, index) => [pluginDefinitionIndexKey(definition), index]),
			)
			memberEntries.sort(
				(left, right) =>
					(rank.get(left.definitionKey) ?? Number.MAX_SAFE_INTEGER) -
						(rank.get(right.definitionKey) ?? Number.MAX_SAFE_INTEGER) ||
					left.nodeKey.localeCompare(right.nodeKey),
			)
		}

		const preferred = new Map(this.preferences.sectionOrder.map((id, index) => [id, index]))
		const sections = Object.freeze(
			[...registered.values()]
				.sort(
					(left, right) =>
						(preferred.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
							(preferred.get(right.id) ?? Number.MAX_SAFE_INTEGER) ||
						sectionKindRank(left.basis.kind) - sectionKindRank(right.basis.kind) ||
						left.name.localeCompare(right.name) ||
						left.id.localeCompare(right.id),
				)
				.map((section) =>
					Object.freeze({
						sectionId: section.id,
						name: section.name,
						basis: section.basis,
						nodes: Object.freeze((members.get(section.id) ?? []).map((entry) => entry.address)),
					}),
				),
		)
		return { sections, registered }
	}

	private async load(): Promise<void> {
		const raw = await this.storage.getText(PREFERENCE_KEY)
		if (raw === undefined) return
		this.preferences = preferencesFromSnapshot(parsePreferencesSnapshot(JSON.parse(raw) as unknown))
	}

	private async save(): Promise<void> {
		const content = JSON.stringify(preferencesSnapshot(this.preferences))
		try {
			await this.storage.put(PREFERENCE_KEY, content)
		} catch (error) {
			if (error instanceof PersistenceError) throw error
			throw new PersistenceError(
				'IO',
				'[management.pluginCatalogLayout] Failed to persist Plugin catalog layout preferences',
				{ cause: error },
			)
		}
	}
}

function normalizeEntries(input: readonly PluginCatalogLayoutEntry[]): CatalogEntry[] {
	if (!Array.isArray(input)) throw new TypeError('Plugin catalog layout entries must be an array')
	const seenNodes = new Set<string>()
	const sectionsByDefinition = new Map<string, RegisteredSection>()
	return input.map((entry) => {
		const address = parsePluginNodeAddress(entry.address)
		const definition = address.definition
		const nodeKey = pluginNodeIndexKey(address)
		if (seenNodes.has(nodeKey)) {
			throw new TypeError('Plugin catalog layout entries contain a duplicate Plugin node')
		}
		seenNodes.add(nodeKey)
		const definitionKey = pluginDefinitionIndexKey(definition)
		const provides =
			entry.provides === undefined ? undefined : parsePluginDefinitionAddress(entry.provides)
		const section = deriveDefaultSection(definition, provides)
		const existingSection = sectionsByDefinition.get(definitionKey)
		if (existingSection && !sameSection(existingSection, section)) {
			throw new TypeError(
				'Plugin catalog layout entries contain inconsistent facts for one Plugin definition',
			)
		}
		sectionsByDefinition.set(definitionKey, section)
		return Object.freeze({
			address,
			nodeKey,
			definition,
			definitionKey,
			section,
		})
	})
}

function registeredSections(entries: readonly CatalogEntry[]): Map<string, RegisteredSection> {
	const sections = new Map<string, RegisteredSection>()
	for (const entry of uniqueDefinitionEntries(entries)) {
		const section = entry.section
		const previous = sections.get(section.id)
		if (previous && !sameSection(previous, section)) {
			throw new Error('[management.pluginCatalogLayout] derived section identity collision')
		}
		sections.set(section.id, section)
	}
	return sections
}

function deriveDefaultSection(
	definition: PluginDefinitionAddress,
	provides?: PluginDefinitionAddress,
): RegisteredSection {
	if (provides) {
		return Object.freeze({
			id: `provider:${formatPluginDefinitionReference(provides)}`,
			name: provides.exportName,
			basis: Object.freeze({ kind: 'provider', definition: provides }),
		})
	}
	const origin = definition.entry
	if (origin.kind === 'package-root') {
		return Object.freeze({
			id: `package:${origin.packageName}`,
			name: origin.packageName,
			basis: Object.freeze({ kind: 'package', packageName: origin.packageName }),
		})
	}
	const slash = origin.path.lastIndexOf('/')
	const directory = slash < 0 ? '' : origin.path.slice(0, slash)
	return Object.freeze({
		id: sourceSectionId(origin.sourceSpace, directory),
		name: directory ? directory.slice(directory.lastIndexOf('/') + 1) : origin.sourceSpace,
		basis: Object.freeze({
			kind: 'source-directory',
			sourceSpace: origin.sourceSpace,
			path: directory,
		}),
	})
}

function sourceSectionId(sourceSpace: string, path: string): string {
	const encodedPath = path
		.split('/')
		.filter(Boolean)
		.map((segment) => encodeURIComponent(segment))
		.join('/')
	return `source:${encodeURIComponent(sourceSpace)}${encodedPath ? `/${encodedPath}` : ''}`
}

function sameSection(left: RegisteredSection, right: RegisteredSection): boolean {
	if (left.id !== right.id || left.name !== right.name || left.basis.kind !== right.basis.kind) {
		return false
	}
	if (left.basis.kind === 'provider' && right.basis.kind === 'provider') {
		return (
			pluginDefinitionIndexKey(left.basis.definition) ===
			pluginDefinitionIndexKey(right.basis.definition)
		)
	}
	if (left.basis.kind === 'package' && right.basis.kind === 'package') {
		return left.basis.packageName === right.basis.packageName
	}
	return (
		left.basis.kind === 'source-directory' &&
		right.basis.kind === 'source-directory' &&
		left.basis.sourceSpace === right.basis.sourceSpace &&
		left.basis.path === right.basis.path
	)
}

function sectionKindRank(kind: PluginCatalogSectionBasis['kind']): number {
	if (kind === 'provider') return 0
	if (kind === 'source-directory') return 1
	return 2
}

function parsePreferencesSnapshot(input: unknown): PluginCatalogPreferencesSnapshot {
	const raw = exactRecord(
		input,
		['version', 'placements', 'sectionOrder', 'definitionOrder'],
		'preferences',
	)
	if (raw.version !== 4) {
		throw new TypeError('[management.pluginCatalogLayout] preferences version must be 4')
	}
	if (!Array.isArray(raw.placements)) {
		throw new TypeError('[management.pluginCatalogLayout] placements must be an array')
	}
	if (!Array.isArray(raw.sectionOrder)) {
		throw new TypeError('[management.pluginCatalogLayout] sectionOrder must be an array')
	}
	if (!Array.isArray(raw.definitionOrder)) {
		throw new TypeError('[management.pluginCatalogLayout] definitionOrder must be an array')
	}

	const seenPlacements = new Set<string>()
	const placements = raw.placements.map((inputPlacement, index) => {
		const placement = exactRecord(
			inputPlacement,
			['definition', 'sectionId'],
			`placements[${index}]`,
		)
		const definition = parsePluginDefinitionAddress(placement.definition)
		const key = pluginDefinitionIndexKey(definition)
		if (seenPlacements.has(key)) throw new TypeError('placements contains a duplicate definition')
		seenPlacements.add(key)
		const sectionId =
			placement.sectionId === null
				? null
				: requiredText(`placements[${index}].sectionId`, placement.sectionId)
		return Object.freeze({ definition, sectionId })
	})

	const sectionOrder = strictUniqueStrings(raw.sectionOrder, 'sectionOrder')
	const seenOrderSections = new Set<string>()
	const orderedDefinitions = new Set<string>()
	const definitionOrder = raw.definitionOrder.map((inputOrder, index) => {
		const order = exactRecord(inputOrder, ['sectionId', 'definitions'], `definitionOrder[${index}]`)
		const sectionId = requiredText(`definitionOrder[${index}].sectionId`, order.sectionId)
		if (seenOrderSections.has(sectionId)) {
			throw new TypeError(`duplicate definitionOrder section "${sectionId}"`)
		}
		seenOrderSections.add(sectionId)
		if (!Array.isArray(order.definitions)) {
			throw new TypeError(`definitionOrder[${index}].definitions must be an array`)
		}
		const definitions = order.definitions.map((inputDefinition) => {
			const definition = parsePluginDefinitionAddress(inputDefinition)
			const key = pluginDefinitionIndexKey(definition)
			if (orderedDefinitions.has(key)) {
				throw new TypeError('definitionOrder contains a duplicate Plugin definition')
			}
			orderedDefinitions.add(key)
			return definition
		})
		return Object.freeze({ sectionId, definitions: Object.freeze(definitions) })
	})

	return Object.freeze({
		version: 4,
		placements: Object.freeze(placements),
		sectionOrder: Object.freeze(sectionOrder),
		definitionOrder: Object.freeze(definitionOrder),
	})
}

function preferencesFromSnapshot(
	snapshot: PluginCatalogPreferencesSnapshot,
): PluginCatalogPreferences {
	return {
		placements: new Map(
			snapshot.placements.map(({ definition, sectionId }) => [
				pluginDefinitionIndexKey(definition),
				{ definition, sectionId },
			]),
		),
		sectionOrder: [...snapshot.sectionOrder],
		definitionOrder: new Map(
			snapshot.definitionOrder.map(({ sectionId, definitions }) => [sectionId, [...definitions]]),
		),
	}
}

function preferencesSnapshot(
	preferences: PluginCatalogPreferences,
): PluginCatalogPreferencesSnapshot {
	return Object.freeze({
		version: 4,
		placements: Object.freeze(
			[...preferences.placements.values()].map(({ definition, sectionId }) =>
				Object.freeze({ definition, sectionId }),
			),
		),
		sectionOrder: Object.freeze([...preferences.sectionOrder]),
		definitionOrder: Object.freeze(
			[...preferences.definitionOrder].map(([sectionId, definitions]) =>
				Object.freeze({ sectionId, definitions: Object.freeze([...definitions]) }),
			),
		),
	})
}

function emptyPreferences(): PluginCatalogPreferences {
	return { placements: new Map(), sectionOrder: [], definitionOrder: new Map() }
}

function exactRecord(
	input: unknown,
	keys: readonly string[],
	label: string,
): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError(`[management.pluginCatalogLayout] ${label} must be an object`)
	}
	const record = input as Record<string, unknown>
	const expected = new Set(keys)
	for (const key of Object.keys(record)) {
		if (!expected.has(key)) {
			throw new TypeError(`[management.pluginCatalogLayout] ${label} has unknown field ${key}`)
		}
	}
	for (const key of keys) {
		if (!(key in record)) {
			throw new TypeError(`[management.pluginCatalogLayout] ${label} is missing ${key}`)
		}
	}
	return record
}

function uniqueDefinitionEntries(entries: readonly CatalogEntry[]): CatalogEntry[] {
	const seen = new Set<string>()
	return entries.filter((entry) => {
		if (seen.has(entry.definitionKey)) return false
		seen.add(entry.definitionKey)
		return true
	})
}

function invalid(message: string, cause?: unknown): PluginCatalogLayoutError {
	return new PluginCatalogLayoutError(
		`[management.pluginCatalogLayout] ${message}${cause instanceof Error ? `: ${cause.message}` : ''}`,
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
