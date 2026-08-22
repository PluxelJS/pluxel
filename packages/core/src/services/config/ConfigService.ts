import { type Context as PluxelContext, Injectable } from '@pluxel/context'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { PluginNodeAddress, PluginNodeSlot } from '../../plugins/runtime/identity'
import { safeParseStandardSchema } from './standardSchema'
import { ConfigValidationError, type ConfigValidationErrors } from './types'

type ConfigRecord = Record<string, unknown>
const EMPTY_CONFIG: Readonly<ConfigRecord> = Object.freeze(Object.create(null))
const serviceName = 'configService' as const

type RegistryIdentity = {
	internNodeAddress(address: PluginNodeAddress): PluginNodeSlot
	nodeAddressOf(slot: PluginNodeSlot): PluginNodeAddress
}

export type PluginConfigRecordSnapshot = Readonly<{
	owner: PluginNodeAddress
	config: Readonly<ConfigRecord>
}>

declare module '@pluxel/context' {
	namespace Context {
		interface Services {
			[serviceName]: ConfigService
		}
	}
}

/** One complete object config record per Plugin node slot. */
@Injectable({ key: serviceName })
export class ConfigService {
	private readonly records = new Map<PluginNodeSlot, ConfigRecord>()
	private readonly rawViews = new Map<PluginNodeSlot, Readonly<ConfigRecord>>()
	private readonly validated = new Map<
		PluginNodeSlot,
		{ rev: number; schema: StandardSchemaV1; snapshot: Readonly<ConfigRecord> }
	>()
	private readonly revisions = new Map<PluginNodeSlot, number>()
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
	protected onConfigChanged(_owner: PluginNodeSlot): void {}

	protected replaceConfigRecords(next: readonly PluginConfigRecordSnapshot[]): void {
		const registry = this.registry()
		const remaining = new Set(this.records.keys())
		for (const item of next) {
			const owner = registry.internNodeAddress(item.owner)
			remaining.delete(owner)
			const source = item.config
			if (!source || typeof source !== 'object' || Array.isArray(source)) continue
			const target = this.records.get(owner) ?? Object.create(null)
			for (const key of Object.keys(target)) delete target[key]
			Object.assign(target, source)
			this.records.set(owner, target)
			this.bump(owner)
		}
		for (const owner of remaining) {
			this.records.delete(owner)
			this.rawViews.delete(owner)
			this.revisions.delete(owner)
			this.validated.delete(owner)
		}
	}

	getRawConfig<T extends object = ConfigRecord>(owner?: PluginNodeSlot): Readonly<T> {
		const resolved = owner ?? this.contextOwner()
		if (!resolved) return EMPTY_CONFIG as T
		const record = this.records.get(resolved)
		if (!record) return EMPTY_CONFIG as T
		const existing = this.rawViews.get(resolved)
		if (existing) return existing as T
		const view = createReadonlyView(record)
		this.rawViews.set(resolved, view)
		return view as T
	}

	getConfigRevision(owner: PluginNodeSlot): number {
		return this.revisions.get(owner) ?? 0
	}

	getValidatedConfig<T extends object = ConfigRecord>(owner?: PluginNodeSlot): Readonly<T> {
		const resolved = owner ?? this.contextOwner()
		if (!resolved) throw new Error('[ConfigService] Missing Plugin node owner.')
		const cached = this.validated.get(resolved)
		if (!cached || cached.rev !== this.getConfigRevision(resolved)) {
			throw new Error('[ConfigService] Validated config is not ready for the Plugin node.')
		}
		return cached.snapshot as T
	}

	tryGetValidatedConfig<T extends object = ConfigRecord>(
		owner?: PluginNodeSlot,
	): Readonly<T> | undefined {
		const resolved = owner ?? this.contextOwner()
		if (!resolved) return undefined
		const cached = this.validated.get(resolved)
		return cached?.rev === this.getConfigRevision(resolved) ? (cached.snapshot as T) : undefined
	}

