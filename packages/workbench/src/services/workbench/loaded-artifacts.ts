import { readLoadedPluginModule, installedPackageFacts } from '@pluxel/host/internal'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, resolve, isAbsolute, relative } from 'pathe'
import {
	pluginDefinitionIndexKey,
	pluginDefinitionAddressOf,
	type PluginConstructor,
} from '@pluxel/core'
import { WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE } from '@pluxel/core/federation'
import type { WorkbenchArtifactBatchCandidate } from './WorkbenchArtifactCoordinator'
import { readPackagedWorkbenchCandidates } from './packaged-artifact'

/** Exact evaluated built modules identify package owners; inventories alone identify artifacts. */
export async function readLoadedWorkbenchArtifacts(
	modules: ReadonlyMap<string, ReadonlySet<string>>,
	selected: ReadonlySet<string>,
): Promise<readonly WorkbenchArtifactBatchCandidate[]> {
	const owners = new Map<string, { name: string; definitions: Set<string> }>()
	for (const [moduleId, definitions] of modules) {
		if (![...definitions].some((key) => selected.has(key))) continue
		const owner = await findPackageOwner(moduleId)
		if (!owner) continue
		const current = owners.get(owner.root) ?? { name: owner.name, definitions: new Set<string>() }
		for (const definition of definitions)
			if (selected.has(definition)) current.definitions.add(definition)
		owners.set(owner.root, current)
	}
	const candidates = new Map<string, WorkbenchArtifactBatchCandidate>()
	for (const [root, owner] of owners) {
		if (owner.definitions.size === 0) continue
		const metadata = installedPackageFacts(resolve(root, 'package.json'))?.manifest.pluxel
		if (metadata?.workbenchArtifacts !== true) continue
		if (
			typeof metadata.artifactRoot !== 'string' ||
			isAbsolute(metadata.artifactRoot) ||
			metadata.artifactRoot.split(/[\\/]/).includes('..')
		)
			throw new TypeError('[workbench] artifactRoot must stay inside its package')
		const artifactRoot = await realpath(resolve(root, metadata.artifactRoot, 'workbench'))
		const ownerRelative = relative(root, artifactRoot)
		if (isAbsolute(ownerRelative) || ownerRelative === '..' || ownerRelative.startsWith('../'))
			throw new TypeError('[workbench] artifactRoot escapes its package')
		// Ordinary built Plugins need no Workbench inventory. Never scan loose artifact folders.
		try {
			const inventory = await realpath(
				resolve(artifactRoot, WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE),
			)
			if (relative(artifactRoot, inventory) !== WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE)
				throw new TypeError('[workbench] packaged inventory escapes its owner')
			await readFile(inventory)
		} catch (error) {
			if (isMissing(error))
				throw new Error(`[workbench] declared packaged inventory is missing: ${artifactRoot}`, {
					cause: error,
				})
			throw error
		}
		for (const candidate of await readPackagedWorkbenchCandidates(
			artifactRoot,
			owner.definitions,
		)) {
			const key = pluginDefinitionIndexKey(candidate.definition)
			if (!owner.definitions.has(key)) continue
			if (
				candidate.definition.entry.kind !== 'source-entry' &&
				candidate.definition.entry.packageName !== owner.name
			) {
				throw new TypeError(
					`[workbench] packaged artifact definition does not belong to ${owner.name}`,
				)
			}
			if (candidates.has(key))
				throw new TypeError(`[workbench] duplicate packaged artifact definition: ${key}`)
			candidates.set(key, candidate)
		}
	}
	return Object.freeze([...candidates.values()])
}

async function findPackageOwner(
	moduleId: string,
): Promise<{ root: string; name: string } | undefined> {
	let directory = dirname(await realpath(moduleId))
	for (;;) {
		let manifest: string
		try {
			manifest = await readFile(resolve(directory, 'package.json'), 'utf8')
		} catch (error) {
			if (!isMissing(error)) throw error
			const parent = dirname(directory)
			if (parent === directory) return undefined
			directory = parent
			continue
		}
		const input = JSON.parse(manifest) as { name?: unknown }
		return typeof input.name === 'string' ? { root: directory, name: input.name } : undefined
	}
}

function isMissing(error: unknown): boolean {
	return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}

/** Pure inventory admission for the loaded native definitions; no compiler or watcher. */
export async function readNativeWorkbenchArtifacts(
	plugins: readonly PluginConstructor[],
): Promise<readonly WorkbenchArtifactBatchCandidate[]> {
	const modules = new Map<string, Set<string>>()
	for (const plugin of plugins) {
		const loaded = readLoadedPluginModule(plugin)
		if (!loaded) continue
		const definitions = modules.get(loaded.module) ?? new Set<string>()
		definitions.add(pluginDefinitionIndexKey(pluginDefinitionAddressOf(plugin)))
		modules.set(loaded.module, definitions)
	}
	const selected = new Set<string>()
	for (const definitions of modules.values())
		for (const definition of definitions) selected.add(definition)
	return readLoadedWorkbenchArtifacts(modules, selected)
}
