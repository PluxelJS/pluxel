import {
	pluginNodeAddressEqual,
	pluginNodeIndexKey,
	type Context as PluxelContext,
	type PluginNodeAddress,
} from '@pluxel/core'
import {
	ConfigService as CoreConfigService,
	type PluginConfigRecordSnapshot,
} from '@pluxel/core/services'
import { hash as ohash } from 'ohash'
import { SuperJSON } from 'superjson'
import { ConfigMutationRejectedError } from './config'
import { coercePluginConfigRecords, mergeConfigRecords, mergeRecord } from './config-records'
import {
	configLeafPaths,
	configPathsOverlap,
	configPathContains,
	configHasPath,
	changedConfigPaths,
	copyConfigPath,
} from './config-paths'
import {
	assertHostStoreStorage,
	type HostDocumentStorage,
	type HostStoreStorageOptions,
} from './document-storage'

type HostStoreMode = 'memory' | 'writable' | 'readonly'
export interface PluginConfigFile {
	version: 3
	plugins: readonly PluginConfigRecordSnapshot[]
}
export type HostConfigStoreOptions = HostStoreStorageOptions &
	Readonly<{
		/** Base records below management saves and environment overlays. Never persisted by this store. */
		initial?: readonly PluginConfigRecordSnapshot[]
		overlays?: readonly HostConfigOverlay[]
		baseSources?: readonly HostConfigBaseSource[]
	}>

export type HostConfigOverlay = PluginConfigRecordSnapshot &
	Readonly<{
		sources: readonly Readonly<{ path: readonly string[]; kind: 'env'; name: string }>[]
	}>
export type HostConfigBaseSource = Readonly<{
	owner: PluginNodeAddress
	path: readonly string[]
	kind: 'file'
	name: string
}>
export type HostConfigSource = Readonly<{
	owner: PluginNodeAddress
	path: readonly string[]
	kind: 'base' | 'file' | 'saved' | 'env'
	readonly: boolean
	name?: string
}>

/** Persistent runtime adapter over core's single config state and validation engine. */
export class HostConfigStore extends CoreConfigService {
	private readonly file = 'config.json'
	private readonly saveDelayMs = 200
	private saveTimer: ReturnType<typeof setTimeout> | null = null
	private saveScheduled = false
	private saveInFlight: Promise<void> | null = null
	private saveAgain = false
	private lastWrittenDigest: string | undefined
	private disposed = false
	private closing?: Promise<void>
	private batching = 0
	private pendingSave = false
	private readonly mode: HostStoreMode
	private readonly readonlyMode: boolean
	private readonly storage: HostDocumentStorage | undefined

	private readonly base: readonly PluginConfigRecordSnapshot[]
	private readonly overlays: readonly HostConfigOverlay[]
	private readonly baseSources: readonly HostConfigBaseSource[]
	private managed: readonly PluginConfigRecordSnapshot[] = []
	private readonly pendingManaged = new Map<
		string,
		{ owner: PluginNodeAddress; config: Readonly<Record<string, unknown>> }
	>()

	getManagedConfig(owner: PluginNodeAddress): Record<string, unknown> {
		return mergeRecord(
			undefined,
			this.managed.find((record) => pluginNodeAddressEqual(record.owner, owner))?.config,
		)
	}

	composeConfig(
		owner: PluginNodeAddress,
		managed = this.getManagedConfig(owner),
	): Record<string, unknown> {
		const base = this.base.find((record) => pluginNodeAddressEqual(record.owner, owner))?.config
		const overlay = this.overlays.find((record) =>
			pluginNodeAddressEqual(record.owner, owner),
		)?.config
		return mergeRecord(mergeRecord(base, managed), overlay)
	}

