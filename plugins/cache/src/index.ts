import { deserialize, serialize } from 'node:v8'
import {
	BasePlugin,
	Plugin,
	pluginMethodDecorator,
	type PersistenceNamespace,
	v,
} from '@pluxel/runtime'
import { CacheBackend, type CacheBackendStore, type CacheValue } from './backend.ts'

export { CacheBackend } from './backend.ts'
export type { CacheBackendStore, CacheValue } from './backend.ts'

const DEFAULT_TTL_MS = 5 * 60_000
const DEFAULT_MAX_ENTRIES = 1_000
const DEFAULT_MAX_IN_FLIGHT = 256
const MAX_TIMER_DELAY_MS = 2_147_483_647
const MAX_KEY_PARTS = 16
const MAX_CANONICAL_KEY_BYTES = 1_024

export type CacheKeyPart = string | number | bigint | boolean
export type CacheKey =
	| CacheKeyPart
	| readonly CacheKeyPart[]
	| Readonly<Record<string, CacheKeyPart>>
export type CacheReadPolicy = 'cache-first' | 'cache-and-refresh' | 'remote-first'
export type CacheBackendFailurePolicy = 'required' | 'bypass'

export const CacheConfig = v.object({
	ttlMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), DEFAULT_TTL_MS),
	maxEntries: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), DEFAULT_MAX_ENTRIES),
	maxInFlight: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), DEFAULT_MAX_IN_FLIGHT),
	readPolicy: v.optional(
		v.picklist(['cache-first', 'cache-and-refresh', 'remote-first'] as const),
		'cache-first',
	),
	backendFailure: v.optional(v.picklist(['required', 'bypass'] as const), 'required'),
})

export const MemoryCacheBackendConfig = v.object({
	maxEntries: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 10_000),
	persistence: v.optional(
		v.object({
			mode: v.optional(v.picklist(['off', 'best-effort', 'durable'] as const), 'off'),
			flushIntervalMs: v.optional(
				v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_TIMER_DELAY_MS)),
				1_000,
			),
		}),
		{ mode: 'off', flushIntervalMs: 1_000 },
	),
})

export type MemoryCacheBackendPluginConfig = v.InferOutput<typeof MemoryCacheBackendConfig>

export interface CacheNamespaceOptions {
	/** Freshness window for local and backend writes unless overridden. */
	ttlMs?: number
	/** Maximum local entries retained for this namespace. */
	maxEntries?: number
	/** Maximum distinct keys doing async work. Same-key subscribers do not consume more slots. */
	maxInFlight?: number
	/** Async read order. Defaults to the CachePlugin configuration. */
	readPolicy?: CacheReadPolicy
	/** Whether getOrLoad requires the backend or may bypass it to the loader. */
	backendFailure?: CacheBackendFailurePolicy
}

export interface CacheSetOptions {
	/** Override the namespace TTL for this value. `0` means no expiry. */
	ttlMs?: number
}

export interface CacheLoadOptions extends CacheSetOptions {
	/** Override the namespace read policy for this operation. */
	readPolicy?: CacheReadPolicy
	/** Do not persist the loader result to the async backend. */
	skipBackendWrite?: boolean
	signal?: AbortSignal
}

export interface CacheGetOptions {
	readPolicy?: CacheReadPolicy
	signal?: AbortSignal
}

export interface CacheStats {
	readonly localHits: number
	readonly backendHits: number
	readonly misses: number
	readonly loads: number
	readonly deduplicated: number
	readonly rejected: number
	readonly refreshes: number
	readonly refreshErrors: number
	readonly backendReadErrors: number
	readonly backendWriteErrors: number
	readonly evictions: number
	readonly entries: number
	readonly inFlight: number
}

export class CacheStoppedError extends Error {
	override name = 'CacheStoppedError'

	constructor() {
		super('Cache handle belongs to a stopped or replaced caller or provider.')
	}
}

export class CacheBusyError extends Error {
	override name = 'CacheBusyError'

	constructor(
		readonly cacheName: string,
		readonly limit: number,
	) {
		super(`Cache "${cacheName}" reached its maxInFlight limit (${limit}).`)
	}
}

export type ResolvedCachePolicy = Readonly<{
	ttlMs: number
	maxEntries: number
	maxInFlight: number
	readPolicy: CacheReadPolicy
	backendFailure: CacheBackendFailurePolicy
}>

export class CachePolicyConflictError extends Error {
	override name = 'CachePolicyConflictError'

	constructor(
		readonly active: ResolvedCachePolicy,
		readonly requested: ResolvedCachePolicy,
	) {
		super('An active cache scope uses a different normalized policy.')
	}
}

export interface LocalCache {
	get<V>(key: CacheKey): V | undefined
	has(key: CacheKey): boolean
	set<V>(key: CacheKey, value: V, options?: CacheSetOptions): void
	delete(key: CacheKey): boolean
	clear(): void
	getOrCompute<V>(key: CacheKey, compute: () => V, options?: CacheSetOptions): V
	stats(): CacheStats
}

export interface CacheNamespace {
	readonly local: LocalCache
	get<V>(key: CacheKey, options?: CacheGetOptions): Promise<V | undefined>
	set<V>(key: CacheKey, value: V, options?: CacheSetOptions): Promise<void>
	delete(key: CacheKey): Promise<boolean>
	clear(): Promise<void>
	getOrLoad<V>(key: CacheKey, load: () => V | Promise<V>, options?: CacheLoadOptions): Promise<V>
	scope(name: string, options?: CacheNamespaceOptions): CacheNamespace
	stats(): CacheStats
}

export interface MemoizedOptions<Args extends unknown[] = unknown[]>
	extends CacheSetOptions, Pick<CacheNamespaceOptions, 'maxEntries'> {
	/** Caller-local method scope name. Defaults to the decorated method name. */
	name?: string
	/** Maps arguments to a cache key. Primitive argument tuples have a stable default. */
	key?: (...args: Args) => CacheKey
}

export interface CachedOptions<Args extends unknown[] = unknown[]>
	extends
		MemoizedOptions<Args>,
		Pick<CacheNamespaceOptions, 'maxInFlight' | 'readPolicy' | 'backendFailure'> {
	skipBackendWrite?: boolean
}

export function Cached<Args extends unknown[] = unknown[]>(
	options: CachedOptions<Args> = {},
): MethodDecorator {
	const handles = new WeakMap<object, CacheNamespace>()

	return pluginMethodDecorator(Cache, async function (original, provider, method, ...args) {
		const owner = this as object
		let handle = handles.get(owner)
		if (!handle) {
			handle = provider.scope(methodScopeName(method, options.name), namespaceOptions(options))
			handles.set(owner, handle)
		}
		const key = options.key ? options.key(...(args as Args)) : defaultMethodKey(args)
		return handle.getOrLoad(
			key,
			() => {
				const value = original.apply(this, args)
				if (!isPromiseLike(value)) {
					throw new TypeError('@Cached requires a Promise-returning method; use @Memoized.')
				}
				return Promise.resolve(value)
			},
			loadOptions(options),
		)
	})
}

