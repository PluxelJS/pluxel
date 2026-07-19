import { BasePlugin, Plugin, v } from '@pluxel/runtime'
import { RatesBackend, type RatesBackendConsumeRequest } from './backend.ts'
import {
	RatesInvalidArgumentError,
	RatesPolicyConflictError,
	RatesStoppedError,
	RatesUnavailableError,
} from './errors.ts'
import { ExpiryHeap } from './expiry-heap.ts'
import { consumeState, createState, type RateState } from './transitions.ts'
import type {
	RateConsumeOptions,
	RateDecision,
	RateIdentity,
	RateLimiter,
	RatePolicy,
	RatesBinding,
	ResolvedRatePolicy,
} from './types.ts'
import {
	encodeIdentity,
	normalizeCost,
	normalizeName,
	normalizePolicy,
	policiesEqual,
} from './validation.ts'

export {
	RatesError,
	RatesInvalidArgumentError,
	RatesPolicyConflictError,
	RatesStoppedError,
	RatesUnavailableError,
} from './errors.ts'
export type {
	RateConsumeOptions,
	RateDecision,
	RateIdentity,
	RateIdentityPart,
	RateLimiter,
	RatePolicy,
	RatesArgument,
	RatesBinding,
	RatesErrorCode,
	ResolvedRatePolicy,
	WindowRatePolicy,
} from './types.ts'

const DEFAULT_MAX_IDENTITIES = 10_000
const MAX_IDENTITIES = 1_000_000
const EXPIRY_CLEANUP_BUDGET = 64

export const MemoryRatesBackendConfig = v.object({
	maxIdentities: v.optional(
		v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_IDENTITIES)),
		DEFAULT_MAX_IDENTITIES,
	),
})

export type MemoryRatesBackendPluginConfig = v.InferOutput<typeof MemoryRatesBackendConfig>

/** Abstract caller-aware admission capability. Consumers depend on this token. */
export abstract class Rates extends BasePlugin implements RatesBinding {
	abstract readonly global: RatesBinding
	abstract use(name: string, policy: RatePolicy): RateLimiter
}

type EffectGuard = { readonly active: boolean }
type OwnerContext = {
	readonly pluginInfo: { readonly id: string }
	readonly effects: { defer(cleanup: () => void, meta?: { tag?: string }): EffectGuard }
	readonly registry: { getInstance(identifier: unknown): unknown }
}
type OwnerState = {
	active: boolean
	readonly context: OwnerContext
	readonly handles: Map<string, RateLimiterHandle>
	readonly registrations: Set<string>
}
type Registration = {
	readonly policy: Readonly<ResolvedRatePolicy>
	readonly owners: Set<OwnerState>
}
type RatesRuntime = {
	active: boolean
	readonly owners: WeakMap<object, OwnerState>
	readonly registrations: Map<string, Registration>
}

/** Validating caller-aware coordinator over a polymorphic atomic backend. */
@Plugin(Rates, { name: 'RatesPlugin' })
export class RatesPlugin extends Rates {
	private readonly runtime: RatesRuntime = {
		active: false,
		owners: new WeakMap(),
		registrations: new Map(),
	}

	constructor(private readonly backend: RatesBackend) {
		super()
	}

	protected override init(): void {
		this.runtime.active = true
	}

	override use(name: string, policy: RatePolicy): RateLimiter {
		return this.binding(false).use(name, policy)
	}

	override get global(): RatesBinding {
		return this.binding(true)
	}

	protected override stop(): void {
		this.runtime.active = false
		this.runtime.registrations.clear()
	}

	private binding(global: boolean): RatesBinding {
		this.assertActive()
		const owner = this.owner()
		return { use: (name, policy) => this.open(owner, global, name, policy) }
	}

	private owner(): OwnerState {
		const context = (this.ctx.caller ?? this.ctx) as unknown as OwnerContext
		let owner = this.runtime.owners.get(context)
		if (owner) {
			if (!owner.active) throw new RatesStoppedError()
			return owner
		}
		owner = { active: true, context, handles: new Map(), registrations: new Set() }
		this.runtime.owners.set(context, owner)
		const cleanupOwner = owner
		try {
			context.effects.defer(() => this.releaseOwner(cleanupOwner), { tag: 'rates-bindings' })
		} catch {
			owner.active = false
			throw new RatesStoppedError()
		}
		return owner
	}

