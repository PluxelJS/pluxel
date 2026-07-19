import { RatesInvalidArgumentError } from './errors.ts'
import type { RateIdentity, RateIdentityPart, RatePolicy, ResolvedRatePolicy } from './types.ts'

export const MAX_WINDOW_MS = 2_147_483_647
export const MAX_STATE_TTL_MS = 2 * MAX_WINDOW_MS
export const MAX_IDENTITY_BYTES = 1_024
const MAX_PARTS = 16
const MAX_NAME_LENGTH = 128
const ALGORITHMS = new Set([
	'token-bucket',
	'fixed-window',
	'sliding-window-counter',
	'sliding-window-log',
])

export function normalizeName(name: string): string {
	if (typeof name !== 'string') invalid('name', 'must be a string')
	if (!name || name.trim() !== name) invalid('name', 'must be non-empty and unchanged by trim')
	if (name.length > MAX_NAME_LENGTH)
		invalid('name', `must not exceed ${MAX_NAME_LENGTH} code units`)
	if (/\p{Cc}/u.test(name)) invalid('name', 'must not contain control characters')
	return name
}

export function normalizePolicy(policy: RatePolicy): Readonly<ResolvedRatePolicy> {
	if (!isPlainObject(policy)) invalid('policy', 'must be an exact plain object')
	const descriptors = Object.getOwnPropertyDescriptors(policy)
	if (Object.getOwnPropertySymbols(policy).length > 0)
		invalid('policy', 'must not contain symbol fields')
	for (const [key, descriptor] of Object.entries(descriptors)) {
		if (!descriptor.enumerable || !('value' in descriptor)) {
			invalid('policy', `field ${bounded(key)} must be an enumerable data property`)
		}
	}
	const algorithm = descriptors.algorithm?.value
	if (typeof algorithm !== 'string' || !ALGORITHMS.has(algorithm)) {
		invalid('policy', 'algorithm must be one of the four supported algorithms')
	}
	const allowed =
		algorithm === 'token-bucket'
			? new Set(['algorithm', 'limit', 'windowMs', 'burst'])
			: new Set(['algorithm', 'limit', 'windowMs'])
	for (const key of Object.keys(descriptors)) {
		if (!allowed.has(key)) invalid('policy', `contains unknown field ${bounded(key)}`)
	}
	for (const required of ['algorithm', 'limit', 'windowMs']) {
		if (!(required in descriptors)) invalid('policy', `is missing ${required}`)
	}
	const limit = positiveSafeInteger(descriptors.limit!.value, 'policy', 'limit')
	const windowMs = positiveSafeInteger(descriptors.windowMs!.value, 'policy', 'windowMs')
	if (windowMs > MAX_WINDOW_MS) invalid('policy', `windowMs must not exceed ${MAX_WINDOW_MS}`)

	if (algorithm === 'token-bucket') {
		const burst =
			descriptors.burst === undefined
				? limit
				: positiveSafeInteger(descriptors.burst.value, 'policy', 'burst')
		assertSafeProduct(burst, windowMs, 'burst * windowMs')
		const refillTtl = Math.ceil((burst * windowMs) / limit)
		if (!Number.isSafeInteger(refillTtl) || refillTtl > MAX_STATE_TTL_MS) {
			invalid('policy', `token bucket state TTL must not exceed ${MAX_STATE_TTL_MS}`)
		}
		return Object.freeze({ algorithm, limit, windowMs, burst })
	}
	if (algorithm === 'sliding-window-counter') assertSafeProduct(limit, windowMs, 'limit * windowMs')
	if (algorithm === 'sliding-window-log' && limit > 10_000) {
		invalid('policy', 'sliding-window-log limit must not exceed 10000')
	}
	return Object.freeze({ algorithm, limit, windowMs }) as Readonly<ResolvedRatePolicy>
}

export function normalizeCost(
	cost: number | undefined,
	policy: Readonly<ResolvedRatePolicy>,
): number {
	const value = positiveSafeInteger(cost ?? 1, 'cost', 'cost')
	const capacity = policy.algorithm === 'token-bucket' ? policy.burst : policy.limit
	if (value > capacity)
		invalid('cost', `must not exceed ${policy.algorithm === 'token-bucket' ? 'burst' : 'limit'}`)
	if (policy.algorithm === 'token-bucket')
		assertSafeProduct(value, policy.windowMs, 'cost * windowMs', 'cost')
	return value
}

