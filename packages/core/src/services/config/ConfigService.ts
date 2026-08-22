import { type Context as PluxelContext, RootService } from '@pluxel/context'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { pluginNodeIndexKey, type PluginNodeAddress } from '../../plugins/runtime/identity'
import { safeParseStandardSchema } from './standardSchema'
import { ConfigValidationError, type ConfigValidationErrors } from './types'
import { immutableConfigRecord } from './immutable'

type ConfigRecord = Record<string, unknown>
type ConfigEntry = { owner: PluginNodeAddress; config: ConfigRecord }
const EMPTY_CONFIG: Readonly<ConfigRecord> = Object.freeze(Object.create(null))
const serviceName = 'configService' as const

/** Immutable candidate fact whose object identity binds one validation result. */
export type PluginConfigValidationAuthority = Readonly<{
	schema: StandardSchemaV1
}>

export type PluginConfigRecordSnapshot = Readonly<{
	owner: PluginNodeAddress
	config: Readonly<ConfigRecord>
}>

/** Opaque revision-bound candidate awaiting durable persistence confirmation. */
export type StagedPluginConfigValidation = Readonly<{
	owner: PluginNodeAddress
	authority: PluginConfigValidationAuthority
	revision: number
	snapshot: Readonly<ConfigRecord>
}>

export class ConfigValidationPendingPersistenceError extends Error {
	constructor() {
		super('[ConfigService] Validated config is awaiting durable persistence confirmation.')
		this.name = 'ConfigValidationPendingPersistenceError'
	}
}

/** One complete object config record per canonical Plugin node address. */
@RootService({ key: serviceName })
export class ConfigService {
	private readonly records = new Map<string, ConfigEntry>()
	private readonly rawViews = new Map<string, Readonly<ConfigRecord>>()
	private readonly validated = new Map<
		string,
		{
			rev: number
			authority: PluginConfigValidationAuthority
			snapshot: Readonly<ConfigRecord>
		}
	>()
	private readonly staged = new Map<
		string,
		{ ticket: StagedPluginConfigValidation; revision: number }
	>()
	private readonly revisions = new Map<string, number>()
	private sequence = 0
	private readyState = true
	private readyTask: Promise<void> = Promise.resolve()

	constructor(public ctx: PluxelContext) {}

	get isReady(): boolean {
		return this.readyState
	}

	get ready(): Promise<void> {
		return this.readyTask
	}

	protected setReadyTask(task: Promise<void>): void {
		this.readyState = false
		this.readyTask = task.finally(() => {
			this.readyState = true
		})
	}

	protected assertConfigMutable(_action: string): void {}
	protected onConfigChanged(_owner: PluginNodeAddress): void {}

	protected replaceConfigRecords(next: readonly PluginConfigRecordSnapshot[]): void {
		const remaining = new Set(this.records.keys())
		for (const item of next) {
			const ownerKey = pluginNodeIndexKey(item.owner)
			remaining.delete(ownerKey)
			const source = item.config
			if (!source || typeof source !== 'object' || Array.isArray(source)) continue
			const snapshot = immutableConfigRecord(source)
			const target = this.records.get(ownerKey)?.config ?? Object.create(null)
			for (const configKey of Object.keys(target)) delete target[configKey]
			Object.assign(target, snapshot)
			this.records.set(ownerKey, { owner: item.owner, config: target })
			this.bump(ownerKey)
		}
		for (const key of remaining) {
			this.records.delete(key)
			this.rawViews.delete(key)
			this.revisions.delete(key)
			this.validated.delete(key)
			this.staged.delete(key)
		}
	}

	getRawConfig<T extends object = ConfigRecord>(owner: PluginNodeAddress): Readonly<T> {
		const key = pluginNodeIndexKey(owner)
		const record = this.records.get(key)?.config
		if (!record) return EMPTY_CONFIG as T
		const existing = this.rawViews.get(key)
		if (existing) return existing as T
		const view = createReadonlyView(record)
		this.rawViews.set(key, view)
		return view as T
	}

	getConfigRevision(owner: PluginNodeAddress): number {
		return this.revisions.get(pluginNodeIndexKey(owner)) ?? 0
	}

