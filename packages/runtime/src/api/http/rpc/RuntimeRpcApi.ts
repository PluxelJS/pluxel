// rpc/RuntimeRpcApi.ts - 主 RPC API
import type { Context } from '@pluxel/core'
import { RpcTarget } from 'capnweb'
import type { ExtensionUiRpcMap } from '../../../services'
import { writeGroups } from '../../features/groups/service'
import { applyStatusActions } from '../../usecases/pluginStatus'
import { ExtensionSessionHandle } from './ExtensionSessionHandle'
import { LoggingHandle } from './LoggingHandle'
import { PackageHandle } from './PackageHandle'
import { PluginHandle } from './PluginHandle'
import type {
	PluginGroup,
	PluginGroupInput,
	PluginStatusBatchAction,
	PluginStatusBatchResult,
} from '../../../web/protocol'

export class RuntimeRpcApi extends RpcTarget {
	private readonly ctx: Context
	private readonly extView: ExtensionUiRpcMap

	constructor(ctx: Context) {
		super()
		this.ctx = ctx
		this.extView = ctx.ext.rpc.createExtensionsView(ctx)
	}

	ping() {
		return 'hmr-rpc:ok'
	}

	plugin(name: string) {
		return new PluginHandle(this.ctx, name)
	}

	/** 包管理操作 */
	package() {
		return new PackageHandle(this.ctx)
	}

	/** Logging settings (host-level, persisted). */
	logging() {
		return new LoggingHandle(this.ctx)
	}

	/** Cross-plugin interaction sessions (surface/offer lifecycle). */
	ui() {
		return new ExtensionSessionHandle(this.ctx)
	}

	/**
	 * 访问插件注册的 RPC 扩展
	 * @example rpc.ext['my-plugin'].method()
	 */
	get ext(): ExtensionUiRpcMap {
		return this.extView
	}

	/**
	 * 列出所有已注册的 RPC 扩展命名空间
	 */
	extensions(): string[] {
		return this.ctx.ext.rpc.getNamespaces()
	}

	async buildSnapshot() {
		return {
			ok: false as const,
			error: 'Snapshot builder is temporarily unavailable while the plugin is being rewritten.',
		}
	}

	updatePluginStatuses(actions: PluginStatusBatchAction[]): Promise<PluginStatusBatchResult> {
		return applyStatusActions(this.ctx, actions ?? [])
	}

	async updatePluginGroups(groups: PluginGroupInput[]): Promise<PluginGroup[]> {
		const safe = Array.isArray(groups) ? groups : []
		return writeGroups(this.ctx, safe)
	}
}
