const DEFINITION_SLOT = Symbol('PluginDefinitionSlot')
const NODE_SLOT = Symbol('PluginNodeSlot')

const ADDRESS_CODEC_VERSION = 1
const MAX_PACKAGE_NAME_BYTES = 214
const MAX_SOURCE_SPACE_BYTES = 64
const MAX_SOURCE_PATH_BYTES = 4096
const MAX_SOURCE_PATH_SEGMENTS = 256
const MAX_EXPORT_NAME_BYTES = 256
const MAX_FORK_ID_BYTES = 64
const MAX_REFERENCE_BYTES = 8192
const MAX_ROUTE_SEGMENTS = 264

const PACKAGE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SOURCE_SPACE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const FORK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const CONTROL_RE = /\p{Cc}/u
const ENCODED_SEPARATOR_RE = /%2f|%5c/i
const textEncoder = new TextEncoder()

export type PluginEntryAddress =
	| Readonly<{ kind: 'package-root'; packageName: string }>
	| Readonly<{ kind: 'source-entry'; sourceSpace: string; path: string }>

export type PluginDefinitionAddress = Readonly<{
	entry: PluginEntryAddress
	exportName: string
}>

export type PluginNodeAddress =
	| Readonly<{ definition: PluginDefinitionAddress; variant: 'default' }>
	| Readonly<{ definition: PluginDefinitionAddress; variant: 'fork'; forkId: string }>

type PluginEntrySlot = Readonly<{ address: PluginEntryAddress }>

export type PluginDefinitionSlot = Readonly<{
	entry: PluginEntrySlot
	exportName: string
	[DEFINITION_SLOT]: true
}>

export type PluginNodeSlot =
	| Readonly<{
			definition: PluginDefinitionSlot
			variant: 'default'
			[NODE_SLOT]: true
	  }>
	| Readonly<{
			definition: PluginDefinitionSlot
			variant: 'fork'
			forkId: string
			[NODE_SLOT]: true
	  }>

export type ParsedPluginNodeRoute = Readonly<{
	nodeAddress: PluginNodeAddress
	consumedSegments: number
}>

function readRecord(input: unknown, label: string): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError(`[pluxel/core] ${label} must be an object`)
	}
	return input as Record<string, unknown>
}

function readText(value: unknown, label: string, maxBytes: number): string {
	if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
		throw new TypeError(
			`[pluxel/core] ${label} must be a non-empty string without surrounding whitespace`,
		)
	}
	if (CONTROL_RE.test(value))
		throw new TypeError(`[pluxel/core] ${label} contains a control character`)
	try {
		encodeURIComponent(value)
	} catch {
		throw new TypeError(`[pluxel/core] ${label} must contain well-formed Unicode`)
	}
	if (utf8Length(value) > maxBytes) {
		throw new TypeError(`[pluxel/core] ${label} exceeds ${maxBytes} UTF-8 bytes`)
	}
	return value
}

function readPackageName(value: unknown): string {
	const packageName = readText(value, 'Plugin package name', MAX_PACKAGE_NAME_BYTES)
	const segments = packageName.split('/')
	const valid = packageName.startsWith('@')
		? segments.length === 2 && /^@[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segments[0]!)
		: segments.length === 1
	if (!valid || !PACKAGE_SEGMENT_RE.test(segments.at(-1)!)) {
		throw new TypeError('[pluxel/core] Plugin package name must be an npm package name')
	}
	return packageName
}

function readSourceSpace(value: unknown): string {
	const sourceSpace = readText(value, 'Plugin source space', MAX_SOURCE_SPACE_BYTES)
	if (!SOURCE_SPACE_RE.test(sourceSpace)) {
		throw new TypeError('[pluxel/core] Plugin source space must match [A-Za-z0-9][A-Za-z0-9._-]*')
	}
	return sourceSpace
}

