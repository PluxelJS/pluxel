import {
	type Context as PluxelContext,
	Injectable,
	parsePluginDefinitionAddress,
	parsePluginNodeAddress,
	type PluginDefinitionAddressSnapshot,
	type PluginNodeAddressSnapshot,
} from '@pluxel/core'
import { hash as ohash } from 'ohash'
import { SuperJSON } from 'superjson'
import type { PersistenceNamespace } from './persistence/PersistenceService'

export type RuntimeStateSnapshot = Readonly<{
	enabled: readonly PluginNodeAddressSnapshot[]
	forks: readonly RuntimeForkState[]
	providerDefaults: readonly RuntimeProviderDefaultState[]
	dependencyOverrides: readonly RuntimeDependencyOverrideState[]
}>

export type RuntimeStateDraft = {
	enabled: PluginNodeAddressSnapshot[]
	forks: RuntimeForkState[]
	providerDefaults: RuntimeProviderDefaultState[]
	dependencyOverrides: RuntimeDependencyOverrideState[]
}

export type RuntimeForkState = {
	definition: PluginDefinitionAddressSnapshot
	forkIds: readonly string[]
}

export type RuntimeProviderDefaultState = {
	token: PluginDefinitionAddressSnapshot
	provider: PluginNodeAddressSnapshot
}

export type RuntimeDependencyOverrideState = {
	consumer: PluginNodeAddressSnapshot
	parameterIndex: number
	provider: PluginNodeAddressSnapshot
}

export type RuntimeStateFile = {
	version: 3
	enabled: PluginNodeAddressSnapshot[]
	forks: RuntimeForkState[]
	providerDefaults: RuntimeProviderDefaultState[]
	dependencyOverrides: RuntimeDependencyOverrideState[]
}

export type RuntimeStateStoreMode = 'file' | 'memory' | 'readonly'

export interface RuntimeStateStoreConfig {
	mode?: RuntimeStateStoreMode
	snapshot?: Partial<RuntimeStateSnapshot> & {
		enabled?: Iterable<PluginNodeAddressSnapshot> | PluginNodeAddressSnapshot[]
	}
}

export {
	isPluginEnabled,
	listForkIds,
	replaceEnabledPlugins,
	setPluginEnabled,
	setPluginsEnabled,
} from './RuntimeStateHelpers'

declare module '@pluxel/core' {
	namespace Context {
		interface Config {
			runtimeState?: RuntimeStateStoreConfig
		}
		interface Services {
			runtimeState: RuntimeStateStore
		}
	}
}

@Injectable({ key: 'runtimeState' })
export class RuntimeStateStore {
	public readonly ready: Promise<void>
	public isReady = false

	private readonly data: RuntimeStateDraft = createDefaultDraft()
	private readonly file: string
	private readonly saveDelayMs = 200
	private readonly mode: RuntimeStateStoreMode
	private readonly readonlyMode: boolean
	private saveTimer: ReturnType<typeof setTimeout> | null = null
	private saveScheduled = false
	private saveInFlight: Promise<void> | null = null
	private saveAgain = false
	private pendingWriteDigest: string | undefined
	private lastWrittenDigest: string | undefined
	private disposed = false
	private batching = 0
	private pendingSave = false
	private readonly storage: PersistenceNamespace