export function Memoized<Args extends unknown[] = unknown[]>(
	options: MemoizedOptions<Args> = {},
): MethodDecorator {
	const handles = new WeakMap<object, LocalCache>()

	return pluginMethodDecorator(Cache, function (original, provider, method, ...args) {
		const owner = this as object
		let handle = handles.get(owner)
		if (!handle) {
			handle = provider.scope(
				methodScopeName(method, options.name),
				namespaceOptions(options),
			).local
			handles.set(owner, handle)
		}
		const key = options.key ? options.key(...(args as Args)) : defaultMethodKey(args)
		return handle.getOrCompute(
			key,
			() => {
				const value = original.apply(this, args)
				if (isPromiseLike(value)) {
					throw new TypeError('@Memoized cannot decorate a Promise-returning method; use @Cached.')
				}
				return value
			},
			setOptions(options),
		)
	})
}

type Entry = {
	key: string
	value: unknown
	expiresAt: number
	visited: boolean
	newer?: Entry
	older?: Entry
}

type MutableStats = {
	localHits: number
	backendHits: number
	misses: number
	loads: number
	deduplicated: number
	rejected: number
	refreshes: number
	refreshErrors: number
	backendReadErrors: number
	backendWriteErrors: number
	evictions: number
}

type Bucket = {
	active: boolean
	entries: Map<string, Entry>
	inFlight: Map<string, Promise<unknown>>
	mutations: Map<string, Promise<void>>
	clearBarrier?: Promise<void>
	stats: MutableStats
	maxEntries: number
	maxInFlight: number
	newest?: Entry
	oldest?: Entry
	hand?: Entry
}

type InternalNamespace = ResolvedCachePolicy & {
	name: string
}

type CacheDefaults = {
	ttlMs: number
	maxEntries: number
	maxInFlight: number
	readPolicy: CacheReadPolicy
	backendFailure: CacheBackendFailurePolicy
}

type Resolved = {
	namespace: InternalNamespace
	backendPrefix: string
	bucket: Bucket
}

type OwnerContext = {
	readonly pluginInfo: { readonly id: string }
	readonly effects: { defer(cleanup: () => void, meta?: { tag?: string }): unknown }
	readonly registry: { getInstance(identifier: unknown): unknown }
}

type CacheOwnerState = {
	active: boolean
	readonly context: OwnerContext
	readonly handles: Map<
		string,
		{ readonly view: CacheNamespace; readonly policy: InternalNamespace }
	>
	readonly registrations: Set<string>
}

type CacheRegistration = {
	readonly namespace: InternalNamespace
	readonly backendPrefix: string
	readonly bucket: Bucket
	readonly owners: Set<CacheOwnerState>
}

type CacheRuntime = {
	active: boolean
	readonly owners: WeakMap<object, CacheOwnerState>
	readonly registrations: Map<string, CacheRegistration>
}

type MemoryCachePersistenceMode = MemoryCacheBackendPluginConfig['persistence']['mode']

type MemoryCacheSnapshotV1 = {
	format: 'pluxel-memory-cache'
	version: 1
	entries: Array<{
		key: string
		expiresAt: number
		value: Uint8Array
	}>
}

type MemoryCacheBackendRuntime = {
	state?: { bucket: Bucket; resolved: Resolved }
	serializedValues: Map<string, Uint8Array>
	storage?: PersistenceNamespace
	persistenceMode: MemoryCachePersistenceMode
	persistenceWritable: boolean
	dirtyRevision: number
	savedRevision: number
	flushTimer?: ReturnType<typeof setTimeout>
	flushTask?: Promise<void>
	running: boolean
	stopping: boolean
}

const MEMORY_CACHE_PERSISTENCE_NAMESPACE = '@pluxel/cache'
const MEMORY_CACHE_SNAPSHOT_KEY = 'memory-backend.snapshot'

function defaultEncodeKey(key: CacheKey): string {
	let encoded: string
	if (isCacheKeyPart(key)) {
		encoded = `p|${encodeKeyPart(key)}`
	} else if (Array.isArray(key)) {
		if (Object.getPrototypeOf(key) !== Array.prototype)
			throw new TypeError('Cache tuple keys must be plain arrays.')
		if (key.length > MAX_KEY_PARTS)
			throw new RangeError(`Cache tuple keys must not exceed ${MAX_KEY_PARTS} parts.`)
		const descriptors = Object.getOwnPropertyDescriptors(key)
		const keys = Object.keys(descriptors).filter((part) => part !== 'length')
		if (keys.length !== key.length || keys.some((part, index) => part !== String(index))) {
			throw new TypeError('Cache tuple keys must be dense and contain only indexed parts.')
		}
		if (Object.getOwnPropertySymbols(key).length > 0)
			throw new TypeError('Cache keys must not contain symbol fields.')
		encoded = `t|${key.length}|${keys
			.map((part) => {
				const descriptor = descriptors[part]!
				if (
					!descriptor.enumerable ||
					!('value' in descriptor) ||
					!isCacheKeyPart(descriptor.value)
				) {
					throw new TypeError('Cache tuple parts must be enumerable primitive data properties.')
				}
				return encodeKeyPart(descriptor.value)
			})
			.join('')}`
	} else {
		if (!isPlainObject(key)) throw new TypeError('Cache record keys must be plain objects.')
		if (Object.getOwnPropertySymbols(key).length > 0)
			throw new TypeError('Cache keys must not contain symbol fields.')
		const descriptors = Object.getOwnPropertyDescriptors(key)
		const keys = Object.keys(descriptors).sort()
		if (keys.length > MAX_KEY_PARTS)
			throw new RangeError(`Cache record keys must not exceed ${MAX_KEY_PARTS} parts.`)
		encoded = `r|${keys.length}|${keys
			.map((part) => {
				const descriptor = descriptors[part]!
				if (
					!descriptor.enumerable ||
					!('value' in descriptor) ||
					!isCacheKeyPart(descriptor.value)
				) {
					throw new TypeError('Cache record values must be enumerable primitive data properties.')
				}
				return `${utf8Length(part)}:${part}${encodeKeyPart(descriptor.value)}`
			})
			.join('')}`
	}
	const canonical = `v1|${encoded}`
	if (utf8Length(canonical) > MAX_CANONICAL_KEY_BYTES) {
		throw new RangeError(
			`Cache canonical keys must not exceed ${MAX_CANONICAL_KEY_BYTES} UTF-8 bytes.`,
		)
	}
	return canonical
}

function encodeKeyPart(value: CacheKeyPart): string {
	switch (typeof value) {
		case 'string':
			return `s${utf8Length(value)}:${value}`
		case 'number':
			if (!Number.isFinite(value)) throw new TypeError('Cache number keys must be finite.')
			return `n${Object.is(value, -0) ? '-0' : String(value)};`
		case 'bigint':
			return `i${value};`
		case 'boolean':
			return value ? 'b1;' : 'b0;'
	}
}

