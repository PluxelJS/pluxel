import { type Context, Injectable } from '@pluxel/context'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { type ConfigSchemaMap, normalizeConfigRecord } from './ops'
import { ConfigValidationError } from './types'

const EMPTY_CONFIG: Readonly<Record<string, unknown>> = Object.freeze(Object.create(null))

const serviceName = 'configService' as const
declare module '@pluxel/context' {
	namespace Context {
		interface Services {
			[serviceName]: ConfigService
		}
	}
}

/**
 * Core config service: provides a stable, minimal contract for plugin config access.
 *
 * - Core owns "when/how @Config is injected".
 * - Core also provides the shared validation/defaulting engine via `ensureValidated(...)`.
 * - Apps/HMR override this service mainly for persistence and enablement policies.
 *
 * Readiness contract:
 * - `isReady/ready` exist on the core service so orchestrators can reliably wait for config-backed policies
 *   (HMR loads from disk asynchronously; core resolves immediately).
 *
 * Note on enablement:
 * - This service stores enablement preference in config state.
 * - Core does not interpret it; orchestrators/loaders may use it to decide whether a plugin should be started.
 */
@Injectable({ key: serviceName })
export class ConfigService {
	public ctx: Context
	/** Core is always "ready"; overridden implementations (e.g. HMR) may load from disk asynchronously. */
	public isReady = true
	/** Resolves when initial config is ready; core resolves immediately. */
	public readonly ready: Promise<void> = Promise.resolve()
	private schemaObjectSeq = 0
	private readonly schemaObjectIds = new WeakMap<object, number>()
	private readonly validated = new Map<
		string,
		{
			rev: number
			schemaMap: Record<string, StandardSchemaV1>
			schemaSig?: string
			snapshot: Readonly<Record<string, unknown>>
		}
	>()
	private enabledInConfig = new Set<string>()
	private store = new Map<string, Record<string, unknown>>()
	private configSeq = 0
	private configRevByPlugin = new Map<string, number>()
	private extra: Record<string, unknown> = Object.create(null)

	constructor(ctx: Context, _config: unknown = undefined) {
		this.ctx = ctx
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

	isEnabledInConfig(name: string): boolean {
		return this.enabledInConfig.has(name)
	}

	setEnabledInConfig(name: string, enabled: boolean) {
		if (enabled) this.enabledInConfig.add(name)
		else this.enabledInConfig.delete(name)
	}

	enableInConfig(...names: string[]) {
		for (const n of names) this.enabledInConfig.add(n)
	}

	disableInConfig(...names: string[]) {
		for (const n of names) this.enabledInConfig.delete(n)
	}

	replaceEnabledInConfigSet(names: Iterable<string>) {
		const next = new Set<string>()
		for (const n of names) next.add(n)

		let same = next.size === this.enabledInConfig.size
		if (same) {
			for (const n of next) {
				if (!this.enabledInConfig.has(n)) {
					same = false
					break
				}
			}
		}
		if (same) return

		this.enabledInConfig.clear()
		for (const n of next) this.enabledInConfig.add(n)
	}

	/**
	 * Raw (unvalidated) config snapshot.
	 *
	 * Prefer `getValidatedConfig()` unless you explicitly need to inspect persisted state
	 * including unknown keys.
	 */
	getRawConfig<T extends object = Record<string, unknown>>(name?: string): Readonly<T> {
		const resolved = name ?? this.ctx.pluginInfo?.id ?? ''
		if (!resolved) return EMPTY_CONFIG as T
		return (this.store.get(resolved) as T | undefined) ?? (EMPTY_CONFIG as T)
	}

	getConfigRevision(name: string): number {
		return this.configRevByPlugin.get(name) ?? 0
	}

	/**
	 * Get the current validated snapshot for a plugin.
	 *
	 * This never falls back to raw config. Callers must either:
	 * - call `ensureValidated(...)` beforehand; or
	 * - use `getRawConfig(...)` explicitly.
	 */
	getValidatedConfig<T extends object = Record<string, unknown>>(name?: string): Readonly<T> {
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

	tryGetValidatedConfig<T extends object = Record<string, unknown>>(
		name?: string,
	): Readonly<T> | undefined {
		const resolved = name ?? this.ctx.pluginInfo?.id ?? ''
		if (!resolved) return undefined
		const rev = this.getConfigRevision(resolved)
		const cached = this.validated.get(resolved)
		if (!cached || cached.rev !== rev) return undefined
		return cached.snapshot as T
	}

	/**
	 * Ensure config is validated and missing defaults are persisted.
	 *
	 * Orchestrators (HMR/loader) should call this before enabling/starting a plugin so:
	 * - invalid config blocks start early;
	 * - missing values are filled deterministically (defaults become part of persisted config).
	 */
	async ensureValidated(
		pluginName: string,
		schemaMap: Record<string, StandardSchemaV1>,
		options: { missingObjectDefault?: unknown } = {},
	): Promise<Readonly<Record<string, unknown>>> {
		await this.ready

		// Fast-path: if raw config revision didn't change AND schema is stable, return cached snapshot.
		//
		// Schema stability is usually "same object reference" (best case).
		// If callers recreate the schemaMap object, we lazily compute a signature derived from schema
		// *references* to avoid revalidation; this keeps ohash overhead off the hot path.
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

		const raw = this.getRawConfig<Record<string, unknown>>(pluginName)
		const res = await normalizeConfigRecord(schemaMap as ConfigSchemaMap, raw, options)
		if (res.ok === false) {
			const errors = res.errors
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

		if (Object.keys(res.patch).length > 0) this.patchConfig(pluginName, res.patch)

		const rev = this.getConfigRevision(pluginName)
		this.validated.set(pluginName, {
			rev,
			schemaMap,
			schemaSig: nextSchemaSig,
			snapshot: res.snapshot,
		})
		return res.snapshot
	}

	patchConfig<T extends object = Record<string, unknown>>(name: string, patch: Partial<T>) {
		let entry = this.store.get(name)
		if (!entry) {
			entry = Object.create(null)
			this.store.set(name, entry)
		}
		let changed = false
		for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
			if (entry[k] !== v) {
				entry[k] = v
				changed = true
			}
		}
		if (!changed) return
		this.configRevByPlugin.set(name, ++this.configSeq)
		this.validated.delete(name)
	}

	unsetConfigKeys(name: string, keys: readonly string[]) {
		const entry = this.store.get(name)
		if (!entry) return
		let changed = false
		for (let i = 0; i < keys.length; i++) {
			const k = keys[i]!
			if (k in entry) {
				delete entry[k]
				changed = true
			}
		}
		if (!changed) return
		this.configRevByPlugin.set(name, ++this.configSeq)
		this.validated.delete(name)
	}

	getExtra<T = unknown>(key: string): T | undefined {
		return this.extra[key] as T | undefined
	}

	setExtra(key: string, value: unknown): void {
		this.extra[key] = value
	}

	/**
	 * 事务批量修改：Core 版为同步合批（与 HMR 版 API 对齐）。
	 */
	batch(run: () => void) {
		run()
	}
}
