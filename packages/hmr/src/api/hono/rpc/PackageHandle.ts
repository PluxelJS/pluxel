// rpc/PackageHandle.ts - 包管理 RPC
import type { Context } from '@pluxel/core'
import { RpcTarget } from 'capnweb'
import { applyMarketMutation, listLoadIssues, listPackageInventory } from '../../features/market/service'
import type {
	PackageBatchResult,
	PackageInventoryEntry,
	PackageInventoryFilter,
	PackageLoadIssue,
	PackageMutationInput,
} from './types'

export class PackageHandle extends RpcTarget {
	#ctx: Context

	constructor(ctx: Context) {
		super()
		this.#ctx = ctx
	}

	/** 执行包管理操作 */
	mutate(input: PackageMutationInput): Promise<PackageBatchResult> {
		return applyMarketMutation(this.#ctx, input)
	}

	/** 读取包清单 */
	inventory(filter?: PackageInventoryFilter): Promise<PackageInventoryEntry[]> {
		return listPackageInventory(this.#ctx, filter)
	}

	/** 读取加载问题列表 */
	async loadIssues(): Promise<PackageLoadIssue[]> {
		return listLoadIssues(this.#ctx)
	}
}