function isCacheKeyPart(value: unknown): value is CacheKeyPart {
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

function utf8Length(value: string): number {
	return new TextEncoder().encode(value).byteLength
}

function defaultMethodKey(args: unknown[]): CacheKey {
	if (args.length === 0) return []
	if (args.length === 1 && isCacheKeyPart(args[0])) return args[0]
	if (args.length <= MAX_KEY_PARTS && args.every(isCacheKeyPart)) {
		return args.slice() as CacheKeyPart[]
	}
	throw new TypeError(
		'Decorated methods require an explicit key() for non-primitive or oversized argument lists.',
	)
}

function methodScopeName(method: string | symbol, configured: string | undefined): string {
	if (configured) return validateScopeName(configured)
	const raw = typeof method === 'string' ? method : (method.description ?? 'symbol')
	return `method/${raw.replaceAll(/[^A-Za-z0-9._:/-]/g, '_')}`
}

function namespaceOptions(options: CacheNamespaceOptions): CacheNamespaceOptions {
	return {
		ttlMs: options.ttlMs,
		maxEntries: options.maxEntries,
		maxInFlight: options.maxInFlight,
		readPolicy: options.readPolicy,
		backendFailure: options.backendFailure,
	}
}

function normalizeNamespace(
	name: string,
	options: CacheNamespaceOptions,
	defaults: CacheDefaults,
): InternalNamespace {
	validateNamespaceOptions(options)
	const ttlMs = normalizeDuration(options.ttlMs ?? defaults.ttlMs, 'ttlMs')
	const maxEntries = options.maxEntries ?? defaults.maxEntries
	if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
		throw new RangeError('Cache maxEntries must be a positive safe integer.')
	}
	const maxInFlight = options.maxInFlight ?? defaults.maxInFlight
	if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1) {
		throw new RangeError('Cache maxInFlight must be a positive safe integer.')
	}
	const readPolicy = options.readPolicy ?? defaults.readPolicy
	const backendFailure = options.backendFailure ?? defaults.backendFailure
	return Object.freeze({ name, ttlMs, maxEntries, maxInFlight, readPolicy, backendFailure })
}

function validateNamespaceOptions(options: CacheNamespaceOptions): void {
	if (!isPlainObject(options))
		throw new TypeError('Cache scope policy must be an exact plain object.')
	if (Object.getOwnPropertySymbols(options).length > 0)
		throw new TypeError('Cache scope policy must not contain symbol fields.')
	const allowed = new Set(['ttlMs', 'maxEntries', 'maxInFlight', 'readPolicy', 'backendFailure'])
	for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(options))) {
		if (!allowed.has(key)) throw new TypeError(`Cache scope policy contains unknown field ${key}.`)
		if (!descriptor.enumerable || !('value' in descriptor))
			throw new TypeError(`Cache scope policy field ${key} must be an enumerable data property.`)
	}
}

function cachePoliciesEqual(a: ResolvedCachePolicy, b: ResolvedCachePolicy): boolean {
	return (
		a.ttlMs === b.ttlMs &&
		a.maxEntries === b.maxEntries &&
		a.maxInFlight === b.maxInFlight &&
		a.readPolicy === b.readPolicy &&
		a.backendFailure === b.backendFailure
	)
}

function validateScopeName(name: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(name)) {
		throw new TypeError(
			'Cache scope must start with an alphanumeric character and contain only A-Z, a-z, 0-9, ., _, :, /, or -.',
		)
	}
	return name
}

function setOptions(options: CacheSetOptions): CacheSetOptions | undefined {
	return options.ttlMs === undefined ? undefined : { ttlMs: options.ttlMs }
}

function loadOptions(options: CacheLoadOptions): CacheLoadOptions | undefined {
	if (
		options.ttlMs === undefined &&
		options.readPolicy === undefined &&
		options.skipBackendWrite === undefined &&
		options.signal === undefined
	) {
		return undefined
	}
	return {
		ttlMs: options.ttlMs,
		readPolicy: options.readPolicy,
		skipBackendWrite: options.skipBackendWrite,
		signal: options.signal,
	}
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		value !== null &&
		(typeof value === 'object' || typeof value === 'function') &&
		typeof (value as { then?: unknown }).then === 'function'
	)
}

function normalizeDuration(value: number, field: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(`Cache ${field} must be a non-negative safe integer.`)
	}
	return value
}

function emptyStats(): MutableStats {
	return {
		localHits: 0,
		backendHits: 0,
		misses: 0,
		loads: 0,
		deduplicated: 0,
		rejected: 0,
		refreshes: 0,
		refreshErrors: 0,
		backendReadErrors: 0,
		backendWriteErrors: 0,
		evictions: 0,
	}
}

/**
 * Abstract cache capability token. Consumers depend on this class; the host selects a provider.
 */
export abstract class Cache extends BasePlugin implements CacheNamespace {
	abstract readonly local: LocalCache
	abstract readonly global: CacheNamespace
	abstract get<V>(key: CacheKey, options?: CacheGetOptions): Promise<V | undefined>
	abstract set<V>(key: CacheKey, value: V, options?: CacheSetOptions): Promise<void>
	abstract delete(key: CacheKey): Promise<boolean>
	abstract clear(): Promise<void>
	abstract getOrLoad<V>(
		key: CacheKey,
		load: () => V | Promise<V>,
		options?: CacheLoadOptions,
	): Promise<V>
	abstract scope(name: string, options?: CacheNamespaceOptions): CacheNamespace
	abstract stats(): CacheStats
}

/**
 * Caller-aware coordinator with synchronous local caching and a polymorphic async backend.
 */
@Plugin(Cache, { name: 'CachePlugin' })
export class CachePlugin extends Cache {
	protected readonly config = this.configs.use(CacheConfig)
	private readonly runtime: CacheRuntime = {
		active: false,
		owners: new WeakMap(),
		registrations: new Map(),
	}

	constructor(private readonly backend: CacheBackend) {
		super()
	}

	protected override init(): void {
		this.runtime.active = true
	}

	override get local(): LocalCache {
		return this.current().local
	}

	override get<V>(key: CacheKey, options?: CacheGetOptions): Promise<V | undefined> {
		return this.current().get<V>(key, options)
	}

	override set<V>(key: CacheKey, value: V, options?: CacheSetOptions): Promise<void> {
		return this.current().set(key, value, options)
	}

	override delete(key: CacheKey): Promise<boolean> {
		return this.current().delete(key)
	}

	override clear(): Promise<void> {
		return this.current().clear()
	}

	override getOrLoad<V>(
		key: CacheKey,
		load: () => V | Promise<V>,
		options?: CacheLoadOptions,
	): Promise<V> {
		return this.current().getOrLoad(key, load, options)
	}

	override get global(): CacheNamespace {
		return this.open(this.owner(), true, '', undefined)
	}

	override scope(name: string, options?: CacheNamespaceOptions): CacheNamespace {
		return this.open(this.owner(), false, validateScopeName(name), options)
	}

	override stats(): CacheStats {
		return this.current().stats()
	}

	protected override stop(): void {
		this.runtime.active = false
		for (const registration of this.runtime.registrations.values()) {
			deactivateBucket(registration.bucket)
		}
		this.runtime.registrations.clear()
	}

	private current(): CacheNamespace {
		return this.open(this.owner(), false, '', undefined)
	}

