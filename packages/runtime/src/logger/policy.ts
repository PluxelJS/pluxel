import type { LogLevel } from '@logtape/logtape'

export type RuntimePluginLogLevel = LogLevel | 'off'

export type PluginLogPolicySnapshot = {
	version: 1
	defaultLevel: RuntimePluginLogLevel
	overrides: Record<string, RuntimePluginLogLevel>
}

export type PluginLogPolicyPersistence = 'none' | 'clean' | 'dirty' | 'failed'

export type VersionedPluginLogPolicySnapshot = PluginLogPolicySnapshot & {
	revision: number
	persistence: PluginLogPolicyPersistence
}

export type PluginLogPolicyMutationResult = {
	revision: number
	persistence: PluginLogPolicyPersistence
}

export type PluginLogPolicyStore = {
	load(profile: string): Promise<PluginLogPolicySnapshot | undefined>
	save(profile: string, snapshot: PluginLogPolicySnapshot): Promise<void>
}

const MAX_PLUGIN_OVERRIDES = 100_000
const MAX_PLUGIN_ID_LENGTH = 512
const OFF_RANK = -1

const LEVEL_RANK: Record<LogLevel, number> = {
	trace: 0,
	debug: 1,
	info: 2,
	warning: 3,
	error: 4,
	fatal: 5,
}

const RANK_LEVEL: readonly LogLevel[] = ['trace', 'debug', 'info', 'warning', 'error', 'fatal']

function normalizeLevel(value: unknown): RuntimePluginLogLevel {
	if (value === 'off') return value
	if (
		value === 'trace' ||
		value === 'debug' ||
		value === 'info' ||
		value === 'warning' ||
		value === 'error' ||
		value === 'fatal'
	) {
		return value
	}
	throw new Error(`Invalid plugin log level: ${String(value)}`)
}

function levelRank(level: RuntimePluginLogLevel): number {
	return level === 'off' ? OFF_RANK : LEVEL_RANK[level]
}

function rankLevel(rank: number): RuntimePluginLogLevel {
	if (rank === OFF_RANK) return 'off'
	const level = RANK_LEVEL[rank]
	if (!level) throw new Error(`Invalid compiled plugin log rank: ${rank}`)
	return level
}

export function normalizePluginLogPolicySnapshot(input: unknown): PluginLogPolicySnapshot {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new Error('Plugin log policy must be an object')
	}
	const raw = input as Partial<PluginLogPolicySnapshot>
	if (raw.version !== 1) throw new Error(`Unsupported plugin log policy version: ${raw.version}`)
	const entries = Object.entries(raw.overrides ?? {})
	if (entries.length > MAX_PLUGIN_OVERRIDES) {
		throw new Error(`Plugin log policy has too many overrides: ${entries.length}`)
	}
	const overrides: Record<string, RuntimePluginLogLevel> = {}
	for (const [pluginId, value] of entries) {
		if (!pluginId) throw new Error('Plugin log policy contains an empty plugin id')
		if (pluginId.length > MAX_PLUGIN_ID_LENGTH) {
			throw new Error(`Plugin log policy contains an oversized plugin id: ${pluginId.length}`)
		}
		Object.defineProperty(overrides, pluginId, {
			value: normalizeLevel(value),
			enumerable: true,
			configurable: true,
			writable: true,
		})
	}
	return {
		version: 1,
		defaultLevel: normalizeLevel(raw.defaultLevel),
		overrides,
	}
}

export const DEFAULT_PLUGIN_LOG_POLICY: PluginLogPolicySnapshot = {
	version: 1,
	defaultLevel: 'info',
	overrides: {},
}

export class RuntimePluginLogPolicy {
	private defaultRank = LEVEL_RANK.info
	private ranks = new Map<string, number>()
	private revisionValue = 0
	private persistenceValue: PluginLogPolicyPersistence = 'none'
	private profile = 'default'
	private store: PluginLogPolicyStore | undefined
	private initialized = false
	private persistRequested = false
	private persistPromise: Promise<void> | undefined
	private lastPersistenceErrorValue: unknown
	private readonly listeners = new Set<(change: PluginLogPolicyMutationResult) => void>()
	private readonly onPersistenceError?: (error: unknown) => void
	private readonly initialSnapshot: PluginLogPolicySnapshot

	constructor(
		snapshot: PluginLogPolicySnapshot = DEFAULT_PLUGIN_LOG_POLICY,
		options: { onPersistenceError?: (error: unknown) => void } = {},
	) {
		this.onPersistenceError = options.onPersistenceError
		this.initialSnapshot = normalizePluginLogPolicySnapshot(snapshot)
		this.apply(this.initialSnapshot, false)
		this.revisionValue = 0
	}

	get revision(): number {
		return this.revisionValue
	}

	get persistence(): PluginLogPolicyPersistence {
		return this.persistenceValue
	}

	get lastPersistenceError(): unknown {
		return this.lastPersistenceErrorValue
	}

	allows(pluginId: string, level: LogLevel): boolean {
		const override = this.ranks.get(pluginId)
		const rank = override === undefined ? this.defaultRank : override
		return rank !== OFF_RANK && LEVEL_RANK[level] >= rank
	}

