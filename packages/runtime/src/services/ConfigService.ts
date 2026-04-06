import { type Context as PluxelContext, Injectable, OverrideOf } from '@pluxel/core'
import {
	type ConfigSchemaMap,
	ConfigValidationError,
	ConfigService as CoreConfigService,
	normalizeConfigRecord,
} from '@pluxel/core/services'
import { watch, type FSWatcher } from 'chokidar'
import { hash as ohash } from 'ohash'
import { SuperJSON } from 'superjson'
import { resolveProfiledPath, resolveRuntimeStoragePaths } from '../runtime/paths'

// —— 3. 全局配置 ——
export interface ConfigShape {
	enabled: Set<string>
	plugins: Record<string, Record<string, unknown>>
	extra: Record<string, unknown>
}

export type ConfigServiceMode = 'file' | 'memory' | 'readonly'

export interface ConfigServiceConfig {
	mode?: ConfigServiceMode
	path?: string
	snapshot?: Partial<{
		enabled: Iterable<string> | string[]
		plugins: Record<string, Record<string, unknown>>
		extra: Record<string, unknown>
	}>
}

declare module '@pluxel/core' {
	namespace Context {
		interface Config {
			configService?: ConfigServiceConfig
		}
	}
}

@Injectable
@OverrideOf(CoreConfigService)
export class ConfigService {
	private static readonly EMPTY_CONFIG: Readonly<Record<string, unknown>> = Object.freeze(
		Object.create(null),
	)

	public ctx: PluxelContext

	/** Whether the initial on-disk config has been loaded (or initialized). */
	public isReady = false

	/** Resolves after the initial config file has been loaded (or initialized). */
	public readonly ready: Promise<void>

	private readonly data: ConfigShape = {
		enabled: new Set(),
		plugins: Object.create(null),
		extra: Object.create(null),
	}
	private readonly file: string
	private readonly saveDelayMs = 200
	private saveTimer: ReturnType<typeof setTimeout> | null = null
	private saveScheduled = false
	private saveInFlight: Promise<void> | null = null
	private saveAgain = false
	private pendingWriteDigest: string | undefined
	private lastWrittenDigest: string | undefined
	private watcher: FSWatcher | undefined
	private disposed = false
	private configSeq = 0
	private configRevByPlugin = new Map<string, number>()
	private configDigestByPlugin = new Map<string, string>()
	private schemaObjectSeq = 0
	private readonly schemaObjectIds = new WeakMap<object, number>()
	private readonly rawViews = new Map<string, Readonly<Record<string, unknown>>>()
	private readonly validated = new Map<
		string,
		{
			rev: number
			schemaMap: Record<string, unknown>
			schemaSig?: string
			snapshot: Readonly<Record<string, unknown>>
		}
	>()

	private batching = 0 // 事务计数
	private pendingSave = false
	private readonly mode: ConfigServiceMode
	private readonly readonlyMode: boolean

	constructor(ctx: PluxelContext, cfg: ConfigServiceConfig = {}) {
		this.ctx = ctx
		// 允许调用方把方法解构出来用（避免丢失 this 导致 this.data 为空）
		this.getExtra = this.getExtra.bind(this)
		this.setExtra = this.setExtra.bind(this)

		// Default mode depends on the filesystem backend:
		// - In tests we frequently run with an in-memory fs, where "file mode" would cause an
		//   async boot load that can race with early patchConfig() calls (clobbering patches).
		// - In normal runtimes, default to file persistence.
		const fsMode = (ctx.config as unknown as { fs?: { mode?: unknown } })?.fs?.mode
		const implicitMode: ConfigServiceMode = fsMode === 'memory' ? 'memory' : 'file'
		this.mode = cfg.mode ?? implicitMode
		this.readonlyMode = this.mode === 'readonly'

		const profile = normalizeProfileName(ctx.config.profile)
		const runtimeStorage = resolveRuntimeStoragePaths(process.cwd())
		const resolved = resolveProfiledPath(
			cfg.path ?? ctx.config.path ?? runtimeStorage.configFile,
			profile,
		)
		this.file = resolved.path
		if (cfg.snapshot) this.applySnapshot(cfg.snapshot)

		if (this.mode === 'file') {
			this.ready = this.loadFromDisk(this.file, resolved.fallbackPath).finally(() => {
				this.isReady = true
			})

			this.watcher = watch(this.file, {
				ignoreInitial: true,
				// 防止编辑器“分块写”引发多次触发
				awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
			})
				.on('add', () => this.onDiskChange(this.file))
				.on('change', () => this.onDiskChange(this.file))
		} else {
			this.isReady = true
			this.ready = Promise.resolve()
		}

		// Ensure watcher + pending writes are cleaned up on context disposal (HMR reloads/shutdown).
		this.ctx.effects.defer(() => this.dispose(), { tag: 'ConfigService' })
	}

