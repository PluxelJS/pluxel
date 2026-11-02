import {
	type Context as PluxelContext,
	parsePluginDefinitionAddress,
	parsePluginNodeAddress,
	pluginDefinitionIndexKey,
	pluginNodeIndexKey,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import { SuperJSON } from 'superjson'
import { HostStateMutationRejectedError } from './mutation'
import type { HostStatePatch, HostStatePatchOperation } from './state'
import {
	type HostStateSnapshot,
	type HostStateVersionedSnapshot,
	HostStateRevisionConflictError,
	type HostStateDraft,
	type HostProviderDefaultState,
	type HostDependencyOverrideState,
	freezeTrustedHostStateSnapshot,
} from './policy'
import {
	assertResolvedHostStoreStorage,
	type HostDocumentStorage,
	type HostStoreStorageOptions,
	type ResolvedHostStoreStorageOptions,
} from './document-storage'

export type HostStateFile = {
	version: 6
	autoStart: PluginNodeAddress[]
	forks: PluginNodeAddress[]
	providerDefaults: HostProviderDefaultState[]
	dependencyOverrides: HostDependencyOverrideState[]
}

export type HostStateDeclaration = Readonly<Partial<HostStateSnapshot>>

export type HostStateStoreOptions = HostStoreStorageOptions &
	HostStateDeclaration &
	Readonly<{
		/** Replace explicitly declared lists for this runtime; saved values remain unchanged. */
		override?: boolean
	}>

export type HostStateConfigurationSnapshot = Readonly<{
	mode: 'memory' | 'writable' | 'readonly'
	override: boolean
	declared: HostStateDeclaration
	overriddenFields: readonly (keyof HostStateSnapshot)[]
	saved: HostStateSnapshot
	effective: HostStateSnapshot
	revision: number
}>

const STATE_FIELDS = ['autoStart', 'forks', 'providerDefaults', 'dependencyOverrides'] as const

export class HostStateStore {
	public readonly ready: Promise<void>
	public isReady = false

	private readonly data: HostStateDraft = createDefaultDraft()
	private revision = 0
	private savedSnapshotCache!: HostStateSnapshot
	private snapshotCache!: HostStateSnapshot
	private readonly declared: HostStateDeclaration
	private readonly override: boolean
	private readonly overriddenFields: readonly (keyof HostStateSnapshot)[]
	private versionedSnapshotCache!: HostStateVersionedSnapshot
	private readonly file: string
	private readonly mode: 'memory' | 'writable' | 'readonly'
	private readonly readonlyMode: boolean
	private disposed = false
	private closing?: Promise<void>
	private activeCommit?: Promise<HostStateVersionedSnapshot>
	private durableCommitInFlight = false
	private readonly storage: HostDocumentStorage | undefined

	constructor(
		public readonly ctx: PluxelContext,
		options: Omit<HostStateStoreOptions, 'storage' | 'mode'> & ResolvedHostStoreStorageOptions = {},
	) {
		assertClosedRecord(options, [...STATE_FIELDS, 'mode', 'storage', 'override'], 'state', false)
		if (options.override !== undefined && typeof options.override !== 'boolean') {
			throw invalidState('state.override must be a boolean')
		}
		assertResolvedHostStoreStorage(options)
		const { autoStart, forks, providerDefaults, dependencyOverrides } = options
		this.declared = resolveHostStateDeclaration({
			autoStart,
			forks,
			providerDefaults,
			dependencyOverrides,
		})
		this.override = options.override ?? false
		this.overriddenFields = Object.freeze(
			this.override ? STATE_FIELDS.filter((field) => this.declared[field] !== undefined) : [],
		)
		this.mode = options.mode ?? (options.storage ? 'writable' : 'memory')
		this.readonlyMode = this.mode === 'readonly'
		this.storage = options.storage
		if (this.mode !== 'memory' && !this.storage)
			throw new TypeError('[host] persistent state requires document storage')
		this.file = 'state.json'
		Object.assign(this.data, this.declared)
		this.refreshSnapshotCache()
		if (this.mode !== 'memory') {
			this.ready = this.loadFromDisk(this.file).then((): void => {
				this.isReady = true
				return undefined
			})
		} else {
			this.isReady = true
			this.ready = Promise.resolve()
		}
		ctx.effects.defer(() => this.dispose(), { tag: 'HostStateStore' })
	}

	snapshot(): HostStateSnapshot {
		return this.snapshotCache
	}

	/** Original loaded/saved values, before runtime declarations are overlaid. */
	savedSnapshot(): HostStateSnapshot {
		return this.savedSnapshotCache
	}

	/** Projects a proposed saved snapshot without writing runtime declarations into it. */
	effectiveSnapshot(saved: HostStateSnapshot): HostStateSnapshot {
		return this.overriddenFields.length === 0
			? saved
			: freezeTrustedHostStateSnapshot({ ...saved, ...this.declared })
	}

	configurationSnapshot(): HostStateConfigurationSnapshot {
		return Object.freeze({
			mode: this.mode,
			override: this.override,
			declared: this.declared,
			overriddenFields: this.overriddenFields,
			saved: this.savedSnapshotCache,
			effective: this.snapshotCache,
			revision: this.revision,
		})
	}

	/** Reject management writes before any graph or metadata side effect. */
	assertPatchMutable(patch: HostStatePatch | undefined): void {
		if (!patch || patch.operations.length === 0) return
		this.assertMutable('update state')
		for (const operation of patch.operations) {
			for (const field of operationFields(operation)) {
				if (this.overriddenFields.includes(field)) this.rejectOverridden(field)
			}
		}
	}

	versionedSnapshot(): HostStateVersionedSnapshot {
		return this.versionedSnapshotCache
	}

	/** Atomically persists and publishes graph policy after a coordinator prepare. */
	async commitVersioned(
		expectedRevision: number,
		next: HostStateSnapshot,
	): Promise<HostStateVersionedSnapshot> {
		this.assertMutable('commitVersioned')
		if (this.durableCommitInFlight) {
			throw new Error('[HostStateStore] nested durable graph transaction is not allowed')
		}
		this.assertRevision(expectedRevision)
		const normalized = canonicalHostStateSnapshot(next)
		for (const field of this.overriddenFields) {
			if (
				SuperJSON.stringify(normalized[field]) !==
				SuperJSON.stringify(this.savedSnapshotCache[field])
			) {
				this.rejectOverridden(field)
			}
		}
		this.durableCommitInFlight = true
		const task = (async () => {
			try {
				this.assertRevision(expectedRevision)
				if (this.mode === 'writable') await this.persistDraft(this.file, normalized)
				replaceDraft(this.data, normalized)
				this.revision++
				this.refreshSnapshotCache(normalized)
				return this.versionedSnapshotCache
			} finally {
				this.durableCommitInFlight = false
				this.activeCommit = undefined
			}
		})()
		this.activeCommit = task
		return task
	}

	dispose(): Promise<void> {
		return (this.closing ??= (async () => {
			this.disposed = true
			try {
				await this.ready
			} catch {
				/* Preparation reports its original failure. */
			}
			await this.activeCommit
		})())
	}

	private assertMutable(action: string) {
		if (!this.isReady)
			throw new Error(`[HostStateStore] ${action} requires a successfully loaded state document.`)
		if (this.disposed) throw new Error(`[HostStateStore] ${action} is disabled after dispose.`)
		if (!this.readonlyMode) return
		throw new Error(`[HostStateStore] ${action} is disabled in readonly mode.`)
	}

	private assertRevision(expectedRevision: number): void {
		if (expectedRevision === this.revision) return
		throw new HostStateRevisionConflictError(expectedRevision, this.revision)
	}

	private rejectOverridden(field: keyof HostStateSnapshot): never {
		throw new HostStateMutationRejectedError(
			Object.freeze({
				code: 'state_overridden',
				field,
				message: `runtime.state.${field} is controlled by an override declaration; edit the declaration or disable override before saving this list`,
			}),
		)
	}

	private refreshSnapshotCache(saved = freezeTrustedHostStateSnapshot(this.data)): void {
		this.savedSnapshotCache = saved
		this.snapshotCache = this.effectiveSnapshot(saved)
		this.versionedSnapshotCache = Object.freeze({
			revision: this.revision,
			state: this.snapshotCache,
		})
	}

	private async loadFromDisk(file: string) {
		let txt: string
		const primary = await this.storage!.getText(file)
		if (primary !== undefined) {
			txt = primary
		} else {
			if (!this.readonlyMode) await this.persistDraft(file, this.data)
			return
		}

		let parsed: HostStateDraft
		try {
			parsed = coerceHostStateFile(SuperJSON.parse(txt))
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error)
			throw new Error(
				`[HostStateStore] Cannot load ${file}: ${reason}. Existing document unchanged; repair or restore it before restarting.`,
				{ cause: error },
			)
		}

		replaceDraft(this.data, parsed)
		this.revision++
		this.refreshSnapshotCache()
	}

	private async persistDraft(
		file: string,
		draft: HostStateDraft | HostStateSnapshot,
	): Promise<void> {
		const content = SuperJSON.stringify(toHostStateFile(draft))
		await this.storage!.put(file, content)
	}
}

