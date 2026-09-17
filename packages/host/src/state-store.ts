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
import {
	type HostStateSnapshot,
	type HostStateVersionedSnapshot,
	HostStateRevisionConflictError,
	type HostStateDraft,
	type HostForkState,
	type HostProviderDefaultState,
	type HostDependencyOverrideState,
	freezeTrustedHostStateSnapshot,
} from './policy'
import {
	assertHostStoreStorage,
	type HostDocumentStorage,
	type HostStoreStorageOptions,
} from './document-storage'

export type HostStateFile = {
	version: 5
	autoStart: PluginNodeAddress[]
	forks: HostForkState[]
	providerDefaults: HostProviderDefaultState[]
	dependencyOverrides: HostDependencyOverrideState[]
}

export type HostStateStoreOptions = HostStoreStorageOptions &
	Readonly<{
		/** Initial graph policy; an existing persisted document replaces it. Omitted lists are empty. */
		initial?: Omit<Partial<HostStateSnapshot>, 'autoStart'> & {
			autoStart?: Iterable<PluginNodeAddress>
		}
	}>

export class HostStateStore {
	public readonly ready: Promise<void>
	public isReady = false

	private readonly data: HostStateDraft = createDefaultDraft()
	private revision = 0
	private snapshotCache!: HostStateSnapshot
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
		options: HostStateStoreOptions = {},
	) {
		assertHostStoreStorage(options)
		this.mode = options.mode ?? (options.storage ? 'writable' : 'memory')
		this.readonlyMode = this.mode === 'readonly'
		this.storage = options.storage
		if (this.mode !== 'memory' && !this.storage)
			throw new TypeError('[host] persistent state requires document storage')
		this.file = 'state.json'
		if (options.initial) applySnapshot(this.data, options.initial)
		this.refreshSnapshotCache()
		if (this.mode !== 'memory') {
			this.ready = this.loadFromDisk(this.file).finally(() => {
				this.isReady = true
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
		if (this.disposed) throw new Error(`[HostStateStore] ${action} is disabled after dispose.`)
		if (!this.readonlyMode) return
		throw new Error(`[HostStateStore] ${action} is disabled in readonly mode.`)
	}

	private assertRevision(expectedRevision: number): void {
		if (expectedRevision === this.revision) return
		throw new HostStateRevisionConflictError(expectedRevision, this.revision)
	}

	private refreshSnapshotCache(snapshot = freezeTrustedHostStateSnapshot(this.data)): void {
		this.snapshotCache = snapshot
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

		let parsed: unknown
		try {
			parsed = SuperJSON.parse(txt)
		} catch (error) {
			if (this.readonlyMode) {
				throw new Error('[HostStateStore] Persisted readonly state is malformed.', {
					cause: error,
				})
			}
			this.ctx.logger.warn('HostStateStore parse failed; isolating broken state', {
				file,
				error,
			})
			await this.isolateBrokenStateFile(file, txt)
			replaceDraft(this.data, createDefaultDraft())
			this.revision++
			this.refreshSnapshotCache()
			await this.persistDraft(file, this.data)
			return
		}

		replaceDraft(this.data, coerceHostStateFile(parsed))
		this.revision++
		this.refreshSnapshotCache()
	}

	private async persistDraft(
		file: string,
		draft: HostStateDraft | HostStateSnapshot,
	): Promise<void> {
		const content = SuperJSON.stringify(toHostStateFile(draft))
		await this.storage!.put(file, content, { atomic: true })
	}

	private async isolateBrokenStateFile(file: string, content: string) {
		const safeTs = new Date().toISOString().replaceAll(/[:.]/g, '-')
		const brokenFile = `${file}.broken.${safeTs}`
		try {
			await this.storage!.put(brokenFile, content)
		} catch (error) {
			this.ctx.logger.warn('failed to isolate broken runtime state file', {
				file,
				brokenFile,
				error,
			})
		}
	}
}

export function resolveHostStateInitial(
	initial: HostStateStoreOptions['initial'] = {},
): HostStateSnapshot {
	const draft = createDefaultDraft()
	applySnapshot(draft, initial)
	return freezeTrustedHostStateSnapshot(draft)
}

function createDefaultDraft(): HostStateDraft {
	return {
		autoStart: [],
		forks: [],
		providerDefaults: [],
		dependencyOverrides: [],
	}
}

function cloneSnapshot(snapshot: HostStateSnapshot): HostStateDraft {
	return {
		autoStart: snapshot.autoStart.map(cloneNodeAddress),
		forks: snapshot.forks.map(cloneForkState),
		providerDefaults: snapshot.providerDefaults.map(cloneProviderDefault),
		dependencyOverrides: snapshot.dependencyOverrides.map(cloneDependencyOverride),
	}
}

function normalizeDraft(draft: HostStateDraft): HostStateDraft {
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
	const snapshot = freezeTrustedHostStateSnapshot(normalizeDraft(cloneSnapshot(state)))
	canonicalSnapshots.add(snapshot)
	return snapshot
}

function replaceDraft(target: HostStateDraft, source: HostStateDraft | HostStateSnapshot): void {
	target.autoStart = source.autoStart.map(cloneNodeAddress)
	target.forks = source.forks.map(cloneForkState)
	target.providerDefaults = source.providerDefaults.map(cloneProviderDefault)
	target.dependencyOverrides = source.dependencyOverrides.map(cloneDependencyOverride)
}

function applySnapshot(
	draft: HostStateDraft,
	snapshot: NonNullable<HostStateStoreOptions['initial']>,
): void {
	assertClosedRecord(
		snapshot,
		['autoStart', 'forks', 'providerDefaults', 'dependencyOverrides'],
		'state.initial',
		false,
	)
	if (snapshot.autoStart) {
		draft.autoStart = parseUniqueNodes([...snapshot.autoStart], 'state.initial.autoStart')
	}
	if (snapshot.forks) draft.forks = parseForks(snapshot.forks, 'state.initial.forks')
	if (snapshot.providerDefaults) {
		draft.providerDefaults = parseProviderDefaults(
			snapshot.providerDefaults,
			'state.initial.providerDefaults',
		)
	}
	if (snapshot.dependencyOverrides) {
		draft.dependencyOverrides = parseDependencyOverrides(
			snapshot.dependencyOverrides,
			'state.initial.dependencyOverrides',
		)
	}
}

function toHostStateFile(draft: HostStateDraft | HostStateSnapshot): HostStateFile {
	return {
		version: 5,
		autoStart: draft.autoStart.map(cloneNodeAddress),
		forks: draft.forks.map(cloneForkState),
		providerDefaults: draft.providerDefaults.map(cloneProviderDefault),
		dependencyOverrides: draft.dependencyOverrides.map(cloneDependencyOverride),
	}
}

function coerceHostStateFile(input: unknown): HostStateDraft {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw invalidState('persisted state must be an object')
	}
	const raw = input as Record<string, unknown>
	if (raw.version !== 5) {
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

function parseForks(input: readonly unknown[], at: string): HostForkState[] {
	const out: HostForkState[] = []
	const seen = new Set<string>()
	for (let i = 0; i < input.length; i++) {
		const raw = closedRecord(input[i], `${at}[${i}]`, ['definition', 'forkIds'])
		const definition = parseDefinition(raw.definition, `${at}[${i}].definition`)
		if (!Array.isArray(raw.forkIds)) throw invalidState(`${at}[${i}].forkIds must be an array`)
		const forkIds = raw.forkIds.map((value, index) =>
			parseForkId(value, definition, `${at}[${i}].forkIds[${index}]`),
		)
		if (new Set(forkIds).size !== forkIds.length) {
			throw invalidState(`${at}[${i}].forkIds contains duplicates`)
		}
		const key = pluginDefinitionIndexKey(definition)
		if (seen.has(key)) {
			throw invalidState(`${at}[${i}] duplicates a definition`)
		}
		seen.add(key)
		out.push({ definition, forkIds: forkIds.sort() })
	}
	return out.sort((left, right) =>
		pluginDefinitionIndexKey(left.definition).localeCompare(
			pluginDefinitionIndexKey(right.definition),
		),
	)
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

function parseForkId(value: unknown, definition: PluginDefinitionAddress, at: string): string {
	try {
		const node = parsePluginNodeAddress({ definition, variant: 'fork', forkId: value })
		if (node.variant !== 'fork') throw new TypeError('Plugin node must be a fork')
		return node.forkId
	} catch (error) {
		throw invalidState(`${at}: ${error instanceof Error ? error.message : String(error)}`)
	}
}

function invalidState(message: string): Error {
	return new Error(`[HostStateStore] ${message}`)
}

function cloneDefinitionAddress(definition: PluginDefinitionAddress): PluginDefinitionAddress {
	return {
		entry:
			definition.entry.kind === 'package-root'
				? { kind: 'package-root', packageName: definition.entry.packageName }
				: {
						kind: 'source-entry',
						sourceSpace: definition.entry.sourceSpace,
						path: definition.entry.path,
					},
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

function cloneForkState(entry: HostForkState): HostForkState {
	return { definition: cloneDefinitionAddress(entry.definition), forkIds: [...entry.forkIds] }
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