	private requestSave() {
		if (this.mode !== 'file') return
		if (this.disposed) return
		// Avoid scheduling disk writes mid-batch; the outer batch() will trigger once on commit.
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

	/** Flush pending disk writes. Use `force` to flush even if a batch() is in progress. */
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

	// —— I/O 层 —— //

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
			// Missing file is expected on first run: initialize a clean default.
			if (isMissingFileError(error)) {
				this.resetToDefault()
				this.configRevByPlugin.clear()
				this.configDigestByPlugin.clear()
				this.rawViews.clear()
				this.validated.clear()
				await this.saveToDisk(file)
				return
			}

			this.ctx.logger.warn('ConfigService read failed (fallback to defaults)', { file, error })
			this.resetToDefault()
			await this.saveToDisk(file)
			return
		}

		// Ignore self-write events deterministically (content hash), no timing heuristics.
		const txtDigest = ohash(txt)
		if (txtDigest === this.pendingWriteDigest || txtDigest === this.lastWrittenDigest) return

		let parsed: Partial<ConfigShape> & { enabled?: unknown }
		try {
			parsed = SuperJSON.parse(txt) as Partial<ConfigShape> & { enabled?: unknown }
		} catch (error) {
			this.ctx.logger.warn('ConfigService parse failed; isolating broken config', { file, error })
			await this.isolateBrokenConfigFile(file, txt)
			this.resetToDefault()
			this.configRevByPlugin.clear()
			this.configDigestByPlugin.clear()
			this.rawViews.clear()
			this.validated.clear()
			await this.saveToDisk(file)
			return
		}

		this.data.enabled.clear()
		const enabledList = Array.isArray(parsed.enabled)
			? (parsed.enabled as string[])
			: parsed?.enabled instanceof Set
				? [...parsed.enabled as Set<string>]
				: []
		for (let i = 0; i < enabledList.length; i++) this.data.enabled.add(enabledList[i])

		const nextPlugins = parsed.plugins ? coercePlugins(parsed.plugins) : Object.create(null)
		this.reconcilePluginsFromDisk(nextPlugins)

		clearRecord(this.data.extra)
		if (parsed.extra) Object.assign(this.data.extra, parsed.extra)