	private owner(): CacheOwnerState {
		this.assertActive()
		const context = (this.ctx.caller ?? this.ctx) as unknown as OwnerContext
		let owner = this.runtime.owners.get(context)
		if (owner) {
			this.assertOwnerActive(owner)
			return owner
		}
		owner = { active: true, context, handles: new Map(), registrations: new Set() }
		this.runtime.owners.set(context, owner)
		const cleanupOwner = owner
		try {
			context.effects.defer(() => this.releaseOwner(cleanupOwner), { tag: 'cache-bindings' })
		} catch {
			owner.active = false
			throw new CacheStoppedError()
		}
		return owner
	}

	private open(
		owner: CacheOwnerState,
		global: boolean,
		name: string,
		options: CacheNamespaceOptions | undefined,
		parentPolicy?: ResolvedCachePolicy,
	): CacheNamespace {
		this.assertOwnerActive(owner)
		const ownerHandleId = `${global ? 'g' : 'l'}\0${name}`
		const existingHandle = owner.handles.get(ownerHandleId)
		if (existingHandle) {
			if (options !== undefined) {
				const requested = normalizeNamespace(
					name,
					options,
					(parentPolicy ?? this.config) as CacheDefaults,
				)
				if (!cachePoliciesEqual(existingHandle.policy, requested)) {
					throw new CachePolicyConflictError(existingHandle.policy, requested)
				}
			}
			return existingHandle.view
		}

		const pluginId = owner.context.pluginInfo.id
		const registrationId = global ? `g\0${name}` : `l\0${pluginId}\0${name}`
		let registration = this.runtime.registrations.get(registrationId)
		let namespace: InternalNamespace
		if (registration) {
			namespace = registration.namespace
			if (options !== undefined) {
				const requested = normalizeNamespace(
					name,
					options,
					(parentPolicy ?? this.config) as CacheDefaults,
				)
				if (!cachePoliciesEqual(namespace, requested)) {
					throw new CachePolicyConflictError(namespace, requested)
				}
			}
		} else {
			namespace = normalizeNamespace(
				name,
				options ?? {},
				(parentPolicy ?? this.config) as CacheDefaults,
			)
			const backendPrefix = global
				? `global:${name ? `${escapePart(name)}:` : ''}`
				: `plugin:${escapePart(pluginId)}:${name ? `${escapePart(name)}:` : ''}`
			const bucket: Bucket = {
				active: true,
				entries: new Map(),
				inFlight: new Map(),
				mutations: new Map(),
				stats: emptyStats(),
				maxEntries: namespace.maxEntries,
				maxInFlight: namespace.maxInFlight,
			}
			registration = { namespace, backendPrefix, bucket, owners: new Set() }
			this.runtime.registrations.set(registrationId, registration)
		}
		registration.owners.add(owner)
		owner.registrations.add(registrationId)
		const resolved: Resolved = {
			namespace,
			backendPrefix: registration.backendPrefix,
			bucket: registration.bucket,
		}
		const view = new NamespaceView(
			resolved,
			this.backend,
			() => this.assertHandleActive(owner),
			(child, childOptions) => {
				const childName = name ? `${name}/${validateScopeName(child)}` : validateScopeName(child)
				return this.open(owner, global, childName, childOptions, namespace)
			},
		)
		owner.handles.set(ownerHandleId, { view, policy: namespace })
		return view
	}

	private releaseOwner(owner: CacheOwnerState): void {
		if (!owner.active) return
		owner.active = false
		for (const id of owner.registrations) {
			const registration = this.runtime.registrations.get(id)
			if (!registration) continue
			registration.owners.delete(owner)
			if (registration.owners.size === 0) {
				deactivateBucket(registration.bucket)
				this.runtime.registrations.delete(id)
			}
		}
		owner.registrations.clear()
		owner.handles.clear()
	}

	private assertActive(): void {
		if (!this.runtime.active) throw new CacheStoppedError()
		const current = (
			this.ctx.registry as unknown as { getInstance(identifier: unknown): unknown }
		).getInstance(Cache) as CachePlugin | undefined
		if (!current || current.runtime !== this.runtime) throw new CacheStoppedError()
	}

	private assertHandleActive(owner: CacheOwnerState): void {
		this.assertOwnerActive(owner)
		const activeOwner = owner.context.registry.getInstance(owner.context.pluginInfo.id) as
			| { ctx?: unknown }
			| undefined
		if (!activeOwner || activeOwner.ctx !== owner.context) throw new CacheStoppedError()
	}

	private assertOwnerActive(owner: CacheOwnerState): void {
		this.assertActive()
		if (!owner.active) throw new CacheStoppedError()
	}
}

@Plugin(CacheBackend, { name: 'MemoryCacheBackendPlugin' })
export class MemoryCacheBackendPlugin extends CacheBackend {
	private readonly config = this.configs.use(MemoryCacheBackendConfig)
	/** Caller-bound dependency views inherit this reference, so all mutations stay provider-owned. */
	private readonly holder: MemoryCacheBackendRuntime = {
		serializedValues: new Map(),
		persistenceMode: 'off',
		persistenceWritable: false,
		dirtyRevision: 0,
		savedRevision: 0,
		running: false,
		stopping: false,
	}

	protected override async init(): Promise<void> {
		this.prepareStart()
		try {
			this.getState()
			this.holder.persistenceMode = this.config.persistence.mode
			if (this.holder.persistenceMode === 'off') return

			const persistence = this.ctx.root.persistence
			this.holder.storage = persistence.namespace(MEMORY_CACHE_PERSISTENCE_NAMESPACE)
			if (this.holder.persistenceMode === 'durable') {
				await persistence.preflight({ durable: true, writable: true })
				this.holder.persistenceWritable = true
			} else {
				try {
					await persistence.preflight({ writable: true })
					this.holder.persistenceWritable = true
				} catch (error) {
					this.ctx.logger.warn(
						'Memory cache persistence is not writable; restoring without saving updates',
						{ error },
					)
				}
				if (persistence.capability === 'ephemeral') {
					this.ctx.logger.warn(
						'Memory cache best-effort persistence is using ephemeral storage and will not survive a process restart',
					)
				}
			}

			await this.restoreSnapshot()
		} catch (error) {
			this.deactivate()
			throw error
		}
	}

	async get<V>(key: string): Promise<CacheValue<V> | undefined> {
		const bucket = this.getState().bucket
		const entry = readEntryNode(bucket, key)
		if (!entry) return undefined
		const ttlMs = entry.expiresAt === 0 ? 0 : entry.expiresAt - Date.now()
		if (entry.expiresAt !== 0 && ttlMs <= 0) {
			deleteEntry(bucket, key)
			return undefined
		}
		return {
			value: entry.value as V,
			ttlMs,
		}
	}

	async set<V>(key: string, value: V, { ttlMs }: { ttlMs: number }): Promise<void> {
		if (value === undefined) throw new TypeError('Cache values cannot be undefined.')
		const state = this.getState()
		const normalizedTtl = normalizeDuration(ttlMs, 'ttlMs')
		const encoded = this.holder.persistenceWritable ? serializeCacheValue(value) : undefined
		const evicted = writeEntry(state.resolved, key, value, normalizedTtl)
		if (encoded) {
			if (evicted) this.holder.serializedValues.delete(evicted)
			this.holder.serializedValues.set(key, encoded)
			this.requestSnapshot()
		}
	}

