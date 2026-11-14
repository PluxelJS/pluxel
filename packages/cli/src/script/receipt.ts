import { isAbsolute } from 'node:path'
import { ScriptExecutionError } from '@pluxel/host/agent/runtime'

const PREFIX = 'pluxel-script-v3.'
const MAX_TOKEN_LENGTH = 16 * 1024
const MAX_PAYLOAD_BYTES = 8 * 1024
const ID = /^[a-zA-Z0-9_-]{1,128}$/

/** A locator for one original owner and request, without discovery or authentication secrets. */
export type ScriptReceipt = Readonly<{
	version: 3
	connection:
		| Readonly<{ kind: 'local'; root: string; serviceId?: string }>
		| Readonly<{ kind: 'remote'; endpoint: string }>
	instanceId: string
	runId: string
	requestHash: string
}>

function invalid(): never {
	throw new ScriptExecutionError(
		'invalid_receipt',
		'Use the complete receipt returned by run; the original owner and request are required',
	)
}

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
	const input = value as Record<string, unknown>
	if (Object.keys(input).some((key) => !fields.includes(key))) invalid()
	return input
}

function text(value: unknown, maxBytes: number): value is string {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		// eslint-disable-next-line no-control-regex -- Receipt fields cannot contain control characters.
		/[\u0000-\u001f\u007f]/.test(value) ||
		Buffer.byteLength(value, 'utf8') > maxBytes
	)
		return false
	try {
		encodeURIComponent(value)
		return true
	} catch {
		return false
	}
}

function validate(value: unknown): ScriptReceipt {
	const input = record(value, ['version', 'connection', 'instanceId', 'runId', 'requestHash'])
	if (
		input.version !== 3 ||
		!text(input.instanceId, 4096) ||
		!text(input.runId, 128) ||
		!ID.test(input.runId) ||
		typeof input.requestHash !== 'string' ||
		!/^[a-f0-9]{64}$/.test(input.requestHash)
	)
		invalid()
	const connection = record(input.connection, ['kind', 'root', 'serviceId', 'endpoint'])
	let target: ScriptReceipt['connection']
	if (connection.kind === 'local') {
		if (
			!text(input.instanceId, 128) ||
			!ID.test(input.instanceId) ||
			!text(connection.root, 4096) ||
			!isAbsolute(connection.root) ||
			'endpoint' in connection ||
			('serviceId' in connection && !text(connection.serviceId, 1024))
		)
			invalid()
		target = {
			kind: 'local',
			root: connection.root,
			...(typeof connection.serviceId === 'string' ? { serviceId: connection.serviceId } : {}),
		}
	} else if (connection.kind === 'remote') {
		if (!text(connection.endpoint, 4096) || 'root' in connection || 'serviceId' in connection)
			invalid()
		let endpoint: URL
		try {
			endpoint = new URL(connection.endpoint)
		} catch {
			invalid()
		}
		if (
			!['http:', 'https:', 'ws:', 'wss:'].includes(endpoint.protocol) ||
			endpoint.username ||
			endpoint.password ||
			endpoint.search ||
			endpoint.hash ||
			(endpoint.pathname !== '/' && endpoint.pathname !== '/__pluxel/runtime/session')
		)
			invalid()
		target = { kind: 'remote', endpoint: endpoint.href }
	} else invalid()
	return {
		version: 3,
		connection: target,
		instanceId: input.instanceId,
		runId: input.runId,
		requestHash: input.requestHash,
	}
}

function serialize(receipt: ScriptReceipt): string {
	const payload = Buffer.from(JSON.stringify(receipt), 'utf8')
	if (payload.length > MAX_PAYLOAD_BYTES) invalid()
	return PREFIX + payload.toString('base64url')
}

export function encodeScriptReceipt(input: ScriptReceipt): string {
	const connection = input.connection
	// A discovery record may include nonce/socket data. Only the explicit locator is serialized.
	return serialize(
		validate({
			version: input.version,
			connection:
				connection.kind === 'local'
					? {
							kind: connection.kind,
							root: connection.root,
							...(connection.serviceId === undefined ? {} : { serviceId: connection.serviceId }),
						}
					: { kind: connection.kind, endpoint: connection.endpoint },
			instanceId: input.instanceId,
			runId: input.runId,
			requestHash: input.requestHash,
		}),
	)
}

export function decodeScriptReceipt(token: string): ScriptReceipt {
	if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || !token.startsWith(PREFIX))
		invalid()
	const encoded = token.slice(PREFIX.length)
	if (!/^[A-Za-z0-9_-]+$/.test(encoded)) invalid()
	const payload = Buffer.from(encoded, 'base64url')
	if (payload.length > MAX_PAYLOAD_BYTES || payload.toString('base64url') !== encoded) invalid()
	let value: unknown
	try {
		value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload))
	} catch {
		invalid()
	}
	const receipt = validate(value)
	if (serialize(receipt) !== token) invalid()
	return receipt
}

export function verifyScriptReceipt(
	snapshot: Readonly<{ instanceId: string; runId: string; requestHash: string }>,
	receipt: Pick<ScriptReceipt, 'instanceId' | 'runId' | 'requestHash'>,
): void {
	if (
		snapshot.instanceId !== receipt.instanceId ||
		snapshot.runId !== receipt.runId ||
		snapshot.requestHash !== receipt.requestHash
	)
		throw new ScriptExecutionError(
			'receipt_mismatch',
			'The result does not belong to the original script request',
		)
}
