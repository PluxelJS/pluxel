import { mkdir } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { type Context, Injectable } from '@pluxel/core'
import type { BaseItem, PersistenceAdapter } from '@signaldb/core'
import createFilesystemAdapter from '@signaldb/fs'
import { SuperJSON } from 'superjson'

const serviceName = 'pluginData' as const

declare module '@pluxel/core' {
	interface Context {
		[serviceName]: PluginDataService
	}
}

@Injectable({ key: serviceName })
export class PluginDataService {
	private baseDir: string

	constructor(private ctx: Context) {
		const cfg = (ctx.config as any)?.pluginData ?? {}
		const dir = cfg.dir ?? cfg.baseDir ?? '.pluxel/plugin-data'
		this.baseDir = resolve(dir)
	}

	/**
	 * 为 SignalDB 创建文件持久化适配器。
	 * - namespace 强制使用插件名（唯一标识）
	 * - 插件自行 new Collection({ persistence: adapter })
	 */
	async persistence<T extends BaseItem<string> = BaseItem<string>>(
		options?: {
			serialize?: (items: T[]) => string
			deserialize?: (txt: string) => T[]
		},
	): Promise<PersistenceAdapter<T, string>> {
		const ns = this.normalizeNamespace(this.ctx.pluginInfo?.name ?? 'default')
		const file = this.fileForNamespace(ns)

		await mkdir(dirname(file), { recursive: true })
		return createFilesystemAdapter<T, string>(file, {
			serialize: options?.serialize ?? ((items) => SuperJSON.stringify(items)),
			deserialize: (txt) => {
				try {
					return (options?.deserialize?.(txt) ??
						(SuperJSON.parse(txt) as T[]) ??
						[]) as T[]
				} catch {
					return []
				}
			},
		})
	}

	/** 获取对应 namespace 的默认存储文件路径（已规范化）。 */
	getFilePath(): string {
		return this.fileForNamespace(this.normalizeNamespace(this.ctx.pluginInfo?.name ?? 'default'))
	}

	private fileForNamespace(namespace: string): string {
		const safe = this.normalizeNamespace(namespace)
		return resolve(this.baseDir, `${safe}.json`)
	}

	private normalizeNamespace(ns: string): string {
		const trimmed = ns || 'default'
		return basename(trimmed).replace(/[^A-Za-z0-9_\-]/g, '_')
	}
}