	getValidatedConfig<T extends object = ConfigRecord>(
		owner: PluginNodeAddress,
		authority: PluginConfigValidationAuthority,
	): Readonly<T> {
		const key = pluginNodeIndexKey(owner)
		const cached = this.validated.get(key)
		if (!cached || cached.rev !== this.getConfigRevision(owner) || cached.authority !== authority) {
			throw new Error('[ConfigService] Validated config is not ready for the Plugin node.')
		}
		return cached.snapshot as T
	}

	tryGetValidatedConfig<T extends object = ConfigRecord>(
		owner: PluginNodeAddress,
		authority: PluginConfigValidationAuthority,
	): Readonly<T> | undefined {
		const cached = this.validated.get(pluginNodeIndexKey(owner))
		return cached?.rev === this.getConfigRevision(owner) && cached.authority === authority
			? (cached.snapshot as T)
			: undefined
	}

	async ensureValidated(
		owner: PluginNodeAddress,
		authority: PluginConfigValidationAuthority,
		options: { missingObjectDefault?: unknown } = {},
	): Promise<Readonly<ConfigRecord>> {
		await this.ready
		const key = pluginNodeIndexKey(owner)
		const revision = this.getConfigRevision(owner)
		if (this.staged.get(key)?.revision === revision) {
			throw new ConfigValidationPendingPersistenceError()
		}
		const cached = this.validated.get(key)
		if (cached?.rev === revision && cached.authority === authority) return cached.snapshot

		const raw = this.getRawConfig<ConfigRecord>(owner)
		const validationInput =
			Object.keys(raw).length === 0 && options.missingObjectDefault !== undefined
				? options.missingObjectDefault
				: raw
		const result = await safeParseStandardSchema(authority.schema, validationInput)
		if (result.success === false) {
			const errors = toValidationErrors(result.issues)
			throw new ConfigValidationError('Plugin config validation failed.', errors)
		}
		if (!result.output || typeof result.output !== 'object' || Array.isArray(result.output)) {
			throw new TypeError('[ConfigService] Plugin config schema must produce an object')
		}
		return this.installValidatedConfig({
			owner,
			authority,
			expectedRevision: revision,
			value: result.output as ConfigRecord,
		})
	}

	/** Stage normalized desired data while keeping it unavailable to Core until flush succeeds. */
	stageValidatedConfig(input: {
		owner: PluginNodeAddress
		authority: PluginConfigValidationAuthority
		expectedRevision: number
		value: Readonly<ConfigRecord>
	}): StagedPluginConfigValidation {
		this.assertConfigMutable('stageValidatedConfig')
		const { owner, authority, expectedRevision } = input
		if (this.getConfigRevision(owner) !== expectedRevision) {
			throw new Error('[ConfigService] Config revision changed during validation.')
		}
		const snapshot = immutableConfigRecord(input.value)
		this.replaceRecord(owner, snapshot)
		const key = pluginNodeIndexKey(owner)
		const ticket = Object.freeze({
			owner,
			authority,
			revision: this.getConfigRevision(owner),
			snapshot,
		})
		this.staged.set(key, { ticket, revision: ticket.revision })
		return ticket
	}

	/** Publish exactly the staged snapshot after its desired record is durably confirmed. */
	confirmValidatedConfig(ticket: StagedPluginConfigValidation): Readonly<ConfigRecord> {
		const key = pluginNodeIndexKey(ticket.owner)
		const staged = this.staged.get(key)
		if (staged?.ticket !== ticket || this.getConfigRevision(ticket.owner) !== ticket.revision) {
			throw new Error('[ConfigService] Staged config validation is stale.')
		}
		this.staged.delete(key)
		this.validated.set(key, {
			rev: ticket.revision,
			authority: ticket.authority,
			snapshot: ticket.snapshot,
		})
		return ticket.snapshot
	}

	getConfigSnapshot(): { plugins: readonly PluginConfigRecordSnapshot[] } {
		return {
			plugins: [...this.records.values()].map(({ owner, config }) => ({
				owner,
				config: { ...config },
			})),
		}
	}

