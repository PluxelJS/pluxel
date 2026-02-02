// rpc/HmrRpcApi.ts - 主 RPC API
import type { Context } from '@pluxel/core'
import { RpcTarget } from 'capnweb'
import type { UI } from '../../../services'
import { writeGroups } from '../../features/groups/service'
import { applyStatusActions } from '../../usecases/pluginStatus'
import { LoggingHandle } from './LoggingHandle'
import { PackageHandle } from './PackageHandle'
import { PluginHandle } from './PluginHandle'
import type {
	PluginGroup,
	PluginGroupInput,
	PluginStatusBatchAction,
	PluginStatusBatchResult,
} from './types'

export class HmrRpcApi extends RpcTarget {
	private readonly ctx: Context
	private readonly extView: UI.rpc

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

	/**
	 * 访问插件注册的 RPC 扩展
	 * @example rpc.ext['my-plugin'].method()
	 */
	get ext(): UI.rpc {
		return this.extView
	}

	/**
	 * 列出所有已注册的 RPC 扩展命名空间
	 */
	extensions(): string[] {
		return this.ctx.ext.rpc.getNamespaces()
	}

	async buildSnapshot() {
		try {
			const ctor = this.ctx.loader.api.registry.getCtor('Snapshot')
			if (!ctor) {
				return {
					ok: false as const,
					error: 'Snapshot plugin is not loaded (enable builtin @pluxel/snapshot).',
				}
			}

			const instance = this.ctx.registry.getInstance(ctor as never) as unknown
			const generateSnapshotFiles = (instance as { generateSnapshotFiles?: unknown })
				?.generateSnapshotFiles
			if (typeof generateSnapshotFiles !== 'function') {
				return {
					ok: false as const,
					error: 'Snapshot plugin is not running (enable it in config).',
				}
			}

			const res = await (generateSnapshotFiles as () => Promise<unknown>)()
			const configPath = (res as { configPath?: unknown } | null | undefined)?.configPath
			return { ok: true as const, path: typeof configPath === 'string' ? configPath : '' }
		} catch (error) {
			return { ok: false as const, error: (error as Error)?.message ?? 'Unknown error' }
		}
	}

	updatePluginStatuses(actions: PluginStatusBatchAction[]): Promise<PluginStatusBatchResult> {
		return applyStatusActions(this.ctx, actions ?? [])
	}

	updatePluginGroups(groups: PluginGroupInput[]): Promise<PluginGroup[]> {
		const safe = Array.isArray(groups) ? groups : []
		return Promise.resolve(writeGroups(this.ctx, safe))
	}
}