	getConfigSources(owner: PluginNodeAddress): readonly HostConfigSource[] {
		const base =
			this.base.find((record) => pluginNodeAddressEqual(record.owner, owner))?.config ?? {}
		const saved = this.getManagedConfig(owner)
		const overlay = this.overlays.find((record) => pluginNodeAddressEqual(record.owner, owner))
		const paths = configLeafPaths(mergeRecord(base, saved))
		const result: HostConfigSource[] = []
		for (const path of paths) {
			if (overlay?.sources.some((source) => configPathsOverlap(source.path, path))) continue
			const fromSaved = configHasPath(saved, path)
			const file = this.baseSources.find(
				(source) =>
					pluginNodeAddressEqual(source.owner, owner) && configPathContains(source.path, path),
			)
			result.push(
				Object.freeze({
					owner,
					path: Object.freeze(path),
					kind: fromSaved ? 'saved' : file ? 'file' : 'base',
					readonly: this.readonlyMode,
					...(!fromSaved && file ? { name: file.name } : {}),
				}),
			)
		}
		for (const source of overlay?.sources ?? [])
			result.push(
				Object.freeze({ owner, ...source, path: Object.freeze([...source.path]), readonly: true }),
			)
		return Object.freeze(result)
	}

	assertPathsMutable(owner: PluginNodeAddress, paths: readonly (readonly string[])[]): void {
		this.assertConfigMutable('config mutation')
		for (const overlay of this.overlays) {
			if (!pluginNodeAddressEqual(overlay.owner, owner)) continue
			const blocked = overlay.sources.find((source) =>
				paths.some((path) => configPathsOverlap(path, source.path)),
			)
			if (blocked)
				throw new ConfigMutationRejectedError('config mutation', {
					path: blocked.path,
					source: blocked.name,
				})
		}
	}

	stageManagedConfig(
		input: Parameters<CoreConfigService['stageValidatedConfig']>[0] & {
			managed: Readonly<Record<string, unknown>>
			paths: readonly (readonly string[])[]
		},
	): ReturnType<CoreConfigService['stageValidatedConfig']> {
		this.assertPathsMutable(input.owner, input.paths)
		this.assertPathsMutable(
			input.owner,
			changedConfigPaths(this.getManagedConfig(input.owner), input.managed),
		)
		const ticket = super.stageValidatedConfig(input)
		this.pendingManaged.set(pluginNodeIndexKey(input.owner), {
			owner: input.owner,
			config: mergeRecord(undefined, input.managed),
		})
		return ticket
	}

	override stageValidatedConfig(
		input: Parameters<CoreConfigService['stageValidatedConfig']>[0],
	): ReturnType<CoreConfigService['stageValidatedConfig']> {
		const current = this.getRawConfig(input.owner)
		const paths = changedConfigPaths(current, input.value)
		const managed = this.getManagedConfig(input.owner)
		for (const path of paths) copyConfigPath(managed, input.value, path)
		return this.stageManagedConfig({ ...input, managed, paths })
	}

	override confirmValidatedConfig(
		ticket: Parameters<CoreConfigService['confirmValidatedConfig']>[0],
	): Readonly<Record<string, unknown>> {
		const result = super.confirmValidatedConfig(ticket)
		const key = pluginNodeIndexKey(ticket.owner)
		const pending = this.pendingManaged.get(key)
		if (pending) {
			this.managed = mergeManagedRecord(this.managed, pending.owner, pending.config)
			this.pendingManaged.delete(key)
		}
		return result
	}

	override patchConfig<T extends object = Record<string, unknown>>(
		owner: PluginNodeAddress,
		patch: Partial<T>,
	): void {
		this.assertPathsMutable(owner, configLeafPaths(patch as Record<string, unknown>))
		this.commitManaged(
			owner,
			mergeRecord(this.getManagedConfig(owner), patch as Record<string, unknown>),
		)
	}

	override unsetConfigKeys(owner: PluginNodeAddress, keys: readonly string[]): void {
		this.assertPathsMutable(
			owner,
			keys.map((key) => [key]),
		)
		const next = this.getManagedConfig(owner)
		for (const key of keys) delete next[key]
		this.commitManaged(owner, next)
	}

	override deleteConfig(owner: PluginNodeAddress): boolean {
		this.assertPathsMutable(owner, [[]])
		const existed = this.managed.some((record) => pluginNodeAddressEqual(record.owner, owner))
		this.commitManaged(owner, {})
		return existed
	}