	async delete(key: string): Promise<void> {
		const deleted = deleteEntry(this.getState().bucket, key)
		const serialized = this.holder.serializedValues.delete(key)
		if (deleted || serialized) this.requestSnapshot()
	}

	async clear(prefix: string): Promise<void> {
		const bucket = this.getState().bucket
		let changed = false
		for (const key of bucket.entries.keys()) {
			if (key.startsWith(prefix) && deleteEntry(bucket, key)) changed = true
		}
		for (const key of this.holder.serializedValues.keys()) {
			if (!key.startsWith(prefix)) continue
			this.holder.serializedValues.delete(key)
			changed = true
		}
		if (changed) this.requestSnapshot()
	}

	protected override async stop(): Promise<void> {
		this.holder.stopping = true
		this.holder.running = false
		this.cancelScheduledSnapshot()
		try {
			await this.flushSnapshot()
		} finally {
			this.deactivate()
		}
	}

	private async restoreSnapshot(): Promise<void> {
		const storage = this.holder.storage
		if (!storage) return

		try {
			const bytes = await storage.get(MEMORY_CACHE_SNAPSHOT_KEY)
			if (!bytes) return
			const snapshot = decodeMemoryCacheSnapshot(bytes)
			const state = this.getState()
			const now = Date.now()
			let needsRewrite = false
			const liveEntries: MemoryCacheSnapshotV1['entries'] = []
			for (const entry of snapshot.entries) {
				if (entry.expiresAt !== 0 && entry.expiresAt <= now) {
					needsRewrite = true
					continue
				}
				liveEntries.push(entry)
			}
			if (liveEntries.length > state.bucket.maxEntries) {
				liveEntries.splice(0, liveEntries.length - state.bucket.maxEntries)
				needsRewrite = true
			}
			for (const entry of liveEntries) {
				const value = deserialize(entry.value)
				if (value === undefined) throw new TypeError('Snapshot values cannot be undefined.')
				writeEntryAt(state.resolved, entry.key, value, entry.expiresAt)
				this.holder.serializedValues.set(entry.key, Uint8Array.from(entry.value))
			}
			if (state.bucket.entries.size !== this.holder.serializedValues.size) {
				needsRewrite = true
				for (const key of this.holder.serializedValues.keys()) {
					if (!state.bucket.entries.has(key)) this.holder.serializedValues.delete(key)
				}
			}
			if (needsRewrite) this.requestSnapshot()
		} catch (error) {
			if (this.holder.persistenceMode === 'durable') {
				throw new Error('Memory cache snapshot could not be restored.', {
					cause: error,
				})
			}
			this.ctx.logger.warn('Memory cache snapshot could not be restored; starting empty', {
				error,
			})
			this.holder.serializedValues.clear()
			clearEntries(this.getState().bucket)
			this.requestSnapshot()
		}
	}

	private requestSnapshot(): void {
		if (!this.holder.persistenceWritable || this.holder.persistenceMode === 'off') return
		this.holder.dirtyRevision++
		if (this.holder.stopping || this.holder.flushTimer) return
		this.holder.flushTimer = setTimeout(() => {
			this.holder.flushTimer = undefined
			void this.flushSnapshot().catch((error) => {
				this.ctx.logger.error('Memory cache snapshot flush failed', { error })
			})
		}, this.config.persistence.flushIntervalMs)
		unrefTimer(this.holder.flushTimer)
	}

	private cancelScheduledSnapshot(): void {
		if (!this.holder.flushTimer) return
		clearTimeout(this.holder.flushTimer)
		this.holder.flushTimer = undefined
	}

	private async flushSnapshot(): Promise<void> {
		if (
			!this.holder.persistenceWritable ||
			this.holder.savedRevision >= this.holder.dirtyRevision
		) {
			return
		}
		if (this.holder.flushTask) return await this.holder.flushTask

		const task = this.writeSnapshots()
		this.holder.flushTask = task
		try {
			await task
		} finally {
			if (this.holder.flushTask === task) this.holder.flushTask = undefined
		}
	}

	private async writeSnapshots(): Promise<void> {
		const storage = this.holder.storage
		if (!storage) return
		while (this.holder.savedRevision < this.holder.dirtyRevision) {
			const revision = this.holder.dirtyRevision
			const snapshot = this.createSnapshot()
			try {
				await storage.put(MEMORY_CACHE_SNAPSHOT_KEY, serialize(snapshot), { atomic: true })
				this.holder.savedRevision = revision
			} catch (error) {
				if (this.holder.persistenceMode === 'durable') throw error
				this.ctx.logger.warn('Memory cache best-effort snapshot could not be saved', { error })
				return
			}
		}
	}

	private createSnapshot(): MemoryCacheSnapshotV1 {
		const entries: MemoryCacheSnapshotV1['entries'] = []
		const bucket = this.holder.state?.bucket
		if (!bucket) throw new CacheStoppedError()
		const now = Date.now()
		let entry = bucket.oldest
		while (entry) {
			const next = entry.newer
			if (entry.expiresAt !== 0 && entry.expiresAt <= now) {
				removeEntry(bucket, entry)
				this.holder.serializedValues.delete(entry.key)
			} else {
				const value = this.holder.serializedValues.get(entry.key)
				if (!value) throw new Error('Memory cache snapshot state is inconsistent.')
				entries.push({
					key: entry.key,
					expiresAt: entry.expiresAt,
					value: Uint8Array.from(value),
				})
			}
			entry = next
		}
		for (const key of this.holder.serializedValues.keys()) {
			if (!bucket.entries.has(key)) this.holder.serializedValues.delete(key)
		}
		return { format: 'pluxel-memory-cache', version: 1, entries }
	}

	private getState(): { bucket: Bucket; resolved: Resolved } {
		if (!this.holder.running) throw new CacheStoppedError()
		if (this.holder.state) return this.holder.state
		const maxEntries = this.config.maxEntries
		if (!maxEntries) throw new Error('Memory cache backend config is not ready.')
		const bucket: Bucket = {
			active: true,
			entries: new Map(),
			inFlight: new Map(),
			mutations: new Map(),
			stats: emptyStats(),
			maxEntries,
			maxInFlight: 1,
		}
		const resolved: Resolved = {
			namespace: {
				name: 'memory-backend',
				ttlMs: 0,
				maxEntries,
				maxInFlight: 1,
				readPolicy: 'cache-first',
				backendFailure: 'required',
			},
			backendPrefix: '',
			bucket,
		}
		return (this.holder.state = { bucket, resolved })
	}

	private prepareStart(): void {
		this.deactivate()
		this.holder.persistenceMode = 'off'
		this.holder.dirtyRevision = 0
		this.holder.savedRevision = 0
		this.holder.flushTask = undefined
		this.holder.running = true
		this.holder.stopping = false
	}

	private deactivate(): void {
		this.cancelScheduledSnapshot()
		if (this.holder.state) {
			deactivateBucket(this.holder.state.bucket)
			this.holder.state = undefined
		}
		this.holder.serializedValues.clear()
		this.holder.storage = undefined
		this.holder.persistenceWritable = false
		this.holder.running = false
	}
}

class NamespaceView implements CacheNamespace {
	readonly local: LocalCache
	private readonly access: AsyncView

