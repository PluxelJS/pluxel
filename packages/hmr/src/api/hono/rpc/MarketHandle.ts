// rpc/MarketHandle.ts - 包管理 RPC
import type { Context } from '@pluxel/core'
import { RpcTarget } from 'capnweb'
import {
	installPackage,
	installPackages,
	listLoadIssues,
	listPackageInventory,
	reinstallPackage,
	reinstallPackages,
	reloadPackages,
	removePackage,
	removePackages,
	retryFailedPackages,
	retryPackage,
	toServiceSpecifierInput,
	uninstallPackage,
	uninstallPackages,
} from '../../features/market/service'
import type { PackageSpecInput, MarketMutationResult, MarketBatchResult } from './types'

export class MarketHandle extends RpcTarget {
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

	/** 安装单个包 */
	install(spec: PackageSpecInput, options?: { force?: boolean }): Promise<MarketMutationResult> {
		return installPackage(this.#ctx, spec, options?.force)
	}

	/** 批量安装 */
	installMany(
		specs: PackageSpecInput[],
		options?: { force?: boolean },
	): Promise<MarketBatchResult> {
		return installPackages(this.#ctx, specs, options?.force)
	}

	/** 卸载单个包 */
	uninstall(spec: PackageSpecInput): Promise<MarketMutationResult> {
		return uninstallPackage(this.#ctx, spec)
	}

	/** 批量卸载 */
	uninstallMany(specs: PackageSpecInput[]): Promise<MarketBatchResult> {
		return uninstallPackages(this.#ctx, specs)
	}

	/** 移除单个包（从 manifest 中移除但不卸载） */
	remove(spec: PackageSpecInput): Promise<MarketMutationResult> {
		return removePackage(this.#ctx, spec)
	}

	/** 批量移除 */
	removeMany(specs: PackageSpecInput[]): Promise<MarketBatchResult> {
		return removePackages(this.#ctx, specs)
	}

	/** 重装单个包 */
	reinstall(spec: PackageSpecInput, options?: { force?: boolean }): Promise<MarketMutationResult> {
		return reinstallPackage(this.#ctx, spec, { force: options?.force })
	}

	/** 批量重装 */
	reinstallMany(
		specs: PackageSpecInput[],
		options?: { force?: boolean },
	): Promise<MarketBatchResult> {
		return reinstallPackages(this.#ctx, specs, { force: options?.force })
	}

	/** 重载包（不重装） */
	reloadMany(specs: PackageSpecInput[], options?: { fresh?: boolean }): Promise<MarketBatchResult> {
		return reloadPackages(this.#ctx, specs, { fresh: options?.fresh ?? true })
	}

	/** 重试加载失败的包 */
	retry(
		spec: PackageSpecInput,
		options?: { reinstall?: boolean; fresh?: boolean },
	): Promise<MarketMutationResult> {
		return retryPackage(this.#ctx, spec, {
			reinstall: options?.reinstall ?? false,
			fresh: options?.fresh ?? true,
		})
	}

	/** 重试所有失败的包 */
	retryAllFailed(options?: { reinstall?: boolean; fresh?: boolean }): Promise<MarketBatchResult> {
		return retryFailedPackages(this.#ctx, {
			reinstall: options?.reinstall ?? false,
			fresh: options?.fresh ?? true,
		})
	}
}