/** Normalizes only supplied declaration lists, preserving omission for override inheritance. */
export function resolveHostStateDeclaration(
	declaration: HostStateDeclaration = {},
): HostStateDeclaration {
	assertClosedRecord(declaration, STATE_FIELDS, 'state', false)
	for (const field of STATE_FIELDS) {
		if (declaration[field] !== undefined && !Array.isArray(declaration[field])) {
			throw invalidState(`state.${field} must be an array`)
		}
	}
	const normalized = canonicalHostStateSnapshot({
		...createDefaultDraft(),
		...Object.fromEntries(
			STATE_FIELDS.filter((field) => declaration[field] !== undefined).map((field) => [
				field,
				declaration[field],
			]),
		),
	})
	return Object.freeze(
		Object.fromEntries(
			STATE_FIELDS.filter((field) => declaration[field] !== undefined).map((field) => [
				field,
				normalized[field],
			]),
		),
	)
}

function operationFields(operation: HostStatePatchOperation): readonly (keyof HostStateSnapshot)[] {
	switch (operation.type) {
		case 'set-auto-start':
			return ['autoStart']
		case 'ensure-fork':
		case 'remove-fork':
			return ['forks']
		case 'set-provider-default':
			return ['providerDefaults']
		case 'set-dependency-override':
			return ['dependencyOverrides']
		case 'remove-node-policy':
			return ['autoStart', 'dependencyOverrides']
	}
}