	private commitManaged(owner: PluginNodeAddress, value: Record<string, unknown>): void {
		// Core validates and freezes the effective value before accepting the management layer.
		this.replaceRecord(owner, this.composeConfig(owner, value))
		this.managed = mergeManagedRecord(this.managed, owner, value)
		this.pendingManaged.delete(pluginNodeIndexKey(owner))
	}

	private replaceLayers(): void {
		this.replaceConfigRecords(
			mergeConfigRecords(mergeConfigRecords(this.base, this.managed), this.overlays),
		)
	}

	constructor(ctx: PluxelContext, options: HostConfigStoreOptions = {}) {
		super(ctx)
		assertHostStoreStorage(options)
		this.mode = options.mode ?? (options.storage ? 'writable' : 'memory')
		this.readonlyMode = this.mode === 'readonly'
		this.storage = options.storage
		if (this.mode !== 'memory' && !this.storage)
			throw new TypeError('[host] persistent config requires document storage')
		this.base = mergeConfigRecords(undefined, coercePluginConfigRecords(options.initial ?? []))
		const overlayRecords = coercePluginConfigRecords(options.overlays ?? [])
		this.overlays = overlayRecords.map((record, index) => {
			const config = mergeRecord(undefined, record.config)
			const sources = options.overlays![index]!.sources.map((source) => {
				assertSourcePath(source.path)
				if (
					source.kind !== 'env' ||
					typeof source.name !== 'string' ||
					!/^[A-Z_][A-Z0-9_]*$/.test(source.name)
				)
					throw new TypeError('[host] invalid config environment source')
				if (!configHasPath(config, source.path))
					throw new TypeError('[host] config environment source must refer to a present value')
				return { path: Object.freeze([...source.path]), kind: 'env' as const, name: source.name }
			})
			if (
				configLeafPaths(config).some(
					(path) => !sources.some((source) => configPathContains(source.path, path)),
				)
			)
				throw new TypeError('[host] every environment overlay value requires source metadata')
			return { owner: record.owner, config, sources }
		})
		this.baseSources = (options.baseSources ?? []).map((source) => {
			assertSourcePath(source.path)
			return {
				owner: source.owner,
				kind: 'file',
				name: source.name,
				path: Object.freeze([...source.path]),
			}
		})
		this.replaceLayers()
		if (this.mode !== 'memory') this.setReadyTask(this.loadFromDisk())
		ctx.effects.defer(() => this.dispose(), { tag: 'HostConfigStore' })
	}

	protected override assertConfigMutable(action: string): void {
		if (this.disposed) throw new Error(`[ConfigService] ${action} is disabled after dispose.`)
		if (!this.readonlyMode) return
		throw new ConfigMutationRejectedError(action)
	}

	protected override onConfigChanged(_owner: PluginNodeAddress): void {
		this.requestSave()
	}

	override batch(run: () => void): void {
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
	}

	private requestSave(): void {
		if (this.mode !== 'writable' || this.disposed) return
		if (this.batching > 0) {
			this.pendingSave = true
			return
		}
		this.scheduleSave()
	}

