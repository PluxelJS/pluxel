import fs from 'node:fs/promises'
import { type Context, Injectable } from '@pluxel/core'
import { debounce } from '@tanstack/pacer'
import chokidar, { type FSWatcher } from 'chokidar'
import { SuperJSON } from 'superjson'

type pluginName = string
interface ConfigShape {
	// 用来存储哪些插件开启
	enabled: pluginName[]
	plugins: {
		[p: pluginName]: {
			dir?: string
			config: {
				[configName: string | symbol]: any
			}
		}
	}
}

const DEFAULT_CONFIG: ConfigShape = { enabled: [], plugins: {} }

declare module '@pluxel/core' {
	interface Context {
		configService: ConfigService
	}
}

@Injectable
export class ConfigService {
	static key = 'configService'
	private data: ConfigShape = DEFAULT_CONFIG
	private watcher: FSWatcher
	private isWriting = false // 写盘标记
	private saveDebounced: () => void

	constructor(private ctx: Context) {
		// 1. 确定文件路径
		const file = ctx.config.path ?? 'default.json'
		// 2. 载入并初始化
		this.loadFromDisk(file)
		// 3. 防抖写盘
		this.saveDebounced = debounce(() => this.saveToDisk(file), { wait: 200 })
		// 4. 监听外部改动
		this.watcher = chokidar
			.watch(file, { ignoreInitial: true })
			.on('change', () => this.onDiskChange(file))
	}

	/** 读盘到 this.data */
	private async loadFromDisk(file: string) {
		try {
			const txt = await fs.readFile(file, 'utf-8')
			this.data = SuperJSON.parse(txt)
		} catch {
			// 文件不存在或解析失败，都回退到默认并落盘
			this.data = DEFAULT_CONFIG
			await this.saveToDisk(file)
		}
	}

	/** 将 this.data 写回文件 */
	private async saveToDisk(file: string) {
		this.isWriting = true
		const content = SuperJSON.stringify(this.data)
		await fs.writeFile(file, content, 'utf-8')
		// 小延迟后重置标记，避免 chokidar 触发
		setTimeout(() => {
			this.isWriting = false
		}, 100)
	}

	/** 磁盘文件被改，重新 load 并通知 */
	private async onDiskChange(file: string) {
		if (this.isWriting) return // 忽略自写触发
		await this.loadFromDisk(file)
	}

	isEnable(name: pluginName): boolean {
		return this.data.enabled.includes(name)
	}
	/** 取某个插件的 config 对象 */
	getConfig<T = any>(name: pluginName = this.ctx.name): T {
		const p = this.data.plugins[name]
		return (p?.config ?? {}) as T
	}

	/** 合并更新内存，并排期写盘 */
	setConfig<T = any>(name: pluginName, partial: Partial<T>) {
		// biome-ignore lint/suspicious/noAssignInExpressions: <explanation>
		const entry = (this.data.plugins[name] ||= { dir: undefined, config: {} })
		Object.assign(entry.config, partial)
		this.saveDebounced()
	}
}
