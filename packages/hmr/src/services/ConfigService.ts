import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import { type Context, Injectable } from '@pluxel/core'
import { debounce } from '@tanstack/pacer'
import chokidar, { type FSWatcher } from 'chokidar'
import { SuperJSON } from 'superjson'

// —— 1. 定义通用的 metadata 结构 ——
export interface pluginInfo {
	dir?: string
	version?: string
	// …以后还可以加 author、license、enabledAt……
	[key: string]: unknown
}

// —— 2. 插件条目，T 是业务 config 的类型 ——
export interface PluginEntry<T extends object = {}> {
	meta: pluginInfo
	configRecord: T
}

// —— 3. 全局配置结构 ——
export interface ConfigShape {
	enabled: Set<string> // 启用列表
	plugins: Record<string, PluginEntry> // 插件名 → 条目
	extra: Record<string, any>
}

@Injectable({ key: 'configService' })
export class ConfigService {
	private data!: ConfigShape
	private watcher!: FSWatcher
	private isWriting = false
	private saveDebounced: () => void

	constructor(private ctx: Context) {
		const file = ctx.config.path ?? 'default.json'
		this.loadFromDisk(file)
		this.saveDebounced = debounce(() => this.saveToDisk(file), { wait: 200 })
		this.watcher = chokidar
			.watch(file, { ignoreInitial: true })
			.on('change', () => this.onDiskChange(file))
	}

	private async loadFromDisk(file: string) {
		try {
			let txt: string
			if (import.meta.hot) {
				txt = await fs.readFile(file, 'utf-8')
			} else {
				txt = readFileSync(file, 'utf-8')
			}
			// parse may give us a raw object if there's no metadata
			const parsed = SuperJSON.parse(txt) as ConfigShape & { enabled?: unknown }
			this.data = {
				// ensure enabled is always a Set<string>
				enabled: new Set(
					Array.isArray(parsed.enabled)
						? (parsed.enabled as string[])
						: parsed.enabled instanceof Set
							? Array.from(parsed.enabled as Set<string>)
							: [],
				),
				plugins: parsed.plugins ?? {},
				extra: parsed.extra ?? {},
			}
		} catch {
			// create a fresh default, never re-use the same DEFAULT_CONFIG object
			this.data = {
				enabled: new Set(),
				plugins: {},
				extra: {},
			}
			await this.saveToDisk(file)
		}
	}

	private async saveToDisk(file: string) {
		this.isWriting = true
		const content = SuperJSON.stringify(this.data)
		await fs.writeFile(file, content, 'utf-8')
		setTimeout(() => {
			this.isWriting = false
		}, 100)
	}

	private async onDiskChange(file: string) {
		if (this.isWriting) return
		await this.loadFromDisk(file)
	}

	/**
	 * 一次拉取 meta + config
	 * @typeParam T 插件业务配置类型
	 */
	getConfig<T extends object = Record<string, any>>(
		name: string = this.ctx.pluginInfo.meta.name,
	): PluginEntry<T> {
		const entry = this.data.plugins[name] || ({ meta: {}, configRecord: {} } as PluginEntry<T>)
		return entry as PluginEntry<T>
	}

	/**
	 * 一次更新 meta 和/或 config
	 * @typeParam T 插件业务配置类型
	 * @param name 插件名
	 * @param partial.meta 要更新的元信息
	 * @param partial.config 要更新的业务配置
	 */
	setConfig<T extends object = { [key: string]: any }>(
		name: string,
		partial: Partial<PluginEntry<T>>,
	) {
		// biome-ignore lint/suspicious/noAssignInExpressions: <explanation>
		const entry = (this.data.plugins[name] ||= { meta: {}, configRecord: {} })
		if (partial.meta) Object.assign(entry.meta, partial.meta)
		if (partial.configRecord) Object.assign(entry.configRecord, partial.configRecord)
		this.saveDebounced()
	}

	getExtra(key: string) {
		return this.data.extra[key]
	}
	setExtra(key: string, data: any) {
		this.data.extra[key] = data
		this.saveDebounced()
	}

	isEnable(name: string): boolean {
		return this.data.enabled.has(name)
	}
	enablePlugin(name: string[] | string): void {
		if (Array.isArray(name)) {
			for (const n of name) {
				this.data.enabled.add(n)
			}
		} else {
			this.data.enabled.add(name)
		}
		this.saveDebounced()
	}
	disablePlugin(name: string[] | string): void {
		if (Array.isArray(name)) {
			for (const n of name) {
				this.data.enabled.delete(n)
			}
		} else {
			this.data.enabled.delete(name)
		}
		this.saveDebounced()
	}
}

declare module '@pluxel/core' {
	interface Context {
		configService: ConfigService
	}
}