function createDefaultDraft(): HostStateDraft {
	return {
		autoStart: [],
		forks: [],
		providerDefaults: [],
		dependencyOverrides: [],
	}
}

function normalizeDraft(draft: HostStateDraft | HostStateSnapshot): HostStateDraft {
	return {
		autoStart: parseUniqueNodes(draft.autoStart, 'autoStart'),
		forks: parseForks(draft.forks, 'forks'),
		providerDefaults: parseProviderDefaults(draft.providerDefaults, 'providerDefaults'),
		dependencyOverrides: parseDependencyOverrides(draft.dependencyOverrides, 'dependencyOverrides'),
	}
}

const canonicalSnapshots = new WeakSet<HostStateSnapshot>()

/** @internal Validates, sorts, clones, and deep-freezes one canonical revision snapshot. */
export function canonicalHostStateSnapshot(state: HostStateSnapshot): HostStateSnapshot {
	if (canonicalSnapshots.has(state)) return state
	const snapshot = freezeTrustedHostStateSnapshot(normalizeDraft(state))
	canonicalSnapshots.add(snapshot)
	return snapshot
}

function replaceDraft(target: HostStateDraft, source: HostStateDraft | HostStateSnapshot): void {
	target.autoStart = source.autoStart.map(cloneNodeAddress)
	target.forks = source.forks.map(cloneNodeAddress)
	target.providerDefaults = source.providerDefaults.map(cloneProviderDefault)
	target.dependencyOverrides = source.dependencyOverrides.map(cloneDependencyOverride)
}

