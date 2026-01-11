import { type Context, Injectable, OverrideOf } from '@pluxel/core'
import { ConfigService as CoreConfigService } from '@pluxel/core/services'
import { debounce } from '@tanstack/pacer'
import chokidar from 'chokidar'
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

	// 自写屏蔽：写盘到落盘结束这段时间内忽略变更事件
	private writingNow = false
	private batching = 0 // 事务计数

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

	// —— I/O 层 —— //

	private async loadFromDisk(file: string) {
		try {
			const txt = await this.ctx.fs.readText(file)

			const parsed = SuperJSON.parse(txt) as Partial<ConfigShape> & { enabled?: unknown }

			this.data.enabled.clear()
			const enabledList = Array.isArray(parsed.enabled)
				? (parsed.enabled as string[])
				: parsed?.enabled instanceof Set
					? Array.from(parsed.enabled as Set<string>)
					: []
			for (let i = 0; i < enabledList.length; i++) this.data.enabled.add(enabledList[i])

			clearRecord(this.data.plugins)
			if (parsed.plugins) Object.assign(this.data.plugins, coercePlugins(parsed.plugins))

			clearRecord(this.data.extra)
			if (parsed.extra) Object.assign(this.data.extra, parsed.extra)
		} catch {
			// 首次无文件：落一个干净默认
			this.data.enabled.clear()
			clearRecord(this.data.plugins)
			clearRecord(this.data.extra)
			await this.saveToDisk(file)
		}
	}

	// 原子写：交给 ctx.fs.writeTextAtomic，配合 writingNow 屏蔽自触发
	private async saveToDisk(file: string) {
		if (this.batching > 0) return // 事务中，先不写；提交时会统一触发
		this.writingNow = true
		try {
			const content = SuperJSON.stringify(this.data)
			await this.ctx.fs.writeTextAtomic(file, content)
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
	getConfig<T extends object = Record<string, unknown>>(
		name: string = this.ctx.pluginInfo?.id ?? 'default',
	): Readonly<T> {
		return (this.data.plugins[name] as T | undefined) ?? (ConfigService.EMPTY_CONFIG as T)
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
			if (this.batching === 0) this.saveDebounced()
		}
	}

	/**
	 * 设置 / 覆盖配置条目（存在则浅合并）
	 */
	patchConfig<T extends object = Record<string, unknown>>(name: string, partial: Partial<T>) {
		const entry = (this.data.plugins[name] ??= Object.create(null))
		Object.assign(entry, partial)
		this.saveDebounced()
	}

	setExtra(key: string, value: unknown) {
		this.data.extra[key] = value
		this.saveDebounced()
	}

	/**
	 * 批量启用：ConfigService.enableInConfig('a', 'b', 'c')
	 */
	enableInConfig(...names: readonly string[]) {
		for (let i = 0; i < names.length; i++) this.data.enabled.add(names[i])
		this.saveDebounced()
	}

	/**
	 * 批量禁用：ConfigService.disableInConfig('a', 'b')
	 */
	disableInConfig(...names: readonly string[]) {
		for (let i = 0; i < names.length; i++) this.data.enabled.delete(names[i])
		this.saveDebounced()
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
		this.data.enabled.clear()
		for (const n of names) this.data.enabled.add(n)
		this.saveDebounced()
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
			out[name] = record as Record<string, unknown>
		} else {
			out[name] = raw as Record<string, unknown>
		}
	}
	return out
}
