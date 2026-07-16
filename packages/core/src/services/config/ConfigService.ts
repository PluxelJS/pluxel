import { type Context as PluxelContext, Injectable } from '@pluxel/context'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { type ConfigSchemaMap, normalizeConfigRecord } from './ops'
import { ConfigValidationError } from './types'

type ConfigRecord = Record<string, unknown>

const EMPTY_CONFIG: Readonly<ConfigRecord> = Object.freeze(Object.create(null))

const serviceName = 'configService' as const
declare module '@pluxel/context' {
	namespace Context {
		interface Services {
			[serviceName]: ConfigService
		}
	}
}

/**
 * The single in-memory config engine shared by core hosts and persistent runtimes.
 *
 * Core owns records, revisions, validation/defaulting and normalized snapshots. Runtime subclasses
 * may load records and react to mutations, but persistence and host policy stay outside core.
 */
@Injectable({ key: serviceName })
export class ConfigService {
	private readonly records = new Map<string, ConfigRecord>()
	private readonly rawViews = new Map<string, Readonly<ConfigRecord>>()
	private schemaObjectSeq = 0
	private readonly schemaObjectIds = new WeakMap<object, number>()
	private readonly validated = new Map<
		string,
		{
			rev: number
			schemaMap: Record<string, StandardSchemaV1>
			schemaSig?: string
			snapshot: Readonly<ConfigRecord>
		}
	>()
	private configSeq = 0
	private readonly configRevByPlugin = new Map<string, number>()
	private readyState = true
	private readyTask: Promise<void> = Promise.resolve()

	constructor(
		public ctx: PluxelContext,
		_config?: unknown,
	) {}

	get isReady(): boolean {
		return this.readyState
	}

	get ready(): Promise<void> {
		return this.readyTask
	}

	/** Install an asynchronous startup task without exposing persistence concepts to core. */
	protected setReadyTask(task: Promise<void>): void {
		this.readyState = false
		this.readyTask = task.finally(() => {
			this.readyState = true
		})
	}

	/** Runtime policy hook. Core's in-memory implementation is always mutable. */
	protected assertConfigMutable(_action: string): void {}

	/** Runtime persistence hook, called exactly once after each effective record mutation. */
	protected onConfigChanged(_name: string): void {}

	/**
	 * Replace raw records loaded by a host adapter.
	 *
	 * Existing record objects are updated in place so cached read views remain valid. Loading is a
	 * state replacement, not an author mutation, so it intentionally does not call onConfigChanged().
	 */
	protected replaceConfigRecords(next: Readonly<Record<string, ConfigRecord>>): void {
		const removed = new Set(this.records.keys())
		for (const [name, value] of Object.entries(next)) {
			if (!value || typeof value !== 'object' || Array.isArray(value)) continue
			removed.delete(name)
			const existing = this.records.get(name)
			if (existing) {
				for (const key of Object.keys(existing)) delete existing[key]
				Object.assign(existing, value)
			} else {
				this.records.set(name, Object.assign(Object.create(null), value))
			}
			this.bumpConfigRevision(name)
		}

		for (const name of removed) {
			this.records.delete(name)
			this.rawViews.delete(name)
			this.configRevByPlugin.delete(name)
			this.validated.delete(name)
		}
	}

	private schemaMapSignature(schemaMap: Record<string, StandardSchemaV1>): string {
		const keys = Object.keys(schemaMap)
		if (keys.length === 0) return 'empty'
		keys.sort()
		let sig = ''
		for (let i = 0; i < keys.length; i++) {
			const key = keys[i]!
			const schema = schemaMap[key]
			if (!schema || (typeof schema !== 'object' && typeof schema !== 'function')) {
				throw new Error(`[ConfigService] Invalid schemaMap: missing schema for "${key}".`)
			}
			const schemaObj = schema as unknown as object
			let id = this.schemaObjectIds.get(schemaObj)
			if (!id) {
				id = ++this.schemaObjectSeq
				this.schemaObjectIds.set(schemaObj, id)
			}
			sig += `${key.length}:${key}#${id};`
		}
		return sig
	}

	/** Raw persisted input. Prefer getValidatedConfig() in plugin code. */
	getRawConfig<T extends object = ConfigRecord>(name?: string): Readonly<T> {
		const resolved = name ?? this.ctx.pluginInfo?.id ?? ''
		if (!resolved) return EMPTY_CONFIG as T
		const record = this.records.get(resolved)
		if (!record) return EMPTY_CONFIG as T
		const existing = this.rawViews.get(resolved)
		if (existing) return existing as T
		const view = createReadonlyView(record)
		this.rawViews.set(resolved, view)
		return view as T
	}

	getConfigRevision(name: string): number {
		return this.configRevByPlugin.get(name) ?? 0
	}

