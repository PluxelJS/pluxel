import { type Context, Injectable, OverrideOf } from '@pluxel/core'
import {
	type ConfigSchemaMap,
	ConfigValidationError,
	ConfigService as CoreConfigService,
	normalizeConfigRecord,
} from '@pluxel/core/services'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { debounce } from '@tanstack/pacer'
import chokidar from 'chokidar'
import { hash as ohash } from 'ohash'
import { resolve } from 'pathe'
import { SuperJSON } from 'superjson'

// —— 3. 全局配置 ——
export interface ConfigShape {
	enabled: Set<string>
	plugins: Record<string, Record<string, unknown>>
	extra: Record<string, unknown>
}

@Injectable
@OverrideOf(CoreConfigService)
export class ConfigService {
	private static readonly EMPTY_CONFIG: Readonly<Record<string, unknown>> = Object.freeze(
		Object.create(null),
	)

	/** Whether the initial on-disk config has been loaded (or initialized). */
	public isReady = false

	/**
	 * Resolves after the initial config file has been loaded (or initialized).
	 *
	 * Note: constructors can't be async, so callers that require a fully-loaded
	 * config should await this before doing "enable/disable auto-start" work.
	 */
	public readonly ready: Promise<void>

	private readonly data: ConfigShape = {
		enabled: new Set(),
		plugins: Object.create(null),
		extra: Object.create(null),
	}
	private readonly saveDebounced: () => void
	private configSeq = 0
	private configRevByPlugin = new Map<string, number>()
	private configDigestByPlugin = new Map<string, string>()
	private readonly validated = new Map<
		string,
		{
			rev: number
			schemaMap: Record<string, StandardSchemaV1>
			snapshot: Readonly<Record<string, unknown>>
		}
	>()

	// 自写屏蔽：写盘到落盘结束这段时间内忽略变更事件
	private writingNow = false
	private batching = 0 // 事务计数
	private pendingSave = false

	constructor(
		public ctx: Context,
		_cfg: unknown = undefined,
	) {
		// 允许调用方把方法解构出来用（避免丢失 this 导致 this.data 为空）
		this.getExtra = this.getExtra.bind(this)
		this.setExtra = this.setExtra.bind(this)

		const file = ctx.config.path ?? 'data/hmr/config.json'
		const resolvedFile = resolve(file)
		this.ready = this.loadFromDisk(resolvedFile).finally(() => {
			this.isReady = true
		})
		this.saveDebounced = debounce(() => this.saveToDisk(resolvedFile), { wait: 200 })

		chokidar
			.watch(resolvedFile, {
				ignoreInitial: true,
				// 防止编辑器“分块写”引发多次触发
				awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
			})
			.on('add', () => this.onDiskChange(resolvedFile))
			.on('change', () => this.onDiskChange(resolvedFile))
	}

	private requestSave() {
		// Avoid scheduling disk writes mid-batch; the outer batch() will trigger once on commit.
		if (this.batching > 0) {
			this.pendingSave = true
			return
		}
		this.saveDebounced()
	}

	// —— I/O 层 —— //

	private async loadFromDisk(file: string) {
		try {
			const txt = await this.ctx.root.fs.readText(file)

			const parsed = SuperJSON.parse(txt) as Partial<ConfigShape> & { enabled?: unknown }

			this.data.enabled.clear()
			const enabledList = Array.isArray(parsed.enabled)
				? (parsed.enabled as string[])
				: parsed?.enabled instanceof Set
					? Array.from(parsed.enabled as Set<string>)
					: []
			for (let i = 0; i < enabledList.length; i++) this.data.enabled.add(enabledList[i])

			const nextPlugins = parsed.plugins ? coercePlugins(parsed.plugins) : Object.create(null)
			this.reconcilePluginsFromDisk(nextPlugins)

			clearRecord(this.data.extra)
			if (parsed.extra) Object.assign(this.data.extra, parsed.extra)
		} catch {
			// 首次无文件：落一个干净默认
			this.data.enabled.clear()
			clearRecord(this.data.plugins)
			clearRecord(this.data.extra)
			this.configRevByPlugin.clear()
			this.configDigestByPlugin.clear()
			this.validated.clear()
			await this.saveToDisk(file)
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
			this.validated.delete(name)
		}
	}

	private bumpPluginRevision(name: string) {
		this.configRevByPlugin.set(name, ++this.configSeq)
		this.validated.delete(name)
	}

	// 原子写：交给 ctx.root.fs.writeTextAtomic，配合 writingNow 屏蔽自触发
	private async saveToDisk(file: string) {
		if (this.batching > 0) return // 事务中，先不写；提交时会统一触发
		this.writingNow = true
		try {
			const content = SuperJSON.stringify(this.data)
			await this.ctx.root.fs.writeTextAtomic(file, content)
		} finally {
			// 小幅延迟，给文件系统时间完成元数据刷新，避免极端条件下的回跳
			setTimeout(() => {
				this.writingNow = false
			}, 60)
		}
	}

	private async onDiskChange(file: string) {
		if (this.writingNow) return
		await this.loadFromDisk(file)
	}

	// —— 读接口 —— //

	/**
	 * 读取某插件的配置（不存在时返回只读“空视图”，避免误改未落盘）
	 */
	getRawConfig<T extends object = Record<string, unknown>>(
		name: string = this.ctx.pluginInfo?.id ?? 'default',
	): Readonly<T> {
		return (this.data.plugins[name] as T | undefined) ?? (ConfigService.EMPTY_CONFIG as T)
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
		schemaMap: Record<string, StandardSchemaV1>,
		options: { missingObjectDefault?: unknown } = {},
	): Promise<Readonly<Record<string, unknown>>> {
		await this.ready

		// Fast-path: if on-disk/in-memory revision didn't change AND schema object is identical,
		// return the cached validated snapshot.
		const curRev = this.getConfigRevision(pluginName)
		const cached = this.validated.get(pluginName)
		if (cached && cached.rev === curRev && cached.schemaMap === schemaMap) return cached.snapshot

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
		this.validated.set(pluginName, { rev, schemaMap, snapshot: res.snapshot })
		return res.snapshot
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
				this.saveDebounced()
			}
		}
	}

	/**
	 * 设置 / 覆盖配置条目（存在则浅合并）
	 */
	patchConfig<T extends object = Record<string, unknown>>(name: string, partial: Partial<T>) {
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
		if (this.data.extra[key] === value) return
		this.data.extra[key] = value
		this.requestSave()
	}

	/**
	 * 批量启用：ConfigService.enableInConfig('a', 'b', 'c')
	 */
	enableInConfig(...names: readonly string[]) {
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
