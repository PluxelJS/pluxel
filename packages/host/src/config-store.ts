import {
	pluginNodeAddressEqual,
	pluginNodeIndexKey,
	type Context as PluxelContext,
	type PluginNodeAddress,
} from '@pluxel/core'
import {
	ConfigService as CoreConfigService,
	ConfigValidationError,
	validateConfigRecord,
	type PluginConfigRecordSnapshot,
} from '@pluxel/core/services'
import { immutableConfigRecord } from '@pluxel/core/internal'
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
} from './config-paths'
import {
	assertResolvedHostStoreStorage,
	type HostDocumentStorage,
	type HostStoreStorageOptions,
	type ResolvedHostStoreStorageOptions,
} from './document-storage'

type HostStoreMode = 'memory' | 'writable' | 'readonly'
export interface PluginConfigFile {
	version: 4
	plugins: readonly PluginConfigRecordSnapshot[]
}
export type HostConfigStoreOptions = HostStoreStorageOptions &
	Readonly<{
		/** Raw declaration records used when the saved document is absent. */
		records?: readonly PluginConfigRecordSnapshot[]
		/** Apply explicitly declared paths over saved records without changing the saved document. */
		override?: boolean
		overlays?: readonly HostConfigOverlay[]
		declarationSources?: readonly HostConfigDeclarationSource[]
	}>

export type HostConfigOverlay = PluginConfigRecordSnapshot &
	Readonly<{
		sources: readonly Readonly<{ path: readonly string[]; kind: 'env'; name: string }>[]
	}>