	constructor(
		resolved: Resolved,
		backend: CacheBackendStore,
		assertHandleActive: () => void,
		private readonly openChild: (
			name: string,
			options: CacheNamespaceOptions | undefined,
		) => CacheNamespace,
	) {
		this.local = new LocalView(resolved, assertHandleActive)
		this.access = new AsyncView(resolved, assertHandleActive, backend)
	}

	get<V>(key: CacheKey, options?: CacheGetOptions): Promise<V | undefined> {
		return this.access.get<V>(key, options)
	}

	set<V>(key: CacheKey, value: V, options?: CacheSetOptions): Promise<void> {
		return this.access.set(key, value, options)
	}

	delete(key: CacheKey): Promise<boolean> {
		return this.access.delete(key)
	}

	clear(): Promise<void> {
		return this.access.clear()
	}

	getOrLoad<V>(key: CacheKey, load: () => V | Promise<V>, options?: CacheLoadOptions): Promise<V> {
		return this.access.getOrLoad(key, load, options)
	}

	scope(name: string, options?: CacheNamespaceOptions): CacheNamespace {
		this.access.assertUsable()
		return this.openChild(name, options)
	}

	stats(): CacheStats {
		return this.access.stats()
	}
}

class CacheViewBase {
	constructor(
		protected readonly resolved: Resolved,
		private readonly assertHandleActive: () => void,
	) {}

	assertUsable(): void {
		this.assertHandleActive()
		assertActive(this.resolved.bucket)
	}

	protected encode(key: CacheKey): string {
		this.assertUsable()
		return defaultEncodeKey(key)
	}
}

class LocalView extends CacheViewBase implements LocalCache {
	get<V>(key: CacheKey): V | undefined {
		const encoded = this.encode(key)
		const value = readEntry(this.resolved.bucket, encoded)
		if (value !== undefined) this.resolved.bucket.stats.localHits++
		return value as V | undefined
	}

	has(key: CacheKey): boolean {
		return this.get(key) !== undefined
	}

	set<V>(key: CacheKey, value: V, options?: CacheSetOptions): void {
		if (value === undefined) throw new TypeError('Cache values cannot be undefined.')
		writeEntry(this.resolved, this.encode(key), value, ttlFor(this.resolved, options))
	}

	delete(key: CacheKey): boolean {
		return deleteEntry(this.resolved.bucket, this.encode(key))
	}

	clear(): void {
		this.assertUsable()
		clearEntries(this.resolved.bucket)
	}

	getOrCompute<V>(key: CacheKey, compute: () => V, options?: CacheSetOptions): V {
		const encoded = this.encode(key)
		const hit = readEntry(this.resolved.bucket, encoded)
		if (hit !== undefined) {
			this.resolved.bucket.stats.localHits++
			return hit as V
		}
		const value = compute()
		if (value === undefined) throw new TypeError('Cache values cannot be undefined.')
		writeEntry(this.resolved, encoded, value, ttlFor(this.resolved, options))
		return value
	}

	stats(): CacheStats {
		this.assertUsable()
		return snapshotStats(this.resolved.bucket)
	}
}

class BackendReadFailure extends Error {
	constructor(readonly cause: unknown) {
		super('Cache backend read failed.', { cause })
	}
}

class AsyncView extends CacheViewBase {
	constructor(
		resolved: Resolved,
		assertHandleActive: () => void,
		private readonly backend: CacheBackendStore,
	) {
		super(resolved, assertHandleActive)
	}

	async get<V>(key: CacheKey, options: CacheGetOptions = {}): Promise<V | undefined> {
		const encoded = this.encode(key)
		await this.awaitMutation(encoded)
		this.assertUsable()
		const policy = options.readPolicy ?? this.resolved.namespace.readPolicy
		if (policy !== 'remote-first') {
			const l1 = readEntry(this.resolved.bucket, encoded)
			if (l1 !== undefined) {
				this.resolved.bucket.stats.localHits++
				if (policy === 'cache-and-refresh') {
					this.refreshInBackground<V>(encoded)
				}
				return l1 as V
			}
		}
		const active = this.resolved.bucket.inFlight.get(encoded)
		if (active) {
			this.resolved.bucket.stats.deduplicated++
			return this.waitForRead(active as Promise<V | undefined>, options.signal)
		}
		const pending = this.singleFlight(encoded, async () => {
			this.assertUsable()
			if (policy !== 'remote-first') {
				const lateLocal = readEntry(this.resolved.bucket, encoded)
				if (lateLocal !== undefined) {
					this.resolved.bucket.stats.localHits++
					return lateLocal as V
				}
			}
			const found = await this.readBackend<V>(encoded)
			this.assertUsable()
			if (!found) {
				this.resolved.bucket.stats.misses++
				return undefined
			}
			assertBackendValue(found.value)
			this.resolved.bucket.stats.backendHits++
			writeEntry(this.resolved, encoded, found.value, backendTtl(this.resolved, found))
			return found.value
		})
		return this.waitForRead(pending, options.signal)
	}

	async set<V>(key: CacheKey, value: V, options?: CacheSetOptions): Promise<void> {
		if (value === undefined) throw new TypeError('Cache values cannot be undefined.')
		const encoded = this.encode(key)
		const ttlMs = ttlFor(this.resolved, options)
		await this.mutate(encoded, async () => {
			this.assertUsable()
			await this.writeBackend(encoded, value, ttlMs)
			this.assertUsable()
			writeEntry(this.resolved, encoded, value, ttlMs)
		})
		this.assertUsable()
	}

	async delete(key: CacheKey): Promise<boolean> {
		const encoded = this.encode(key)
		const deleted = await this.mutate(encoded, async () => {
			this.assertUsable()
			try {
				await this.backend.delete(this.backendKey(encoded))
			} catch (error) {
				this.resolved.bucket.stats.backendWriteErrors++
				throw error
			}
			this.assertUsable()
			return deleteEntry(this.resolved.bucket, encoded)
		})
		this.assertUsable()
		return deleted
	}

	async clear(): Promise<void> {
		const bucket = this.resolved.bucket
		this.assertUsable()
		const priorClear = bucket.clearBarrier
		const priorMutations = [...bucket.mutations.values()]
		const pending = Promise.resolve().then(async (): Promise<void> => {
			await priorClear
			await Promise.all(priorMutations)
			await Promise.allSettled(bucket.inFlight.values())
			this.assertUsable()
			try {
				await this.backend.clear?.(this.resolved.backendPrefix)
			} catch (error) {
				bucket.stats.backendWriteErrors++
				throw error
			}
			this.assertUsable()
			clearEntries(bucket)
			return undefined
		})
		const barrier = pending.then(
			(): void => undefined,
			(): void => undefined,
		)
		bucket.clearBarrier = barrier
		void pending.then(
			() => this.clearGlobalBarrier(barrier),
			() => this.clearGlobalBarrier(barrier),
		)
		await pending
		this.assertUsable()
	}

