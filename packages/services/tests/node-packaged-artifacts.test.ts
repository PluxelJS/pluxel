import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { BasePlugin, Plugin } from '@pluxel/core'
import { __setPluginDefinition, PLUGIN_LOWERING_ABI_VERSION } from '@pluxel/core/toolchain'
import { recordLoadedPluginModule } from '@pluxel/host/internal'
import { expect, it } from 'vitest'
import { readLoadedNodeArtifacts } from '../src/node/packaged-artifacts'

it('requires declared Node inventories, validates bytes and rejects package symlink escapes', async () => {
	const fixture = await mkdtemp(resolve(tmpdir(), 'pluxel-node-owner-'))
	const root = resolve(fixture, 'owner')
	try {
		class Fixture extends BasePlugin {}
		Plugin()(Fixture)
		__setPluginDefinition(Fixture, {
			abiVersion: PLUGIN_LOWERING_ABI_VERSION,
			kind: 'plugin',
			definition: {
				entry: { kind: 'package-root', packageName: 'node-owner' },
				exportName: 'Fixture',
			},
		})
		const manifest = { name: 'node-owner', pluxel: { artifactRoot: '.', nodeArtifacts: true } }
		recordLoadedPluginModule(Fixture, resolve(root, 'index.mjs'), {
			root,
			name: manifest.name,
			manifest,
		})
		const directory = resolve(root, 'artifacts/node')
		await mkdir(directory, { recursive: true })
		await expect(readLoadedNodeArtifacts([Fixture])).rejects.toMatchObject({ code: 'ENOENT' })
		const key = 'node-aaaaaaaaaaaaaaaa',
			content = 'export default 42'
		const inventory = {
			version: 1,
			artifacts: [
				{ key, file: `${key}.mjs`, sha256: createHash('sha256').update(content).digest('hex') },
			],
		}
		await writeFile(resolve(directory, 'pluxel-node-artifacts.json'), JSON.stringify(inventory))
		await writeFile(resolve(directory, `${key}.mjs`), content)
		const admitted = await readLoadedNodeArtifacts([Fixture])
		expect([...admitted.values()][0]?.get(key)).toBe(resolve(directory, `${key}.mjs`))
		await writeFile(resolve(directory, `${key}.mjs`), content + '\n// corrupt')
		await expect(readLoadedNodeArtifacts([Fixture])).rejects.toThrow('digest mismatch')
		recordLoadedPluginModule(Fixture, resolve(root, 'index.mjs'), {
			root,
			name: manifest.name,
			manifest: { name: 'node-owner', pluxel: { artifactRoot: '.', nodeArtifacts: false } },
		})
		const disabled = await readLoadedNodeArtifacts([Fixture])
		expect(disabled.size).toBe(0)
		await mkdir(resolve(fixture, 'outside/node'), { recursive: true })
		await rm(resolve(root, 'artifacts'), { recursive: true })
		await symlink(resolve(fixture, 'outside'), resolve(root, 'artifacts'))
		recordLoadedPluginModule(Fixture, resolve(root, 'index.mjs'), {
			root,
			name: manifest.name,
			manifest,
		})
		await expect(readLoadedNodeArtifacts([Fixture])).rejects.toThrow(
			'artifactRoot escapes its package',
		)
	} finally {
		await rm(fixture, { recursive: true, force: true })
	}
})
