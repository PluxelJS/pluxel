import { createDiskFixture } from '@pluxel/test/fixtures'
import {
	WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE,
	WORKBENCH_PROFILE_VERSION,
	WORKBENCH_FEDERATION_BUILD_CONTRACT_VERSION,
} from '@pluxel/core/federation'
import { expect, it } from 'vitest'
import { readLoadedWorkbenchArtifacts } from '../src/services/workbench/loaded-artifacts'

it('requires the selected owner inventory and rejects an artifactRoot outside the package', async () => {
	await using fixture = await createDiskFixture({
		owner: {
			'dist/workbench': {},
			'package.json': JSON.stringify({
				name: 'workbench-owner',
				pluxel: { artifactRoot: 'dist', workbenchArtifacts: true },
			}),
			'index.mjs': 'export {}',
		},
		'outside/workbench': {},
	})
	const modules = new Map([[fixture.getPath('owner/index.mjs'), new Set(['selected'])]])
	await expect(readLoadedWorkbenchArtifacts(modules, new Set(['selected']))).rejects.toThrow(
		'declared packaged inventory is missing',
	)
	await fixture.fsp.writeFile(
		fixture.getPath('owner/dist/workbench', WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE),
		JSON.stringify({
			version: 1,
			profile: WORKBENCH_PROFILE_VERSION,
			buildContract: WORKBENCH_FEDERATION_BUILD_CONTRACT_VERSION,
			producers: [],
		}),
	)
	expect(await readLoadedWorkbenchArtifacts(modules, new Set(['selected']))).toEqual([])
	await fixture.fsp.rm(fixture.getPath('owner/dist'), { recursive: true })
	await fixture.fsp.symlink(fixture.getPath('outside'), fixture.getPath('owner/dist'))
	await expect(readLoadedWorkbenchArtifacts(modules, new Set(['selected']))).rejects.toThrow(
		'artifactRoot escapes its package',
	)
	expect(await readLoadedWorkbenchArtifacts(modules, new Set())).toEqual([])
})
