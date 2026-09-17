import { existsSync } from 'node:fs'
import type { Context, PluginNodeAddress } from '@pluxel/core'
import { dirname, resolve } from 'pathe'
import { resolveModuleIdBaseDir } from './module-id'
import {
	pluginCatalogEntry,
	requireRuntimePluginGraphCoordinator,
} from '../internal/reconciliation'
export function resolvePackagedNodeModule(
	root: Context,
	owner: PluginNodeAddress,
	artifactKey: string,
): string | null {
	const registryPath = pluginModuleId(root, owner)
	if (!registryPath) return null
	const baseDir = resolveModuleIdBaseDir(registryPath)
	if (!baseDir) return null
	const packageRoot = findNearestPackageRoot(baseDir)
	return resolve(packageRoot ?? baseDir, 'dist/artifacts/node', `${artifactKey}.mjs`)
}

function pluginModuleId(root: Context, owner: PluginNodeAddress): string | undefined {
	const moduleId = pluginCatalogEntry(
		requireRuntimePluginGraphCoordinator(root).catalogSnapshot(),
		owner.definition,
	)?.provenance.moduleId
	return typeof moduleId === 'string' ? moduleId : undefined
}

function findNearestPackageRoot(start: string): string | null {
	let current = start
	while (true) {
		if (existsSync(resolve(current, 'package.json'))) return current
		const parent = dirname(current)
		if (parent === current) return null
		current = parent
	}
}