export function encodeIdentity(identity: RateIdentity): string {
	let encoded: string
	if (isIdentityPart(identity)) {
		encoded = `p|${encodePart(identity)}`
	} else if (Array.isArray(identity)) {
		if (Object.getPrototypeOf(identity) !== Array.prototype)
			invalid('identity', 'tuple must be a plain array')
		if (identity.length > MAX_PARTS) invalid('identity', `tuple must not exceed ${MAX_PARTS} parts`)
		const descriptors = Object.getOwnPropertyDescriptors(identity)
		const keys = Object.keys(descriptors).filter((key) => key !== 'length')
		if (keys.length !== identity.length || keys.some((key, index) => key !== String(index))) {
			invalid('identity', 'tuple must be dense and contain only indexed parts')
		}
		for (const key of keys) {
			const descriptor = descriptors[key]!
			if (!descriptor.enumerable || !('value' in descriptor)) {
				invalid('identity', 'tuple parts must be enumerable data properties')
			}
		}
		if (Object.getOwnPropertySymbols(identity).length > 0)
			invalid('identity', 'must not contain symbol fields')
		encoded = `t|${identity.length}|${keys.map((key) => encodePartChecked(descriptors[key]!.value)).join('')}`
	} else {
		if (!isPlainObject(identity)) invalid('identity', 'record must be a plain object')
		if (Object.getOwnPropertySymbols(identity).length > 0)
			invalid('identity', 'must not contain symbol fields')
		const descriptors = Object.getOwnPropertyDescriptors(identity)
		const keys = Object.keys(descriptors).sort()
		if (keys.length > MAX_PARTS) invalid('identity', `record must not exceed ${MAX_PARTS} parts`)
		for (const key of keys) {
			const descriptor = descriptors[key]!
			if (!descriptor.enumerable || !('value' in descriptor)) {
				invalid('identity', 'record fields must be enumerable data properties')
			}
		}
		encoded = `r|${keys.length}|${keys
			.map((key) => `${byteLength(key)}:${key}${encodePartChecked(descriptors[key]!.value)}`)
			.join('')}`
	}
	if (byteLength(encoded) > MAX_IDENTITY_BYTES) {
		invalid('identity', `canonical encoding must not exceed ${MAX_IDENTITY_BYTES} UTF-8 bytes`)
	}
	return encoded
}

export function policiesEqual(
	a: Readonly<ResolvedRatePolicy>,
	b: Readonly<ResolvedRatePolicy>,
): boolean {
	return (
		a.algorithm === b.algorithm &&
		a.limit === b.limit &&
		a.windowMs === b.windowMs &&
		(a.algorithm !== 'token-bucket' || (b.algorithm === 'token-bucket' && a.burst === b.burst))
	)
}

function encodePartChecked(value: unknown): string {
	if (!isIdentityPart(value))
		invalid('identity', 'parts must be string, finite number, bigint, or boolean')
	return encodePart(value)
}

function encodePart(value: RateIdentityPart): string {
	switch (typeof value) {
		case 'string':
			return `s${byteLength(value)}:${value}`
		case 'number':
			if (!Number.isFinite(value)) invalid('identity', 'number parts must be finite')
			return `n${Object.is(value, -0) ? '-0' : String(value)};`
		case 'bigint':
			return `i${value};`
		case 'boolean':
			return value ? 'b1;' : 'b0;'
	}
}

function isIdentityPart(value: unknown): value is RateIdentityPart {
	return (
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'bigint' ||
		typeof value === 'boolean'
	)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object') return false
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}

function positiveSafeInteger(value: unknown, argument: 'policy' | 'cost', field: string): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0)
		invalid(argument, `${field} must be a positive safe integer`)
	return value as number
}

function assertSafeProduct(
	a: number,
	b: number,
	field: string,
	argument: 'policy' | 'cost' = 'policy',
): void {
	if (!Number.isSafeInteger(a * b))
		invalid(argument, `${field} must not exceed Number.MAX_SAFE_INTEGER`)
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength
}

function bounded(value: string): string {
	return JSON.stringify(value.length > 64 ? `${value.slice(0, 64)}…` : value)
}

function invalid(argument: 'name' | 'policy' | 'identity' | 'cost', reason: string): never {
	throw new RatesInvalidArgumentError(argument, reason)
}
