import { mutation, query, resolver } from '@gqloom/core'
import type { Context as PlxContext } from '@pluxel/core'
import * as v from 'valibot'

import {
	PackageBatchMutationResult,
	PackageLoadIssueEntry,
	PackageMutationResult,
	PackageRemovalScope,
	PackageSpecifierInput as PackageSpecifierInputSchema,
} from './schema'
import {
	installPackage,
	installPackages,
	listLoadIssues,
	reinstallPackage,
	reinstallPackages,
	retryFailedPackages,
	retryPackage,
	resolveRemovalScope,
	uninstallPackage,
	uninstallPackages,
	reloadPackages,
} from './service'

export function createMarketResolver(pCtx: PlxContext) {
	return resolver({
		packageLoadIssues: query(v.array(PackageLoadIssueEntry)).resolve(() => listLoadIssues(pCtx)),
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
		uninstallPackage: mutation(PackageMutationResult)
			.input({
				spec: PackageSpecifierInputSchema,
				scope: v.nullish(PackageRemovalScope),
			})
			.resolve(({ spec, scope }) => uninstallPackage(pCtx, spec, resolveRemovalScope(scope))),
		uninstallPackages: mutation(PackageBatchMutationResult)
			.input({
				specs: v.array(PackageSpecifierInputSchema),
				scope: v.nullish(PackageRemovalScope),
			})
			.resolve(({ specs, scope }) =>
				uninstallPackages(pCtx, specs, resolveRemovalScope(scope)),
			),
		reinstallPackage: mutation(PackageMutationResult)
			.input({
				spec: PackageSpecifierInputSchema,
				force: v.optional(v.boolean()),
				scope: v.optional(PackageRemovalScope),
			})
			.resolve(({ spec, force, scope }) =>
				reinstallPackage(pCtx, spec, {
					force,
					scope: resolveRemovalScope(scope),
				}),
			),
		reinstallPackages: mutation(PackageBatchMutationResult)
			.input({
				specs: v.array(PackageSpecifierInputSchema),
				force: v.optional(v.boolean()),
				scope: v.optional(PackageRemovalScope),
			})
			.resolve(({ specs, force, scope }) =>
				reinstallPackages(pCtx, specs, {
					force,
					scope: resolveRemovalScope(scope),
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