function readSourcePath(value: unknown): string {
	const path = readText(value, 'Plugin source path', MAX_SOURCE_PATH_BYTES)
	if (path.startsWith('/') || path.endsWith('/') || path.includes('\\')) {
		throw new TypeError('[pluxel/core] Plugin source path must be a relative POSIX path')
	}
	if (path.includes('?') || path.includes('#')) {
		throw new TypeError('[pluxel/core] Plugin source path must not contain query or hash')
	}
	const segments = path.split('/')
	if (
		segments.length > MAX_SOURCE_PATH_SEGMENTS ||
		segments.some((segment) => !segment || segment === '.' || segment === '..')
	) {
		throw new TypeError('[pluxel/core] Plugin source path contains invalid segments')
	}
	return path
}

function readExportName(value: unknown): string {
	const exportName = readText(value, 'Plugin root export name', MAX_EXPORT_NAME_BYTES)
	if (exportName.includes('/') || exportName.includes('\\')) {
		throw new TypeError('[pluxel/core] Plugin root export name must be one path segment')
	}
	return exportName
}

function readForkId(value: unknown): string {
	const forkId = readText(value, 'Plugin fork id', MAX_FORK_ID_BYTES)
	if (!FORK_ID_RE.test(forkId)) {
		throw new TypeError('[pluxel/core] Plugin fork id must match [A-Za-z0-9][A-Za-z0-9._-]*')
	}
	return forkId
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

export function parsePluginEntryAddress(input: unknown): PluginEntryAddress {
	const record = readRecord(input, 'Plugin entry address')
	if (record.kind === 'package-root') {
		assertExactKeys(record, ['kind', 'packageName'], 'Plugin package-root address')
		return Object.freeze({ kind: 'package-root', packageName: readPackageName(record.packageName) })
	}
	if (record.kind === 'source-entry') {
		assertExactKeys(record, ['kind', 'sourceSpace', 'path'], 'Plugin source-entry address')
		return Object.freeze({
			kind: 'source-entry',
			sourceSpace: readSourceSpace(record.sourceSpace),
			path: readSourcePath(record.path),
		})
	}
	throw new TypeError(
		'[pluxel/core] Plugin entry address kind must be package-root or source-entry',
	)
}

export function parsePluginDefinitionAddress(input: unknown): PluginDefinitionAddress {
	const record = readRecord(input, 'Plugin definition address')
	assertExactKeys(record, ['entry', 'exportName'], 'Plugin definition address')
	return Object.freeze({
		entry: parsePluginEntryAddress(record.entry),
		exportName: readExportName(record.exportName),
	})
}

export function parsePluginNodeAddress(input: unknown): PluginNodeAddress {
	const record = readRecord(input, 'Plugin node address')
	if (record.variant === 'default') {
		assertExactKeys(record, ['definition', 'variant'], 'Default Plugin node address')
		return Object.freeze({
			definition: parsePluginDefinitionAddress(record.definition),
			variant: 'default',
		})
	}
	if (record.variant === 'fork') {
		assertExactKeys(record, ['definition', 'variant', 'forkId'], 'Fork Plugin node address')
		return Object.freeze({
			definition: parsePluginDefinitionAddress(record.definition),
			variant: 'fork',
			forkId: readForkId(record.forkId),
		})
	}
	throw new TypeError('[pluxel/core] Plugin node variant must be default or fork')
}

export class PluginSlotRegistry {
	private readonly packageEntries = new Map<string, PluginEntrySlot>()
	private readonly sourceEntries = new Map<string, Map<string, PluginEntrySlot>>()
	private readonly definitions = new WeakMap<PluginEntrySlot, Map<string, PluginDefinitionSlot>>()
	private readonly defaultNodes = new WeakMap<PluginDefinitionSlot, PluginNodeSlot>()
	private readonly forkNodes = new WeakMap<PluginDefinitionSlot, Map<string, PluginNodeSlot>>()
	private readonly ownedDefinitions = new WeakSet<PluginDefinitionSlot>()
	private readonly ownedNodes = new WeakSet<PluginNodeSlot>()

	internDefinition(input: PluginDefinitionAddress): PluginDefinitionSlot {
		const address = parsePluginDefinitionAddress(input)
		return this.internParsedDefinition(address)
	}

	internNode(input: PluginNodeAddress): PluginNodeSlot {
		const address = parsePluginNodeAddress(input)
		const definition = this.internParsedDefinition(address.definition)
		return address.variant === 'default'
			? this.defaultNode(definition)
			: this.forkNode(definition, address.forkId)
	}

	defaultNode(definition: PluginDefinitionSlot): PluginNodeSlot {
		this.assertOwnedDefinition(definition)
		const existing = this.defaultNodes.get(definition)
		if (existing) return existing
		const slot = Object.freeze({
			definition,
			variant: 'default' as const,
			[NODE_SLOT]: true as const,
		})
		this.defaultNodes.set(definition, slot)
		this.ownedNodes.add(slot)
		return slot
	}

	forkNode(definition: PluginDefinitionSlot, forkId: string): PluginNodeSlot {
		this.assertOwnedDefinition(definition)
		const normalized = readForkId(forkId)
		let byId = this.forkNodes.get(definition)
		if (!byId) {
			byId = new Map()
			this.forkNodes.set(definition, byId)
		}
		const existing = byId.get(normalized)
		if (existing) return existing
		const slot = Object.freeze({
			definition,
			variant: 'fork' as const,
			forkId: normalized,
			[NODE_SLOT]: true as const,
		})
		byId.set(normalized, slot)
		this.ownedNodes.add(slot)
		return slot
	}

	definitionAddress(slot: PluginDefinitionSlot): PluginDefinitionAddress {
		this.assertOwnedDefinition(slot)
		return Object.freeze({ entry: slot.entry.address, exportName: slot.exportName })
	}

	nodeAddress(slot: PluginNodeSlot): PluginNodeAddress {
		if (!this.ownedNodes.has(slot)) {
			throw new TypeError('[pluxel/core] Plugin node slot belongs to another registry')
		}
		const definition = this.definitionAddress(slot.definition)
		return slot.variant === 'default'
			? Object.freeze({ definition, variant: 'default' as const })
			: Object.freeze({ definition, variant: 'fork' as const, forkId: slot.forkId })
	}

	private internParsedDefinition(address: PluginDefinitionAddress): PluginDefinitionSlot {
		const entry = this.internParsedEntry(address.entry)
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
		this.ownedDefinitions.add(slot)
		return slot
	}

	private internParsedEntry(address: PluginEntryAddress): PluginEntrySlot {
		if (address.kind === 'package-root') {
			const existing = this.packageEntries.get(address.packageName)
			if (existing) return existing
			const slot = Object.freeze({ address })
			this.packageEntries.set(address.packageName, slot)
			return slot
		}
		let byPath = this.sourceEntries.get(address.sourceSpace)
		if (!byPath) {
			byPath = new Map()
			this.sourceEntries.set(address.sourceSpace, byPath)
		}
		const existing = byPath.get(address.path)
		if (existing) return existing
		const slot = Object.freeze({ address })
		byPath.set(address.path, slot)
		return slot
	}

	private assertOwnedDefinition(definition: PluginDefinitionSlot): void {
		if (!this.ownedDefinitions.has(definition)) {
			throw new TypeError('[pluxel/core] Plugin definition slot belongs to another registry')
		}
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

export function pluginDefinitionAddressEqual(
	leftAddress: PluginDefinitionAddress,
	rightAddress: PluginDefinitionAddress,
): boolean {
	const leftEntry = leftAddress.entry
	const rightEntry = rightAddress.entry
	return (
		leftAddress.exportName === rightAddress.exportName &&
		leftEntry.kind === rightEntry.kind &&
		(leftEntry.kind === 'package-root'
			? rightEntry.kind === 'package-root' && leftEntry.packageName === rightEntry.packageName
			: rightEntry.kind === 'source-entry' &&
				leftEntry.sourceSpace === rightEntry.sourceSpace &&
				leftEntry.path === rightEntry.path)
	)
}

export function pluginNodeAddressEqual(
	leftAddress: PluginNodeAddress,
	rightAddress: PluginNodeAddress,
): boolean {
	return (
		leftAddress.variant === rightAddress.variant &&
		pluginDefinitionAddressEqual(leftAddress.definition, rightAddress.definition) &&
		(leftAddress.variant === 'default' ||
			(rightAddress.variant === 'fork' && leftAddress.forkId === rightAddress.forkId))
	)
}

export function comparePluginDefinitionAddress(
	leftAddress: PluginDefinitionAddress,
	rightAddress: PluginDefinitionAddress,
): number {
	return compareBytes(
		encodePluginDefinitionAddressBytes(leftAddress),
		encodePluginDefinitionAddressBytes(rightAddress),
	)
}

export function comparePluginNodeAddress(
	leftAddress: PluginNodeAddress,
	rightAddress: PluginNodeAddress,
): number {
	return compareBytes(
		encodePluginNodeAddressBytes(leftAddress),
		encodePluginNodeAddressBytes(rightAddress),
	)
}

export function encodePluginDefinitionAddressBytes(
	definitionAddress: PluginDefinitionAddress,
): Uint8Array {
	const entry = definitionAddress.entry
	return entry.kind === 'package-root'
		? encodeFields(0x11, [entry.packageName, definitionAddress.exportName])
		: encodeFields(0x12, [entry.sourceSpace, entry.path, definitionAddress.exportName])
}

export function encodePluginNodeAddressBytes(nodeAddress: PluginNodeAddress): Uint8Array {
	const entry = nodeAddress.definition.entry
	const fields =
		entry.kind === 'package-root'
			? [entry.packageName, nodeAddress.definition.exportName]
			: [entry.sourceSpace, entry.path, nodeAddress.definition.exportName]
	if (nodeAddress.variant === 'fork') fields.push(nodeAddress.forkId)
	const tag =
		entry.kind === 'package-root'
			? nodeAddress.variant === 'default'
				? 0x21
				: 0x22
			: nodeAddress.variant === 'default'
				? 0x23
				: 0x24
	return encodeFields(tag, fields)
}

export function pluginDefinitionIndexKey(definitionAddress: PluginDefinitionAddress): string {
	return bytesToHex(encodePluginDefinitionAddressBytes(definitionAddress))
}

export function pluginNodeIndexKey(nodeAddress: PluginNodeAddress): string {
	return bytesToHex(encodePluginNodeAddressBytes(nodeAddress))
}

export function formatPluginDefinitionReference(
	definitionAddress: PluginDefinitionAddress,
): string {
	const entry = definitionAddress.entry
	const provenance =
		entry.kind === 'package-root'
			? `package:${entry.packageName.split('/').map(encodeSegment).join('/')}`
			: `source:${[entry.sourceSpace, ...entry.path.split('/')].map(encodeSegment).join('/')}`
	return `${provenance}::${encodeSegment(definitionAddress.exportName)}`
}

export function formatPluginNodeReference(nodeAddress: PluginNodeAddress): string {
	const definition = formatPluginDefinitionReference(nodeAddress.definition)
	return nodeAddress.variant === 'default'
		? definition
		: `${definition}#fork=${encodeSegment(nodeAddress.forkId)}`
}

export function parsePluginDefinitionReference(input: string): PluginDefinitionAddress {
	const value = readReference(input)
	if (value.includes('#fork=')) {
		throw new TypeError('[pluxel/core] Plugin definition reference must not contain a fork')
	}
	return parseDefinitionReferenceBody(value)
}

export function parsePluginNodeReference(input: string): PluginNodeAddress {
	const value = readReference(input)
	const forkMarker = '#fork='
	const forkOffset = value.indexOf(forkMarker)
	if (forkOffset === -1) {
		return Object.freeze({
			definition: parseDefinitionReferenceBody(value),
			variant: 'default',
		})
	}
	if (forkOffset !== value.lastIndexOf(forkMarker)) {
		throw new TypeError('[pluxel/core] Plugin node reference contains multiple fork markers')
	}
	const definition = parseDefinitionReferenceBody(value.slice(0, forkOffset))
	const forkId = decodeSegment(value.slice(forkOffset + forkMarker.length), 'Plugin fork id')
	return parsePluginNodeAddress({ definition, variant: 'fork', forkId })
}

export function formatPluginNodeRoute(nodeAddress: PluginNodeAddress): string {
	const segments = ['v1']
	if (nodeAddress.variant === 'fork') segments.push('fork', encodeSegment(nodeAddress.forkId))
	const entry = nodeAddress.definition.entry
	segments.push(entry.kind === 'package-root' ? 'package' : 'source')
	segments.push(encodeSegment(nodeAddress.definition.exportName))
	if (entry.kind === 'package-root') {
		segments.push(...entry.packageName.split('/').map(encodeSegment))
	} else {
		const pathSegments = entry.path.split('/')
		segments.push(encodeSegment(entry.sourceSpace), String(pathSegments.length))
		segments.push(...pathSegments.map(encodeSegment))
	}
	return segments.join('/')
}

export function parsePluginNodeRoute(rawSegments: readonly string[]): ParsedPluginNodeRoute {
	if (rawSegments.length > MAX_ROUTE_SEGMENTS) {
		throw new TypeError('[pluxel/core] Plugin node route has too many segments')
	}
	let offset = 0
	if (rawSegments[offset++] !== 'v1') {
		throw new TypeError('[pluxel/core] Plugin node route version must be v1')
	}
	let forkId: string | undefined
	if (rawSegments[offset] === 'fork') {
		offset += 1
		forkId = decodeSegment(rawSegments[offset++] ?? '', 'Plugin fork id')
	}
	const kind = rawSegments[offset++]
	if (kind !== 'package' && kind !== 'source') {
		throw new TypeError('[pluxel/core] Plugin node route kind must be package or source')
	}
	const exportName = decodeSegment(rawSegments[offset++] ?? '', 'Plugin root export name')
	let entry: PluginEntryAddress
	if (kind === 'package') {
		const first = decodeSegment(rawSegments[offset++] ?? '', 'Plugin package name')
		const packageName = first.startsWith('@')
			? `${first}/${decodeSegment(rawSegments[offset++] ?? '', 'Plugin package name')}`
			: first
		entry = parsePluginEntryAddress({ kind: 'package-root', packageName })
	} else {
		const sourceSpace = decodeSegment(rawSegments[offset++] ?? '', 'Plugin source space')
		const rawCount = rawSegments[offset++] ?? ''
		if (!/^[1-9][0-9]*$/.test(rawCount)) {
			throw new TypeError('[pluxel/core] Plugin source route path count must be canonical')
		}
		const count = Number(rawCount)
		if (!Number.isSafeInteger(count) || count > MAX_SOURCE_PATH_SEGMENTS) {
			throw new TypeError('[pluxel/core] Plugin source route path count is out of range')
		}
		if (offset + count > rawSegments.length) {
			throw new TypeError('[pluxel/core] Plugin source route is missing path segments')
		}
		const path = rawSegments
			.slice(offset, offset + count)
			.map((segment) => decodeSegment(segment, 'Plugin source path'))
			.join('/')
		offset += count
		entry = parsePluginEntryAddress({ kind: 'source-entry', sourceSpace, path })
	}
	const definition = parsePluginDefinitionAddress({ entry, exportName })
	const nodeAddress =
		forkId === undefined
			? parsePluginNodeAddress({ definition, variant: 'default' })
			: parsePluginNodeAddress({ definition, variant: 'fork', forkId })
	return Object.freeze({ nodeAddress, consumedSegments: offset })
}

function parseDefinitionReferenceBody(value: string): PluginDefinitionAddress {
	const separator = '::'
	const separatorOffset = value.indexOf(separator)
	if (separatorOffset <= 0 || separatorOffset !== value.lastIndexOf(separator)) {
		throw new TypeError('[pluxel/core] Plugin reference must contain one :: separator')
	}
	const provenance = value.slice(0, separatorOffset)
	const exportName = decodeSegment(
		value.slice(separatorOffset + separator.length),
		'Plugin root export name',
	)
	let entry: PluginEntryAddress
	if (provenance.startsWith('package:')) {
		const rawSegments = provenance.slice('package:'.length).split('/')
		const packageName = rawSegments
			.map((segment) => decodeSegment(segment, 'Plugin package name'))
			.join('/')
		entry = parsePluginEntryAddress({ kind: 'package-root', packageName })
	} else if (provenance.startsWith('source:')) {
		const rawSegments = provenance.slice('source:'.length).split('/')
		if (rawSegments.length < 2) {
			throw new TypeError('[pluxel/core] Plugin source reference must contain a path')
		}
		const sourceSpace = decodeSegment(rawSegments[0]!, 'Plugin source space')
		const path = rawSegments
			.slice(1)
			.map((segment) => decodeSegment(segment, 'Plugin source path'))
			.join('/')
		entry = parsePluginEntryAddress({ kind: 'source-entry', sourceSpace, path })
	} else {
		throw new TypeError('[pluxel/core] Plugin reference must start with package: or source:')
	}
	return parsePluginDefinitionAddress({ entry, exportName })
}

function readReference(input: string): string {
	if (typeof input !== 'string' || input.length === 0 || input.trim() !== input) {
		throw new TypeError('[pluxel/core] Plugin reference must be a non-empty trimmed string')
	}
	if (CONTROL_RE.test(input) || utf8Length(input) > MAX_REFERENCE_BYTES) {
		throw new TypeError('[pluxel/core] Plugin reference is invalid or too long')
	}
	return input
}

function encodeSegment(value: string): string {
	return encodeURIComponent(value)
		.replaceAll(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
		.replaceAll('%40', '@')
}

function decodeSegment(raw: string, label: string): string {
	if (!raw || raw === '.' || raw === '..' || raw.includes('/') || raw.includes('\\')) {
		throw new TypeError(`[pluxel/core] ${label} route segment is invalid`)
	}
	if (ENCODED_SEPARATOR_RE.test(raw)) {
		throw new TypeError(`[pluxel/core] ${label} route segment contains an encoded separator`)
	}
	let decoded: string
	try {
		decoded = decodeURIComponent(raw)
	} catch {
		throw new TypeError(`[pluxel/core] ${label} route segment has invalid percent encoding`)
	}
	if (encodeSegment(decoded) !== raw) {
		throw new TypeError(`[pluxel/core] ${label} route segment is not canonical`)
	}
	if (CONTROL_RE.test(decoded)) {
		throw new TypeError(`[pluxel/core] ${label} route segment contains a control character`)
	}
	return decoded
}

function utf8Length(value: string): number {
	return textEncoder.encode(value).length
}

function encodeFields(tag: number, fields: readonly string[]): Uint8Array {
	const encodedFields = fields.map((field) => textEncoder.encode(field))
	const length = 2 + encodedFields.reduce((sum, field) => sum + 4 + field.length, 0)
	const output = new Uint8Array(length)
	const view = new DataView(output.buffer)
	output[0] = ADDRESS_CODEC_VERSION
	output[1] = tag
	let offset = 2
	for (const field of encodedFields) {
		view.setUint32(offset, field.length)
		offset += 4
		output.set(field, offset)
		offset += field.length
	}
	return output
}

function bytesToHex(bytes: Uint8Array): string {
	let output = ''
	for (const byte of bytes) output += byte.toString(16).padStart(2, '0')
	return output
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
	const length = Math.min(left.length, right.length)
	for (let index = 0; index < length; index += 1) {
		const difference = left[index]! - right[index]!
		if (difference !== 0) return difference
	}
	return left.length - right.length
}
