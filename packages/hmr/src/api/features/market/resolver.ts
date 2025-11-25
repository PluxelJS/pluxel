import { mutation, query, resolver } from '@gqloom/core'
import type { Context as PlxContext } from '@pluxel/core'
import * as v from 'valibot'

import {
	PackageBatchMutationResult,
	PackageLoadIssueEntry,
	PackageInventoryEntry,
	PackageInventoryFilter,
	PackageMutationResult,
	PackageSpecifierInput as PackageSpecifierInputSchema,
} from './schema'
import {
	installPackage,
	installPackages,
	listPackageInventory,
	listPackageInventoryWithFilter,
	listLoadIssues,
	removePackage,
	removePackages,
	reinstallPackage,
	reinstallPackages,
	retryFailedPackages,
	retryPackage,
	uninstallPackage,
	uninstallPackages,
	reloadPackages,
} from './service'

export function createMarketResolver(pCtx: PlxContext) {
	return resolver({
		packageLoadIssues: query(v.array(PackageLoadIssueEntry)).resolve(() => listLoadIssues(pCtx)),
		packageInventory: query(v.array(PackageInventoryEntry))
			.input(PackageInventoryFilter)
			.resolve(({ includeUntracked }) => listPackageInventory(pCtx, { includeUntracked })),
		installPackage: mutation(PackageMutationResult)
			.input({
				spec: PackageSpecifierInputSchema,
				force: v.nullish(v.boolean()),
			})
			.resolve(({ spec, force }) => installPackage(pCtx, spec, force ?? undefined)),
		installPackages: mutation(PackageBatchMutationResult)
			.input({
				specs: v.array(PackageSpecifierInputSchema),
				force: v.nullish(v.boolean()),
			})
			.resolve(({ specs, force }) => installPackages(pCtx, specs, force ?? undefined)),
		removePackage: mutation(PackageMutationResult)
			.input({
				spec: PackageSpecifierInputSchema,
			})
			.resolve(({ spec }) => removePackage(pCtx, spec)),
		removePackages: mutation(PackageBatchMutationResult)
			.input({
				specs: v.array(PackageSpecifierInputSchema),
			})
			.resolve(({ specs }) => removePackages(pCtx, specs)),
		uninstallPackage: mutation(PackageMutationResult)
			.input({
				spec: PackageSpecifierInputSchema,
			})
			.resolve(({ spec }) => uninstallPackage(pCtx, spec)),
		uninstallPackages: mutation(PackageBatchMutationResult)
			.input({
				specs: v.array(PackageSpecifierInputSchema),
			})
			.resolve(({ specs }) => uninstallPackages(pCtx, specs)),
		reinstallPackage: mutation(PackageMutationResult)
			.input({
				spec: PackageSpecifierInputSchema,
				force: v.optional(v.boolean()),
			})
			.resolve(({ spec, force }) =>
				reinstallPackage(pCtx, spec, {
					force,
				}),
			),
		reinstallPackages: mutation(PackageBatchMutationResult)
			.input({
				specs: v.array(PackageSpecifierInputSchema),
				force: v.optional(v.boolean()),
			})
			.resolve(({ specs, force }) =>
				reinstallPackages(pCtx, specs, {
					force,
				}),
			),
		reloadPackages: mutation(PackageBatchMutationResult)
			.input({
				specs: v.array(PackageSpecifierInputSchema),
				fresh: v.nullish(v.boolean()),
			})
			.resolve(({ specs, fresh }) =>
				reloadPackages(pCtx, specs, {
					fresh: fresh ?? true,
				}),
			),
		retryPackage: mutation(PackageMutationResult)
			.input({
				spec: PackageSpecifierInputSchema,
				reinstall: v.nullish(v.boolean()),
				fresh: v.nullish(v.boolean()),
			})
			.resolve(({ spec, reinstall, fresh }) =>
				retryPackage(pCtx, spec, {
					reinstall: reinstall ?? false,
					fresh: fresh ?? true,
				}),
			),
		retryFailedPackages: mutation(PackageBatchMutationResult)
			.input({
				reinstall: v.nullish(v.boolean()),
				fresh: v.nullish(v.boolean()),
			})
			.resolve(({ reinstall, fresh }) =>
				retryFailedPackages(pCtx, {
					reinstall: reinstall ?? false,
					fresh: fresh ?? true,
				}),
			),
	})
}
