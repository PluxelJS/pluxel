import { type Context as PluxelContext, Injectable } from '@pluxel/core'
import { watch, type FSWatcher } from 'chokidar'
import { hash as ohash } from 'ohash'
import { SuperJSON } from 'superjson'
import { resolveProfiledPath, resolveRuntimeStoragePaths } from '../runtime/paths'

export type PluginGroupState = {
	groupId: string
	name: string
	pluginIds: string[]
}

export type RuntimeStateSnapshot = Readonly<{
	enabled: readonly string[]
	forks: Readonly<Record<string, readonly string[]>>
	baseProviders: Readonly<Record<string, string>>
	dependencyOverrides: Readonly<Record<string, Readonly<Record<number, string>>>>
	builtinsKnown: Readonly<Record<string, 1>>
	pluginGroups: readonly PluginGroupState[]
}>

export type RuntimeStateDraft = {
	enabled: Set<string>
	forks: Record<string, string[]>
	baseProviders: Record<string, string>
	dependencyOverrides: Record<string, Record<number, string>>
	builtinsKnown: Record<string, 1>
	pluginGroups: PluginGroupState[]
}

export type RuntimeStateFile = {
	version: 1
	enabled: string[]
	forks?: Record<string, string[]>
	baseProviders?: Record<string, string>
	dependencyOverrides?: Record<string, Record<number, string>>
	builtinsKnown?: Record<string, 1>
	pluginGroups?: PluginGroupState[]
}

export type RuntimeStateStoreMode = 'file' | 'memory' | 'readonly'

