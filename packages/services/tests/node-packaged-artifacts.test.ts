import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { BasePlugin, Plugin } from '@pluxel/core'
import { __setPluginDefinition, PLUGIN_LOWERING_ABI_VERSION } from '@pluxel/core/toolchain'
import { readLoadedPluginModule, recordLoadedPluginModule } from '@pluxel/host/internal'
import { expect, it } from 'vitest'
import { readLoadedNodeArtifacts } from '../src/node/packaged-artifacts'

it('retains loaded owners, requires Node inventories, validates bytes and rejects package symlink escapes', async () => {
	const fixture = await mkdtemp(resolve(tmpdir(), 'pluxel-node-owner-'))
	const root = resolve(fixture, 'owner')
	try {
		const createFixture = () => {
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
			return Fixture
		}
		const Fixture = createFixture()
		const manifest = { name: 'node-owner', pluxel: { artifactRoot: '.', nodeArtifacts: true } }
		recordLoadedPluginModule(Fixture, resolve(root, 'index.mjs'), {
			root,
			name: manifest.name,
			manifest,
		})
		const firstBinding = readLoadedPluginModule(Fixture)
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
		const disabledOwner = {
			root,
			name: manifest.name,
			manifest: { name: 'node-owner', pluxel: { artifactRoot: '.', nodeArtifacts: false } },
		}
		// A cached constructor still belongs to its original loaded output and cannot
		// disable that output's integrity checks through a newer package manifest.
		recordLoadedPluginModule(Fixture, resolve(root, 'replacement.mjs'), disabledOwner)
		expect(readLoadedPluginModule(Fixture)).toBe(firstBinding)
		expect(readLoadedPluginModule(Fixture)?.module).toBe(resolve(root, 'index.mjs'))
		await expect(readLoadedNodeArtifacts([Fixture])).rejects.toThrow('digest mismatch')
		const DisabledFixture = createFixture()
		recordLoadedPluginModule(DisabledFixture, resolve(root, 'disabled.mjs'), disabledOwner)
		const disabled = await readLoadedNodeArtifacts([DisabledFixture])
		expect(disabled.size).toBe(0)
		await mkdir(resolve(fixture, 'outside/node'), { recursive: true })
		await rm(resolve(root, 'artifacts'), { recursive: true })
		await symlink(resolve(fixture, 'outside'), resolve(root, 'artifacts'))
		const EscapingFixture = createFixture()
		recordLoadedPluginModule(EscapingFixture, resolve(root, 'escaping.mjs'), {
			root,
			name: manifest.name,
			manifest,
		})
		await expect(readLoadedNodeArtifacts([EscapingFixture])).rejects.toThrow(
			'artifactRoot escapes its package',
		)
	} finally {
		await rm(fixture, { recursive: true, force: true })
	}
})