		if (readFromFallback) {
			await this.saveToDisk(file)
		}
	}

	private resetToDefault() {
		this.data.enabled.clear()
		clearRecord(this.data.plugins)
		clearRecord(this.data.extra)
	}

	private applySnapshot(
		snapshot: Partial<{
			enabled: Iterable<string> | string[]
			plugins: Record<string, Record<string, unknown>>
			extra: Record<string, unknown>
		}>,
	) {
		this.resetToDefault()
		for (const name of snapshot.enabled ?? []) {
			if (typeof name === 'string' && name) this.data.enabled.add(name)
		}
		if (snapshot.plugins) {
			for (const [name, value] of Object.entries(snapshot.plugins)) {
				if (!value || typeof value !== 'object') continue
				this.data.plugins[name] = { ...(value as Record<string, unknown>) }
				this.configDigestByPlugin.set(name, digest(this.data.plugins[name]!))
				this.configRevByPlugin.set(name, 1)
			}
		}
		if (snapshot.extra) Object.assign(this.data.extra, snapshot.extra)
	}

	private assertMutable(action: string) {
		if (!this.readonlyMode) return
		throw new Error(`[ConfigService] ${action} is disabled in readonly mode.`)
	}

	private async isolateBrokenConfigFile(file: string, content: string) {
		const safeTs = new Date().toISOString().replaceAll(/[:.]/g, '-')
		const brokenFile = `${file}.broken.${safeTs}`
		try {
			await this.ctx.root.fs.writeTextAtomic(brokenFile, content)
		} catch (error) {
			this.ctx.logger.warn('failed to isolate broken config file', { file, brokenFile, error })
		}
	}

	private reconcilePluginsFromDisk(next: Record<string, Record<string, unknown>>) {
		const prev = this.data.plugins
		const removed = new Set(Object.keys(prev))

		for (const [name, nextRecord] of Object.entries(next)) {
			removed.delete(name)

			const prevRecord = prev[name]
			if (!prevRecord) prev[name] = nextRecord
			else {
				// Preserve object identity for callers holding onto the raw snapshot reference.
				clearRecord(prevRecord)
				Object.assign(prevRecord, nextRecord)
			}

			// Hashing is not free. Only hash/bump revisions for plugins that can currently benefit:
			// - plugins with a cached validated snapshot (keep correctness / avoid stale reads);
			// - plugins we've already started tracking previously (e.g. edited via patchConfig()).
			//
			// Note: "enabled in config" alone is not enough reason to hash during disk reload; it doesn't
			// affect correctness until the plugin actually validates/starts.
			const shouldTrack = this.validated.has(name) || this.configDigestByPlugin.has(name)
			if (!shouldTrack) continue

			const nextDigest = digest(prev[name] ?? nextRecord)
			const prevDigest = this.configDigestByPlugin.get(name)
			if (prevDigest === nextDigest) continue

			this.configDigestByPlugin.set(name, nextDigest)
			this.bumpPluginRevision(name)
		}

		for (const name of removed) {
			delete prev[name]
			this.configRevByPlugin.delete(name)
			this.configDigestByPlugin.delete(name)
			this.rawViews.delete(name)
			this.validated.delete(name)
		}
	}

	private bumpPluginRevision(name: string) {
		this.configRevByPlugin.set(name, ++this.configSeq)
		this.validated.delete(name)
	}

	// 原子写：交给 ctx.root.fs.writeTextAtomic（tmp + rename）
	private async saveToDisk(file: string, options: { force?: boolean } = {}): Promise<void> {
		const force = options.force ?? false
		if (!force && this.batching > 0) return // 事务中，先不写；提交时会统一触发

		// Coalesce concurrent save requests: never write multiple times in parallel.
		if (this.saveInFlight) {
			this.saveAgain = true
			await this.saveInFlight.catch((): void => undefined)
			if (this.saveAgain) {
				this.saveAgain = false
				await this.saveToDisk(file, options)
			}
			return
		}

		const content = SuperJSON.stringify(this.data)
		const nextDigest = ohash(content)
		if (nextDigest === this.lastWrittenDigest && this.ctx.root.fs.exists(file)) return

		this.pendingWriteDigest = nextDigest
		const task = this.ctx.root.fs
			.writeTextAtomic(file, content)
			.then(() => {
				this.lastWrittenDigest = nextDigest
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

	async dispose(): Promise<void> {
		if (this.disposed) return
		this.disposed = true
		this.cancelScheduledSave()
		await this.flush({ force: true }).catch((): void => undefined)
		await Promise.resolve(this.watcher?.close()).catch((): void => undefined)
		this.watcher = undefined
	}

	// —— 读接口 —— //

	/**
	 * 读取某插件的配置（不存在时返回只读“空视图”，避免误改未落盘）
	 */
	getRawConfig<T extends object = Record<string, unknown>>(
		name: string = this.ctx.pluginInfo?.id ?? 'default',
	): Readonly<T> {
		const entry = this.data.plugins[name] as Record<string, unknown> | undefined
		if (!entry) return ConfigService.EMPTY_CONFIG as T
		const existing = this.rawViews.get(name)
		if (existing) return existing as T
		const view = createReadonlyView(entry)
		this.rawViews.set(name, view)
		return view as T
	}

	getConfigRevision(name: string): number {
		return this.configRevByPlugin.get(name) ?? 0
	}

	getValidatedConfig<T extends object = Record<string, unknown>>(
		name: string = this.ctx.pluginInfo?.id ?? 'default',
	): Readonly<T> {
		const rev = this.getConfigRevision(name)
		const cached = this.validated.get(name)
		if (!cached || cached.rev !== rev) {
			throw new Error(
				`[ConfigService] Validated config not ready for "${name}". Call configService.ensureValidated(...) before reading validated config.`,
			)
		}
		return cached.snapshot as T
	}

	tryGetValidatedConfig<T extends object = Record<string, unknown>>(
		name: string = this.ctx.pluginInfo?.id ?? 'default',
	): Readonly<T> | undefined {
		const rev = this.getConfigRevision(name)
		const cached = this.validated.get(name)
		if (!cached || cached.rev !== rev) return undefined
		return cached.snapshot as T
	}

	async ensureValidated(
		pluginName: string,
		schemaMap: Record<string, unknown>,
		options: { missingObjectDefault?: unknown } = {},
	): Promise<Readonly<Record<string, unknown>>> {
		await this.ready

		// Fast-path: if raw config revision didn't change AND schema is stable, return cached snapshot.
		//
		// Schema stability is usually "same object reference" (best case).
		// If callers recreate the schemaMap object, we lazily compute a signature derived from schema
		// *references* to avoid revalidation; this keeps hashing/normalization off the hot path.
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

		if (Object.keys(res.patch).length > 0) {
			this.patchConfig(pluginName, res.patch)
		}

		const rev = this.getConfigRevision(pluginName)
		// Establish a baseline digest for future on-disk reload comparisons, without forcing a revision bump.
		// If `patchConfig()` ran above, it already recorded the digest.
		if (!this.configDigestByPlugin.has(pluginName)) {
			const entry = this.data.plugins[pluginName]
			if (entry) this.configDigestByPlugin.set(pluginName, digest(entry))
		}
		this.validated.set(pluginName, {
			rev,
			schemaMap,
			schemaSig: nextSchemaSig,
			snapshot: res.snapshot,
		})
		return res.snapshot
	}

	private schemaMapSignature(schemaMap: Record<string, unknown>): string {
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

	getExtra<T = unknown>(key: string): T | undefined {
		return this.data.extra[key] as T | undefined
	}

	isEnabledInConfig(name: string): boolean {
		return this.data.enabled.has(name)
	}

	// —— 写接口（更简洁的 API）—— //

	/**
	 * 事务批量修改：函数内多次 set/enable 只触发一次保存
	 */
	batch(run: () => void) {
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

	/**
	 * 设置 / 覆盖配置条目（存在则浅合并）
	 */
	patchConfig<T extends object = Record<string, unknown>>(name: string, partial: Partial<T>) {
		this.assertMutable('patchConfig')
		const entry = (this.data.plugins[name] ??= Object.create(null))
		let changed = false
		for (const [k, v] of Object.entries(partial as Record<string, unknown>)) {
			if (entry[k] !== v) {
				entry[k] = v
				changed = true
			}
		}
		if (changed) {
			this.configDigestByPlugin.set(name, digest(entry))
			this.bumpPluginRevision(name)
			this.requestSave()
		}
	}

	unsetConfigKeys(name: string, keys: readonly string[]) {
		this.assertMutable('unsetConfigKeys')
		const entry = this.data.plugins[name]
		if (!entry) return
		let changed = false
		for (let i = 0; i < keys.length; i++) {
			const k = keys[i]!
			if (k in entry) {
				delete entry[k]
				changed = true
			}
		}
		if (changed) {
			this.configDigestByPlugin.set(name, digest(entry))
			this.bumpPluginRevision(name)
			this.requestSave()
		}
	}

	setExtra(key: string, value: unknown) {
		this.assertMutable('setExtra')
		if (this.data.extra[key] === value) return
		this.data.extra[key] = value
		this.requestSave()
	}

	/**
	 * 批量启用：ConfigService.enableInConfig('a', 'b', 'c')
	 */
	enableInConfig(...names: readonly string[]) {
		this.assertMutable('enableInConfig')
		let changed = false
		for (let i = 0; i < names.length; i++) {
			const n = names[i]
			if (!this.data.enabled.has(n)) {
				this.data.enabled.add(n)
				changed = true
			}
		}
		if (changed) this.requestSave()
	}

	/**
	 * 批量禁用：ConfigService.disableInConfig('a', 'b')
	 */
	disableInConfig(...names: readonly string[]) {
		this.assertMutable('disableInConfig')
		let changed = false
		for (let i = 0; i < names.length; i++) {
			const n = names[i]
			if (this.data.enabled.delete(n)) changed = true
		}
		if (changed) this.requestSave()
	}

	/**
	 * 单个开关（更语义化）
	 */
	setEnabledInConfig(name: string, enabled: boolean) {
		if (enabled) this.enableInConfig(name)
		else this.disableInConfig(name)
	}

	/**
	 * 一次性覆盖启用集合（常用于 UI “全选/重置”）
	 */
	replaceEnabledInConfigSet(names: Iterable<string>) {
		this.assertMutable('replaceEnabledInConfigSet')
		const next = new Set<string>()
		for (const n of names) next.add(n)

		let same = next.size === this.data.enabled.size
		if (same) {
			for (const n of next) {
				if (!this.data.enabled.has(n)) {
					same = false
					break
				}
			}
		}
		if (same) return

		this.data.enabled.clear()
		for (const n of next) this.data.enabled.add(n)
		this.requestSave()
	}
}

function clearRecord(record: Record<string, unknown>) {
	for (const k in record) delete record[k]
}

// Optional placeholder: allows callers to control where the profile lands.
function isMissingFileError(error: unknown): boolean {
	if (!error || typeof error !== 'object') return false
	if ('code' in error && (error as { code?: unknown }).code === 'ENOENT') return true
	if ('name' in error && (error as { name?: unknown }).name === 'FsError') {
		return 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
	}
	return false
}

function createReadonlyView<T extends Record<string, unknown>>(target: T): Readonly<T> {
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

function normalizeProfileName(raw: unknown): string | undefined {
	if (typeof raw !== 'string') return undefined
	const trimmed = raw.trim()
	if (!trimmed) return undefined
	// Keep profile names safe for filesystem usage across platforms.
	const safe = trimmed
		// oxlint-disable-next-line eslint/no-control-regex -- intentionally strips ASCII control characters for safe filenames.
		.replaceAll(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
		.replaceAll(/\s+/g, '-')
		.replaceAll(/-+/g, '-')
		.replace(/^[-.]+/, '')
		.replace(/[-.]+$/, '')
	return safe || undefined
}

function coercePlugins(input: Record<string, unknown>): Record<string, Record<string, unknown>> {
	const out: Record<string, Record<string, unknown>> = Object.create(null)
	for (const [name, raw] of Object.entries(input)) {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
		const maybe = raw as Record<string, unknown>
		const record = maybe.configRecord
		if (record && typeof record === 'object' && !Array.isArray(record)) {
			out[name] = Object.assign(Object.create(null), record as Record<string, unknown>)
		} else {
			out[name] = Object.assign(Object.create(null), raw as Record<string, unknown>)
		}
	}
	return out
}

function digest(value: unknown): string {
	// Hash-only change detection (no large intermediate strings like SuperJSON.stringify()).
	// This is intentionally independent from the on-disk encoding; it only drives in-memory invalidation.
	return ohash(value)
}
