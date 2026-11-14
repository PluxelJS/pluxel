import {
	parsePluginDefinitionAddress,
	pluginDefinitionIndexKey,
	type Context,
	type PluginDefinitionAddress,
} from '@pluxel/core'
import { requirePluginHostCoordinator } from '../install'
import {
	parsePluginControlManifest,
	verifyPluginControlMaterial,
	isControlFilePath,
	encodeControlData,
	type PluginControlManifest,
} from '../control-manifest'
import { ScriptExecutionError } from './protocol'

const MAX_MATERIALS = 128
const MAX_BYTES = 64 * 1024 * 1024
export const PLUGIN_CONTROL_CHUNK_BYTES = 32 * 1024
export const PLUGIN_CONTROL_CACHE_MS = 5 * 60 * 1000
const encoder = new TextEncoder()

export type PluginControlMaterialsSnapshot = Readonly<{
	catalogRevision: number
	materials: readonly Readonly<{
		snapshot: string
		manifest: PluginControlManifest
		files: Readonly<Record<string, string>>
	}>[]
	definitions: readonly Readonly<{
		definition: PluginDefinitionAddress
		snapshot: string
		exportName: string
	}>[]
	unavailable: readonly PluginDefinitionAddress[]
}>

/** Read and verify only material attached to the same committed implementation candidates. */
export async function readPluginControlMaterials(
	ctx: Context,
	options?: Readonly<{ signal?: AbortSignal }>,
): Promise<PluginControlMaterialsSnapshot> {
	const catalog = await requirePluginHostCoordinator(ctx).readCommitted(
		(view) => view.catalog,
		options,
	)
	if (catalog.entries.length > 4096)
		throw new ScriptExecutionError(
			'control_material_limit',
			'Control material selection exceeds 4096 definitions',
		)
	const materials = new Map<string, PluginControlMaterialsSnapshot['materials'][number]>()
	const unavailable: PluginDefinitionAddress[] = []
	const definitions: PluginControlMaterialsSnapshot['definitions'][number][] = []
	let bytes = 0
	for (const entry of catalog.entries) {
		options?.signal?.throwIfAborted()
		const control = entry.provenance.control
		if (!control || control.state !== 'available' || !control.material) {
			unavailable.push(entry.address)
			continue
		}
		const material = control.material
		const manifest = parsePluginControlManifest(material.manifest)
		const definition = manifest.definitions.find(
			(item) => pluginDefinitionIndexKey(item.definition) === entry.indexKey,
		)
		if (
			material.snapshot !== manifest.snapshot ||
			!definition ||
			definition.contracts.config !== control.contracts.config ||
			definition.contracts.instance !== control.contracts.instance
		)
			throw new ScriptExecutionError(
				'control_contract_mismatch',
				'Committed control material does not match its implementation candidate',
			)
		definitions.push(
			Object.freeze({
				definition: entry.address,
				snapshot: material.snapshot,
				exportName: definition.exportName,
			}),
		)
		const previous = materials.get(material.snapshot)
		if (previous) {
			if (
				encodeControlData(previous.manifest) !== encodeControlData(manifest) ||
				Object.keys(previous.files).length !== Object.keys(material.files).length ||
				Object.keys(previous.files).some((path) => previous.files[path] !== material.files[path])
			)
				throw new ScriptExecutionError(
					'control_contract_mismatch',
					'One material snapshot has inconsistent committed contents',
				)
			continue
		}
		bytes += manifest.files.reduce((sum, file) => sum + file.size, 0)
		bytes += encoder.encode(material.files['manifest.json'] ?? '').byteLength
		if (materials.size >= MAX_MATERIALS || bytes > MAX_BYTES)
			throw new ScriptExecutionError(
				'control_material_limit',
				'Control materials exceed 128 snapshots or 64 MiB',
			)
		await verifyPluginControlMaterial(manifest, material.files)
		materials.set(
			material.snapshot,
			Object.freeze({ snapshot: material.snapshot, manifest, files: material.files }),
		)
	}
	options?.signal?.throwIfAborted()
	return Object.freeze({
		catalogRevision: catalog.revision,
		materials: Object.freeze([...materials.values()]),
		definitions: Object.freeze(definitions),
		unavailable: Object.freeze(unavailable),
	})
}