	async getOrLoad<V>(
		key: CacheKey,
		load: () => V | Promise<V>,
		options: CacheLoadOptions = {},
	): Promise<V> {
		const encoded = this.encode(key)
		await this.awaitMutation(encoded)
		this.assertUsable()
		const policy = options.readPolicy ?? this.resolved.namespace.readPolicy
		if (policy !== 'remote-first') {
			const l1 = readEntry(this.resolved.bucket, encoded)
			if (l1 !== undefined) {
				this.resolved.bucket.stats.localHits++
				if (policy === 'cache-and-refresh') {
					this.refreshInBackground(encoded, load, options)
				}
				return l1 as V
			}
		}
		let backendAlreadyChecked = false
		const active = this.resolved.bucket.inFlight.get(encoded)
		if (active) {
			this.resolved.bucket.stats.deduplicated++
			try {
				const joined = await waitFor(active as Promise<V | undefined>, options.signal)
				this.assertUsable()
				if (joined !== undefined) return joined
				backendAlreadyChecked = true
			} catch (error) {
				if (
					!(error instanceof BackendReadFailure) ||
					this.resolved.namespace.backendFailure !== 'bypass'
				) {
					throw unwrapBackendReadFailure(error)
				}
				backendAlreadyChecked = true
			}
		}
		const pending = this.singleFlight(encoded, async () => {
			this.assertUsable()
			if (policy !== 'remote-first') {
				const lateLocal = readEntry(this.resolved.bucket, encoded)
				if (lateLocal !== undefined) {
					this.resolved.bucket.stats.localHits++
					return lateLocal as V
				}
			}
			if (!backendAlreadyChecked) {
				try {
					const found = await this.readBackend<V>(encoded)
					this.assertUsable()
					if (found) {
						assertBackendValue(found.value)
						this.resolved.bucket.stats.backendHits++
						writeEntry(this.resolved, encoded, found.value, backendTtl(this.resolved, found))
						return found.value
					}
					this.resolved.bucket.stats.misses++
				} catch (error) {
					if (
						!(error instanceof BackendReadFailure) ||
						this.resolved.namespace.backendFailure !== 'bypass'
					) {
						throw error
					}
				}
				this.assertUsable()
			}
			this.resolved.bucket.stats.loads++
			// A subscriber abort must not cancel shared work for every other subscriber.
			const value = await load()
			if (value === undefined) throw new TypeError('Cache values cannot be undefined.')
			this.assertUsable()
			const ttlMs = ttlFor(this.resolved, options)
			if (!options.skipBackendWrite) {
				try {
					await this.writeBackend(encoded, value, ttlMs)
				} catch (error) {
					if (this.resolved.namespace.backendFailure !== 'bypass') throw error
				}
			}
			this.assertUsable()
			writeEntry(this.resolved, encoded, value, ttlMs)
			return value
		})
		try {
			const value = await waitFor(pending, options.signal)
			this.assertUsable()
			return value
		} catch (error) {
			throw unwrapBackendReadFailure(error)
		}
	}

	private refreshInBackground<V>(
		encoded: string,
		load?: () => V | Promise<V>,
		options: CacheLoadOptions = {},
	): void {
		this.resolved.bucket.stats.refreshes++
		try {
			const refresh = this.singleFlight(encoded, async () => {
				this.assertUsable()
				let found: CacheValue<V> | undefined
				try {
					found = await this.readBackend<V>(encoded)
				} catch (error) {
					if (!load || this.resolved.namespace.backendFailure !== 'bypass') throw error
				}
				this.assertUsable()
				if (found) {
					assertBackendValue(found.value)
					this.resolved.bucket.stats.backendHits++
					writeEntry(this.resolved, encoded, found.value, backendTtl(this.resolved, found))
					return found.value
				}
				if (!load) return undefined
				this.resolved.bucket.stats.loads++
				const value = await load()
				if (value === undefined) throw new TypeError('Cache values cannot be undefined.')
				this.assertUsable()
				const ttlMs = ttlFor(this.resolved, options)
				if (!options.skipBackendWrite) {
					try {
						await this.writeBackend(encoded, value, ttlMs)
					} catch (error) {
						if (this.resolved.namespace.backendFailure !== 'bypass') throw error
					}
				}
				this.assertUsable()
				writeEntry(this.resolved, encoded, value, ttlMs)
				return value
			})
			void refresh.catch(() => {
				this.resolved.bucket.stats.refreshErrors++
			})
		} catch {
			this.resolved.bucket.stats.refreshErrors++
		}
	}

	stats(): CacheStats {
		this.assertUsable()
		return snapshotStats(this.resolved.bucket)
	}

	private singleFlight<T>(encoded: string, work: () => Promise<T>): Promise<T> {
		const existing = this.resolved.bucket.inFlight.get(encoded)
		if (existing) {
			this.resolved.bucket.stats.deduplicated++
			return existing as Promise<T>
		}
		if (this.resolved.bucket.inFlight.size >= this.resolved.bucket.maxInFlight) {
			this.resolved.bucket.stats.rejected++
			throw new CacheBusyError(
				this.resolved.namespace.name || '<default>',
				this.resolved.bucket.maxInFlight,
			)
		}
		// Publish the flight before invoking user/adapter code, preventing re-entrant duplication.
		const pending = Promise.resolve().then(work)
		this.resolved.bucket.inFlight.set(encoded, pending)
		void pending.then(
			() => this.clearFlight(encoded, pending),
			() => this.clearFlight(encoded, pending),
		)
		return pending
	}

	private async awaitMutation(encoded: string): Promise<void> {
		const clear = this.resolved.bucket.clearBarrier
		if (clear) await clear
		const mutation = this.resolved.bucket.mutations.get(encoded)
		if (mutation) await mutation
	}

	private mutate<T>(encoded: string, work: () => Promise<T>): Promise<T> {
		const bucket = this.resolved.bucket
		const previous = bucket.mutations.get(encoded)
		const clear = bucket.clearBarrier
		const pending = Promise.resolve().then(async (): Promise<T> => {
			await clear
			await previous
			await settle(bucket.inFlight.get(encoded))
			return work()
		})
		const barrier = pending.then(
			(): void => undefined,
			(): void => undefined,
		)
		bucket.mutations.set(encoded, barrier)
		void pending.then(
			() => this.clearMutation(encoded, barrier),
			() => this.clearMutation(encoded, barrier),
		)
		return pending
	}

	private clearMutation(encoded: string, barrier: Promise<void>): void {
		if (this.resolved.bucket.mutations.get(encoded) === barrier) {
			this.resolved.bucket.mutations.delete(encoded)
		}
	}

	private clearGlobalBarrier(barrier: Promise<void>): void {
		if (this.resolved.bucket.clearBarrier === barrier) {
			this.resolved.bucket.clearBarrier = undefined
		}
	}

	private clearFlight(encoded: string, pending: Promise<unknown>): void {
		if (this.resolved.bucket.inFlight.get(encoded) === pending) {
			this.resolved.bucket.inFlight.delete(encoded)
		}
	}

	private backendKey(encoded: string): string {
		return `${this.resolved.backendPrefix}${encoded}`
	}

	private async readBackend<V>(encoded: string): Promise<CacheValue<V> | undefined> {
		try {
			return await this.backend.get<V>(this.backendKey(encoded))
		} catch (error) {
			this.resolved.bucket.stats.backendReadErrors++
			throw new BackendReadFailure(error)
		}
	}

