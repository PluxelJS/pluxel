import { existsSync } from 'node:fs'
import type { Context } from '@pluxel/core'
import {
	workbenchFederationBuildManifestPath,
	workbenchFederationManifestPath,
} from '@pluxel/core/federation'
import { dirname, resolve } from 'pathe'
import { findRuntimeModuleId, resolveModuleIdBaseDir } from '../../runtime/module-id'

export function resolvePackagedWorkbenchManifest(
	root: Context,
	pluginName: string,
	artifactName: string,
): string | null {
	const registryPath = findRuntimeModuleId(root, pluginName)
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
	pluginName: string,
	artifactKey: string,
): string | null {
	const registryPath = findRuntimeModuleId(root, pluginName)
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
