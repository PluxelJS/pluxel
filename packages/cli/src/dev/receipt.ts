import { isAbsolute } from 'node:path'
import { DevClientError } from './client'

const PREFIX = 'pluxel-dev-v1.'
const MAX_TOKEN_LENGTH = 16 * 1024
const MAX_PAYLOAD_BYTES = 8 * 1024
const ID = /^[a-zA-Z0-9_-]{1,128}$/
const fields = new Set(['root', 'instanceId', 'runId', 'serviceId'])

/** A locator for the original run, never a credential or a mutable target selection. */
export interface DevReceipt {
	root: string
	instanceId: string
	runId: string
	serviceId?: string
}

function invalid(): never {
	throw new DevClientError('invalid_input', 'Invalid development run receipt', {
		hint: 'Use the complete receipt returned by dev run. A raw runId cannot identify its original instance.',
	})
}

function boundedText(value: unknown, maxBytes: number): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		// eslint-disable-next-line no-control-regex -- Reject control characters in serialized receipt fields.
		!/[\u0000-\u001f\u007f]/.test(value) &&
		Buffer.byteLength(value, 'utf8') <= maxBytes
	)
}

function validate(value: unknown): DevReceipt {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
	const input = value as Record<string, unknown>
	if (
		Object.keys(input).some((key) => !fields.has(key)) ||
		!boundedText(input.root, 4096) ||
		!isAbsolute(input.root) ||
		!boundedText(input.instanceId, 128) ||
		!ID.test(input.instanceId) ||
		!boundedText(input.runId, 128) ||
		!ID.test(input.runId) ||
		('serviceId' in input && !boundedText(input.serviceId, 1024))
	) {
		invalid()
	}
	return {
		root: input.root,
		instanceId: input.instanceId,
		runId: input.runId,
		...(typeof input.serviceId === 'string' ? { serviceId: input.serviceId } : {}),
	}
}

export function encodeDevReceipt(input: DevReceipt): string {
	// Callers may hold a discovery record: never carry its nonce or socket into the receipt.
	const receipt = validate({
		root: input.root,
		instanceId: input.instanceId,
		runId: input.runId,
		...(input.serviceId === undefined ? {} : { serviceId: input.serviceId }),
	})
	const payload = Buffer.from(JSON.stringify(receipt), 'utf8')
	if (payload.length > MAX_PAYLOAD_BYTES) invalid()
	return PREFIX + payload.toString('base64url')
}

export function decodeDevReceipt(token: string): DevReceipt {
	if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || !token.startsWith(PREFIX)) {
		invalid()
	}
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
	return validate(value)
}