/** A small index; manifest.json is itself downloaded through the chunked file method. */
export type PluginControlManifestIndex = Readonly<{
	transfer: string
	catalogRevision: number
	expiresAt: number
	unavailableCount: number
	materials: readonly Readonly<{ snapshot: string; manifestSize: number }>[]
	definitions: PluginControlMaterialsSnapshot['definitions']
	nextOffset: number | null
}>
export type PluginControlManifestRequest = Readonly<{ transfer: string; offset: number }>
export type PluginControlFileRequest = Readonly<{ snapshot: string; path: string; offset: number }>
export type PluginControlFileChunk = PluginControlFileRequest &
	Readonly<{
		encoding: 'base64'
		data: string
		totalSize: number
		nextOffset: number
		done: boolean
	}>
export interface PluginControlMaterialReader extends Disposable {
	manifest(input?: unknown): Promise<PluginControlManifestIndex>
	file(input: unknown): PluginControlFileChunk
}

/** One authenticated session owns a bounded, expiring immutable material snapshot. */
export function createPluginControlMaterialReader(
	read: () => Promise<PluginControlMaterialsSnapshot>,
	options: Readonly<{ signal?: AbortSignal; now?: () => number }> = {},
): PluginControlMaterialReader {
	const now = options.now ?? Date.now
	type Cached = {
		files: Readonly<Record<string, string>>
		paths: Set<string>
		encoded: Map<string, Uint8Array>
	}
	const cache = new Map<string, Cached>()
	let expiresAt = 0
	let expiryTimer: ReturnType<typeof setTimeout> | undefined
	let closed = false
	let transfer = ''
	let index: Omit<PluginControlManifestIndex, 'definitions' | 'nextOffset'> | undefined
	let definitions: PluginControlMaterialsSnapshot['definitions'] = []
	const clear = () => {
		if (expiryTimer !== undefined) clearTimeout(expiryTimer)
		expiryTimer = undefined
		cache.clear()
		expiresAt = 0
		index = undefined
		definitions = []
	}
	const assertOpen = () => {
		options.signal?.throwIfAborted()
		if (closed) throw new ScriptExecutionError('session_closed', 'Material reader is closed')
	}
	const onAbort = () => clear()
	options.signal?.addEventListener('abort', onAbort, { once: true })
	return Object.freeze({
		async manifest(input?: unknown) {
			assertOpen()
			if (input !== undefined) {
				const request = parsePluginControlManifestRequest(input)
				if (now() >= expiresAt) clear()
				if (!index || request.transfer !== transfer)
					throw new ScriptExecutionError(
						'control_snapshot_expired',
						'The material index has expired; start synchronization again',
					)
				if (request.offset > definitions.length)
					throw new ScriptExecutionError(
						'invalid_request',
						'Material index offset exceeds its size',
					)
				const end = Math.min(request.offset + 16, definitions.length)
				return Object.freeze({
					...index,
					definitions: Object.freeze(definitions.slice(request.offset, end)),
					nextOffset: end < definitions.length ? end : null,
				})
			}
			const value = await read()
			assertOpen()
			if (value.materials.length > MAX_MATERIALS || value.definitions.length > 4096)
				throw new ScriptExecutionError(
					'control_material_limit',
					'Too many control material snapshots',
				)
			let total = 0
			for (const material of value.materials) {
				total += material.manifest.files.reduce((sum, file) => sum + file.size, 0)
				total += encoder.encode(material.files['manifest.json']).byteLength
			}
			if (total > MAX_BYTES)
				throw new ScriptExecutionError(
					'control_material_limit',
					'Control material cache exceeds 64 MiB',
				)
			clear()
			expiresAt = now() + PLUGIN_CONTROL_CACHE_MS
			expiryTimer = setTimeout(clear, PLUGIN_CONTROL_CACHE_MS)
			transfer = crypto.randomUUID()
			definitions = value.definitions
			const materials = value.materials.map((material) => {
				cache.set(material.snapshot, {
					files: material.files,
					paths: new Set(['manifest.json', ...material.manifest.files.map((file) => file.path)]),
					encoded: new Map(),
				})
				return Object.freeze({
					snapshot: material.snapshot,
					manifestSize: encoder.encode(material.files['manifest.json']).byteLength,
				})
			})
			index = Object.freeze({
				transfer,
				catalogRevision: value.catalogRevision,
				expiresAt,
				unavailableCount: value.unavailable.length,
				materials: Object.freeze(materials),
			})
			return Object.freeze({
				...index,
				definitions: Object.freeze(definitions.slice(0, 16)),
				nextOffset: definitions.length > 16 ? 16 : null,
			})
		},
		file(input: unknown) {
			assertOpen()
			const request = parsePluginControlFileRequest(input)
			if (now() >= expiresAt) clear()
			const material = cache.get(request.snapshot)
			if (!material)
				throw new ScriptExecutionError(
					'control_snapshot_expired',
					'Read the material manifest again; this session no longer retains that snapshot',
				)
			if (!material.paths.has(request.path))
				throw new ScriptExecutionError(
					'control_file_unavailable',
					'The requested path is not in the control manifest',
				)
			let bytes = material.encoded.get(request.path)
			if (!bytes) {
				bytes = encoder.encode(material.files[request.path])
				material.encoded.set(request.path, bytes)
			}
			if (request.offset > bytes.length)
				throw new ScriptExecutionError('invalid_request', 'Control file offset exceeds its size')
			const nextOffset = Math.min(bytes.length, request.offset + PLUGIN_CONTROL_CHUNK_BYTES)
			let binary = ''
			for (const byte of bytes.subarray(request.offset, nextOffset))
				binary += String.fromCharCode(byte)
			return Object.freeze({
				...request,
				encoding: 'base64' as const,
				data: btoa(binary),
				totalSize: bytes.length,
				nextOffset,
				done: nextOffset === bytes.length,
			})
		},
		[Symbol.dispose]() {
			if (closed) return
			closed = true
			clear()
			options.signal?.removeEventListener('abort', onAbort)
		},
	})
}