	private open(
		owner: OwnerState,
		global: boolean,
		rawName: string,
		rawPolicy: RatePolicy,
	): RateLimiter {
		this.assertActive(owner)
		const name = normalizeName(rawName)
		const policy = normalizePolicy(rawPolicy)
		const ownerHandleId = `${global ? 'g' : 'l'}\0${name}`
		const existingHandle = owner.handles.get(ownerHandleId)
		if (existingHandle) {
			if (!policiesEqual(existingHandle.policy, policy)) {
				throw new RatesPolicyConflictError(existingHandle.policy, policy)
			}
			return existingHandle
		}

		const pluginId = owner.context.pluginInfo.id
		const registrationId = global ? `g\0${name}` : `l\0${pluginId}\0${name}`
		let registration = this.runtime.registrations.get(registrationId)
		if (registration && !policiesEqual(registration.policy, policy)) {
			throw new RatesPolicyConflictError(registration.policy, policy)
		}
		if (!registration) {
			registration = { policy, owners: new Set() }
			this.runtime.registrations.set(registrationId, registration)
		}
		registration.owners.add(owner)
		owner.registrations.add(registrationId)

		const prefix = global
			? `rates|v1|global|${encodeString(name)}|`
			: `rates|v1|plugin|${encodeString(pluginId)}|${encodeString(name)}|`
		const handle = new RateLimiterHandle(
			policy,
			prefix,
			() => this.assertHandleActive(owner),
			(request) => this.consumeBackend(request),
		)
		owner.handles.set(ownerHandleId, handle)
		return handle
	}

	private releaseOwner(owner: OwnerState): void {
		if (!owner.active) return
		owner.active = false
		for (const id of owner.registrations) {
			const registration = this.runtime.registrations.get(id)
			if (!registration) continue
			registration.owners.delete(owner)
			if (registration.owners.size === 0) this.runtime.registrations.delete(id)
		}
		owner.registrations.clear()
		owner.handles.clear()
	}

	private async consumeBackend(request: RatesBackendConsumeRequest): Promise<RateDecision> {
		this.assertActive()
		try {
			return validateBackendDecision(
				await this.backend.consume(request),
				request.policy,
				request.cost,
			)
		} catch (error) {
			if (
				error instanceof RatesStoppedError ||
				error instanceof RatesUnavailableError ||
				error instanceof RatesPolicyConflictError ||
				error instanceof RatesInvalidArgumentError
			)
				throw error
			throw new RatesUnavailableError({ cause: error })
		}
	}

	private assertActive(owner?: OwnerState): void {
		if (!this.runtime.active || (owner && !owner.active)) throw new RatesStoppedError()
		const current = (
			this.ctx.registry as unknown as { getInstance(identifier: unknown): unknown }
		).getInstance(Rates) as RatesPlugin | undefined
		if (!current || current.runtime !== this.runtime) throw new RatesStoppedError()
	}

	private assertHandleActive(owner: OwnerState): void {
		this.assertActive(owner)
		const activeOwner = owner.context.registry.getInstance(owner.context.pluginInfo.id) as
			| { ctx?: unknown }
			| undefined
		if (!activeOwner || activeOwner.ctx !== owner.context) throw new RatesStoppedError()
	}
}

class RateLimiterHandle implements RateLimiter {
	constructor(
		readonly policy: Readonly<ResolvedRatePolicy>,
		private readonly keyPrefix: string,
		private readonly assertActive: () => void,
		private readonly consumeBackend: (request: RatesBackendConsumeRequest) => Promise<RateDecision>,
	) {}

	async consume(identity: RateIdentity, options?: RateConsumeOptions): Promise<RateDecision> {
		this.assertActive()
		if (options !== undefined) validateConsumeOptions(options)
		const cost = normalizeCost(options?.cost, this.policy)
		const key = `${this.keyPrefix}${encodeIdentity(identity)}`
		return this.consumeBackend({ key, policy: this.policy, cost })
	}
}

type MemoryRuntime = {
	active: boolean
	readonly states: Map<string, RateState>
	readonly expiry: ExpiryHeap
}

/** Single-process backend for all built-in algorithms. Active identities are never evicted. */
@Plugin(RatesBackend, { name: 'MemoryRatesBackendPlugin' })
export class MemoryRatesBackendPlugin extends RatesBackend {
	private readonly config = this.configs.use(MemoryRatesBackendConfig)
	private readonly runtime: MemoryRuntime = {
		active: false,
		states: new Map(),
		expiry: new ExpiryHeap(),
	}

	protected override init(): void {
		this.runtime.active = true
	}

	async consume(request: RatesBackendConsumeRequest): Promise<RateDecision> {
		this.assertActive()
		const now = Date.now()
		this.deleteExpired(now, EXPIRY_CLEANUP_BUDGET)
		let state = this.runtime.states.get(request.key)
		if (state && state.expiresAt <= now) {
			this.runtime.expiry.delete(request.key)
			this.runtime.states.delete(request.key)
			state = undefined
		}
		if (state && !policiesEqual(state.policy, request.policy)) {
			throw new RatesPolicyConflictError(state.policy, request.policy)
		}
		if (!state) {
			if (this.runtime.states.size >= this.config.maxIdentities) {
				// Reclaim only enough expired state to admit this identity. If the root is live,
				// every remaining state is live and capacity must fail closed.
				this.deleteExpired(now, this.runtime.states.size - this.config.maxIdentities + 1)
			}
			if (this.runtime.states.size >= this.config.maxIdentities) {
				const expiresAt = this.runtime.expiry.peek()?.expiresAt
				throw new RatesUnavailableError({
					retryAfterMs: expiresAt === undefined ? undefined : Math.max(1, expiresAt - now),
				})
			}
			state = createState(request.policy, now)
			this.runtime.states.set(request.key, state)
		}
		const decision = consumeState(state, request.cost, now)
		this.runtime.expiry.set(request.key, state.expiresAt)
		return decision
	}

