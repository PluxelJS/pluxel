import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { tsImport } from 'tsx/esm/api'
import {
	isPublishablePackage,
	repositoryPackages,
	repositoryRoot,
} from '../../../scripts/repository-packages.mjs'
import { dependencyPolicy } from './dependency-policy.mjs'

/** Build-only: synchronize copied product assets, never the source templates. */
export async function syncTemplateCatalog(root) {
	const { applyCatalogSync, planCatalogSync } = await tsImport(
		'@pluxel-internal/pncat/sync',
		import.meta.url,
	)
	const versions = dependencyPolicy(
		await readFile(resolve(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8'),
	)
	for (const { manifest } of repositoryPackages.filter(isPublishablePackage)) {
		versions[manifest.name] = `^${manifest.version}`
	}
	const plan = await planCatalogSync({
		root,
		versions,
		configModule: createRequire(import.meta.url).resolve('@pluxel-internal/pncat'),
		preservePeerRanges: false,
	})
	if (plan.conflicts.length > 0) throw new Error(plan.conflicts.join('\n'))
	await applyCatalogSync(plan)
}