	async ensureValidated(
		owner: PluginNodeSlot,
		schema: StandardSchemaV1,
		options: { missingObjectDefault?: unknown } = {},
	): Promise<Readonly<ConfigRecord>> {
		await this.ready
		const revision = this.getConfigRevision(owner)
		const cached = this.validated.get(owner)
		if (cached?.rev === revision && cached.schema === schema) return cached.snapshot

		const raw = this.getRawConfig<ConfigRecord>(owner)
		let result = await safeParseStandardSchema(schema, raw)
		if (
			result.success === false &&
			Object.keys(raw).length === 0 &&
			options.missingObjectDefault !== undefined
		) {
			result = await safeParseStandardSchema(schema, options.missingObjectDefault)
		}
		if (result.success === false) {
			const errors = toValidationErrors(result.issues)
			throw new ConfigValidationError('Plugin config validation failed.', errors)
		}
		if (!result.output || typeof result.output !== 'object' || Array.isArray(result.output)) {
			throw new TypeError('[ConfigService] Plugin config schema must produce an object')
		}
		const snapshot = Object.freeze({ ...(result.output as ConfigRecord) })
		if (!shallowEqual(raw, snapshot)) this.replaceRecord(owner, snapshot)
		const nextRevision = this.getConfigRevision(owner)
		this.validated.set(owner, { rev: nextRevision, schema, snapshot })
		return snapshot
	}

	getConfigSnapshot(): { plugins: readonly PluginConfigRecordSnapshot[] } {
		const registry = this.registry()
		return {
			plugins: [...this.records].map(([owner, config]) => ({
				owner: registry.nodeAddressOf(owner),
				config: { ...config },
			})),
		}
	}

	patchConfig<T extends object = ConfigRecord>(owner: PluginNodeSlot, patch: Partial<T>): void {
		this.assertConfigMutable('patchConfig')
		const entry = this.records.get(owner) ?? Object.assign(Object.create(null), {})
		if (!this.records.has(owner)) this.records.set(owner, entry)
		let changed = false
		for (const [key, value] of Object.entries(patch as ConfigRecord)) {
			if (entry[key] === value) continue
			entry[key] = value
			changed = true
		}
		if (changed) this.changed(owner)
	}

	unsetConfigKeys(owner: PluginNodeSlot, keys: readonly string[]): void {
		this.assertConfigMutable('unsetConfigKeys')
		const entry = this.records.get(owner)
		if (!entry) return
		let changed = false
		for (const key of keys) {
			if (!(key in entry)) continue
			delete entry[key]
			changed = true
		}
		if (changed) this.changed(owner)
	}

	batch(run: () => void): void {
		run()
	}

	/** Wait until this backend has durably persisted all queued desired Config records. */
	async flush(_options: { force?: boolean } = {}): Promise<void> {}

	private replaceRecord(owner: PluginNodeSlot, value: Readonly<ConfigRecord>): void {
		const target = this.records.get(owner) ?? Object.create(null)
		for (const key of Object.keys(target)) delete target[key]
		Object.assign(target, value)
		this.records.set(owner, target)
		this.changed(owner)
	}

	private changed(owner: PluginNodeSlot): void {
		this.bump(owner)
		this.onConfigChanged(owner)
	}

	private bump(owner: PluginNodeSlot): void {
		this.revisions.set(owner, ++this.sequence)
		this.validated.delete(owner)
	}

	private contextOwner(): PluginNodeSlot | undefined {
		return (this.ctx as unknown as { pluginInfo?: { nodeSlot?: PluginNodeSlot } }).pluginInfo
			?.nodeSlot
	}

	private registry(): RegistryIdentity {
		const registry = (this.ctx as unknown as { registry?: RegistryIdentity }).registry
		if (!registry) throw new Error('[ConfigService] Plugin registry is not available')
		return registry
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
