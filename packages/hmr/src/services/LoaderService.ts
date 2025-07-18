// services/LoaderService.ts
import {
	type Context,
	Injectable,
	type PluginClass,
	getPluginMeta,
} from '@pluxel/core'
import { readPackageJSON } from 'pkg-types'
import { getAllTsFiles } from './utils'
declare module '@pluxel/core' {
	interface Context {
		loader: LoaderService
	}
}

@Injectable
export class LoaderService {
	static key = 'loader'
	public ctorMap = new Map<string, PluginClass>()
	public nameMap = new Map<string, PluginClass>()

	constructor(private ctx: Context) {}

	/**
	 * 接收已加载的模块和它的标识（通常是文件路径）。
	 * 只负责扫描 module 里被 @Plugin 标记的类并注册
	 */
	loadFileModule(id: string, mod: any) {
		this.unloadFileModule(id)
		for (const exp of Object.values(mod)) {
			if (typeof exp !== 'function') continue
			const meta = getPluginMeta('META_KEY', exp)
			if (!meta) continue
			const ctor = exp as PluginClass
			this.ctorMap.set(id, ctor)
			this.nameMap.set(meta.name, ctor)
			if (true || this.ctx.configService.isEnable(meta.name)) {
				this.ctx.registry.pluginRegistry.registerPlugin(ctor)
				// this.ctx.registry.commit()
			}
		}
	}

	/** 卸载单个文件对应的插件 */
	unloadFileModule(id: string) {
		if (this.ctorMap.has(id)) {
			const ctor = this.ctorMap.get(id)!
			this.ctx.registry.pluginRegistry.unregisterPlugin(ctor)
			this.ctorMap.delete(id)
			// this.ctx.registry.commit()
		}
	}

	/**
	 * 遍历多个目录中的 .ts 文件（不监听）
	 * @param {string[]} dirs - 要遍历的目录路径
	 * @returns {Promise<string[]>} 所有匹配的文件路径
	 */
	getAllTsFiles(dirs: string[]): Promise<string[]> {
		return getAllTsFiles(dirs)
	}

	scanDirs(dirs: string[]): Promise<(string | undefined)[]> {
		return Promise.all(
			dirs.map(async (d) => {
				const { exports: exportDefine } = await readPackageJSON(d)
				if (typeof exportDefine !== 'object' || Array.isArray(exportDefine)) {
					return
				}
				for (const [key, path] of Object.entries(exportDefine)) {
					if (key === '@pluxel/source' && typeof path === 'string') {
						return path // 只在真正匹配时才返回
					}
				}
				return
			}),
		)
	}

	getLoadedPluginsName(): string[] {
		return [...this.nameMap.keys()]
	}

	getPluginConfig(target: PluginClass) {
		return getPluginMeta('CONFIG_MAP', target)
	}
}