	constructor(
		public readonly ctx: PluxelContext,
		cfg: RuntimeStateStoreConfig = {},
	) {
		const implicitMode = defaultRuntimeStateStoreMode(ctx.root.persistence.capability)
		this.mode = cfg.mode ?? implicitMode
		this.readonlyMode = this.mode === 'readonly'
		this.storage = ctx.root.persistence.namespace('runtime-state')

		this.file = 'state.json'

		if (cfg.snapshot) applySnapshot(this.data, cfg.snapshot)

		if (this.mode === 'file') {
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
		return freezeSnapshot(this.data)
	}

	update(run: (draft: RuntimeStateDraft) => void): void {
		this.assertMutable('update')
		this.batch(() => run(this.data))
	}

	batch(run: () => void): void {
		this.batching++
		try {
			run()
		} finally {
			this.batching--
			if (this.batching === 0 && this.pendingSave) {
				this.pendingSave = false
				this.scheduleSave()
			}
		}
		if (this.batching === 0) this.requestSave()
		else this.pendingSave = true
	}

	async flush(options: { force?: boolean } = {}): Promise<void> {
		if (this.mode !== 'file') return
		const force = options.force ?? false
		const hadScheduled = this.saveScheduled || !!this.saveTimer
		this.cancelScheduledSave()
		if (this.saveInFlight) await this.saveInFlight.catch((): void => undefined)
		if (hadScheduled || this.pendingSave) {
			this.saveScheduled = false
			this.pendingSave = false
			await this.saveToDisk(this.file, { force }).catch((): void => undefined)
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return
		this.disposed = true
		this.cancelScheduledSave()
		await this.flush({ force: true }).catch((): void => undefined)
	}

	private assertMutable(action: string) {
		if (!this.readonlyMode) return
		throw new Error(`[RuntimeStateStore] ${action} is disabled in readonly mode.`)
	}

	private requestSave() {
		if (this.mode !== 'file') return
		if (this.disposed) return
		if (this.batching > 0) {
			this.pendingSave = true
			return
		}
		this.scheduleSave()
	}

	private scheduleSave() {
		if (this.disposed) return
		this.saveScheduled = true
		if (this.saveTimer) return
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null
			if (!this.saveScheduled) return
			this.saveScheduled = false
			void this.saveToDisk(this.file).catch((error: unknown) => {
				this.ctx.logger.error('RuntimeStateStore background save failed', { error })
			})
		}, this.saveDelayMs)
	}

	private cancelScheduledSave() {
		this.saveScheduled = false
		if (this.saveTimer) {
			clearTimeout(this.saveTimer)
			this.saveTimer = null
		}
	}

	private async loadFromDisk(file: string) {
		let txt: string
		const primary = await this.storage.getText(file)
		if (primary !== undefined) {
			txt = primary
		} else {
			await this.saveToDisk(file)
			return
		}

		const txtDigest = ohash(txt)
		if (txtDigest === this.pendingWriteDigest || txtDigest === this.lastWrittenDigest) return

		let parsed: unknown
		try {
			parsed = SuperJSON.parse(txt)
		} catch (error) {
			this.ctx.logger.warn('RuntimeStateStore parse failed; isolating broken state', {
				file,
				error,
			})
			await this.isolateBrokenStateFile(file, txt)
			replaceDraft(this.data, createDefaultDraft())
			await this.saveToDisk(file)
			return
		}

		replaceDraft(this.data, coerceRuntimeStateFile(parsed))
	}

	private async saveToDisk(file: string, options: { force?: boolean } = {}): Promise<void> {
		const force = options.force ?? false
		if (!force && this.batching > 0) return

		if (this.saveInFlight) {
			this.saveAgain = true
			await this.saveInFlight.catch((): void => undefined)
			if (this.saveAgain) {
				this.saveAgain = false
				await this.saveToDisk(file, options)
			}
			return
		}

		const content = SuperJSON.stringify(toRuntimeStateFile(this.data))
		const nextDigest = ohash(content)
		if (nextDigest === this.lastWrittenDigest && (await this.storage.stat(file))) return

		this.pendingWriteDigest = nextDigest
		const task = this.storage
			.put(file, content)
			.then((): undefined => {
				this.lastWrittenDigest = nextDigest
				return undefined
			})
			.finally(() => {
				if (this.pendingWriteDigest === nextDigest) this.pendingWriteDigest = undefined
			})
		this.saveInFlight = task.finally(() => {
			this.saveInFlight = null
		})
		await this.saveInFlight

		if (this.saveAgain) {
			this.saveAgain = false
			await this.saveToDisk(file, options)
		}
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
		enabled: [],
		forks: [],
		providerDefaults: [],
		dependencyOverrides: [],
	}
}

function replaceDraft(target: RuntimeStateDraft, source: RuntimeStateDraft): void {
	target.enabled = source.enabled.map(cloneNodeAddress)
	target.forks = source.forks.map(cloneForkState)
	target.providerDefaults = source.providerDefaults.map(cloneProviderDefault)
	target.dependencyOverrides = source.dependencyOverrides.map(cloneDependencyOverride)
}