	protected override stop(): void {
		this.runtime.active = false
		this.runtime.states.clear()
		this.runtime.expiry.clear()
	}

	private deleteExpired(now: number, budget: number): void {
		for (let deleted = 0; deleted < budget; deleted++) {
			const next = this.runtime.expiry.peek()
			if (!next || next.expiresAt > now) return
			this.runtime.expiry.delete(next.key)
			this.runtime.states.delete(next.key)
		}
	}

	private assertActive(): void {
		if (!this.runtime.active) throw new RatesStoppedError()
	}
}

function validateBackendDecision(
	value: unknown,
	policy: Readonly<ResolvedRatePolicy>,
	cost: number,
): RateDecision {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('Expected a rates decision object.')
	}
	if (Object.getOwnPropertySymbols(value).length > 0) {
		throw new TypeError('Rates decision must not contain symbol fields.')
	}
	const prototype = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError('Expected a plain rates decision object.')
	}
	const descriptors = Object.getOwnPropertyDescriptors(value)
	const denied = decisionField(descriptors, 'denied')
	if (denied !== true && denied !== false) {
		throw new TypeError('Expected an exact rates decision shape.')
	}
	const keys = Object.keys(descriptors)
	const expectedKeyCount = denied ? 4 : 3
	if (
		keys.length !== expectedKeyCount ||
		keys.some(
			(key) =>
				key !== 'denied' &&
				key !== 'remaining' &&
				key !== 'resetAt' &&
				(denied === false || key !== 'retryAfterMs'),
		)
	) {
		throw new TypeError('Expected an exact rates decision shape.')
	}
	const remaining = nonNegativeSafeInteger(decisionField(descriptors, 'remaining'), 'remaining')
	const resetAt = nonNegativeSafeInteger(decisionField(descriptors, 'resetAt'), 'resetAt')
	const capacity = policy.algorithm === 'token-bucket' ? policy.burst : policy.limit
	const maximumRemaining = denied ? cost - 1 : capacity - cost
	if (remaining > maximumRemaining) {
		throw new TypeError('Rates decision remaining is inconsistent with the policy and cost.')
	}
	if (denied === false) return { denied, remaining, resetAt }
	return {
		denied,
		remaining,
		retryAfterMs: positiveSafeInteger(decisionField(descriptors, 'retryAfterMs'), 'retryAfterMs'),
		resetAt,
	}
}

function decisionField(
	descriptors: PropertyDescriptorMap,
	name: 'denied' | 'remaining' | 'retryAfterMs' | 'resetAt',
): unknown {
	const descriptor = descriptors[name]
	if (!descriptor?.enumerable || !('value' in descriptor)) {
		throw new TypeError('Rates decision fields must be enumerable data properties.')
	}
	return descriptor.value
}

function nonNegativeSafeInteger(value: unknown, name: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new TypeError(`Expected non-negative safe integer ${name}.`)
	}
	return value as number
}

function positiveSafeInteger(value: unknown, name: string): number {
	const number = nonNegativeSafeInteger(value, name)
	if (number < 1) throw new TypeError(`Expected positive safe integer ${name}.`)
	return number
}

function validateConsumeOptions(options: RateConsumeOptions): void {
	if (options === null || typeof options !== 'object' || Array.isArray(options)) {
		throw new RatesInvalidArgumentError('cost', 'options must be a plain object')
	}
	const prototype = Object.getPrototypeOf(options)
	if (prototype !== Object.prototype && prototype !== null) {
		throw new RatesInvalidArgumentError('cost', 'options must be a plain object')
	}
	if (Object.getOwnPropertySymbols(options).length > 0) {
		throw new RatesInvalidArgumentError('cost', 'options must not contain symbol fields')
	}
	const descriptors = Object.getOwnPropertyDescriptors(options)
	for (const [key, descriptor] of Object.entries(descriptors)) {
		if (key !== 'cost')
			throw new RatesInvalidArgumentError('cost', 'options contain an unknown field')
		if (!descriptor.enumerable || !('value' in descriptor)) {
			throw new RatesInvalidArgumentError('cost', 'must be an enumerable data property')
		}
	}
}

function encodeString(value: string): string {
	return `${new TextEncoder().encode(value).byteLength}:${value}`
}