function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		!input ||
		typeof input !== 'object' ||
		Array.isArray(input) ||
		Object.keys(input).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(input, key))
	)
		throw new ScriptExecutionError('protocol_mismatch', 'Invalid control material response fields')
	for (const key of Reflect.ownKeys(input)) {
		if (
			typeof key !== 'string' ||
			!keys.includes(key) ||
			!('value' in Object.getOwnPropertyDescriptor(input, key)!)
		)
			throw new ScriptExecutionError(
				'protocol_mismatch',
				'Control material responses require data properties',
			)
	}
	return input as Record<string, unknown>
}
const digest = (value: unknown): value is string =>
	typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
const integer = (value: unknown): value is number =>
	Number.isSafeInteger(value) && (value as number) >= 0

export function parsePluginControlFileRequest(input: unknown): PluginControlFileRequest {
	const value = record(input, ['snapshot', 'path', 'offset'])
	if (!digest(value.snapshot) || !isControlFilePath(value.path) || !integer(value.offset))
		throw new ScriptExecutionError(
			'invalid_request',
			'Invalid control file snapshot, path or offset',
		)
	return Object.freeze({ snapshot: value.snapshot, path: value.path, offset: value.offset })
}
export function parsePluginControlManifestIndex(input: unknown): PluginControlManifestIndex {
	const value = record(input, [
		'transfer',
		'catalogRevision',
		'expiresAt',
		'unavailableCount',
		'materials',
		'definitions',
		'nextOffset',
	])
	if (
		typeof value.transfer !== 'string' ||
		!/^[a-f0-9-]{36}$/.test(value.transfer) ||
		!integer(value.catalogRevision) ||
		!integer(value.expiresAt) ||
		!integer(value.unavailableCount) ||
		!Array.isArray(value.materials) ||
		value.materials.length > MAX_MATERIALS ||
		!Array.isArray(value.definitions) ||
		value.definitions.length > 16 ||
		(value.nextOffset !== null && !integer(value.nextOffset))
	)
		throw new ScriptExecutionError('protocol_mismatch', 'Invalid control material index')
	const snapshots = new Set<string>()
	const materials = value.materials.map((rawMaterial) => {
		const material = record(rawMaterial, ['snapshot', 'manifestSize'])
		if (
			!digest(material.snapshot) ||
			!integer(material.manifestSize) ||
			material.manifestSize > MAX_BYTES ||
			snapshots.has(material.snapshot)
		)
			throw new ScriptExecutionError(
				'protocol_mismatch',
				'Invalid or duplicate control material snapshot',
			)
		snapshots.add(material.snapshot)
		return Object.freeze({ snapshot: material.snapshot, manifestSize: material.manifestSize })
	})
	const definitions = value.definitions.map((rawSelection) => {
		const entry = record(rawSelection, ['definition', 'snapshot', 'exportName'])
		if (
			!digest(entry.snapshot) ||
			!snapshots.has(entry.snapshot) ||
			typeof entry.exportName !== 'string' ||
			!/^[A-Za-z_$][\w$]*$/.test(entry.exportName)
		)
			throw new ScriptExecutionError('protocol_mismatch', 'Invalid material definition selection')
		return Object.freeze({
			definition: parsePluginDefinitionAddress(entry.definition),
			snapshot: entry.snapshot,
			exportName: entry.exportName,
		})
	})
	return Object.freeze({
		transfer: value.transfer,
		catalogRevision: value.catalogRevision,
		expiresAt: value.expiresAt,
		unavailableCount: value.unavailableCount,
		materials: Object.freeze(materials),
		definitions: Object.freeze(definitions),
		nextOffset: value.nextOffset as number | null,
	})
}
export function parsePluginControlManifestRequest(input: unknown): PluginControlManifestRequest {
	const request = record(input, ['transfer', 'offset'])
	if (
		typeof request.transfer !== 'string' ||
		!/^[a-f0-9-]{36}$/.test(request.transfer) ||
		!integer(request.offset)
	)
		throw new ScriptExecutionError('invalid_request', 'Invalid material index request')
	return Object.freeze({ transfer: request.transfer, offset: request.offset })
}
export function parsePluginControlFileChunk(input: unknown): PluginControlFileChunk {
	const value = record(input, [
		'snapshot',
		'path',
		'offset',
		'encoding',
		'data',
		'totalSize',
		'nextOffset',
		'done',
	])
	const request = parsePluginControlFileRequest({
		snapshot: value.snapshot,
		path: value.path,
		offset: value.offset,
	})
	if (
		value.encoding !== 'base64' ||
		typeof value.data !== 'string' ||
		value.data.length > Math.ceil(PLUGIN_CONTROL_CHUNK_BYTES / 3) * 4 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data) ||
		!integer(value.totalSize) ||
		value.totalSize > MAX_BYTES ||
		!integer(value.nextOffset) ||
		value.nextOffset < request.offset ||
		value.nextOffset > value.totalSize ||
		typeof value.done !== 'boolean' ||
		value.done !== (value.nextOffset === value.totalSize)
	)
		throw new ScriptExecutionError('protocol_mismatch', 'Invalid control file chunk')
	const decoded = atob(value.data)
	if (
		btoa(decoded) !== value.data ||
		decoded.length !== value.nextOffset - request.offset ||
		decoded.length > PLUGIN_CONTROL_CHUNK_BYTES ||
		(!value.done && decoded.length === 0)
	)
		throw new ScriptExecutionError(
			'protocol_mismatch',
			'Control file chunk length or encoding mismatch',
		)
	return Object.freeze({
		...request,
		encoding: 'base64',
		data: value.data,
		totalSize: value.totalSize,
		nextOffset: value.nextOffset,
		done: value.done,
	})
}