	getValidatedConfig<T extends object = ConfigRecord>(name?: string): Readonly<T> {
		const resolved = name ?? this.ctx.pluginInfo?.id ?? ''
		if (!resolved) throw new Error('[ConfigService] Missing plugin name (not in plugin context).')
		const rev = this.getConfigRevision(resolved)
		const cached = this.validated.get(resolved)
		if (!cached || cached.rev !== rev) {
			throw new Error(
				`[ConfigService] Validated config not ready for "${resolved}". Call configService.ensureValidated(...) before reading validated config.`,
			)
		}
		return cached.snapshot as T
	}

	tryGetValidatedConfig<T extends object = ConfigRecord>(name?: string): Readonly<T> | undefined {
		const resolved = name ?? this.ctx.pluginInfo?.id ?? ''
		if (!resolved) return undefined
		const rev = this.getConfigRevision(resolved)
		const cached = this.validated.get(resolved)
		if (!cached || cached.rev !== rev) return undefined
		return cached.snapshot as T
	}

	async ensureValidated(
		pluginName: string,
		schemaMap: Record<string, StandardSchemaV1>,
		options: { missingObjectDefault?: unknown } = {},
	): Promise<Readonly<ConfigRecord>> {
		await this.ready

		const curRev = this.getConfigRevision(pluginName)
		const cached = this.validated.get(pluginName)
		let nextSchemaSig: string | undefined
		if (cached && cached.rev === curRev) {
			if (cached.schemaMap === schemaMap) return cached.snapshot
			const cachedSig =
				cached.schemaSig ?? (cached.schemaSig = this.schemaMapSignature(cached.schemaMap))
			nextSchemaSig = this.schemaMapSignature(schemaMap)
			if (cachedSig === nextSchemaSig) return cached.snapshot
		}

		const raw = this.getRawConfig<ConfigRecord>(pluginName)
		const result = await normalizeConfigRecord(schemaMap as ConfigSchemaMap, raw, options)
		if (result.ok === false) {
			const errors = result.errors
			let where = '_root'
			let message = 'unknown'

			outer: for (const configKey in errors) {
				const fields = errors[configKey]
				if (!fields) continue
				for (const fieldKey in fields) {
					const issues = fields[fieldKey]
					const first = issues?.[0]
					where = first?.path?.length
						? first.path.map(String).join('.')
						: `${configKey}.${fieldKey}`
					message = first?.message ?? 'unknown'
					break outer
				}
			}

			throw new ConfigValidationError(`插件 ${pluginName} 配置无效：${where} -> ${message}`, errors)
		}

		if (Object.keys(result.patch).length > 0) this.patchConfig(pluginName, result.patch)

		const rev = this.getConfigRevision(pluginName)
		this.validated.set(pluginName, {
			rev,
			schemaMap,
			schemaSig: nextSchemaSig,
			snapshot: result.snapshot,
		})
		return result.snapshot
	}

	/** Detached read model for persistence and host diagnostics. */
	getConfigSnapshot(): { plugins: Record<string, ConfigRecord> } {
		const plugins: Record<string, ConfigRecord> = Object.create(null)
		for (const [name, record] of this.records) plugins[name] = { ...record }
		return { plugins }
	}

	patchConfig<T extends object = ConfigRecord>(name: string, patch: Partial<T>): void {
		this.assertConfigMutable('patchConfig')
		let entry = this.records.get(name)
		if (!entry) {
			entry = Object.create(null)
			this.records.set(name, entry)
		}
		let changed = false
		for (const [key, value] of Object.entries(patch as ConfigRecord)) {
			if (entry[key] !== value) {
				entry[key] = value
				changed = true
			}
		}
		if (!changed) return
		this.bumpConfigRevision(name)
		this.onConfigChanged(name)
	}

	unsetConfigKeys(name: string, keys: readonly string[]): void {
		this.assertConfigMutable('unsetConfigKeys')
		const entry = this.records.get(name)
		if (!entry) return
		let changed = false
		for (let i = 0; i < keys.length; i++) {
			const key = keys[i]!
			if (key in entry) {
				delete entry[key]
				changed = true
			}
		}
		if (!changed) return
		this.bumpConfigRevision(name)
		this.onConfigChanged(name)
	}

	batch(run: () => void): void {
		run()
	}

	private bumpConfigRevision(name: string): void {
		this.configRevByPlugin.set(name, ++this.configSeq)
		this.validated.delete(name)
	}
}

function createReadonlyView<T extends ConfigRecord>(target: T): Readonly<T> {
	return new Proxy(target, {
		set(): boolean {
			throw new Error(
				'[ConfigService] Raw config is read-only; use patchConfig()/unsetConfigKeys().',
			)
		},
		defineProperty(): boolean {
			throw new Error(
				'[ConfigService] Raw config is read-only; use patchConfig()/unsetConfigKeys().',
			)
		},
		deleteProperty(): boolean {
			throw new Error(
				'[ConfigService] Raw config is read-only; use patchConfig()/unsetConfigKeys().',
			)
		},
	}) as Readonly<T>
}
