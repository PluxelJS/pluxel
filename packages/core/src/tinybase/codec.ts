import { pluginNodeAddressEqual, parsePluginNodeAddress } from '../plugins/runtime/identity'
import type { Content } from 'tinybase'
import { TinyBaseError } from './error'
import type { TinyBaseIdentity } from './types'

type Envelope = {
	format: 'pluxel.tinybase'
	formatVersion: 1
	identity: TinyBaseIdentity
	content: Content
}

function record(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		[Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
		Reflect.ownKeys(value).every(
			(key) =>
				typeof key === 'string' &&
				Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'),
		)
	)
}

function scalar(value: unknown): boolean {
	return (
		typeof value === 'string' ||
		typeof value === 'boolean' ||
		(typeof value === 'number' && Number.isFinite(value))
	)
}

export function assertContent(
	input: unknown,
	identity: TinyBaseIdentity,
): asserts input is Content {
	if (
		!Array.isArray(input) ||
		input.length !== 2 ||
		!record(input[0]) ||
		!record(input[1]) ||
		!Object.values(input[1]).every(scalar) ||
		!Object.values(input[0]).every(
			(table) =>
				record(table) &&
				Object.values(table).every((row) => record(row) && Object.values(row).every(scalar)),
		)
	)
		throw new TinyBaseError(
			'SNAPSHOT_INVALID',
			'Content must contain Tables and Values of strings, booleans and finite numbers.',
			identity,
		)
}

/** Content equality ignores key order and treats signed zero according to JSON number semantics. */
export function sameContent(left: unknown, right: unknown): boolean {
	if (left === right) return true
	if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
	if (Array.isArray(left) !== Array.isArray(right)) return false
	const a = Object.keys(left)
	const b = Object.keys(right)
	return (
		a.length === b.length &&
		a.every(
			(key) =>
				Object.hasOwn(right, key) &&
				sameContent(
					(left as Record<string, unknown>)[key],
					(right as Record<string, unknown>)[key],
				),
		)
	)
}

export function encodeSnapshot(
	identity: TinyBaseIdentity,
	content: Content,
	maxBytes: number,
): string {
	assertContent(content, identity)
	const envelope: Envelope = { format: 'pluxel.tinybase', formatVersion: 1, identity, content }
	const text = `${JSON.stringify(envelope)}\n`
	assertBudget(text, identity, maxBytes)
	return text
}

export function decodeSnapshot(
	text: string,
	identity: TinyBaseIdentity,
	maxBytes: number,
): Content {
	assertBudget(text, identity, maxBytes)
	const input: unknown = JSON.parse(text)
	if (
		!record(input) ||
		Object.keys(input).length !== 4 ||
		input.format !== 'pluxel.tinybase' ||
		input.formatVersion !== 1 ||
		!record(input.identity) ||
		Object.keys(input.identity).length !== 2 ||
		input.identity.kind !== identity.kind
	)
		throw new TinyBaseError('SNAPSHOT_INVALID', 'Unknown snapshot format or identity.', identity)
	if (identity.kind === 'plugin') {
		if (!pluginNodeAddressEqual(parsePluginNodeAddress(input.identity.node), identity.node))
			throw new TinyBaseError(
				'SNAPSHOT_INVALID',
				'Snapshot belongs to another Plugin node.',
				identity,
			)
	} else if (input.identity.namespace !== identity.namespace) {
		throw new TinyBaseError(
			'SNAPSHOT_INVALID',
			'Snapshot belongs to another Host document namespace.',
			identity,
		)
	}
	assertContent(input.content, identity)
	return input.content
}

function assertBudget(text: string, identity: TinyBaseIdentity, maxBytes: number): void {
	if (new TextEncoder().encode(text).byteLength > maxBytes)
		throw new TinyBaseError(
			'BUDGET_EXCEEDED',
			`Snapshot exceeds ${maxBytes} UTF-8 bytes.`,
			identity,
		)
}
