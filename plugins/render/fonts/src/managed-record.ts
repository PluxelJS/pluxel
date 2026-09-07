import { createHash, type Hash } from 'node:crypto'
import type { ManagedFontSnapshot } from './workbench.ts'

const MAGIC = new TextEncoder().encode('PLUXELF1')
const HEADER_LIMIT = 4_096
const CHUNK_BYTES = 1024 * 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

/** Maximum non-payload bytes accepted by the managed record envelope. */
export const MANAGED_FONT_RECORD_OVERHEAD_LIMIT = MAGIC.byteLength + 4 + HEADER_LIMIT

export type StoredManagedFont = Readonly<{
	id: string
	fileName: string
	family?: string
	byteLength: number
	installedAt: string
	data: Uint8Array
}>

export async function managedFontId(
	data: Uint8Array,
	family?: string,
	signal?: AbortSignal,
): Promise<string> {
	throwIfAborted(signal)
	const hash = createHash('sha256')
	hash.update(family ?? '')
	hash.update('\0')
	await updateHash(hash, data, signal)
	return hash.digest('base64url')
}

export function managedFontKey(prefix: string, id: string): string {
	return `${prefix}/${id}.font`
}

export async function encodeManagedFont(font: StoredManagedFont): Promise<Uint8Array> {
	const header = encoder.encode(
		JSON.stringify({
			version: 1,
			id: font.id,
			fileName: font.fileName,
			...(font.family ? { family: font.family } : {}),
			byteLength: font.byteLength,
			installedAt: font.installedAt,
		}),
	)
	if (header.byteLength > HEADER_LIMIT) throw new Error('Managed font metadata is too large')
	const output = new Uint8Array(MAGIC.byteLength + 4 + header.byteLength + font.data.byteLength)
	output.set(MAGIC)
	new DataView(output.buffer).setUint32(MAGIC.byteLength, header.byteLength)
	output.set(header, MAGIC.byteLength + 4)
	const dataOffset = MAGIC.byteLength + 4 + header.byteLength
	for (let offset = 0; offset < font.data.byteLength; offset += CHUNK_BYTES) {
		if (offset > 0) await checkpoint()
		output.set(
			font.data.subarray(offset, Math.min(offset + CHUNK_BYTES, font.data.byteLength)),
			dataOffset + offset,
		)
	}
	return output
}

export async function decodeManagedFont(
	value: Uint8Array,
	expectedId: string,
): Promise<StoredManagedFont> {
	if (value.byteLength < MAGIC.byteLength + 4) throw new Error('Managed font record is truncated')
	for (let index = 0; index < MAGIC.byteLength; index += 1) {
		if (value[index] !== MAGIC[index]) throw new Error('Managed font record has an unknown format')
	}
	const headerLength = new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(
		MAGIC.byteLength,
	)
	if (headerLength <= 0 || headerLength > HEADER_LIMIT) {
		throw new Error('Managed font record has invalid metadata length')
	}
	const dataOffset = MAGIC.byteLength + 4 + headerLength
	if (dataOffset > value.byteLength) throw new Error('Managed font record is truncated')
	const parsed = JSON.parse(
		decoder.decode(value.subarray(MAGIC.byteLength + 4, dataOffset)),
	) as unknown
	if (!isRecord(parsed) || parsed.version !== 1) {
		throw new Error('Managed font record has an unsupported version')
	}
	const id = requiredText(parsed.id, 'id')
	const fileName = requiredText(parsed.fileName, 'fileName')
	const family = optionalText(parsed.family, 'family')
	const installedAt = requiredText(parsed.installedAt, 'installedAt')
	const payloadLength = value.byteLength - dataOffset
	if (id !== expectedId) {
		throw new Error('Managed font record content ID does not match its key')
	}
	if (!Number.isInteger(parsed.byteLength) || parsed.byteLength !== payloadLength) {
		throw new Error('Managed font record byte length does not match its payload')
	}
	if (!Number.isFinite(Date.parse(installedAt))) {
		throw new TypeError('Managed font record installedAt is invalid')
	}
	if (
		fileName.length > 255 ||
		fileName !== fileName.split(/[\\/]/).at(-1) ||
		hasControlCharacters(fileName)
	) {
		throw new TypeError('Managed font fileName is invalid')
	}
	if (family && (family.length > 128 || hasControlCharacters(family))) {
		throw new Error('Managed font family is invalid')
	}
	const data = new Uint8Array(payloadLength)
	for (let offset = 0; offset < data.byteLength; offset += CHUNK_BYTES) {
		if (offset > 0) await checkpoint()
		data.set(
			value.subarray(
				dataOffset + offset,
				dataOffset + Math.min(offset + CHUNK_BYTES, data.byteLength),
			),
			offset,
		)
	}
	if ((await managedFontId(data, family)) !== id) {
		throw new Error('Managed font record content ID does not match its key')
	}
	return Object.freeze({
		id,
		fileName,
		...(family ? { family } : {}),
		byteLength: data.byteLength,
		installedAt,
		data,
	})
}

async function updateHash(
	hash: Hash,
	data: Uint8Array,
	signal: AbortSignal | undefined,
): Promise<void> {
	for (let offset = 0; offset < data.byteLength; offset += CHUNK_BYTES) {
		if (offset > 0) await checkpoint(signal)
		hash.update(data.subarray(offset, Math.min(offset + CHUNK_BYTES, data.byteLength)))
	}
}

async function checkpoint(signal?: AbortSignal): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve))
	throwIfAborted(signal)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return
	throw signal.reason instanceof Error
		? signal.reason
		: new DOMException('Font content hashing aborted', 'AbortError')
}

export function toManagedFontSnapshot(
	font: StoredManagedFont,
	resolvedFamilies: readonly string[],
): ManagedFontSnapshot {
	return Object.freeze({
		id: font.id,
		fileName: font.fileName,
		...(font.family ? { family: font.family } : {}),
		resolvedFamilies: Object.freeze([...resolvedFamilies]),
		byteLength: font.byteLength,
		installedAt: font.installedAt,
	})
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function requiredText(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value.trim())
		throw new Error(`Managed font ${field} is invalid`)
	return value
}

function optionalText(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined
	return requiredText(value, field)
}

function hasControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index)
		if (code <= 0x1f || code === 0x7f) return true
	}
	return false
}
