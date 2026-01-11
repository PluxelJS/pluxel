// rpc/HmrRpcApi.ts - 主 RPC API
import type { Context } from '@pluxel/core'
import { RpcTarget } from 'capnweb'
import { resolve } from 'pathe'
import type { UI } from '../../../services'
import { writeGroups } from '../../features/groups/service'
import { PackageHandle } from './PackageHandle'
import { applyStatusActions, PluginHandle } from './PluginHandle'
import type {
	PluginGroup,
	PluginGroupInput,
	PluginStatusBatchAction,
	PluginStatusBatchResult,
} from './types'

export class HmrRpcApi extends RpcTarget {
	#ctx: Context
	#ext: UI.rpc

	constructor(ctx: Context) {
		super()
		this.#ctx = ctx
		this.#ext = ctx.ext.rpc.createExtensionsView(ctx)
	}

	ping() {
		return 'hmr-rpc:ok'
	}

	plugin(name: string) {
		return new PluginHandle(this.#ctx, name)
	}

	/** 包管理操作 */
	package() {
		return new PackageHandle(this.#ctx)
	}

	/**
	 * 访问插件注册的 RPC 扩展
	 * @example rpc.ext['my-plugin'].method()
	 */
	get ext(): UI.rpc {
		return this.#ext
	}

	/**
	 * 列出所有已注册的 RPC 扩展命名空间
	 */
	extensions(): string[] {
		return this.#ctx.ext.rpc.getNamespaces()
	}

	async buildSnapshot() {
		try {
			const content = this.#ctx.loader.buildSnapshot()
			const path = resolve(process.cwd(), 'snapshot.ts')
			await this.#ctx.fs.writeTextAtomic(path, content)
			return { ok: true as const, path }
		} catch (error) {
			return { ok: false as const, error: (error as Error)?.message ?? 'Unknown error' }
		}
	}

	updatePluginStatuses(actions: PluginStatusBatchAction[]): Promise<PluginStatusBatchResult> {
		return applyStatusActions(this.#ctx, actions ?? [])
	}

	updatePluginGroups(groups: PluginGroupInput[]): Promise<PluginGroup[]> {
		const safe = Array.isArray(groups) ? groups : []
		return Promise.resolve(writeGroups(this.#ctx, safe))
	}
}
