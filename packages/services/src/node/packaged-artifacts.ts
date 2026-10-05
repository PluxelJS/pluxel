import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import {
	pluginDefinitionAddressOf,
	pluginDefinitionIndexKey,
	type PluginConstructor,
} from '@pluxel/core'
import { readLoadedPluginModule } from '@pluxel/host/internal'

/** Read and validate the declared loaded owners' Node inventories before any Plugin activates. */
export async function readLoadedNodeArtifacts(
	plugins: readonly PluginConstructor[],
): Promise<ReadonlyMap<string, ReadonlyMap<string, string>>> {
	const owners = new Map<string, ReadonlyMap<string, string>>()
	const inventories = new Map<string, ReadonlyMap<string, string>>()
	for (const plugin of plugins) {
		const loaded = readLoadedPluginModule(plugin)
		if (!loaded) continue
		if (loaded.package.manifest.pluxel?.nodeArtifacts !== true) continue
		const output = loaded.package.manifest.pluxel?.artifactRoot
		if (typeof output !== 'string')
			throw new TypeError('[node] declared Node artifacts require artifactRoot')
		if (isAbsolute(output) || output.split(/[\\/]/).includes('..'))
			throw new TypeError('[node] artifactRoot must stay inside its package')
		const directory = resolve(loaded.package.root, output, 'artifacts/node')
		let artifacts = inventories.get(directory)
		if (!artifacts) {
			const root = await realpath(directory)
			const ownerRelative = relative(loaded.package.root, root)
			if (isAbsolute(ownerRelative) || ownerRelative === '..' || ownerRelative.startsWith('../'))
				throw new TypeError('[node] artifactRoot escapes its package')
			const inventory = await realpath(resolve(root, 'pluxel-node-artifacts.json'))
			if (relative(root, inventory) !== 'pluxel-node-artifacts.json')
				throw new TypeError('[node] packaged Node inventory escapes its owner')
			const input = JSON.parse(await readFile(inventory, 'utf8')) as {
				version?: unknown
				artifacts?: unknown
			}
			if (input.version !== 1 || !Array.isArray(input.artifacts))
				throw new TypeError(`[node] invalid packaged Node inventory: ${directory}`)
			const files = new Map<string, string>()
			for (const item of input.artifacts) {
				if (
					!item ||
					typeof item !== 'object' ||
					typeof item.key !== 'string' ||
					!/^node-[a-f0-9]{16}$/.test(item.key) ||
					item.file !== `${item.key}.mjs` ||
					!/^[a-f0-9]{64}$/.test(item.sha256) ||
					files.has(item.key)
				)
					throw new TypeError(`[node] invalid packaged Node artifact record: ${directory}`)
				const path = await realpath(resolve(root, item.file))
				const name = relative(root, path)
				if (isAbsolute(name) || name === '..' || name.startsWith('../'))
					throw new TypeError('[node] packaged Node artifact escapes its owner')
				if (
					createHash('sha256')
						.update(await readFile(path))
						.digest('hex') !== item.sha256
				)
					throw new TypeError(`[node] packaged Node artifact digest mismatch: ${item.key}`)
				files.set(item.key, path)
			}
			artifacts = files
			inventories.set(directory, files)
		}
		owners.set(pluginDefinitionIndexKey(pluginDefinitionAddressOf(plugin)), artifacts)
	}
	return owners
}