	private scheduleSave(): void {
		if (this.disposed) return
		this.saveScheduled = true
		if (this.saveTimer) return
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null
			if (!this.saveScheduled) return
			this.saveScheduled = false
			void this.saveToDisk().catch((error: unknown) => {
				this.saveScheduled = true
				this.ctx.logger.error('ConfigService background save failed', { error })
			})
		}, this.saveDelayMs)
	}

	private cancelScheduledSave(): void {
		this.saveScheduled = false
		if (!this.saveTimer) return
		clearTimeout(this.saveTimer)
		this.saveTimer = null
	}

	/** Flush pending disk writes. Use force while disposing inside a batch. */
	override async flush(options: { force?: boolean } = {}): Promise<void> {
		if (this.mode !== 'writable') return
		try {
			const hadScheduled = this.saveScheduled || this.saveTimer !== null
			this.cancelScheduledSave()
			if (this.saveInFlight) await this.saveInFlight
			if (!hadScheduled && !this.pendingSave) return
			this.pendingSave = false
			await this.saveToDisk({ force: options.force })
		} catch (error) {
			this.saveScheduled = true
			throw error
		}
	}

	private async loadFromDisk(): Promise<void> {
		const text = await this.storage!.getText(this.file)
		if (text === undefined) {
			if (!this.readonlyMode) await this.saveToDisk()
			return
		}

		this.lastWrittenDigest = ohash(text)
		let parsed: Record<string, unknown>
		try {
			const value = SuperJSON.parse(text) as unknown
			if (!value || typeof value !== 'object' || Array.isArray(value)) {
				throw new Error('persisted config must be an object')
			}
			parsed = value as Record<string, unknown>
		} catch (error) {
			if (this.readonlyMode) {
				throw new Error('[ConfigService] Persisted readonly config is malformed.', {
					cause: error,
				})
			}
			this.ctx.logger.warn('ConfigService parse failed; isolating broken config', {
				file: this.file,
				error,
			})
			await this.isolateBrokenConfigFile(text)
			this.managed = []
			this.replaceLayers()
			await this.saveToDisk()
			return
		}

		if (parsed.version !== 3) {
			throw new Error(
				`[ConfigService] Unsupported persisted config version: ${String(parsed.version)}`,
			)
		}
		this.managed = coercePluginConfigRecords(parsed.plugins)
		this.replaceLayers()
	}

	private async isolateBrokenConfigFile(content: string): Promise<void> {
		const safeTs = new Date().toISOString().replaceAll(/[:.]/g, '-')
		const brokenFile = `${this.file}.broken.${safeTs}`
		try {
			await this.storage!.put(brokenFile, content)
		} catch (error) {
			this.ctx.logger.warn('failed to isolate broken config file', {
				file: this.file,
				brokenFile,
				error,
			})
		}
	}

	private async saveToDisk(options: { force?: boolean } = {}): Promise<void> {
		if (!options.force && this.batching > 0) return

		if (this.saveInFlight) {
			this.saveAgain = true
			await this.saveInFlight
			if (this.saveAgain) {
				this.saveAgain = false
				await this.saveToDisk(options)
			}
			return
		}

		const content = SuperJSON.stringify({
			version: 3,
			plugins: [...this.pendingManaged.values()].reduce(
				(records, record) => mergeManagedRecord(records, record.owner, record.config),
				this.managed,
			),
		} satisfies PluginConfigFile)
		const nextDigest = ohash(content)
		if (nextDigest === this.lastWrittenDigest && (await this.storage!.stat(this.file))) return

		const task = this.storage!.put(this.file, content, { atomic: true }).then((): undefined => {
			this.lastWrittenDigest = nextDigest
			return undefined
		})
		this.saveInFlight = task.finally(() => {
			this.saveInFlight = null
		})
		await this.saveInFlight

		if (this.saveAgain) {
			this.saveAgain = false
			await this.saveToDisk(options)
		}
	}

	dispose(): Promise<void> {
		return (this.closing ??= (async () => {
			this.disposed = true
			try {
				await this.ready
			} catch {
				/* Preparation reports its original failure. */
			}
			await this.flush({ force: true })
		})())
	}
}

function mergeManagedRecord(
	records: readonly PluginConfigRecordSnapshot[],
	owner: PluginNodeAddress,
	config: Readonly<Record<string, unknown>>,
): readonly PluginConfigRecordSnapshot[] {
	return [
		...records.filter((record) => !pluginNodeAddressEqual(record.owner, owner)),
		...(Object.keys(config).length > 0 ? [{ owner, config: mergeRecord(undefined, config) }] : []),
	]
}

function assertSourcePath(path: readonly string[]): void {
	if (
		!Array.isArray(path) ||
		path.some(
			(part) =>
				typeof part !== 'string' ||
				!part ||
				['__proto__', 'constructor', 'prototype'].includes(part),
		)
	)
		throw new TypeError('[host] invalid config source path')
}
