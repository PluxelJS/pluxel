import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
	WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE,
	WORKBENCH_PROFILE_VERSION,
	WORKBENCH_FEDERATION_BUILD_CONTRACT_VERSION,
} from '@pluxel/core/federation'
import { expect, it } from 'vitest'
import { readLoadedWorkbenchArtifacts } from '../src/services/workbench/loaded-artifacts'

it('requires the selected owner inventory and rejects an artifactRoot outside the package', async () => {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-workbench-owner-'))
	try {
		const owner = resolve(root, 'owner')
		await mkdir(resolve(owner, 'dist/workbench'), { recursive: true })
		await writeFile(
			resolve(owner, 'package.json'),
			JSON.stringify({
				name: 'workbench-owner',
				pluxel: { artifactRoot: 'dist', workbenchArtifacts: true },
			}),
		)
		await writeFile(resolve(owner, 'index.mjs'), 'export {}')
		const modules = new Map([[resolve(owner, 'index.mjs'), new Set(['selected'])]])
		await expect(readLoadedWorkbenchArtifacts(modules, new Set(['selected']))).rejects.toThrow(
			'declared packaged inventory is missing',
		)
		await writeFile(
			resolve(owner, 'dist/workbench', WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE),
			JSON.stringify({
				version: 1,
				profile: WORKBENCH_PROFILE_VERSION,
				buildContract: WORKBENCH_FEDERATION_BUILD_CONTRACT_VERSION,
				producers: [],
			}),
		)
		expect(await readLoadedWorkbenchArtifacts(modules, new Set(['selected']))).toEqual([])
		await mkdir(resolve(root, 'outside/workbench'), { recursive: true })
		await rm(resolve(owner, 'dist'), { recursive: true })
		await symlink(resolve(root, 'outside'), resolve(owner, 'dist'))
		await expect(readLoadedWorkbenchArtifacts(modules, new Set(['selected']))).rejects.toThrow(
			'artifactRoot escapes its package',
		)
		expect(await readLoadedWorkbenchArtifacts(modules, new Set())).toEqual([])
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