function applySnapshot(
	draft: RuntimeStateDraft,
	snapshot: Partial<RuntimeStateSnapshot> & {
		enabled?: Iterable<PluginNodeAddressSnapshot> | PluginNodeAddressSnapshot[]
	},
): void {
	if (snapshot.enabled) {
		draft.enabled = parseUniqueNodes([...snapshot.enabled], 'runtimeState.snapshot.enabled')
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

function freezeSnapshot(draft: RuntimeStateDraft): RuntimeStateSnapshot {
	return Object.freeze({
		enabled: Object.freeze(draft.enabled.map(freezeNodeAddress)),
		forks: Object.freeze(
			draft.forks.map((entry) =>
				Object.freeze({
					definition: freezeDefinitionAddress(entry.definition),
					forkIds: Object.freeze([...entry.forkIds]),
				}),
			),
		),
		providerDefaults: Object.freeze(
			draft.providerDefaults.map((entry) =>
				Object.freeze({
					token: freezeDefinitionAddress(entry.token),
					provider: freezeNodeAddress(entry.provider),
				}),
			),
		),
		dependencyOverrides: Object.freeze(
			draft.dependencyOverrides.map((entry) =>
				Object.freeze({
					consumer: freezeNodeAddress(entry.consumer),
					parameterIndex: entry.parameterIndex,
					provider: freezeNodeAddress(entry.provider),
				}),
			),
		),
	})
}

function toRuntimeStateFile(draft: RuntimeStateDraft): RuntimeStateFile {
	return {
		version: 3,
		enabled: draft.enabled.map(cloneNodeAddress),
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
	if (raw.version !== 3) {
		throw invalidState(`unsupported persisted state version: ${String(raw.version)}`)
	}
	if (!Array.isArray(raw.enabled)) throw invalidState('enabled must be an array')
	if (!Array.isArray(raw.forks)) throw invalidState('forks must be an array')
	if (!Array.isArray(raw.providerDefaults)) {
		throw invalidState('providerDefaults must be an array')
	}
	if (!Array.isArray(raw.dependencyOverrides)) {
		throw invalidState('dependencyOverrides must be an array')
	}
	return {
		enabled: parseUniqueNodes(raw.enabled, 'enabled'),
		forks: parseForks(raw.forks, 'forks'),
		providerDefaults: parseProviderDefaults(raw.providerDefaults, 'providerDefaults'),
		dependencyOverrides: parseDependencyOverrides(raw.dependencyOverrides, 'dependencyOverrides'),
	}
}

function parseUniqueNodes(input: readonly unknown[], at: string): PluginNodeAddressSnapshot[] {
	const out: PluginNodeAddressSnapshot[] = []
	for (let i = 0; i < input.length; i++) {
		const node = parseNode(input[i], `${at}[${i}]`)
		if (out.some((candidate) => sameNode(candidate, node))) {
			throw invalidState(`${at}[${i}] duplicates an earlier node`)
		}
		out.push(node)
	}
	return out
}

function parseForks(input: readonly unknown[], at: string): RuntimeForkState[] {
	const out: RuntimeForkState[] = []
	for (let i = 0; i < input.length; i++) {
		const raw = record(input[i], `${at}[${i}]`)
		const definition = parseDefinition(raw.definition, `${at}[${i}].definition`)
		if (!Array.isArray(raw.forkIds)) throw invalidState(`${at}[${i}].forkIds must be an array`)
		const forkIds = raw.forkIds.map((value, index) =>
			nonEmptyText(value, `${at}[${i}].forkIds[${index}]`),
		)
		if (new Set(forkIds).size !== forkIds.length) {
			throw invalidState(`${at}[${i}].forkIds contains duplicates`)
		}
		if (out.some((candidate) => sameDefinition(candidate.definition, definition))) {
			throw invalidState(`${at}[${i}] duplicates a definition`)
		}
		out.push({ definition, forkIds })
	}
	return out
}

function parseProviderDefaults(
	input: readonly unknown[],
	at: string,
): RuntimeProviderDefaultState[] {
	const out: RuntimeProviderDefaultState[] = []
	for (let i = 0; i < input.length; i++) {
		const raw = record(input[i], `${at}[${i}]`)
		const token = parseDefinition(raw.token, `${at}[${i}].token`)
		const provider = parseNode(raw.provider, `${at}[${i}].provider`)
		if (out.some((candidate) => sameDefinition(candidate.token, token))) {
			throw invalidState(`${at}[${i}] duplicates a provider token`)
		}
		out.push({ token, provider })
	}
	return out
}

function parseDependencyOverrides(
	input: readonly unknown[],
	at: string,
): RuntimeDependencyOverrideState[] {
	const out: RuntimeDependencyOverrideState[] = []
	for (let i = 0; i < input.length; i++) {
		const raw = record(input[i], `${at}[${i}]`)
		const consumer = parseNode(raw.consumer, `${at}[${i}].consumer`)
		const provider = parseNode(raw.provider, `${at}[${i}].provider`)
		const parameterIndex = raw.parameterIndex
		if (!Number.isSafeInteger(parameterIndex) || (parameterIndex as number) < 0) {
			throw invalidState(`${at}[${i}].parameterIndex must be a non-negative integer`)
		}
		if (
			out.some(
				(candidate) =>
					sameNode(candidate.consumer, consumer) && candidate.parameterIndex === parameterIndex,
			)
		) {
			throw invalidState(`${at}[${i}] duplicates a consumer parameter`)
		}
		out.push({ consumer, parameterIndex: parameterIndex as number, provider })
	}
	return out
}

function parseDefinition(value: unknown, at: string): PluginDefinitionAddressSnapshot {
	try {
		return parsePluginDefinitionAddress(value)
	} catch (error) {
		throw invalidState(`${at}: ${error instanceof Error ? error.message : String(error)}`)
	}
}

function parseNode(value: unknown, at: string): PluginNodeAddressSnapshot {
	try {
		return parsePluginNodeAddress(value)
	} catch (error) {
		throw invalidState(`${at}: ${error instanceof Error ? error.message : String(error)}`)
	}
}

function record(value: unknown, at: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw invalidState(`${at} must be an object`)
	}
	return value as Record<string, unknown>
}

function nonEmptyText(value: unknown, at: string): string {
	if (typeof value !== 'string' || value.trim() === '') {
		throw invalidState(`${at} must be a non-empty string`)
	}
	return value
}

function invalidState(message: string): Error {
	return new Error(`[RuntimeStateStore] ${message}`)
}

function sameDefinition(
	left: PluginDefinitionAddressSnapshot,
	right: PluginDefinitionAddressSnapshot,
): boolean {
	if (left.exportName !== right.exportName || left.entry.kind !== right.entry.kind) return false
	return left.entry.kind === 'package-root'
		? right.entry.kind === 'package-root' && left.entry.packageName === right.entry.packageName
		: right.entry.kind === 'source-entry' && left.entry.source === right.entry.source
}

function sameNode(left: PluginNodeAddressSnapshot, right: PluginNodeAddressSnapshot): boolean {
	if (!sameDefinition(left.definition, right.definition) || left.instance !== right.instance) {
		return false
	}
	return left.instance === 'default'
		? true
		: right.instance === 'fork' && left.forkId === right.forkId
}

function cloneDefinitionAddress(
	definition: PluginDefinitionAddressSnapshot,
): PluginDefinitionAddressSnapshot {
	return {
		entry:
			definition.entry.kind === 'package-root'
				? { kind: 'package-root', packageName: definition.entry.packageName }
				: { kind: 'source-entry', source: definition.entry.source },
		exportName: definition.exportName,
	}
}

function cloneNodeAddress(node: PluginNodeAddressSnapshot): PluginNodeAddressSnapshot {
	return node.instance === 'default'
		? { definition: cloneDefinitionAddress(node.definition), instance: 'default' }
		: {
				definition: cloneDefinitionAddress(node.definition),
				instance: 'fork',
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
		consumer: cloneNodeAddress(entry.consumer),
		parameterIndex: entry.parameterIndex,
		provider: cloneNodeAddress(entry.provider),
	}
}

function freezeDefinitionAddress(
	definition: PluginDefinitionAddressSnapshot,
): PluginDefinitionAddressSnapshot {
	const entry = Object.freeze({ ...definition.entry })
	return Object.freeze({
		entry,
		exportName: definition.exportName,
	}) as PluginDefinitionAddressSnapshot
}

function freezeNodeAddress(node: PluginNodeAddressSnapshot): PluginNodeAddressSnapshot {
	return Object.freeze(
		node.instance === 'default'
			? { definition: freezeDefinitionAddress(node.definition), instance: 'default' as const }
			: {
					definition: freezeDefinitionAddress(node.definition),
					instance: 'fork' as const,
					forkId: node.forkId,
				},
	)
}

function defaultRuntimeStateStoreMode(
	capability: PluxelContext.RootServices['persistence']['capability'],
): RuntimeStateStoreMode {
	if (capability === 'readonly') return 'readonly'
	return 'file'
}
