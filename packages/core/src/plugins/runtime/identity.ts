const DEFINITION_SLOT = Symbol('PluginDefinitionSlot')
const NODE_SLOT = Symbol('PluginNodeSlot')

export type PluginEntryAddressSnapshot =
	| { readonly kind: 'package-root'; readonly packageName: string }
	| { readonly kind: 'source-entry'; readonly source: string }

export type PluginDefinitionAddressSnapshot = {
	readonly entry: PluginEntryAddressSnapshot
	readonly exportName: string
}

export type PluginNodeAddressSnapshot =
	| {
			readonly definition: PluginDefinitionAddressSnapshot
			readonly instance: 'default'
	  }
	| {
			readonly definition: PluginDefinitionAddressSnapshot
			readonly instance: 'fork'
			readonly forkId: string
	  }

type PluginEntrySlot = Readonly<{
	address: PluginEntryAddressSnapshot
}>

export type PluginDefinitionSlot = Readonly<{
	readonly entry: PluginEntrySlot
	readonly exportName: string
	readonly [DEFINITION_SLOT]: true
}>

export type PluginNodeSlot = Readonly<{
	readonly definition: PluginDefinitionSlot
	readonly instance: 'default' | 'fork'
	readonly forkId?: string
	readonly [NODE_SLOT]: true
}>

function readRecord(input: unknown, label: string): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError(`[pluxel/core] ${label} must be an object`)
	}
	return input as Record<string, unknown>
}

function readNonEmptyString(value: unknown, label: string): string {
	if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
		throw new TypeError(
			`[pluxel/core] ${label} must be a non-empty string without surrounding whitespace`,
		)
	}
	return value
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string) {
	const expected = new Set(keys)
	for (const key of Object.keys(record)) {
		if (!expected.has(key)) throw new TypeError(`[pluxel/core] ${label} has unknown field ${key}`)
	}
	for (const key of keys) {
		if (!(key in record)) throw new TypeError(`[pluxel/core] ${label} is missing field ${key}`)
	}
}

export function parsePluginEntryAddress(input: unknown): PluginEntryAddressSnapshot {
	const record = readRecord(input, 'Plugin entry address')
	if (record.kind === 'package-root') {
		assertExactKeys(record, ['kind', 'packageName'], 'Plugin package-root address')
		return Object.freeze({
			kind: 'package-root',
			packageName: readNonEmptyString(record.packageName, 'Plugin package name'),
		})
	}
	if (record.kind === 'source-entry') {
		assertExactKeys(record, ['kind', 'source'], 'Plugin source-entry address')
		return Object.freeze({
			kind: 'source-entry',
			source: readNonEmptyString(record.source, 'Plugin source locator'),
		})
	}
	throw new TypeError(
		'[pluxel/core] Plugin entry address kind must be package-root or source-entry',
	)
}

export function parsePluginDefinitionAddress(input: unknown): PluginDefinitionAddressSnapshot {
	const record = readRecord(input, 'Plugin definition address')
	assertExactKeys(record, ['entry', 'exportName'], 'Plugin definition address')
	return Object.freeze({
		entry: parsePluginEntryAddress(record.entry),
		exportName: readNonEmptyString(record.exportName, 'Plugin root export name'),
	})
}

export function parsePluginNodeAddress(input: unknown): PluginNodeAddressSnapshot {
	const record = readRecord(input, 'Plugin node address')
	if (record.instance === 'default') {
		assertExactKeys(record, ['definition', 'instance'], 'Default Plugin node address')
		return Object.freeze({
			definition: parsePluginDefinitionAddress(record.definition),
			instance: 'default',
		})
	}
	if (record.instance === 'fork') {
		assertExactKeys(record, ['definition', 'instance', 'forkId'], 'Fork Plugin node address')
		return Object.freeze({
			definition: parsePluginDefinitionAddress(record.definition),
			instance: 'fork',
			forkId: readNonEmptyString(record.forkId, 'Plugin fork id'),
		})
	}
	throw new TypeError('[pluxel/core] Plugin node instance must be default or fork')
}

export const createPluginEntryAddress = parsePluginEntryAddress
export const createPluginDefinitionAddress = parsePluginDefinitionAddress
export const createPluginNodeAddress = parsePluginNodeAddress

export class PluginSlotRegistry {
	private readonly packageEntries = new Map<string, PluginEntrySlot>()
	private readonly sourceEntries = new Map<string, PluginEntrySlot>()
	private readonly definitions = new WeakMap<PluginEntrySlot, Map<string, PluginDefinitionSlot>>()
	private readonly defaultNodes = new WeakMap<PluginDefinitionSlot, PluginNodeSlot>()
	private readonly forkNodes = new WeakMap<PluginDefinitionSlot, Map<string, PluginNodeSlot>>()

