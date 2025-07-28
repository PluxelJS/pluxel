import fs from 'node:fs/promises'
import { type Context, Injectable } from '@pluxel/core'
import { debounce } from '@tanstack/pacer'
import chokidar, { type FSWatcher } from 'chokidar'
import { SuperJSON } from 'superjson'

// —— 1. 定义通用的 metadata 结构 ——
export interface PluginMeta {
	dir?: string
	version?: string
	// …以后还可以加 author、license、enabledAt……
	[key: string]: unknown
}

// —— 2. 插件条目，T 是业务 config 的类型 ——
export interface PluginEntry<T extends object = {}> {
	meta: PluginMeta
	config: T
}

// —— 3. 全局配置结构 ——
export interface ConfigShape {
	enabled: string[] // 启用列表
	plugins: Record<string, PluginEntry> // 插件名 → 条目
}

const DEFAULT_CONFIG: ConfigShape = {
	enabled: [],
	plugins: {},
}

@Injectable
export class ConfigService {
	static key = 'configService'
	private data: ConfigShape = DEFAULT_CONFIG
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
			const txt = await fs.readFile(file, 'utf-8')
			this.data = SuperJSON.parse(txt)
		} catch {
			this.data = DEFAULT_CONFIG
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
	getConfig<T extends object = {}>(
		name: string = this.ctx.name,
	): PluginEntry<T> {
		const entry =
			this.data.plugins[name] || ({ meta: {}, config: {} } as PluginEntry<T>)
		return entry as PluginEntry<T>
	}

	/**
	 * 一次更新 meta 和/或 config
	 * @typeParam T 插件业务配置类型
	 * @param name 插件名
	 * @param partial.meta 要更新的元信息
	 * @param partial.config 要更新的业务配置
	 */
	setConfig<T extends object = {}>(
		name: string,
		partial: Partial<PluginEntry<T>>,
	) {
		// biome-ignore lint/suspicious/noAssignInExpressions: <explanation>
		const entry = (this.data.plugins[name] ||= { meta: {}, config: {} })
		if (partial.meta) Object.assign(entry.meta, partial.meta)
		if (partial.config) Object.assign(entry.config, partial.config)
		this.saveDebounced()
	}

	isEnable(name: string): boolean {
		return this.data.enabled.includes(name)
	}
}
