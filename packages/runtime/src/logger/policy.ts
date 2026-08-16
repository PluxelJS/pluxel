import type { LogLevel } from '@logtape/logtape'
import { parsePluginNodeAddress, type PluginNodeAddressSnapshot } from '@pluxel/core'

export type RuntimePluginLogLevel = LogLevel | 'off'
export type PluginLogPolicyOverride = Readonly<{
	owner: PluginNodeAddressSnapshot
	level: RuntimePluginLogLevel
}>
export type PluginLogPolicySnapshot = {
	version: 2
	defaultLevel: RuntimePluginLogLevel
	overrides: readonly PluginLogPolicyOverride[]
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
	if (
		value === 'off' ||
		value === 'trace' ||
		value === 'debug' ||
		value === 'info' ||
		value === 'warning' ||
		value === 'error' ||
		value === 'fatal'
	)
		return value
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
function ownerKey(owner: PluginNodeAddressSnapshot): string {
	const entry = owner.definition.entry
	return JSON.stringify([
		entry.kind,
		entry.kind === 'package-root' ? entry.packageName : entry.source,
		owner.definition.exportName,
		owner.instance,
		owner.instance === 'fork' ? owner.forkId : null,
	])
}

export function normalizePluginLogPolicySnapshot(input: unknown): PluginLogPolicySnapshot {
	if (!input || typeof input !== 'object' || Array.isArray(input))
		throw new Error('Plugin log policy must be an object')
	const raw = input as Partial<PluginLogPolicySnapshot>
	if (raw.version !== 2)
		throw new Error(`Unsupported plugin log policy version: ${String(raw.version)}`)
	if (!Array.isArray(raw.overrides)) throw new Error('Plugin log policy overrides must be an array')
	if (raw.overrides.length > MAX_PLUGIN_OVERRIDES)
		throw new Error(`Plugin log policy has too many overrides: ${raw.overrides.length}`)
	const seen = new Set<string>()
	const overrides = raw.overrides.map((inputOverride, index) => {
		if (!inputOverride || typeof inputOverride !== 'object' || Array.isArray(inputOverride))
			throw new Error(`Plugin log policy overrides[${index}] must be an object`)
		const override = inputOverride as Partial<PluginLogPolicyOverride>
		const owner = parsePluginNodeAddress(override.owner)
		const key = ownerKey(owner)
		if (seen.has(key))
			throw new Error(`Plugin log policy contains duplicate owner at overrides[${index}]`)
		seen.add(key)
		return { owner, level: normalizeLevel(override.level) }
	})
	return { version: 2, defaultLevel: normalizeLevel(raw.defaultLevel), overrides }
}

export const DEFAULT_PLUGIN_LOG_POLICY: PluginLogPolicySnapshot = {
	version: 2,
	defaultLevel: 'info',
	overrides: [],
}

type CompiledOverride = { owner: PluginNodeAddressSnapshot; rank: number }

export class RuntimePluginLogPolicy {
	private defaultRank = LEVEL_RANK.info
	private ranks = new Map<string, CompiledOverride>()
	private revisionValue = 0
	private persistenceValue: PluginLogPolicyPersistence = 'none'
	private profile = 'default'
	private store: PluginLogPolicyStore | undefined
	private initialized = false
	private persistRequested = false
	private persistPromise: Promise<void> | undefined
	private lastPersistenceErrorValue: unknown
	private readonly listeners = new Set<(change: PluginLogPolicyMutationResult) => void>()
	private readonly initialSnapshot: PluginLogPolicySnapshot

	constructor(
		snapshot: PluginLogPolicySnapshot = DEFAULT_PLUGIN_LOG_POLICY,
		private readonly options: { onPersistenceError?: (error: unknown) => void } = {},
	) {
		this.initialSnapshot = normalizePluginLogPolicySnapshot(snapshot)
		this.apply(this.initialSnapshot, false)
		this.revisionValue = 0
	}

	get revision() {
		return this.revisionValue
	}
	get persistence() {
		return this.persistenceValue
	}
	get lastPersistenceError() {
		return this.lastPersistenceErrorValue
	}

	allows(owner: PluginNodeAddressSnapshot, level: LogLevel): boolean {
		const rank = this.ranks.get(ownerKey(owner))?.rank ?? this.defaultRank
		return rank !== OFF_RANK && LEVEL_RANK[level] >= rank
	}

	snapshot(): PluginLogPolicySnapshot {
		return {
			version: 2,
			defaultLevel: rankLevel(this.defaultRank),
			overrides: [...this.ranks.values()].map(({ owner, rank }) => ({
				owner,
				level: rankLevel(rank),
			})),
		}
	}

	describe(): VersionedPluginLogPolicySnapshot {
		return { ...this.snapshot(), revision: this.revisionValue, persistence: this.persistenceValue }
	}

	assertRevision(expectedRevision: number): void {
		if (expectedRevision !== this.revisionValue)
			throw new Error(
				`Plugin log policy revision conflict: expected ${expectedRevision}, current ${this.revisionValue}`,
			)
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
	setPluginLevel(
		ownerInput: PluginNodeAddressSnapshot,
		level: RuntimePluginLogLevel,
	): PluginLogPolicyMutationResult {
		const owner = parsePluginNodeAddress(ownerInput)
		const key = ownerKey(owner)
		if (!this.ranks.has(key) && this.ranks.size >= MAX_PLUGIN_OVERRIDES)
			throw new Error(`Plugin log policy has too many overrides: ${this.ranks.size}`)
		const rank = levelRank(normalizeLevel(level))
		if (this.ranks.get(key)?.rank === rank) return this.mutationResult()
		this.ranks.set(key, { owner, rank })
		return this.commitMutation()
	}
	clearPluginLevel(owner: PluginNodeAddressSnapshot): PluginLogPolicyMutationResult {
		if (!this.ranks.delete(ownerKey(parsePluginNodeAddress(owner)))) return this.mutationResult()
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
		this.defaultRank = levelRank(snapshot.defaultLevel)
		this.ranks = new Map(
			snapshot.overrides.map(({ owner, level }) => [
				ownerKey(owner),
				{ owner, rank: levelRank(level) },
			]),
		)
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
			.then(async (): Promise<void> => {
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
				this.options.onPersistenceError?.(error)
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