	snapshot(): PluginLogPolicySnapshot {
		const overrides: Record<string, RuntimePluginLogLevel> = {}
		for (const [pluginId, rank] of this.ranks) {
			Object.defineProperty(overrides, pluginId, {
				value: rankLevel(rank),
				enumerable: true,
				configurable: true,
				writable: true,
			})
		}
		return {
			version: 1,
			defaultLevel: rankLevel(this.defaultRank),
			overrides,
		}
	}

	describe(): VersionedPluginLogPolicySnapshot {
		return {
			...this.snapshot(),
			revision: this.revisionValue,
			persistence: this.persistenceValue,
		}
	}

	assertRevision(expectedRevision: number): void {
		if (expectedRevision !== this.revisionValue) {
			throw new Error(
				`Plugin log policy revision conflict: expected ${expectedRevision}, current ${this.revisionValue}`,
			)
		}
	}

	replace(snapshot: PluginLogPolicySnapshot): PluginLogPolicyMutationResult {
		this.apply(normalizePluginLogPolicySnapshot(snapshot), true)
		return this.mutationResult()
	}

	setDefaultLevel(level: RuntimePluginLogLevel): PluginLogPolicyMutationResult {
		const next = levelRank(normalizeLevel(level))
		if (next === this.defaultRank) return this.mutationResult()
		this.defaultRank = next
		return this.commitMutation()
	}

	setPluginLevel(pluginId: string, level: RuntimePluginLogLevel): PluginLogPolicyMutationResult {
		const id = String(pluginId)
		if (!id) throw new Error('Plugin id must not be empty')
		if (id.length > MAX_PLUGIN_ID_LENGTH) {
			throw new Error(`Plugin id is too long: ${id.length}`)
		}
		if (!this.ranks.has(id) && this.ranks.size >= MAX_PLUGIN_OVERRIDES) {
			throw new Error(`Plugin log policy has too many overrides: ${this.ranks.size}`)
		}
		const next = levelRank(normalizeLevel(level))
		if (this.ranks.get(id) === next) return this.mutationResult()
		this.ranks.set(id, next)
		return this.commitMutation()
	}

	clearPluginLevel(pluginId: string): PluginLogPolicyMutationResult {
		if (!this.ranks.delete(String(pluginId))) return this.mutationResult()
		return this.commitMutation()
	}

	reset(): VersionedPluginLogPolicySnapshot {
		this.apply(this.initialSnapshot, true)
		return this.describe()
	}

	subscribe(listener: (change: PluginLogPolicyMutationResult) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	async initialize(profile: string, store?: PluginLogPolicyStore): Promise<void> {
		if (this.initialized) throw new Error('Plugin log policy is already initialized')
		this.initialized = true
		this.profile = profile || 'default'
		this.store = store
		this.persistenceValue = store ? 'clean' : 'none'
		if (!store) return
		const persisted = await store.load(this.profile)
		if (persisted) this.apply(normalizePluginLogPolicySnapshot(persisted), false)
	}

	async flush(): Promise<void> {
		await this.persistPromise
	}

	private apply(snapshot: PluginLogPolicySnapshot, persist: boolean): void {
		const next = new Map<string, number>()
		for (const [pluginId, level] of Object.entries(snapshot.overrides)) {
			next.set(pluginId, levelRank(level))
		}
		this.defaultRank = levelRank(snapshot.defaultLevel)
		this.ranks = next
		this.revisionValue++
		if (persist) this.schedulePersist()
		this.notify()
	}

	private commitMutation(): PluginLogPolicyMutationResult {
		this.revisionValue++
		this.schedulePersist()
		const result = this.mutationResult()
		this.notify(result)
		return result
	}

	private mutationResult(): PluginLogPolicyMutationResult {
		return { revision: this.revisionValue, persistence: this.persistenceValue }
	}

	private notify(change = this.mutationResult()): void {
		for (const listener of this.listeners) listener(change)
	}

	private schedulePersist(): void {
		if (!this.store) return
		this.persistRequested = true
		this.persistenceValue = 'dirty'
		if (this.persistPromise) return
		this.persistPromise = Promise.resolve()
			.then(async (): Promise<undefined> => {
				while (this.persistRequested) {
					this.persistRequested = false
					await this.store!.save(this.profile, this.snapshot())
				}
				this.persistenceValue = 'clean'
				this.lastPersistenceErrorValue = undefined
				return undefined
			})
			.catch((error) => {
				this.persistenceValue = 'failed'
				this.lastPersistenceErrorValue = error
				this.onPersistenceError?.(error)
			})
			.finally(() => {
				this.persistPromise = undefined
			})
	}
}

export function parsePluginLogPolicySnapshot(raw: string): PluginLogPolicySnapshot {
	return normalizePluginLogPolicySnapshot(JSON.parse(raw) as unknown)
}

export function serializePluginLogPolicySnapshot(snapshot: PluginLogPolicySnapshot): string {
	return `${JSON.stringify(normalizePluginLogPolicySnapshot(snapshot), null, 2)}\n`
}