	internDefinition(input: PluginDefinitionAddressSnapshot): PluginDefinitionSlot {
		const address = parsePluginDefinitionAddress(input)
		const entry = this.internEntry(address.entry)
		let byExport = this.definitions.get(entry)
		if (!byExport) {
			byExport = new Map()
			this.definitions.set(entry, byExport)
		}
		const existing = byExport.get(address.exportName)
		if (existing) return existing
		const slot = Object.freeze({
			entry,
			exportName: address.exportName,
			[DEFINITION_SLOT]: true as const,
		})
		byExport.set(address.exportName, slot)
		return slot
	}

	internNode(input: PluginNodeAddressSnapshot): PluginNodeSlot {
		const address = parsePluginNodeAddress(input)
		const definition = this.internDefinition(address.definition)
		return address.instance === 'default'
			? this.defaultNode(definition)
			: this.forkNode(definition, address.forkId)
	}

	defaultNode(definition: PluginDefinitionSlot): PluginNodeSlot {
		const existing = this.defaultNodes.get(definition)
		if (existing) return existing
		const slot = Object.freeze({
			definition,
			instance: 'default' as const,
			[NODE_SLOT]: true as const,
		})
		this.defaultNodes.set(definition, slot)
		return slot
	}

	forkNode(definition: PluginDefinitionSlot, forkId: string): PluginNodeSlot {
		const normalized = readNonEmptyString(forkId, 'Plugin fork id')
		let byId = this.forkNodes.get(definition)
		if (!byId) {
			byId = new Map()
			this.forkNodes.set(definition, byId)
		}
		const existing = byId.get(normalized)
		if (existing) return existing
		const slot = Object.freeze({
			definition,
			instance: 'fork' as const,
			forkId: normalized,
			[NODE_SLOT]: true as const,
		})
		byId.set(normalized, slot)
		return slot
	}

	definitionAddress(slot: PluginDefinitionSlot): PluginDefinitionAddressSnapshot {
		return Object.freeze({ entry: slot.entry.address, exportName: slot.exportName })
	}

	nodeAddress(slot: PluginNodeSlot): PluginNodeAddressSnapshot {
		const definition = this.definitionAddress(slot.definition)
		return slot.instance === 'default'
			? Object.freeze({ definition, instance: 'default' as const })
			: Object.freeze({ definition, instance: 'fork' as const, forkId: slot.forkId! })
	}

	private internEntry(input: PluginEntryAddressSnapshot): PluginEntrySlot {
		const address = parsePluginEntryAddress(input)
		const map = address.kind === 'package-root' ? this.packageEntries : this.sourceEntries
		const key = address.kind === 'package-root' ? address.packageName : address.source
		const existing = map.get(key)
		if (existing) return existing
		const slot = Object.freeze({ address })
		map.set(key, slot)
		return slot
	}
}

export function isPluginDefinitionSlot(value: unknown): value is PluginDefinitionSlot {
	return (
		!!value &&
		typeof value === 'object' &&
		(value as Partial<PluginDefinitionSlot>)[DEFINITION_SLOT] === true
	)
}

export function isPluginNodeSlot(value: unknown): value is PluginNodeSlot {
	return (
		!!value && typeof value === 'object' && (value as Partial<PluginNodeSlot>)[NODE_SLOT] === true
	)
}

export function formatPluginDefinitionAddress(address: PluginDefinitionAddressSnapshot): string {
	const normalized = parsePluginDefinitionAddress(address)
	const entry = normalized.entry
	return `${entry.kind === 'package-root' ? entry.packageName : entry.source}::${normalized.exportName}`
}

export function formatPluginNodeAddress(address: PluginNodeAddressSnapshot): string {
	const normalized = parsePluginNodeAddress(address)
	const definition = formatPluginDefinitionAddress(normalized.definition)
	return normalized.instance === 'default'
		? definition
		: `${definition} (fork ${normalized.forkId})`
}

export function pluginDefinitionAddressEqual(
	left: PluginDefinitionAddressSnapshot,
	right: PluginDefinitionAddressSnapshot,
): boolean {
	return (
		left.exportName === right.exportName &&
		left.entry.kind === right.entry.kind &&
		(left.entry.kind === 'package-root'
			? right.entry.kind === 'package-root' && left.entry.packageName === right.entry.packageName
			: right.entry.kind === 'source-entry' && left.entry.source === right.entry.source)
	)
}

export function pluginNodeAddressEqual(
	left: PluginNodeAddressSnapshot,
	right: PluginNodeAddressSnapshot,
): boolean {
	return (
		left.instance === right.instance &&
		pluginDefinitionAddressEqual(left.definition, right.definition) &&
		(left.instance === 'default' || (right.instance === 'fork' && left.forkId === right.forkId))
	)
}