function toHostStateFile(draft: HostStateDraft | HostStateSnapshot): HostStateFile {
	return {
		version: 6,
		autoStart: draft.autoStart.map(cloneNodeAddress),
		forks: draft.forks.map(cloneNodeAddress),
		providerDefaults: draft.providerDefaults.map(cloneProviderDefault),
		dependencyOverrides: draft.dependencyOverrides.map(cloneDependencyOverride),
	}
}

function coerceHostStateFile(input: unknown): HostStateDraft {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw invalidState('persisted state must be an object')
	}
	const raw = input as Record<string, unknown>
	if (raw.version !== 6) {
		throw invalidState(`unsupported persisted state version: ${String(raw.version)}`)
	}
	assertClosedRecord(
		raw,
		['version', 'autoStart', 'forks', 'providerDefaults', 'dependencyOverrides'],
		'persisted state',
	)
	if (!Array.isArray(raw.autoStart)) throw invalidState('autoStart must be an array')
	if (!Array.isArray(raw.forks)) throw invalidState('forks must be an array')
	if (!Array.isArray(raw.providerDefaults)) {
		throw invalidState('providerDefaults must be an array')
	}
	if (!Array.isArray(raw.dependencyOverrides)) {
		throw invalidState('dependencyOverrides must be an array')
	}
	return {
		autoStart: parseUniqueNodes(raw.autoStart, 'autoStart'),
		forks: parseForks(raw.forks, 'forks'),
		providerDefaults: parseProviderDefaults(raw.providerDefaults, 'providerDefaults'),
		dependencyOverrides: parseDependencyOverrides(raw.dependencyOverrides, 'dependencyOverrides'),
	}
}

function parseUniqueNodes(input: readonly unknown[], at: string): PluginNodeAddress[] {
	const out: PluginNodeAddress[] = []
	const seen = new Set<string>()
	for (let i = 0; i < input.length; i++) {
		const node = parseNode(input[i], `${at}[${i}]`)
		const key = pluginNodeIndexKey(node)
		if (seen.has(key)) {
			throw invalidState(`${at}[${i}] duplicates an earlier node`)
		}
		seen.add(key)
		out.push(node)
	}
	return out.sort((left, right) =>
		pluginNodeIndexKey(left).localeCompare(pluginNodeIndexKey(right)),
	)
}

function parseForks(input: readonly unknown[], at: string): PluginNodeAddress[] {
	const nodes = parseUniqueNodes(input, at)
	for (const node of nodes) {
		if (node.variant !== 'fork') throw invalidState(`${at} must contain only fork node addresses`)
	}
	return nodes
}

function parseProviderDefaults(input: readonly unknown[], at: string): HostProviderDefaultState[] {
	const out: HostProviderDefaultState[] = []
	const seen = new Set<string>()
	for (let i = 0; i < input.length; i++) {
		const raw = closedRecord(input[i], `${at}[${i}]`, ['token', 'provider'])
		const token = parseDefinition(raw.token, `${at}[${i}].token`)
		const provider = parseNode(raw.provider, `${at}[${i}].provider`)
		const key = pluginDefinitionIndexKey(token)
		if (seen.has(key)) {
			throw invalidState(`${at}[${i}] duplicates a provider token`)
		}
		seen.add(key)
		out.push({ token, provider })
	}
	return out.sort((left, right) =>
		pluginDefinitionIndexKey(left.token).localeCompare(pluginDefinitionIndexKey(right.token)),
	)
}

