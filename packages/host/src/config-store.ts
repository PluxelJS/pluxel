import {
	pluginNodeAddressEqual,
	pluginNodeIndexKey,
	type Context,
	type PluginNodeAddress,
} from '@pluxel/core'
import {
	ConfigService,
	ConfigValidationError,
	validateConfigRecord,
	type PluginConfigRecordSnapshot,
} from '@pluxel/core/services'
import { immutableConfigRecord } from '@pluxel/core/internal'
import { hash } from 'ohash'
import { SuperJSON } from 'superjson'
import { ConfigMutationRejectedError } from './config'
import {
	coercePluginConfigRecords,
	configProvenance,
	mergeRecord,
	snapshotConfigInput,
	snapshotHostConfig,
	type HostConfigOptions,
} from './config-records'
import {
	configLeafPaths,
	configHasPath,
	configPathContains,
	configPathsOverlap,
} from './config-paths'
import {
	assertResolvedHostStoreStorage,
	type ResolvedHostStoreStorageOptions,
} from './document-storage'
import type { HostInputMode } from './input-mode'
import type { HostPersistenceRetention } from './persistence'

export interface PluginConfigFile {
	version: 4
	plugins: readonly PluginConfigRecordSnapshot[]
}
export type HostConfigSource = Readonly<{
	owner: PluginNodeAddress
	path: readonly string[]
	kind: 'declaration' | 'file' | 'saved' | 'memory' | 'env'
	readonly: boolean
	name?: string
}>
type Validation = Parameters<ConfigService['stageValidatedConfig']>[0]
export type ManagedConfigTransaction = Readonly<{
	validation: Validation
	managed: Readonly<Record<string, unknown>> | null
	effective: Readonly<Record<string, unknown>>
	changed: boolean
	desiredChanged: boolean
}>

/** Host owns raw inputs; Core owns the sole validated output and generation revisions. */
export class HostConfigStore extends ConfigService {
	private readonly file = 'config.json'
	private readonly options: ReturnType<typeof snapshotHostConfig>
	private managed: readonly PluginConfigRecordSnapshot[] = []
	private readonly instance = globalThis.crypto.randomUUID()
	private managedSequence = 0
	private readonly inputDigests = new Map<string, string>()
	private pending?: ManagedConfigTransaction
	private saving?: Promise<void>
	private disposed = false
	private closing?: Promise<void>
	private internalMutation = false
	private lastWrittenDigest?: string
	private unsubscribe?: () => void
	readonly retention: HostPersistenceRetention

