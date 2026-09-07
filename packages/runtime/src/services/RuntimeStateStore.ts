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
import { pinOwnerContext } from '../context/owner-view'
import type { PersistenceNamespace } from './persistence/PersistenceService'

export type RuntimeStateSnapshot = Readonly<{
	autoStart: readonly PluginNodeAddress[]
	forks: readonly RuntimeForkState[]
	providerDefaults: readonly RuntimeProviderDefaultState[]
	dependencyOverrides: readonly RuntimeDependencyOverrideState[]
}>

export type RuntimeStateVersionedSnapshot = Readonly<{
	revision: number
	state: RuntimeStateSnapshot
}>

export class RuntimeStateRevisionConflictError extends Error {
	public readonly code = 'runtime_state_revision_conflict' as const

	constructor(
		public readonly expectedRevision: number,
		public readonly actualRevision: number,
	) {
		super(`[RuntimeStateStore] revision changed from ${expectedRevision} to ${actualRevision}`)
		this.name = 'RuntimeStateRevisionConflictError'
	}
}

export type RuntimeStateDraft = {
	autoStart: PluginNodeAddress[]
	forks: RuntimeForkState[]
	providerDefaults: RuntimeProviderDefaultState[]
	dependencyOverrides: RuntimeDependencyOverrideState[]
}

export type RuntimeForkState = {
	definition: PluginDefinitionAddress
	forkIds: readonly string[]
}

export type RuntimeProviderDefaultState = {
	token: PluginDefinitionAddress
	provider: PluginNodeAddress
}

export type RuntimeDependencyOverrideState = {
	consumerAddress: PluginNodeAddress
	requirementAddress: PluginDefinitionAddress
	providerAddress: PluginNodeAddress
}

export type RuntimeStateFile = {
	version: 5
	autoStart: PluginNodeAddress[]
	forks: RuntimeForkState[]
	providerDefaults: RuntimeProviderDefaultState[]
	dependencyOverrides: RuntimeDependencyOverrideState[]
}

export type RuntimeStateStoreMode = 'file' | 'memory' | 'readonly'

export interface RuntimeStateStoreConfig {
	mode?: RuntimeStateStoreMode
	snapshot?: Omit<Partial<RuntimeStateSnapshot>, 'autoStart'> & {
		autoStart?: Iterable<PluginNodeAddress>
	}
}

export {
	isPluginAutoStartEnabled,
	listForkIds,
	replaceAutoStartPlugins,
	setPluginAutoStart,
	setPluginsAutoStart,
} from './RuntimeStateHelpers'

export class RuntimeStateStore {
	public readonly ready: Promise<void>
	public isReady = false

	private readonly data: RuntimeStateDraft = createDefaultDraft()
	private revision = 0
	private snapshotCache!: RuntimeStateSnapshot
	private versionedSnapshotCache!: RuntimeStateVersionedSnapshot
	private readonly file: string
	private readonly mode: RuntimeStateStoreMode
	private readonly readonlyMode: boolean
	private disposed = false
	private durableCommitInFlight = false
	private readonly storage: PersistenceNamespace

	constructor(
		public readonly ctx: PluxelContext,
		cfg: RuntimeStateStoreConfig = {},
	) {
		pinOwnerContext(this, ctx)
		const implicitMode = defaultRuntimeStateStoreMode(ctx.root.persistence.capability)
		this.mode = cfg.mode ?? implicitMode
		this.readonlyMode = this.mode === 'readonly'
		this.storage = ctx.root.persistence.namespace('runtime-state')

		this.file = 'state.json'

		if (cfg.snapshot) applySnapshot(this.data, cfg.snapshot)
		this.refreshSnapshotCache()

		if (this.mode !== 'memory') {
			this.ready = this.loadFromDisk(this.file).finally(() => {
				this.isReady = true
			})
		} else {
			this.isReady = true
			this.ready = Promise.resolve()
		}

		this.ctx.effects.defer(() => this.dispose(), { tag: 'RuntimeStateStore' })
	}

	snapshot(): RuntimeStateSnapshot {
		return this.snapshotCache
	}

	versionedSnapshot(): RuntimeStateVersionedSnapshot {
		return this.versionedSnapshotCache
	}

	/** Atomically persists and publishes graph policy after a coordinator prepare. */
	async commitVersioned(
		expectedRevision: number,
		next: RuntimeStateSnapshot,
	): Promise<RuntimeStateVersionedSnapshot> {
		this.assertMutable('commitVersioned')
		if (this.durableCommitInFlight) {
			throw new Error('[RuntimeStateStore] nested durable graph transaction is not allowed')
		}
		this.assertRevision(expectedRevision)
		const normalized = canonicalRuntimeStateSnapshot(next)
		this.durableCommitInFlight = true
		try {
			this.assertRevision(expectedRevision)
			if (this.mode === 'file') await this.persistDraft(this.file, normalized)
			replaceDraft(this.data, normalized)
			this.revision++
			this.refreshSnapshotCache(normalized)
			return this.versionedSnapshotCache
		} finally {
			this.durableCommitInFlight = false
		}
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
	}