export interface RuntimeStateStoreConfig {
	mode?: RuntimeStateStoreMode
	path?: string
	snapshot?: Partial<RuntimeStateSnapshot> & { enabled?: Iterable<string> | string[] }
}

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
	private watcher: FSWatcher | undefined
	private disposed = false
	private batching = 0
	private pendingSave = false

	constructor(
		public readonly ctx: PluxelContext,
		cfg: RuntimeStateStoreConfig = {},
	) {
		const fsMode = (ctx.config as unknown as { fs?: { mode?: unknown } })?.fs?.mode
		const implicitMode: RuntimeStateStoreMode = fsMode === 'memory' ? 'memory' : 'file'
		this.mode = cfg.mode ?? implicitMode
		this.readonlyMode = this.mode === 'readonly'

		const profile = normalizeProfileName(ctx.config.profile)
		const runtimeStorage = resolveRuntimeStoragePaths(process.cwd())
		const resolved = resolveProfiledPath(cfg.path ?? runtimeStorage.runtimeStateFile, profile)
		this.file = resolved.path

		if (cfg.snapshot) applySnapshot(this.data, cfg.snapshot)

		if (this.mode === 'file') {
			this.ready = this.loadFromDisk(this.file, resolved.fallbackPath).finally(() => {
				this.isReady = true
			})
			this.watcher = watch(this.file, {
				ignoreInitial: true,
				awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
			})
				.on('add', () => this.onDiskChange(this.file))
				.on('change', () => this.onDiskChange(this.file))
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
		await Promise.resolve(this.watcher?.close()).catch((): void => undefined)
		this.watcher = undefined
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
			void this.saveToDisk(this.file)
		}, this.saveDelayMs)
	}

	private cancelScheduledSave() {
		this.saveScheduled = false
		if (this.saveTimer) {
			clearTimeout(this.saveTimer)
			this.saveTimer = null
		}
	}

	private async loadFromDisk(file: string, fallbackFile?: string) {
		const fs = this.ctx.root.fs
		let txt: string
		let readFromFallback = false
		try {
			const hasPrimary = fs.exists(file)
			const shouldSeed = !hasPrimary && !!fallbackFile && fs.exists(fallbackFile)
			if (shouldSeed) {
				txt = await fs.readText(fallbackFile!)
				readFromFallback = true
			} else {
				txt = await fs.readText(file)
			}
		} catch (error) {
			if (isMissingFileError(error)) {
				replaceDraft(this.data, createDefaultDraft())
				await this.saveToDisk(file)
				return
			}
			this.ctx.logger.warn('RuntimeStateStore read failed (fallback to defaults)', {
				file,
				error,
			})
			replaceDraft(this.data, createDefaultDraft())
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
		if (readFromFallback) await this.saveToDisk(file)
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
		if (nextDigest === this.lastWrittenDigest && this.ctx.root.fs.exists(file)) return

		this.pendingWriteDigest = nextDigest
		const task = this.ctx.root.fs
			.writeTextAtomic(file, content)
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

	private async onDiskChange(file: string) {
		if (this.disposed) return
		await this.loadFromDisk(file)
	}

	private async isolateBrokenStateFile(file: string, content: string) {
		const safeTs = new Date().toISOString().replaceAll(/[:.]/g, '-')
		const brokenFile = `${file}.broken.${safeTs}`
		try {
			await this.ctx.root.fs.writeTextAtomic(brokenFile, content)
		} catch (error) {
			this.ctx.logger.warn('failed to isolate broken runtime state file', {
				file,
				brokenFile,
				error,
			})
		}
	}
}

export function isPluginEnabled(state: RuntimeStateSnapshot, pluginId: string): boolean {
	return state.enabled.includes(pluginId)
}

export function setPluginEnabled(
	draft: RuntimeStateDraft,
	pluginId: string,
	enabled: boolean,
): void {
	if (enabled) draft.enabled.add(pluginId)
	else draft.enabled.delete(pluginId)
}

export function setPluginsEnabled(
	draft: RuntimeStateDraft,
	pluginIds: Iterable<string>,
	enabled: boolean,
): void {
	for (const pluginId of pluginIds) setPluginEnabled(draft, pluginId, enabled)
}

export function replaceEnabledPlugins(draft: RuntimeStateDraft, pluginIds: Iterable<string>): void {
	draft.enabled.clear()
	for (const pluginId of pluginIds) {
		if (typeof pluginId === 'string' && pluginId) draft.enabled.add(pluginId)
	}
}

export function listForkIds(state: RuntimeStateSnapshot, basePluginId: string): readonly string[] {
	return state.forks[basePluginId] ?? []
}

function createDefaultDraft(): RuntimeStateDraft {
	return {
		enabled: new Set(),
		forks: Object.create(null),
		baseProviders: Object.create(null),
		dependencyOverrides: Object.create(null),
		builtinsKnown: Object.create(null),
		pluginGroups: [],
	}
}

function replaceDraft(target: RuntimeStateDraft, source: RuntimeStateDraft): void {
	target.enabled.clear()
	for (const name of source.enabled) target.enabled.add(name)
	replaceRecord(target.forks, source.forks)
	replaceRecord(target.baseProviders, source.baseProviders)
	replaceRecord(target.dependencyOverrides, source.dependencyOverrides)
	replaceRecord(target.builtinsKnown, source.builtinsKnown)
	target.pluginGroups = source.pluginGroups.map(clonePluginGroup)
}

function applySnapshot(
	draft: RuntimeStateDraft,
	snapshot: Partial<RuntimeStateSnapshot> & { enabled?: Iterable<string> | string[] },
): void {
	if (snapshot.enabled) {
		draft.enabled.clear()
		for (const name of snapshot.enabled) {
			if (typeof name === 'string' && name) draft.enabled.add(name)
		}
	}
	if (snapshot.forks) replaceRecord(draft.forks, coerceForks(snapshot.forks))
	if (snapshot.baseProviders)
		replaceRecord(draft.baseProviders, coerceStringRecord(snapshot.baseProviders))
	if (snapshot.dependencyOverrides) {
		replaceRecord(draft.dependencyOverrides, coerceDepOverrides(snapshot.dependencyOverrides))
	}
	if (snapshot.builtinsKnown)
		replaceRecord(draft.builtinsKnown, coerceBuiltinsKnown(snapshot.builtinsKnown))
	if (snapshot.pluginGroups) draft.pluginGroups = coercePluginGroups(snapshot.pluginGroups)
}

function freezeSnapshot(draft: RuntimeStateDraft): RuntimeStateSnapshot {
	return Object.freeze({
		enabled: Object.freeze([...draft.enabled]),
		forks: freezeRecordOfArrays(draft.forks),
		baseProviders: Object.freeze({ ...draft.baseProviders }),
		dependencyOverrides: freezeNestedRecord(draft.dependencyOverrides),
		builtinsKnown: Object.freeze({ ...draft.builtinsKnown }),
		pluginGroups: Object.freeze(draft.pluginGroups.map(clonePluginGroup)),
	})
}

function toRuntimeStateFile(draft: RuntimeStateDraft): RuntimeStateFile {
	return {
		version: 1,
		enabled: [...draft.enabled],
		forks: cloneRecordOfArrays(draft.forks),
		baseProviders: { ...draft.baseProviders },
		dependencyOverrides: cloneNestedRecord(draft.dependencyOverrides),
		builtinsKnown: { ...draft.builtinsKnown },
		pluginGroups: draft.pluginGroups.map(clonePluginGroup),
	}
}

function coerceRuntimeStateFile(input: unknown): RuntimeStateDraft {
	const out = createDefaultDraft()
	if (!input || typeof input !== 'object' || Array.isArray(input)) return out
	const raw = input as Partial<RuntimeStateFile>
	if (Array.isArray(raw.enabled)) {
		for (const name of raw.enabled) {
			if (typeof name === 'string' && name) out.enabled.add(name)
		}
	}
	if (raw.forks) replaceRecord(out.forks, coerceForks(raw.forks))
	if (raw.baseProviders) replaceRecord(out.baseProviders, coerceStringRecord(raw.baseProviders))
	if (raw.dependencyOverrides) {
		replaceRecord(out.dependencyOverrides, coerceDepOverrides(raw.dependencyOverrides))
	}
	if (raw.builtinsKnown) replaceRecord(out.builtinsKnown, coerceBuiltinsKnown(raw.builtinsKnown))
	if (raw.pluginGroups) out.pluginGroups = coercePluginGroups(raw.pluginGroups)
	return out
}

function replaceRecord<T>(target: Record<string, T>, source: Record<string, T>): void {
	for (const key in target) delete target[key]
	Object.assign(target, source)
}

function coerceForks(input: unknown): Record<string, string[]> {
	const out: Record<string, string[]> = Object.create(null)
	if (!input || typeof input !== 'object' || Array.isArray(input)) return out
	for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
		if (!Array.isArray(value)) continue
		const items = value.filter((item): item is string => typeof item === 'string' && !!item)
		if (items.length > 0) out[key] = items
	}
	return out
}

