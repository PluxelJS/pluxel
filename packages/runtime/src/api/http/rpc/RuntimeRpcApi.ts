// rpc/RuntimeRpcApi.ts - 主 RPC API
import type { Context } from '@pluxel/core'
import { errors } from '@pluxel/ops'
import { RpcTarget } from 'capnweb'
import type { ExtensionUiRpcMap } from '../../../services'
import {
	dispatchRuntimeCommand,
	ensureRuntimeOpsRegistered,
	getRuntimeOps,
	invokeRuntimeOp,
} from '../../ops'
import { writeGroups } from '../../features/groups/service'
import { ExtensionSessionHandle } from './ExtensionSessionHandle'
import { LoggingHandle } from './LoggingHandle'
import { PackageHandle } from './PackageHandle'
import type {
	PluginGroup,
	PluginGroupInput,
} from '../../../web/protocol'

export class RuntimeRpcApi extends RpcTarget {
	private readonly ctx: Context
	private readonly extView: ExtensionUiRpcMap

	constructor(ctx: Context) {
		super()
		this.ctx = ctx
		ensureRuntimeOpsRegistered(ctx)
		this.extView = ctx.ext.rpc.createExtensionsView(ctx)
	}

	ping() {
		return 'hmr-rpc:ok'
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

	opsList() {
		return getRuntimeOps(this.ctx)
	}

	async opsInvoke(id: string, input?: unknown): Promise<unknown> {
		const descriptor = this.ctx.ext.ops.getDescriptor(id)
		if (descriptor && descriptor.exposure.rpc !== true) {
			throw new errors.OpError('E_FORBIDDEN', 'Operation not exposed over RPC', {
				details: { node: id, reason: 'rpc_not_exposed' },
				message: `Operation "${id}" is not exposed over RPC`,
			})
		}
		return await invokeRuntimeOp(this.ctx, id, input, 'rpc')
	}

	async opsDispatch(command: string): Promise<unknown> {
		return await dispatchRuntimeCommand(this.ctx, command, 'rpc')
	}

	async updatePluginGroups(groups: PluginGroupInput[]): Promise<PluginGroup[]> {
		const safe = Array.isArray(groups) ? groups : []
		return writeGroups(this.ctx, safe)
	}
}