export type HostConfigDeclarationSource = Readonly<{
	owner: PluginNodeAddress
	path: readonly string[]
	kind: 'file'
	name: string
}>
export type HostConfigSource = Readonly<{
	owner: PluginNodeAddress
	path: readonly string[]
	kind: 'declaration' | 'file' | 'saved' | 'memory' | 'env'
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
	private internalMutation = false
	private unsubscribe?: () => void
	private readonly deferredRecords = new Set<string>()

	private readonly declarations: readonly PluginConfigRecordSnapshot[]
	private readonly declarationOverride: boolean
	private readonly overlays: readonly HostConfigOverlay[]
	private readonly declarationSources: readonly HostConfigDeclarationSource[]
	private managed: readonly PluginConfigRecordSnapshot[] = []
	private rawSource: 'declaration' | 'saved' | 'memory' = 'declaration'
	private readonly pendingManaged = new Map<
		string,
		{ owner: PluginNodeAddress; config: Readonly<Record<string, unknown>> }
	>()

	get isReadonly(): boolean {
		return this.readonlyMode
	}
	get storageMode(): HostStoreMode {
		return this.mode
	}
	get supportsExternalReload(): boolean {
		return this.mode !== 'memory' && typeof this.storage?.subscribe === 'function'
	}
	get isDeclarationOverride(): boolean {
		return this.declarationOverride
	}
	getDeclaredConfig(owner: PluginNodeAddress): Record<string, unknown> {
		return mergeRecord(
			undefined,
			this.declarations.find((record) => pluginNodeAddressEqual(record.owner, owner))?.config,
		)
	}
	getManagedRecords(): readonly PluginConfigRecordSnapshot[] {
		return mergeConfigRecords(undefined, this.managed)
	}

	override getRawConfig<T extends object = Record<string, unknown>>(
		owner: PluginNodeAddress,
	): Readonly<T> {
		if (this.deferredRecords.has(pluginNodeIndexKey(owner)))
			return SuperJSON.parse(SuperJSON.stringify(this.composeConfig(owner))) as Readonly<T>
		return super.getRawConfig<T>(owner)
	}

	/** Unknown saved owners enter Core only when their real declaration is admitted. */
	override async ensureValidated(
		owner: PluginNodeAddress,
		authority: Parameters<CoreConfigService['ensureValidated']>[1],
		options: Parameters<CoreConfigService['ensureValidated']>[2] = {},
	): Promise<Readonly<Record<string, unknown>>> {
		await this.ready
		const key = pluginNodeIndexKey(owner)
		if (!this.deferredRecords.has(key)) return super.ensureValidated(owner, authority, options)
		const expectedRevision = this.getConfigRevision(owner)
		const raw = this.composeConfig(owner)
		const input =
			Object.keys(raw).length === 0 && options.missingObjectDefault !== undefined
				? options.missingObjectDefault
				: raw
		const validation = await validateConfigRecord(
			authority.schema,
			input as Record<string, unknown>,
		)
		if (validation.ok === false)
			throw new ConfigValidationError('Plugin config validation failed.', validation.errors)
		const value = immutableConfigRecord(validation.output)
		this.internalMutation = true
		try {
			const ticket = super.stageValidatedConfig({ owner, authority, expectedRevision, value })
			const result = super.confirmValidatedConfig(ticket)
			this.deferredRecords.delete(key)
			return result
		} finally {
			this.internalMutation = false
		}
	}
	/** Called after the Host coordinator is installed. External loads never write back. */
	async observe(reload: () => Promise<void>): Promise<void> {
		if (this.mode === 'memory' || !this.storage) return
		const reloadAndReport = async () => {
			if (this.disposed) return
			try {
				await reload()
			} catch (error) {
				if (!this.disposed) this.ctx.logger.error('ConfigService external reload failed', { error })
			}
		}
		this.unsubscribe = this.storage.subscribe?.(() => {
			void reloadAndReport()
		})
		// A document can change while Host services prepare, before the subscription exists.
		await reloadAndReport()
	}

	stopObserving(): void {
		this.unsubscribe?.()
		this.unsubscribe = undefined
	}

	assertManagedMutation(): void {
		this.assertConfigMutable('config mutation')
	}

	async deleteManagedConfig(owner: PluginNodeAddress): Promise<void> {
		this.deleteConfig(owner)
		await this.flush()
	}

	async readExternal(): Promise<
		{ text: string | undefined; records: readonly PluginConfigRecordSnapshot[] } | undefined
	> {
		if (this.disposed || this.mode === 'memory' || !this.storage) return undefined
		const text = await this.storage.getText(this.file)
		if (ohash(text) === this.lastWrittenDigest) return undefined
		return { text, records: text === undefined ? [] : this.parseDocument(text) }
	}

	/** Internal complete-document commit. Validation is pinned and completed by config.ts first. */
	acceptExternal(
		document: { text: string | undefined; records: readonly PluginConfigRecordSnapshot[] },
		validated: readonly Parameters<CoreConfigService['stageValidatedConfig']>[0][],
		knownOwners: readonly PluginNodeAddress[],
	): readonly ReturnType<CoreConfigService['stageValidatedConfig']>[] {
		const { records } = document
		this.internalMutation = true
		let tickets: ReturnType<CoreConfigService['stageValidatedConfig']>[]
		try {
			tickets = validated.map((input) => super.stageValidatedConfig(input))
		} finally {
			this.internalMutation = false
		}
		const previous = this.managed
		this.managed = records
		this.rawSource = 'saved'
		const known = new Set(knownOwners.map(pluginNodeIndexKey))
		const changed = new Map(
			[...previous, ...records].map((record) => [pluginNodeIndexKey(record.owner), record.owner]),
		)
		this.internalMutation = true
		try {
			for (const [key, owner] of changed) {
				if (known.has(key)) continue
				const before =
					previous.find((record) => pluginNodeAddressEqual(record.owner, owner))?.config ?? {}
				const after = this.getManagedConfig(owner)
				if (ohash(before) !== ohash(after)) {
					super.deleteConfig(owner)
					this.deferredRecords.add(key)
				}
			}
			for (const ticket of tickets) {
				super.confirmValidatedConfig(ticket)
				this.deferredRecords.delete(pluginNodeIndexKey(ticket.owner))
			}
		} finally {
			this.internalMutation = false
		}
		this.lastWrittenDigest = ohash(document.text)
		return tickets
	}

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
		const declared = this.declarationOverride ? this.getDeclaredConfig(owner) : undefined
		const overlay = this.overlays.find((record) =>
			pluginNodeAddressEqual(record.owner, owner),
		)?.config
		return mergeRecord(mergeRecord(managed, declared), overlay)
	}

	getConfigSources(owner: PluginNodeAddress): readonly HostConfigSource[] {
		const declared = this.declarationOverride ? this.getDeclaredConfig(owner) : {}
		const declarationPaths = configLeafPaths(declared)
		const saved = this.getManagedConfig(owner)
		const overlay = this.overlays.find((record) => pluginNodeAddressEqual(record.owner, owner))
		const result: HostConfigSource[] = []
		for (const path of configLeafPaths(mergeRecord(saved, declared))) {
			if (overlay?.sources.some((source) => configPathsOverlap(source.path, path))) continue
			const overridden = declarationPaths.some((source) => configPathContains(source, path))
			const fromDeclaration = overridden || this.rawSource === 'declaration'
			const file =
				fromDeclaration &&
				this.declarationSources.find(
					(source) =>
						pluginNodeAddressEqual(source.owner, owner) && configPathContains(source.path, path),
				)
			result.push(
				Object.freeze({
					owner,
					path: Object.freeze(path),
					kind: fromDeclaration ? (file ? 'file' : 'declaration') : this.rawSource,
					readonly: this.isReadonly || overridden,
					...(file ? { name: file.name } : {}),
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
		const blocked = this.getConfigSources(owner).find(
			(source) => source.readonly && paths.some((path) => configPathsOverlap(path, source.path)),
		)
		if (blocked)
			throw new ConfigMutationRejectedError('config mutation', {
				path: blocked.path,
				source: blocked.name ?? 'declaration override',
				kind: blocked.kind === 'env' ? 'environment' : 'declaration',
			})
	}

	stageManagedConfig(
		input: Parameters<CoreConfigService['stageValidatedConfig']>[0] & {
			managed: Readonly<Record<string, unknown>>
			paths: readonly (readonly string[])[]
		},
	): ReturnType<CoreConfigService['stageValidatedConfig']> {
		this.assertManagedMutation()
		this.internalMutation = true
		let ticket: ReturnType<CoreConfigService['stageValidatedConfig']>
		try {
			this.assertPathsMutable(input.owner, input.paths)
			this.assertPathsMutable(
				input.owner,
				changedConfigPaths(this.getManagedConfig(input.owner), input.managed),
			)
			ticket = super.stageValidatedConfig(input)
		} finally {
			this.internalMutation = false
		}
		this.pendingManaged.set(pluginNodeIndexKey(input.owner), {
			owner: input.owner,
			config: mergeRecord(undefined, input.managed),
		})
		this.requestSave()
		return ticket
	}

	override stageValidatedConfig(
		input: Parameters<CoreConfigService['stageValidatedConfig']>[0],
	): ReturnType<CoreConfigService['stageValidatedConfig']> {
		this.assertPathsMutable(
			input.owner,
			changedConfigPaths(this.getRawConfig(input.owner), input.value),
		)
		throw new TypeError(
			'[HostConfigStore] Config staging requires explicit raw records; use host.config.patch/reset.',
		)
	}

	override confirmValidatedConfig(
		ticket: Parameters<CoreConfigService['confirmValidatedConfig']>[0],
	): Readonly<Record<string, unknown>> {
		const result = super.confirmValidatedConfig(ticket)
		const key = pluginNodeIndexKey(ticket.owner)
		const pending = this.pendingManaged.get(key)
		if (pending) {
			this.managed = mergeManagedRecord(this.managed, pending.owner, pending.config)
			if (this.mode === 'memory') this.rawSource = 'memory'
			this.pendingManaged.delete(key)
		}
		this.deferredRecords.delete(key)
		return result
	}

	override patchConfig<T extends object = Record<string, unknown>>(
		owner: PluginNodeAddress,
		patch: Partial<T>,
	): void {
		this.assertConfigMutable('patchConfig')
		this.assertPathsMutable(owner, configLeafPaths(patch as Record<string, unknown>))
		this.commitManaged(
			owner,
			mergeRecord(this.getManagedConfig(owner), patch as Record<string, unknown>),
		)
	}

	override unsetConfigKeys(owner: PluginNodeAddress, keys: readonly string[]): void {
		this.assertConfigMutable('unsetConfigKeys')
		this.assertPathsMutable(
			owner,
			keys.map((key) => [key]),
		)
		const next = this.getManagedConfig(owner)
		for (const key of keys) delete next[key]
		this.commitManaged(owner, next)
	}

	override deleteConfig(owner: PluginNodeAddress): boolean {
		this.assertConfigMutable('deleteConfig')
		this.assertPathsMutable(owner, [[]])
		const existed = this.managed.some((record) => pluginNodeAddressEqual(record.owner, owner))
		this.commitManaged(owner, {})
		return existed
	}

	private commitManaged(owner: PluginNodeAddress, value: Record<string, unknown>): void {
		// Core validates and freezes the effective value before accepting the management layer.
		this.replaceRecord(owner, this.composeConfig(owner, value))
		this.managed = mergeManagedRecord(this.managed, owner, value)
		if (this.mode === 'memory') this.rawSource = 'memory'
		this.pendingManaged.delete(pluginNodeIndexKey(owner))
		this.requestSave()
	}

	private replaceLayers(): void {
		this.replaceConfigRecords(
			mergeConfigRecords(
				mergeConfigRecords(this.managed, this.declarationOverride ? this.declarations : undefined),
				this.overlays,
			),
		)
	}

	constructor(
		ctx: PluxelContext,
		options: Omit<HostConfigStoreOptions, 'storage' | 'mode'> &
			ResolvedHostStoreStorageOptions = {},
	) {
		super(ctx)
		assertResolvedHostStoreStorage(options)
		this.mode = options.mode ?? (options.storage ? 'writable' : 'memory')
		this.readonlyMode = this.mode === 'readonly'
		this.storage = options.storage
		if (this.mode !== 'memory' && !this.storage)
			throw new TypeError('[host] persistent config requires document storage')
		this.declarations = mergeConfigRecords(
			undefined,
			coercePluginConfigRecords(options.records ?? []),
		)
		this.declarationOverride = options.override ?? false
		this.managed = mergeConfigRecords(undefined, this.declarations)
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
		this.declarationSources = (options.declarationSources ?? []).map((source) => {
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
		if (!this.isReady)
			throw new Error(`[ConfigService] ${action} requires a successfully loaded config document.`)
		if (this.disposed) throw new Error(`[ConfigService] ${action} is disabled after dispose.`)
		if (this.internalMutation) return
		if (!this.readonlyMode) return
		throw new ConfigMutationRejectedError(action)
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
		if (this.internalMutation) return
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
		this.lastWrittenDigest = ohash(text)
		if (text === undefined) {
			if (!this.readonlyMode) await this.saveToDisk()
			return
		}

		this.managed = this.parseDocument(text)
		this.rawSource = 'saved'
		this.replaceLayers()
	}

	private parseDocument(text: string): PluginConfigRecordSnapshot[] {
		try {
			const value = SuperJSON.parse(text) as unknown
			if (!value || typeof value !== 'object' || Array.isArray(value))
				throw new Error('persisted config must be an object')
			const parsed = value as Record<string, unknown>
			if (parsed.version !== 4)
				throw new Error(
					`unsupported persisted config version: ${String(parsed.version)}; expected 4`,
				)
			return coercePluginConfigRecords(parsed.plugins)
		} catch (cause) {
			const reason = cause instanceof Error ? cause.message : String(cause)
			throw new Error(
				`[ConfigService] Cannot load ${this.file}: ${reason}. Existing document unchanged; repair or restore it before restarting.`,
				{ cause },
			)
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
			version: 4,
			plugins: [...this.pendingManaged.values()].reduce(
				(records, record) => mergeManagedRecord(records, record.owner, record.config),
				this.managed,
			),
		} satisfies PluginConfigFile)
		const nextDigest = ohash(content)
		if (nextDigest === this.lastWrittenDigest && (await this.storage!.stat(this.file))) return

		const task = this.storage!.put(this.file, content).then((): undefined => {
			this.lastWrittenDigest = nextDigest
			this.rawSource = 'saved'
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
			this.stopObserving()
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
