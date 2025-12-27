// rpc/PackageHandle.ts - 包管理 RPC
import type { Context } from '@pluxel/core'
import { RpcTarget } from 'capnweb'
import { applyMarketMutation, listLoadIssues, listPackageInventory } from '../../features/market/service'
import type { PackageBatchResult, PackageMutationInput } from './types'

export class PackageHandle extends RpcTarget {
	#ctx: Context

	constructor(ctx: Context) {
		super()
		this.#ctx = ctx
	}

	/** 列出加载问题 */
	loadIssues() {
		return listLoadIssues(this.#ctx)
	}

	/** 列出已安装的包 */
	inventory(options?: { includeUntracked?: boolean }) {
		return listPackageInventory(this.#ctx, options)
	}

	/** 执行包管理操作 */
	mutate(input: PackageMutationInput): Promise<PackageBatchResult> {
		return applyMarketMutation(this.#ctx, input)
	}
}