function coerceStringRecord(input: unknown): Record<string, string> {
	const out: Record<string, string> = Object.create(null)
	if (!input || typeof input !== 'object' || Array.isArray(input)) return out
	for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
		if (typeof value === 'string' && value) out[key] = value
	}
	return out
}

function coerceDepOverrides(input: unknown): Record<string, Record<number, string>> {
	const out: Record<string, Record<number, string>> = Object.create(null)
	if (!input || typeof input !== 'object' || Array.isArray(input)) return out
	for (const [consumer, rawOverrides] of Object.entries(input as Record<string, unknown>)) {
		if (!rawOverrides || typeof rawOverrides !== 'object' || Array.isArray(rawOverrides)) continue
		const entry: Record<number, string> = Object.create(null)
		for (const [rawIndex, target] of Object.entries(rawOverrides as Record<string, unknown>)) {
			const index = Number(rawIndex)
			if (!Number.isFinite(index) || index < 0) continue
			if (typeof target === 'string' && target) entry[index] = target
		}
		if (Object.keys(entry).length > 0) out[consumer] = entry
	}
	return out
}

function coerceBuiltinsKnown(input: unknown): Record<string, 1> {
	const out: Record<string, 1> = Object.create(null)
	if (!input || typeof input !== 'object' || Array.isArray(input)) return out
	for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
		if (value === 1) out[key] = 1
	}
	return out
}

function coercePluginGroups(input: unknown): PluginGroupState[] {
	if (!Array.isArray(input)) return []
	return input.flatMap((item): PluginGroupState[] => {
		if (!item || typeof item !== 'object' || Array.isArray(item)) return []
		const raw = item as Record<string, unknown>
		if (typeof raw.groupId !== 'string' || typeof raw.name !== 'string') return []
		if (!Array.isArray(raw.pluginIds)) return []
		return [
			{
				groupId: raw.groupId,
				name: raw.name,
				pluginIds: raw.pluginIds.filter((id): id is string => typeof id === 'string'),
			},
		]
	})
}

function clonePluginGroup(group: PluginGroupState): PluginGroupState {
	return { groupId: group.groupId, name: group.name, pluginIds: [...group.pluginIds] }
}

function cloneRecordOfArrays(input: Record<string, readonly string[]>): Record<string, string[]> {
	const out: Record<string, string[]> = Object.create(null)
	for (const [key, value] of Object.entries(input)) out[key] = [...value]
	return out
}

function cloneNestedRecord(
	input: Record<string, Readonly<Record<number, string>>>,
): Record<string, Record<number, string>> {
	const out: Record<string, Record<number, string>> = Object.create(null)
	for (const [key, value] of Object.entries(input)) {
		out[key] = Object.assign(Object.create(null), value)
	}
	return out
}

function freezeRecordOfArrays(
	input: Record<string, readonly string[]>,
): Readonly<Record<string, readonly string[]>> {
	const out: Record<string, readonly string[]> = Object.create(null)
	for (const [key, value] of Object.entries(input)) out[key] = Object.freeze([...value])
	return Object.freeze(out)
}

function freezeNestedRecord(
	input: Record<string, Readonly<Record<number, string>>>,
): Readonly<Record<string, Readonly<Record<number, string>>>> {
	const out: Record<string, Readonly<Record<number, string>>> = Object.create(null)
	for (const [key, value] of Object.entries(input)) {
		out[key] = Object.freeze(Object.assign(Object.create(null), value))
	}
	return Object.freeze(out)
}

function isMissingFileError(error: unknown): boolean {
	if (!error || typeof error !== 'object') return false
	if ('code' in error && (error as { code?: unknown }).code === 'ENOENT') return true
	if ('name' in error && (error as { name?: unknown }).name === 'FsError') {
		return 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
	}
	return false
}

function normalizeProfileName(raw: unknown): string | undefined {
	if (typeof raw !== 'string') return undefined
	const trimmed = raw.trim()
	if (!trimmed) return undefined
	const safe = trimmed
		// oxlint-disable-next-line eslint/no-control-regex -- intentionally strips ASCII control characters for safe filenames.
		.replaceAll(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
		.replaceAll(/\s+/g, '-')
		.replaceAll(/-+/g, '-')
		.replace(/^[-.]+/, '')
		.replace(/[-.]+$/, '')
	return safe || undefined
}