	patchConfig<T extends object = ConfigRecord>(owner: PluginNodeAddress, patch: Partial<T>): void {
		this.assertConfigMutable('patchConfig')
		const ownerKey = pluginNodeIndexKey(owner)
		const current = this.records.get(ownerKey)
		const entry = current?.config ?? Object.assign(Object.create(null), {})
		const next = immutableConfigRecord({ ...entry, ...(patch as ConfigRecord) })
		if (shallowEqual(entry, next)) return
		for (const configKey of Object.keys(entry)) delete entry[configKey]
		Object.assign(entry, next)
		if (!current) this.records.set(ownerKey, { owner, config: entry })
		this.changed(owner, ownerKey)
	}

	unsetConfigKeys(owner: PluginNodeAddress, keys: readonly string[]): void {
		this.assertConfigMutable('unsetConfigKeys')
		const ownerKey = pluginNodeIndexKey(owner)
		const entry = this.records.get(ownerKey)?.config
		if (!entry) return
		let changed = false
		for (const configKey of keys) {
			if (!(configKey in entry)) continue
			delete entry[configKey]
			changed = true
		}
		if (changed) this.changed(owner, ownerKey)
	}

	/** Delete the complete desired record for one Plugin node. */
	deleteConfig(owner: PluginNodeAddress): boolean {
		this.assertConfigMutable('deleteConfig')
		const key = pluginNodeIndexKey(owner)
		if (!this.records.delete(key)) return false
		this.rawViews.delete(key)
		this.validated.delete(key)
		this.staged.delete(key)
		this.revisions.delete(key)
		this.onConfigChanged(owner)
		return true
	}

	batch(run: () => void): void {
		run()
	}

	/** Wait until this backend has durably persisted all queued desired Config records. */
	async flush(_options: { force?: boolean } = {}): Promise<void> {}

	private replaceRecord(owner: PluginNodeAddress, value: Readonly<ConfigRecord>): void {
		const ownerKey = pluginNodeIndexKey(owner)
		const current = this.records.get(ownerKey)
		const target = current?.config ?? Object.create(null)
		for (const configKey of Object.keys(target)) delete target[configKey]
		Object.assign(target, value)
		if (!current) this.records.set(ownerKey, { owner, config: target })
		this.changed(owner, ownerKey)
	}

	private installValidatedConfig(input: {
		owner: PluginNodeAddress
		authority: PluginConfigValidationAuthority
		expectedRevision: number
		value: Readonly<ConfigRecord>
	}): Readonly<ConfigRecord> {
		const { owner, authority, expectedRevision, value } = input
		if (this.getConfigRevision(owner) !== expectedRevision) {
			throw new Error('[ConfigService] Config revision changed during validation.')
		}
		const snapshot = immutableConfigRecord(value)
		const raw = this.getRawConfig<ConfigRecord>(owner)
		if (!shallowEqual(raw, snapshot)) this.replaceRecord(owner, snapshot)
		const key = pluginNodeIndexKey(owner)
		this.validated.set(key, {
			rev: this.getConfigRevision(owner),
			authority,
			snapshot,
		})
		return snapshot
	}

	private changed(owner: PluginNodeAddress, key: string): void {
		this.bump(key)
		this.onConfigChanged(owner)
	}

	private bump(key: string): void {
		this.revisions.set(key, ++this.sequence)
		this.validated.delete(key)
		this.staged.delete(key)
	}
}

function toValidationErrors(
	issues: readonly { message: string; path: readonly (string | number)[] }[],
): ConfigValidationErrors {
	const fields: Record<string, Array<{ message: string; path: string[] }>> = Object.create(null)
	for (const issue of issues) {
		const path = issue.path.map(String)
		const key = path[0] ?? '_root'
		;(fields[key] ??= []).push({ message: issue.message, path })
	}
	return { _root: fields }
}

function shallowEqual(left: Readonly<ConfigRecord>, right: Readonly<ConfigRecord>): boolean {
	const leftKeys = Object.keys(left)
	const rightKeys = Object.keys(right)
	if (leftKeys.length !== rightKeys.length) return false
	for (const key of leftKeys) if (left[key] !== right[key]) return false
	return true
}

function createReadonlyView<T extends ConfigRecord>(target: T): Readonly<T> {
	return new Proxy(target, {
		set: rejectMutation,
		defineProperty: rejectMutation,
		deleteProperty: rejectMutation,
	}) as Readonly<T>
}

function rejectMutation(): never {
	throw new Error('[ConfigService] Raw config is read-only; use patchConfig()/unsetConfigKeys().')
}
