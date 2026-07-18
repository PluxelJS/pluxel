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

export type CacheKey = string | number | bigint | boolean
export type CacheReadPolicy = 'cache-first' | 'cache-and-refresh' | 'remote-first'

export const CacheConfig = v.object({
	ttlMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), DEFAULT_TTL_MS),
	maxEntries: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), DEFAULT_MAX_ENTRIES),
	maxInFlight: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), DEFAULT_MAX_IN_FLIGHT),
	readPolicy: v.optional(
		v.picklist(['cache-first', 'cache-and-refresh', 'remote-first'] as const),
		'cache-first',
	),
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
	readonly evictions: number
	readonly entries: number
	readonly inFlight: number
}

export class CacheStoppedError extends Error {
	override name = 'CacheStoppedError'

	constructor() {
		super('Cache handle belongs to a stopped or replaced provider.')
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
	/** Maps arguments to a primitive cache key. Primitive tuples have a stable default. */
	key?: (...args: Args) => CacheKey
}

export interface CachedOptions<Args extends unknown[] = unknown[]>
	extends MemoizedOptions<Args>, Pick<CacheNamespaceOptions, 'maxInFlight' | 'readPolicy'> {
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

type InternalNamespace = Required<CacheNamespaceOptions> & {
	name: string
	encodeKey: (key: CacheKey) => string
}

type CacheDefaults = {
	ttlMs: number
	maxEntries: number
	maxInFlight: number
	readPolicy: CacheReadPolicy
}

type Resolved = {
	namespace: InternalNamespace
	backendPrefix: string
	bucket: Bucket
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

function defaultEncodeKey(key: unknown): string {
	switch (typeof key) {
		case 'string':
			return `s:${key}`
		case 'number':
			if (!Number.isFinite(key)) throw new TypeError('Cache number keys must be finite.')
			return `n:${Object.is(key, -0) ? '-0' : String(key)}`
		case 'bigint':
			return `i:${key}`
		case 'boolean':
			return key ? 'b:1' : 'b:0'
		default:
			throw new TypeError('Object and symbol cache keys require an explicit key encoder.')
	}
}

function encodeMethodArguments(args: unknown[]): string {
	if (args.length === 0) return 'call:0'
	return args
		.map((arg) => {
			if (arg === null) return 'z:'
			if (arg === undefined) return 'u:'
			if (typeof arg === 'string') return `s:${arg.length}:${arg}`
			return defaultEncodeKey(arg)
		})
		.join('|')
}

function defaultMethodKey(args: unknown[]): CacheKey {
	if (args.length === 0) return '__call__'
	if (args.length === 1 && isCacheKey(args[0])) return args[0]
	return encodeMethodArguments(args)
}

function isCacheKey(value: unknown): value is CacheKey {
	return (
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'bigint' ||
		typeof value === 'boolean'
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
	}
}

function normalizeNamespace(
	name: string,
	options: CacheNamespaceOptions,
	defaults: CacheDefaults,
): InternalNamespace {
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
	return { name, ttlMs, maxEntries, maxInFlight, readPolicy, encodeKey: defaultEncodeKey }
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
	private readonly buckets = new Map<string, Bucket>()
	private readonly views = new Map<string, CacheNamespace>()

	constructor(private readonly backend: CacheBackend) {
		super()
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
		return this.open({ id: 'global', backendPrefix: 'global:' }, '', {})
	}

	override scope(name: string, options: CacheNamespaceOptions = {}): CacheNamespace {
		return this.open(this.callerOwner(), validateScopeName(name), options)
	}

	override stats(): CacheStats {
		return this.current().stats()
	}

	protected override async stop(): Promise<void> {
		for (const bucket of this.buckets.values()) {
			bucket.active = false
			clearEntries(bucket)
		}
		this.buckets.clear()
		this.views.clear()
	}

	private current(): CacheNamespace {
		return this.open(this.callerOwner(), '', {})
	}

	private callerOwner(): NamespaceOwner {
		const pluginId = this.ctx.caller?.pluginInfo.id ?? this.ctx.pluginInfo.id
		return { id: `plugin:${pluginId}`, backendPrefix: `plugin:${escapePart(pluginId)}:` }
	}

	private open(
		owner: NamespaceOwner,
		name: string,
		options: CacheNamespaceOptions,
	): CacheNamespace {
		const namespace = normalizeNamespace(name, options, this.config as CacheDefaults)
		const viewId = `${owner.id}\0${name}`
		const resolved = this.resolve(owner, namespace)
		let view = this.views.get(viewId)
		if (!view) {
			view = new NamespaceView(resolved, this.backend, (child, childOptions) => {
				const childName = name ? `${name}/${validateScopeName(child)}` : validateScopeName(child)
				return this.open(owner, childName, {
					ttlMs: childOptions.ttlMs ?? namespace.ttlMs,
					maxEntries: childOptions.maxEntries ?? namespace.maxEntries,
					maxInFlight: childOptions.maxInFlight ?? namespace.maxInFlight,
					readPolicy: childOptions.readPolicy ?? namespace.readPolicy,
				})
			})
			this.views.set(viewId, view)
		}
		return view
	}

	private resolve(owner: NamespaceOwner, namespace: InternalNamespace): Resolved {
		const bucketId = `${owner.id}\0${namespace.name}`
		let bucket = this.buckets.get(bucketId)
		if (!bucket) {
			bucket = {
				active: true,
				entries: new Map(),
				inFlight: new Map(),
				mutations: new Map(),
				stats: emptyStats(),
				maxEntries: namespace.maxEntries,
				maxInFlight: namespace.maxInFlight,
			}
			this.buckets.set(bucketId, bucket)
		} else if (
			bucket.maxEntries !== namespace.maxEntries ||
			bucket.maxInFlight !== namespace.maxInFlight
		) {
			throw new Error(
				`Cache namespace conflict for "${namespace.name || '<default>'}": capacity limits must match.`,
			)
		}
		return {
			namespace,
			backendPrefix: `${owner.backendPrefix}${namespace.name ? `${escapePart(namespace.name)}:` : ''}`,
			bucket,
		}
	}
}

type NamespaceOwner = { id: string; backendPrefix: string }

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
				encodeKey: defaultEncodeKey,
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
			this.holder.state.bucket.active = false
			clearEntries(this.holder.state.bucket)
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
		private readonly openChild: (name: string, options: CacheNamespaceOptions) => CacheNamespace,
	) {
		this.local = new LocalView(resolved)
		this.access = new AsyncView(resolved, backend)
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

	scope(name: string, options: CacheNamespaceOptions = {}): CacheNamespace {
		return this.openChild(name, options)
	}

	stats(): CacheStats {
		return this.access.stats()
	}
}

class CacheViewBase {
	constructor(protected readonly resolved: Resolved) {}

	protected encode(key: CacheKey): string {
		assertActive(this.resolved.bucket)
		const encoded = this.resolved.namespace.encodeKey(key)
		if (typeof encoded !== 'string' || encoded.length === 0) {
			throw new TypeError('Cache key encoder must return a non-empty string.')
		}
		return encoded
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
		assertActive(this.resolved.bucket)
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
		assertActive(this.resolved.bucket)
		return snapshotStats(this.resolved.bucket)
	}
}

class AsyncView extends CacheViewBase {
	constructor(
		resolved: Resolved,
		private readonly backend: CacheBackendStore,
	) {
		super(resolved)
	}

	async get<V>(key: CacheKey, options: CacheGetOptions = {}): Promise<V | undefined> {
		const encoded = this.encode(key)
		await this.awaitMutation(encoded)
		assertActive(this.resolved.bucket)
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
			return waitFor(active as Promise<V | undefined>, options.signal)
		}
		const pending = this.singleFlight(encoded, async () => {
			if (policy !== 'remote-first') {
				const lateLocal = readEntry(this.resolved.bucket, encoded)
				if (lateLocal !== undefined) {
					this.resolved.bucket.stats.localHits++
					return lateLocal as V
				}
			}
			const found = await this.backend.get<V>(this.backendKey(encoded))
			assertActive(this.resolved.bucket)
			if (!found) {
				this.resolved.bucket.stats.misses++
				return undefined
			}
			assertBackendValue(found.value)
			this.resolved.bucket.stats.backendHits++
			writeEntry(this.resolved, encoded, found.value, backendTtl(this.resolved, found))
			return found.value
		})
		return waitFor(pending, options.signal)
	}

	async set<V>(key: CacheKey, value: V, options?: CacheSetOptions): Promise<void> {
		if (value === undefined) throw new TypeError('Cache values cannot be undefined.')
		const encoded = this.encode(key)
		const ttlMs = ttlFor(this.resolved, options)
		await this.mutate(encoded, async () => {
			assertActive(this.resolved.bucket)
			await this.backend.set(this.backendKey(encoded), value, { ttlMs })
			writeEntry(this.resolved, encoded, value, ttlMs)
		})
	}

	async delete(key: CacheKey): Promise<boolean> {
		const encoded = this.encode(key)
		return this.mutate(encoded, async () => {
			assertActive(this.resolved.bucket)
			await this.backend.delete(this.backendKey(encoded))
			return deleteEntry(this.resolved.bucket, encoded)
		})
	}

	async clear(): Promise<void> {
		const bucket = this.resolved.bucket
		assertActive(bucket)
		const priorClear = bucket.clearBarrier
		const priorMutations = [...bucket.mutations.values()]
		const pending = Promise.resolve().then(async (): Promise<void> => {
			await priorClear
			await Promise.all(priorMutations)
			await Promise.allSettled(bucket.inFlight.values())
			assertActive(bucket)
			await this.backend.clear?.(this.resolved.backendPrefix)
			assertActive(bucket)
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
		return pending
	}

	async getOrLoad<V>(
		key: CacheKey,
		load: () => V | Promise<V>,
		options: CacheLoadOptions = {},
	): Promise<V> {
		const encoded = this.encode(key)
		await this.awaitMutation(encoded)
		assertActive(this.resolved.bucket)
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
		let backendAlreadyMissed = false
		const active = this.resolved.bucket.inFlight.get(encoded)
		if (active) {
			this.resolved.bucket.stats.deduplicated++
			const joined = await waitFor(active as Promise<V | undefined>, options.signal)
			if (joined !== undefined) return joined
			backendAlreadyMissed = true
		}
		const pending = this.singleFlight(encoded, async () => {
			if (policy !== 'remote-first') {
				const lateLocal = readEntry(this.resolved.bucket, encoded)
				if (lateLocal !== undefined) {
					this.resolved.bucket.stats.localHits++
					return lateLocal as V
				}
			}
			if (!backendAlreadyMissed) {
				const found = await this.backend.get<V>(this.backendKey(encoded))
				assertActive(this.resolved.bucket)
				if (found) {
					assertBackendValue(found.value)
					this.resolved.bucket.stats.backendHits++
					writeEntry(this.resolved, encoded, found.value, backendTtl(this.resolved, found))
					return found.value
				}
			}
			if (!backendAlreadyMissed) this.resolved.bucket.stats.misses++
			this.resolved.bucket.stats.loads++
			// A subscriber abort must not cancel shared work for every other subscriber.
			const value = await load()
			if (value === undefined) throw new TypeError('Cache values cannot be undefined.')
			assertActive(this.resolved.bucket)
			const ttlMs = ttlFor(this.resolved, options)
			if (!options.skipBackendWrite) {
				await this.backend.set(this.backendKey(encoded), value, { ttlMs })
			}
			writeEntry(this.resolved, encoded, value, ttlMs)
			return value
		})
		return waitFor(pending, options.signal)
	}

	private refreshInBackground<V>(
		encoded: string,
		load?: () => V | Promise<V>,
		options: CacheLoadOptions = {},
	): void {
		this.resolved.bucket.stats.refreshes++
		try {
			const refresh = this.singleFlight(encoded, async () => {
				const found = await this.backend.get<V>(this.backendKey(encoded))
				assertActive(this.resolved.bucket)
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
				assertActive(this.resolved.bucket)
				const ttlMs = ttlFor(this.resolved, options)
				if (!options.skipBackendWrite) {
					await this.backend.set(this.backendKey(encoded), value, { ttlMs })
				}
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
		assertActive(this.resolved.bucket)
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
		return `${this.resolved.backendPrefix}${escapePart(encoded)}`
	}
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