	private assertMutable(action: string) {
		if (this.disposed) throw new Error(`[RuntimeStateStore] ${action} is disabled after dispose.`)
		if (!this.readonlyMode) return
		throw new Error(`[RuntimeStateStore] ${action} is disabled in readonly mode.`)
	}

	private assertRevision(expectedRevision: number): void {
		if (expectedRevision === this.revision) return
		throw new RuntimeStateRevisionConflictError(expectedRevision, this.revision)
	}

	private refreshSnapshotCache(snapshot = freezeTrustedRuntimeStateSnapshot(this.data)): void {
		this.snapshotCache = snapshot
		this.versionedSnapshotCache = Object.freeze({
			revision: this.revision,
			state: this.snapshotCache,
		})
	}

	private async loadFromDisk(file: string) {
		let txt: string
		const primary = await this.storage.getText(file)
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
				throw new Error('[RuntimeStateStore] Persisted readonly state is malformed.', {
					cause: error,
				})
			}
			this.ctx.logger.warn('RuntimeStateStore parse failed; isolating broken state', {
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

		replaceDraft(this.data, coerceRuntimeStateFile(parsed))
		this.revision++
		this.refreshSnapshotCache()
	}

	private async persistDraft(
		file: string,
		draft: RuntimeStateDraft | RuntimeStateSnapshot,
	): Promise<void> {
		const content = SuperJSON.stringify(toRuntimeStateFile(draft))
		await this.storage.put(file, content)
	}

	private async isolateBrokenStateFile(file: string, content: string) {
		const safeTs = new Date().toISOString().replaceAll(/[:.]/g, '-')
		const brokenFile = `${file}.broken.${safeTs}`
		try {
			await this.storage.put(brokenFile, content)
		} catch (error) {
			this.ctx.logger.warn('failed to isolate broken runtime state file', {
				file,
				brokenFile,
				error,
			})
		}
	}
}

function createDefaultDraft(): RuntimeStateDraft {
	return {
		autoStart: [],
		forks: [],
		providerDefaults: [],
		dependencyOverrides: [],
	}
}

function cloneSnapshot(snapshot: RuntimeStateSnapshot): RuntimeStateDraft {
	return {
		autoStart: snapshot.autoStart.map(cloneNodeAddress),
		forks: snapshot.forks.map(cloneForkState),
		providerDefaults: snapshot.providerDefaults.map(cloneProviderDefault),
		dependencyOverrides: snapshot.dependencyOverrides.map(cloneDependencyOverride),
	}
}

function normalizeDraft(draft: RuntimeStateDraft): RuntimeStateDraft {
	return {
		autoStart: parseUniqueNodes(draft.autoStart, 'autoStart'),
		forks: parseForks(draft.forks, 'forks'),
		providerDefaults: parseProviderDefaults(draft.providerDefaults, 'providerDefaults'),
		dependencyOverrides: parseDependencyOverrides(draft.dependencyOverrides, 'dependencyOverrides'),
	}
}

const canonicalSnapshots = new WeakSet<RuntimeStateSnapshot>()

/** @internal Validates, sorts, clones, and deep-freezes one canonical revision snapshot. */
export function canonicalRuntimeStateSnapshot(state: RuntimeStateSnapshot): RuntimeStateSnapshot {
	if (canonicalSnapshots.has(state)) return state
	return freezeTrustedRuntimeStateSnapshot(normalizeDraft(cloneSnapshot(state)))
}

function replaceDraft(
	target: RuntimeStateDraft,
	source: RuntimeStateDraft | RuntimeStateSnapshot,
): void {
	target.autoStart = source.autoStart.map(cloneNodeAddress)
	target.forks = source.forks.map(cloneForkState)
	target.providerDefaults = source.providerDefaults.map(cloneProviderDefault)
	target.dependencyOverrides = source.dependencyOverrides.map(cloneDependencyOverride)
}

function applySnapshot(
	draft: RuntimeStateDraft,
	snapshot: NonNullable<RuntimeStateStoreConfig['snapshot']>,
): void {
	assertClosedRecord(
		snapshot,
		['autoStart', 'forks', 'providerDefaults', 'dependencyOverrides'],
		'runtimeState.snapshot',
		false,
	)
	if (snapshot.autoStart) {
		draft.autoStart = parseUniqueNodes([...snapshot.autoStart], 'runtimeState.snapshot.autoStart')
	}
	if (snapshot.forks) draft.forks = parseForks(snapshot.forks, 'runtimeState.snapshot.forks')
	if (snapshot.providerDefaults) {
		draft.providerDefaults = parseProviderDefaults(
			snapshot.providerDefaults,
			'runtimeState.snapshot.providerDefaults',
		)
	}
	if (snapshot.dependencyOverrides) {
		draft.dependencyOverrides = parseDependencyOverrides(
			snapshot.dependencyOverrides,
			'runtimeState.snapshot.dependencyOverrides',
		)
	}
}

/** @internal Deep-freezes already-admitted state and imposes canonical serialization order. */
export function freezeTrustedRuntimeStateSnapshot(
	draft: RuntimeStateDraft | RuntimeStateSnapshot,
): RuntimeStateSnapshot {
	const snapshot: RuntimeStateSnapshot = Object.freeze({
		autoStart: Object.freeze(sortByKey(draft.autoStart.map(freezeNodeAddress), pluginNodeIndexKey)),
		forks: Object.freeze(
			sortByKey(
				draft.forks.map((entry) =>
					Object.freeze({
						definition: freezeDefinitionAddress(entry.definition),
						forkIds: Object.freeze([...entry.forkIds].sort()),
					}),
				),
				(entry) => pluginDefinitionIndexKey(entry.definition),
			),
		),
		providerDefaults: Object.freeze(
			sortByKey(
				draft.providerDefaults.map((entry) =>
					Object.freeze({
						token: freezeDefinitionAddress(entry.token),
						provider: freezeNodeAddress(entry.provider),
					}),
				),
				(entry) => pluginDefinitionIndexKey(entry.token),
			),
		),
		dependencyOverrides: Object.freeze(
			sortByKey(
				draft.dependencyOverrides.map((entry) =>
					Object.freeze({
						consumerAddress: freezeNodeAddress(entry.consumerAddress),
						requirementAddress: freezeDefinitionAddress(entry.requirementAddress),
						providerAddress: freezeNodeAddress(entry.providerAddress),
					}),
				),
				(entry) => overrideIndexKey(entry.consumerAddress, entry.requirementAddress),
			),
		),
	})
	canonicalSnapshots.add(snapshot)
	return snapshot
}

function overrideIndexKey(
	consumer: PluginNodeAddress,
	requirement: PluginDefinitionAddress,
): string {
	return `${pluginNodeIndexKey(consumer)}:${pluginDefinitionIndexKey(requirement)}`
}

function sortByKey<T>(values: T[], keyOf: (value: T) => string): T[] {
	return values
		.map((value, order) => ({ value, key: keyOf(value), order }))
		.sort((left, right) => left.key.localeCompare(right.key) || left.order - right.order)
		.map(({ value }) => value)
}

function toRuntimeStateFile(draft: RuntimeStateDraft | RuntimeStateSnapshot): RuntimeStateFile {
	return {
		version: 5,
		autoStart: draft.autoStart.map(cloneNodeAddress),
		forks: draft.forks.map(cloneForkState),
		providerDefaults: draft.providerDefaults.map(cloneProviderDefault),
		dependencyOverrides: draft.dependencyOverrides.map(cloneDependencyOverride),
	}
}

function coerceRuntimeStateFile(input: unknown): RuntimeStateDraft {
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

function parseForks(input: readonly unknown[], at: string): RuntimeForkState[] {
	const out: RuntimeForkState[] = []
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

function parseProviderDefaults(
	input: readonly unknown[],
	at: string,
): RuntimeProviderDefaultState[] {
	const out: RuntimeProviderDefaultState[] = []
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
): RuntimeDependencyOverrideState[] {
	const out: RuntimeDependencyOverrideState[] = []
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
	return new Error(`[RuntimeStateStore] ${message}`)
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

function cloneForkState(entry: RuntimeForkState): RuntimeForkState {
	return { definition: cloneDefinitionAddress(entry.definition), forkIds: [...entry.forkIds] }
}

function cloneProviderDefault(entry: RuntimeProviderDefaultState): RuntimeProviderDefaultState {
	return {
		token: cloneDefinitionAddress(entry.token),
		provider: cloneNodeAddress(entry.provider),
	}
}

function cloneDependencyOverride(
	entry: RuntimeDependencyOverrideState,
): RuntimeDependencyOverrideState {
	return {
		consumerAddress: cloneNodeAddress(entry.consumerAddress),
		requirementAddress: cloneDefinitionAddress(entry.requirementAddress),
		providerAddress: cloneNodeAddress(entry.providerAddress),
	}
}

function freezeDefinitionAddress(definition: PluginDefinitionAddress): PluginDefinitionAddress {
	const entry = Object.freeze({ ...definition.entry })
	return Object.freeze({
		entry,
		exportName: definition.exportName,
	}) as PluginDefinitionAddress
}

function freezeNodeAddress(node: PluginNodeAddress): PluginNodeAddress {
	return Object.freeze(
		node.variant === 'default'
			? { definition: freezeDefinitionAddress(node.definition), variant: 'default' as const }
			: {
					definition: freezeDefinitionAddress(node.definition),
					variant: 'fork' as const,
					forkId: node.forkId,
				},
	)
}

function defaultRuntimeStateStoreMode(
	capability: PluxelContext['root']['persistence']['capability'],
): RuntimeStateStoreMode {
	if (capability === 'readonly') return 'readonly'
	return 'file'
}
