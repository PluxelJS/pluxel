import { existsSync } from 'node:fs'
import type { Context, PluginNodeAddressSnapshot } from '@pluxel/core'
import {
	workbenchFederationBuildManifestPath,
	workbenchFederationManifestPath,
} from '@pluxel/core/federation'
import { dirname, resolve } from 'pathe'
import { resolveModuleIdBaseDir } from '../../runtime/module-id'

export function resolvePackagedWorkbenchManifest(
	root: Context,
	owner: PluginNodeAddressSnapshot,
	artifactName: string,
): string | null {
	const registryPath = root.registry.getRuntimeModuleId(root.registry.internNodeAddress(owner))
	if (registryPath) {
		const baseDir = resolveModuleIdBaseDir(registryPath)
		if (baseDir) {
			const packageRoot = findNearestPackageRoot(baseDir)
			return resolve(
				packageRoot ?? baseDir,
				packageRoot
					? workbenchFederationBuildManifestPath(artifactName)
					: workbenchFederationManifestPath(artifactName),
			)
		}
	}
	const cwd = process.cwd()
	return resolve(
		cwd,
		/(?:^|[\\/])dist$/i.test(cwd)
			? workbenchFederationManifestPath(artifactName)
			: workbenchFederationBuildManifestPath(artifactName),
	)
}

export function resolvePackagedNodeModule(
	root: Context,
	owner: PluginNodeAddressSnapshot,
	artifactKey: string,
): string | null {
	const registryPath = root.registry.getRuntimeModuleId(root.registry.internNodeAddress(owner))
	if (!registryPath) return null
	const baseDir = resolveModuleIdBaseDir(registryPath)
	if (!baseDir) return null
	const packageRoot = findNearestPackageRoot(baseDir)
	return resolve(packageRoot ?? baseDir, 'dist/artifacts/node', `${artifactKey}.mjs`)
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
