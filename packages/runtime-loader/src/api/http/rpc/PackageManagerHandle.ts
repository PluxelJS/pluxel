// rpc/PackageManagerHandle.ts - loader route package-management RPC
import type { Context } from '@pluxel/core'
import { RpcTarget } from 'capnweb'
import {
	applyPackageMutation,
	listLoadIssues,
	listPackageInventory,
} from '../../features/package-manager/service'
import type {
	PackageBatchResult,
	PackageInventoryEntry,
	PackageInventoryFilter,
	PackageLoadIssue,
	PackageMutationInput,
} from '@pluxel/runtime/protocol'

export class PackageManagerHandle extends RpcTarget {
	private readonly ctx: Context

	constructor(ctx: Context) {
		super()
		this.ctx = ctx
	}

	/** 执行包管理操作 */
	mutate(input: PackageMutationInput): Promise<PackageBatchResult> {
		return applyPackageMutation(this.ctx, input)
	}

	/** 读取包清单 */
	inventory(filter?: PackageInventoryFilter): Promise<PackageInventoryEntry[]> {
		return listPackageInventory(this.ctx, filter)
	}

	/** 读取加载问题列表 */
	loadIssues(): Promise<PackageLoadIssue[]> {
		return Promise.resolve(listLoadIssues(this.ctx))
	}
}
