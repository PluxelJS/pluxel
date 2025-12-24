// rpc/HmrRpcApi.ts - 主 RPC API
import { writeFile } from 'node:fs/promises'
import type { Context } from '@pluxel/core'
import { RpcTarget } from 'capnweb'
import { resolve } from 'pathe'
import * as v from 'valibot'
import type { RpcExtensions } from '../../../services'
import { PluginGroupInput, type PluginGroupInputValue } from '../../features/groups/schema'
import { readGroups, writeGroups } from '../../features/groups/service'
import { getStatusOverview } from '../../features/pluginStatus/service'
import { MarketHandle } from './MarketHandle'
import { applyStatusActions, PluginHandle } from './PluginHandle'
import type { GroupMutationResult, PluginStatusBatchAction, PluginStatusBatchResult } from './types'
import { formatGroupIssues } from './utils'

export class HmrRpcApi extends RpcTarget {
	#ctx: Context
	#ext: RpcExtensions

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
	market() {
		return new MarketHandle(this.#ctx)
	}

	/**
	 * 访问插件注册的 RPC 扩展
	 * @example rpc.ext['my-plugin'].method()
	 */
	get ext(): RpcExtensions {
		return this.#ext
	}

	/**
	 * 列出所有已注册的 RPC 扩展命名空间
	 */
	extensions(): string[] {
		return this.#ctx.ext.rpc.getNamespaces()
	}

	pluginStatus() {
		return getStatusOverview(this.#ctx)
	}

	async buildSnapshot() {
		try {
			const content = this.#ctx.loader.buildSnapshot()
			const path = resolve(process.cwd(), 'snapshot.ts')
			await writeFile(path, content, 'utf8')
			return { ok: true as const, path }
		} catch (error) {
			return { ok: false as const, error: (error as Error)?.message ?? 'Unknown error' }
		}
	}

	pluginGroups(): ReturnType<typeof readGroups> {
		return readGroups(this.#ctx)
	}

	updatePluginGroups(groups: PluginGroupInputValue[]): GroupMutationResult {
		const parsed = v.safeParse(v.array(PluginGroupInput), groups)
		if (!parsed.success) {
			return { ok: false, code: 'validation_failed', errors: formatGroupIssues(parsed.issues) }
		}
		return { ok: true, groups: writeGroups(this.#ctx, parsed.output) }
	}

	updatePluginStatuses(actions: PluginStatusBatchAction[]): Promise<PluginStatusBatchResult> {
		return applyStatusActions(this.#ctx, actions ?? [])
	}
}