	constructor(
		ctx: Context,
		options: HostConfigOptions = {},
		private readonly documents: ResolvedHostStoreStorageOptions = {},
	) {
		super(ctx)
		assertResolvedHostStoreStorage(documents)
		this.options = snapshotHostConfig(options)
		this.retention = documents.retention ?? (documents.storage ? 'unknown' : 'session')
		if (documents.storage) this.setReadyTask(this.load())
		ctx.effects.defer(() => this.dispose(), { tag: 'HostConfigStore' })
	}
	get isReadonly(): boolean {
		return this.documents.readOnly ?? false
	}
	get supportsExternalReload(): boolean {
		return typeof this.documents.storage?.subscribe === 'function'
	}
	get managedRevision(): string {
		return `config:${this.instance}:${this.managedSequence}`
	}
	getMode(owner: PluginNodeAddress): HostInputMode {
		return (
			this.options.records.find((entry) => pluginNodeAddressEqual(entry.owner, owner))?.mode ??
			this.options.mode
		)
	}
	getDeclaredConfig(owner: PluginNodeAddress): Record<string, unknown> {
		return mergeRecord(
			undefined,
			this.options.records.find((entry) => pluginNodeAddressEqual(entry.owner, owner))?.config,
		)
	}
	getManagedRecords(): readonly PluginConfigRecordSnapshot[] {
		return this.managed
	}
	getManagedInput(owner: PluginNodeAddress): Readonly<Record<string, unknown>> | null {
		return this.managed.find((entry) => pluginNodeAddressEqual(entry.owner, owner))?.config ?? null
	}
	getManagedConfig(owner: PluginNodeAddress): Record<string, unknown> {
		return mergeRecord(undefined, this.getManagedInput(owner) ?? undefined)
	}
	composeConfig(
		owner: PluginNodeAddress,
		managed: Readonly<Record<string, unknown>> | null = this.getManagedInput(owner),
	): Record<string, unknown> {
		const declared = this.getDeclaredConfig(owner)
		const mode = this.getMode(owner)
		return mode === 'declared-only'
			? declared
			: mode === 'declared-first'
				? mergeRecord(managed ?? undefined, declared)
				: mergeRecord(declared, managed ?? undefined)
	}
	override getRawConfig<T extends object = Record<string, unknown>>(
		owner: PluginNodeAddress,
	): Readonly<T> {
		return (
			this.inputDigests.has(pluginNodeIndexKey(owner))
				? super.getRawConfig(owner)
				: snapshotConfigInput(this.composeConfig(owner))
		) as Readonly<T>
	}
	/** Cache against effective input AND immutable definition facts, never schema output as input. */
	async validateEffective(
		owner: PluginNodeAddress,
		authority: Validation['authority'],
		effective: Readonly<Record<string, unknown>>,
	) {
		const cached = this.tryGetValidatedConfig(owner, authority)
		if (cached && this.inputDigests.get(pluginNodeIndexKey(owner)) === hash(effective))
			return { ok: true as const, output: cached }
		return validateConfigRecord(authority.schema, effective)
	}
	override async ensureValidated(
		owner: PluginNodeAddress,
		authority: Validation['authority'],
		_options: { missingObjectDefault?: unknown } = {},
	): Promise<Readonly<Record<string, unknown>>> {
		await this.ready
		const effective = this.composeConfig(owner)
		const result = await this.validateEffective(owner, authority, effective)
		if (result.ok === false)
			throw new ConfigValidationError('Plugin config validation failed.', result.errors)
		if (
			this.tryGetValidatedConfig(owner, authority) &&
			this.inputDigests.get(pluginNodeIndexKey(owner)) === hash(effective)
		)
			return result.output
		return this.publish(
			{ owner, authority, expectedRevision: this.getConfigRevision(owner), value: result.output },
			effective,
		)
	}
	private publish(
		validation: Validation,
		effective: Readonly<Record<string, unknown>>,
	): Readonly<Record<string, unknown>> {
		this.internalMutation = true
		try {
			const ticket = super.stageValidatedConfig(validation)
			const result = super.confirmValidatedConfig(ticket)
			this.inputDigests.set(pluginNodeIndexKey(validation.owner), hash(effective))
			return result
		} finally {
			this.internalMutation = false
		}
	}
	getConfigSources(
		owner: PluginNodeAddress,
		managed: Readonly<Record<string, unknown>> | null = this.getManagedInput(owner),
	): readonly HostConfigSource[] {
		const mode = this.getMode(owner)
		const declared = this.getDeclaredConfig(owner)
		const effective = this.composeConfig(owner, managed)
		const facts = configProvenance(this.options).sources.filter((source) =>
			pluginNodeAddressEqual(source.owner, owner),
		)
		return Object.freeze(
			configLeafPaths(effective).map((path) => {
				const fromSaved =
					mode !== 'declared-only' &&
					configHasPath(managed ?? {}, path) &&
					(mode === 'saved-first' || !configHasPath(declared, path))
				const source = fromSaved
					? undefined
					: facts.toReversed().find((fact) => configPathContains(fact.path, path))
				return Object.freeze({
					owner,
					path: Object.freeze(path),
					kind: fromSaved
						? this.documents.storage
							? ('saved' as const)
							: ('memory' as const)
						: (source?.kind ?? ('declaration' as const)),
					readonly: this.isReadonly,
					...(source ? { name: source.name } : {}),
				})
			}),
		)
	}
	getShadowedPaths(
		owner: PluginNodeAddress,
		managed: Readonly<Record<string, unknown>> | null = this.getManagedInput(owner),
	): readonly (readonly string[])[] {
		const sources = this.getConfigSources(owner, managed)
		return Object.freeze(
			configLeafPaths(managed ?? {})
				.filter(
					(path) =>
						!sources.some(
							(source) =>
								['saved', 'memory'].includes(source.kind) && configPathsOverlap(source.path, path),
						),
				)
				.map((path) => Object.freeze(path)),
		)
	}
	assertManagedMutation(): void {
		this.assertConfigMutable('config mutation')
	}
	protected override assertConfigMutable(action: string): void {
		if (this.internalMutation) return
		if (!this.isReady)
			throw new Error(`[ConfigService] ${action} requires a successfully loaded config document.`)
		if (this.disposed) throw new Error(`[ConfigService] ${action} is disabled after dispose.`)
		if (this.isReadonly) throw new ConfigMutationRejectedError(action)
	}
	stageManagedConfig(
		input: Validation & { managed: Readonly<Record<string, unknown>> | null },
	): ManagedConfigTransaction {
		this.assertManagedMutation()
		if (this.pending) throw new Error('[HostConfigStore] Another raw config transaction is pending')
		const managed = input.managed === null ? null : snapshotConfigInput(input.managed)
		const effective = snapshotConfigInput(this.composeConfig(input.owner, managed))
		const current = this.getManagedInput(input.owner)
		const transaction = Object.freeze({
			validation: {
				owner: input.owner,
				authority: input.authority,
				expectedRevision: input.expectedRevision,
				value: immutableConfigRecord(input.value),
			},
			managed,
			effective,
			changed: hash(current) !== hash(managed),
			desiredChanged:
				!this.tryGetValidatedConfig(input.owner, input.authority) ||
				this.inputDigests.get(pluginNodeIndexKey(input.owner)) !== hash(effective),
		})
		this.pending = transaction
		return transaction
	}
	confirmManagedConfig(transaction: ManagedConfigTransaction): Readonly<Record<string, unknown>> {
		if (this.pending !== transaction)
			throw new Error('[HostConfigStore] Raw config transaction is stale')
		const output = transaction.desiredChanged
			? this.publish(transaction.validation, transaction.effective)
			: this.getRawConfig(transaction.validation.owner)
		if (transaction.changed) {
			this.managed = replaceManaged(this.managed, transaction.validation.owner, transaction.managed)
			this.managedSequence++
		}
		this.pending = undefined
		return output
	}
	discardManagedConfig(transaction: ManagedConfigTransaction): void {
		if (this.pending === transaction) this.pending = undefined
	}
	override async flush(): Promise<void> {
		if (this.saving) await this.saving
		if (!this.pending?.changed || !this.documents.storage) return
		await this.write(
			replaceManaged(this.managed, this.pending.validation.owner, this.pending.managed),
		)
	}
	private async write(records: readonly PluginConfigRecordSnapshot[]): Promise<void> {
		if (!this.documents.storage) return
		const content = SuperJSON.stringify({ version: 4, plugins: records } satisfies PluginConfigFile)
		const task = this.documents.storage.put(this.file, content).then((): undefined => {
			this.lastWrittenDigest = hash(content)
			return undefined
		})
		this.saving = task
		try {
			await task
		} finally {
			if (this.saving === task) this.saving = undefined
		}
	}
	async deleteManagedConfig(owner: PluginNodeAddress): Promise<void> {
		this.assertManagedMutation()
		if (this.getManagedInput(owner) === null) return
		const next = replaceManaged(this.managed, owner, null)
		await this.write(next)
		this.managed = next
		this.managedSequence++
		this.internalMutation = true
		try {
			super.deleteConfig(owner)
			this.inputDigests.delete(pluginNodeIndexKey(owner))
		} finally {
			this.internalMutation = false
		}
	}
	override stageValidatedConfig(_input: Validation): never {
		this.assertManagedMutation()
		throw new TypeError('[HostConfigStore] Use host.config.patch/reset for raw input transactions.')
	}
	override patchConfig<T extends object = Record<string, unknown>>(
		_owner: PluginNodeAddress,
		_patch: Partial<T>,
	): never {
		this.assertManagedMutation()
		throw new TypeError('[HostConfigStore] Use host.config.patch/reset for raw input transactions.')
	}
	override unsetConfigKeys(_owner: PluginNodeAddress, _keys: readonly string[]): never {
		this.assertManagedMutation()
		throw new TypeError('[HostConfigStore] Use host.config.patch/reset for raw input transactions.')
	}
	override deleteConfig(_owner: PluginNodeAddress): never {
		this.assertManagedMutation()
		throw new TypeError('[HostConfigStore] Use host.config.reset for raw input transactions.')
	}
	private async load(): Promise<void> {
		const text = await this.documents.storage!.getText(this.file)
		this.lastWrittenDigest = hash(text)
		if (text !== undefined) this.managed = this.parseDocument(text)
	}
	private parseDocument(text: string): readonly PluginConfigRecordSnapshot[] {
		try {
			const value = SuperJSON.parse(text) as { version?: unknown; plugins?: unknown }
			if (!value || typeof value !== 'object' || Array.isArray(value))
				throw new Error('persisted config must be an object')
			if (value.version !== 4)
				throw new Error(
					`unsupported persisted config version: ${String(value.version)}; expected 4`,
				)
			return Object.freeze(coercePluginConfigRecords(value.plugins))
		} catch (cause) {
			throw new Error(
				`[ConfigService] Cannot load ${this.file}: ${cause instanceof Error ? cause.message : String(cause)}. Existing document unchanged; repair or restore it before restarting.`,
				{ cause },
			)
		}
	}
	async observe(reload: () => Promise<void>): Promise<void> {
		if (!this.documents.storage) return
		const observe = async () => {
			if (this.disposed) return
			try {
				await reload()
			} catch (error) {
				if (!this.disposed) this.ctx.logger.error('ConfigService external reload failed', { error })
			}
		}
		this.unsubscribe = this.documents.storage.subscribe?.(() => {
			void observe()
		})
		await observe()
	}
	stopObserving(): void {
		this.unsubscribe?.()
		this.unsubscribe = undefined
	}
	async readExternal(): Promise<
		{ text: string | undefined; records: readonly PluginConfigRecordSnapshot[] } | undefined
	> {
		if (this.disposed || !this.documents.storage) return undefined
		const text = await this.documents.storage.getText(this.file)
		if (hash(text) === this.lastWrittenDigest) return undefined
		return { text, records: text === undefined ? [] : this.parseDocument(text) }
	}
	acceptExternal(
		document: { text: string | undefined; records: readonly PluginConfigRecordSnapshot[] },
		validated: readonly (Validation & { effective: Readonly<Record<string, unknown>> })[],
	): readonly {
		owner: PluginNodeAddress
		snapshot: Readonly<Record<string, unknown>>
		revision: number
	}[] {
		const updates = validated.map((entry) => ({
			owner: entry.owner,
			snapshot: this.publish(entry, entry.effective),
			revision: this.getConfigRevision(entry.owner),
		}))
		if (hash(this.managed) !== hash(document.records)) {
			this.managed = document.records
			this.managedSequence++
		}
		this.lastWrittenDigest = hash(document.text)
		return updates
	}
	dispose(): Promise<void> {
		return (this.closing ??= (async () => {
			this.disposed = true
			this.stopObserving()
			try {
				await this.ready
			} catch {
				/* preparation owns the original failure */
			}
			if (this.saving) await this.saving
		})())
	}
}
function replaceManaged(
	records: readonly PluginConfigRecordSnapshot[],
	owner: PluginNodeAddress,
	config: Readonly<Record<string, unknown>> | null,
): readonly PluginConfigRecordSnapshot[] {
	return Object.freeze([
		...records.filter((record) => !pluginNodeAddressEqual(record.owner, owner)),
		...(config === null ? [] : [Object.freeze({ owner, config })]),
	])
}