function parseDependencyOverrides(
	input: readonly unknown[],
	at: string,
): HostDependencyOverrideState[] {
	const out: HostDependencyOverrideState[] = []
	const seen = new Set<string>()
	for (let i = 0; i < input.length; i++) {
		const raw = closedRecord(input[i], `${at}[${i}]`, [
			'consumerAddress',
			'requirementAddress',
			'providerAddress',
		])
		const consumerAddress = parseNode(raw.consumerAddress, `${at}[${i}].consumerAddress`)
		const requirementAddress = parseDefinition(
			raw.requirementAddress,
			`${at}[${i}].requirementAddress`,
		)
		const providerAddress = parseNode(raw.providerAddress, `${at}[${i}].providerAddress`)
		const key = `${pluginNodeIndexKey(consumerAddress)}:${pluginDefinitionIndexKey(requirementAddress)}`
		if (seen.has(key)) {
			throw invalidState(`${at}[${i}] duplicates a consumer requirement`)
		}
		seen.add(key)
		out.push({ consumerAddress, requirementAddress, providerAddress })
	}
	return out.sort((left, right) => {
		const leftKey = `${pluginNodeIndexKey(left.consumerAddress)}:${pluginDefinitionIndexKey(left.requirementAddress)}`
		const rightKey = `${pluginNodeIndexKey(right.consumerAddress)}:${pluginDefinitionIndexKey(right.requirementAddress)}`
		return leftKey.localeCompare(rightKey)
	})
}

function parseDefinition(value: unknown, at: string): PluginDefinitionAddress {
	try {
		return parsePluginDefinitionAddress(value)
	} catch (error) {
		throw invalidState(`${at}: ${error instanceof Error ? error.message : String(error)}`)
	}
}

function parseNode(value: unknown, at: string): PluginNodeAddress {
	try {
		return parsePluginNodeAddress(value)
	} catch (error) {
		throw invalidState(`${at}: ${error instanceof Error ? error.message : String(error)}`)
	}
}

function closedRecord(
	value: unknown,
	at: string,
	keys: readonly string[],
): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw invalidState(`${at} must be an object`)
	}
	const record = value as Record<string, unknown>
	assertClosedRecord(record, keys, at)
	return record
}

function assertClosedRecord(
	record: object,
	keys: readonly string[],
	at: string,
	requireAll = true,
): void {
	const expected = new Set(keys)
	for (const key of Object.keys(record)) {
		if (!expected.has(key)) throw invalidState(`${at} has unknown field ${key}`)
	}
	if (!requireAll) return
	for (const key of keys) {
		if (!Object.hasOwn(record, key)) throw invalidState(`${at} is missing field ${key}`)
	}
}

function invalidState(message: string): Error {
	return new Error(`[HostStateStore] ${message}`)
}

function cloneDefinitionAddress(definition: PluginDefinitionAddress): PluginDefinitionAddress {
	return {
		entry: { ...definition.entry },
		exportName: definition.exportName,
	}
}

function cloneNodeAddress(node: PluginNodeAddress): PluginNodeAddress {
	return node.variant === 'default'
		? { definition: cloneDefinitionAddress(node.definition), variant: 'default' }
		: {
				definition: cloneDefinitionAddress(node.definition),
				variant: 'fork',
				forkId: node.forkId,
			}
}

function cloneProviderDefault(entry: HostProviderDefaultState): HostProviderDefaultState {
	return {
		token: cloneDefinitionAddress(entry.token),
		provider: cloneNodeAddress(entry.provider),
	}
}

function cloneDependencyOverride(entry: HostDependencyOverrideState): HostDependencyOverrideState {
	return {
		consumerAddress: cloneNodeAddress(entry.consumerAddress),
		requirementAddress: cloneDefinitionAddress(entry.requirementAddress),
		providerAddress: cloneNodeAddress(entry.providerAddress),
	}
}