	private async writeBackend<V>(encoded: string, value: V, ttlMs: number): Promise<void> {
		try {
			await this.backend.set(this.backendKey(encoded), value, { ttlMs })
		} catch (error) {
			this.resolved.bucket.stats.backendWriteErrors++
			throw error
		}
	}

	private async waitForRead<V>(
		pending: Promise<V | undefined>,
		signal: AbortSignal | undefined,
	): Promise<V | undefined> {
		try {
			const value = await waitFor(pending, signal)
			this.assertUsable()
			return value
		} catch (error) {
			throw unwrapBackendReadFailure(error)
		}
	}
}

function unwrapBackendReadFailure(error: unknown): unknown {
	return error instanceof BackendReadFailure ? error.cause : error
}

function readEntry(bucket: Bucket, encoded: string): unknown {
	return readEntryNode(bucket, encoded)?.value
}

function readEntryNode(bucket: Bucket, encoded: string): Entry | undefined {
	const entry = bucket.entries.get(encoded)
	if (!entry) return undefined
	if (entry.expiresAt !== 0 && entry.expiresAt <= Date.now()) {
		removeEntry(bucket, entry)
		return undefined
	}
	entry.visited = true
	return entry
}

function writeEntry<V>(
	resolved: Resolved,
	encoded: string,
	value: V,
	ttlMs: number,
): string | undefined {
	return writeEntryAt(resolved, encoded, value, ttlMs === 0 ? 0 : Date.now() + ttlMs)
}

function writeEntryAt<V>(
	resolved: Resolved,
	encoded: string,
	value: V,
	expiresAt: number,
): string | undefined {
	const { bucket } = resolved
	assertActive(bucket)
	const existing = bucket.entries.get(encoded)
	if (existing) removeEntry(bucket, existing)
	const entry: Entry = {
		key: encoded,
		value,
		expiresAt,
		visited: false,
	}
	bucket.entries.set(encoded, entry)
	insertNewest(bucket, entry)
	if (!bucket.hand) bucket.hand = bucket.oldest
	let evicted: string | undefined
	while (bucket.entries.size > bucket.maxEntries) {
		evicted = evictOne(bucket)
		bucket.stats.evictions++
	}
	return evicted
}

function serializeCacheValue(value: unknown): Uint8Array {
	try {
		return Uint8Array.from(serialize(value))
	} catch (error) {
		throw new TypeError(
			'Memory cache persistence requires values serializable by the Node structured clone codec.',
			{ cause: error },
		)
	}
}

function decodeMemoryCacheSnapshot(bytes: Uint8Array): MemoryCacheSnapshotV1 {
	const value = deserialize(bytes) as Partial<MemoryCacheSnapshotV1> | undefined
	if (
		!value ||
		value.format !== 'pluxel-memory-cache' ||
		value.version !== 1 ||
		!Array.isArray(value.entries)
	) {
		throw new TypeError('Unsupported memory cache snapshot format.')
	}
	const keys = new Set<string>()
	for (const entry of value.entries) {
		if (
			!entry ||
			typeof entry !== 'object' ||
			typeof entry.key !== 'string' ||
			entry.key.length === 0 ||
			keys.has(entry.key) ||
			!Number.isSafeInteger(entry.expiresAt) ||
			entry.expiresAt < 0 ||
			!(entry.value instanceof Uint8Array)
		) {
			throw new TypeError('Invalid memory cache snapshot entry.')
		}
		keys.add(entry.key)
	}
	return value as MemoryCacheSnapshotV1
}

function evictOne(bucket: Bucket): string | undefined {
	let candidate = bucket.hand ?? bucket.oldest
	if (!candidate) return undefined
	while (candidate.visited) {
		candidate.visited = false
		candidate = candidate.newer ?? bucket.oldest
		if (!candidate) return undefined
	}
	const next = candidate.newer
	const evicted = candidate.key
	removeEntry(bucket, candidate)
	bucket.hand = next ?? bucket.oldest
	return evicted
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
	const candidate = timer as unknown as { unref?: () => void }
	candidate.unref?.()
}

function insertNewest(bucket: Bucket, entry: Entry): void {
	entry.newer = undefined
	entry.older = bucket.newest
	if (bucket.newest) bucket.newest.newer = entry
	else bucket.oldest = entry
	bucket.newest = entry
}

function detach(bucket: Bucket, entry: Entry): void {
	if (entry.newer) entry.newer.older = entry.older
	else bucket.newest = entry.older
	if (entry.older) entry.older.newer = entry.newer
	else bucket.oldest = entry.newer
	entry.newer = undefined
	entry.older = undefined
}

function removeEntry(bucket: Bucket, entry: Entry): void {
	const nextHand = entry.newer
	detach(bucket, entry)
	bucket.entries.delete(entry.key)
	if (bucket.hand === entry) bucket.hand = nextHand ?? bucket.oldest
	if (bucket.entries.size === 0) bucket.hand = undefined
}

function deleteEntry(bucket: Bucket, encoded: string): boolean {
	const entry = bucket.entries.get(encoded)
	if (!entry) return false
	removeEntry(bucket, entry)
	return true
}

function clearEntries(bucket: Bucket): void {
	bucket.entries.clear()
	bucket.newest = undefined
	bucket.oldest = undefined
	bucket.hand = undefined
}

function deactivateBucket(bucket: Bucket): void {
	bucket.active = false
	clearEntries(bucket)
	bucket.inFlight.clear()
	bucket.mutations.clear()
	bucket.clearBarrier = undefined
}

function ttlFor(resolved: Resolved, options?: CacheSetOptions): number {
	return normalizeDuration(options?.ttlMs ?? resolved.namespace.ttlMs, 'ttlMs')
}

function backendTtl(resolved: Resolved, found: CacheValue<unknown>): number {
	return normalizeDuration(
		found.ttlMs === undefined ? resolved.namespace.ttlMs : found.ttlMs,
		'backend ttlMs',
	)
}

function assertBackendValue(value: unknown): void {
	if (value === undefined) {
		throw new TypeError('Cache backend returned undefined as a hit value.')
	}
}

function assertActive(bucket: Bucket): void {
	if (!bucket.active) throw new CacheStoppedError()
}

function snapshotStats(bucket: Bucket): CacheStats {
	return Object.freeze({
		...bucket.stats,
		entries: bucket.entries.size,
		inFlight: bucket.inFlight.size,
	})
}

function escapePart(value: string): string {
	return encodeURIComponent(value)
}

async function settle(pending: Promise<unknown> | undefined): Promise<void> {
	if (!pending) return
	try {
		await pending
	} catch {
		// A failed read/load does not prevent a later explicit mutation.
	}
}

function waitFor<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return pending
	if (signal.aborted) return Promise.reject(abortError(signal.reason))
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(abortError(signal.reason))
		signal.addEventListener('abort', abort, { once: true })
		void pending.then(
			(value) => {
				signal.removeEventListener('abort', abort)
				return resolve(value)
			},
			(error: unknown) => {
				signal.removeEventListener('abort', abort)
				return reject(error)
			},
		)
	})
}

function abortError(reason: unknown): Error {
	if (reason instanceof Error) return reason
	const error = new Error(reason === undefined ? 'Cache wait aborted.' : String(reason))
	error.name = 'AbortError'
	return error
}
