import { readFile, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'pathe'
import { pluginDefinitionIndexKey } from '@pluxel/core'
import { WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE } from '@pluxel/core/federation'
import type { WorkbenchArtifactBatchCandidate } from '../services/workbench/WorkbenchArtifactCoordinator'
import { readPackagedWorkbenchCandidates } from '../services/workbench/packaged-artifact'

/** Exact evaluated built modules identify package owners; inventories alone identify artifacts. */
export async function readDevelopmentPackagedArtifacts(
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
		const artifactRoot = resolve(root, 'dist/workbench')
		// Ordinary built Plugins need no Workbench inventory. Never scan loose artifact folders.
		try {
			await readFile(resolve(artifactRoot, WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE))
		} catch (error) {
			if (isMissing(error)) continue
			throw error
		}
		for (const candidate of await readPackagedWorkbenchCandidates(
			artifactRoot,
			owner.definitions,
		)) {
			const key = pluginDefinitionIndexKey(candidate.definition)
			if (!owner.definitions.has(key)) continue
			if (
				candidate.definition.entry.kind !== 'package-root' ||
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
