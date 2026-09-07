import { readFile } from 'node:fs/promises'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { describe, expect, it } from 'vitest'

import { assembleNodeModuleDeploymentArtifacts } from '../src/plugin-artifact/deployment-assembly.ts'

describe('static Node artifact deployment assembly', () => {
	it('merges reachable package artifacts and deduplicates identical keys', async () => {
		await using fixture = await createDiskFixture({
			application: {
				artifacts: { node: { 'node-local.mjs': 'export const owner = "application"\n' } },
			},
			dependencyA: {
				dist: {
					artifacts: {
						node: {
							'node-dependency.mjs': 'export const owner = "dependency"\n',
							'node-shared.mjs': 'export const owner = "shared"\n',
							'ignored.txt': 'not a Node artifact\n',
						},
					},
				},
			},
			dependencyB: {
				dist: {
					artifacts: {
						node: { 'node-shared.mjs': 'export const owner = "shared"\n' },
					},
				},
			},
		})
		const destinationRoot = fixture.getPath('application/artifacts/node')

		await assembleNodeModuleDeploymentArtifacts({
			destinationRoot,
			dependencyRoots: [
				destinationRoot,
				fixture.getPath('dependencyA/dist/artifacts/node'),
				fixture.getPath('dependencyB/dist/artifacts/node'),
				fixture.getPath('missing/dist/artifacts/node'),
			],
			requiredArtifactKeys: [],
		})

		await expect(readFile(`${destinationRoot}/node-local.mjs`, 'utf8')).resolves.toContain(
			'application',
		)
		await expect(readFile(`${destinationRoot}/node-dependency.mjs`, 'utf8')).resolves.toContain(
			'dependency',
		)
		await expect(readFile(`${destinationRoot}/node-shared.mjs`, 'utf8')).resolves.toContain(
			'shared',
		)
	})

	it('rejects different bytes for the same immutable artifact key', async () => {
		await using fixture = await createDiskFixture({
			application: {
				artifacts: { node: { 'node-collision.mjs': 'export const owner = "application"\n' } },
			},
			dependency: {
				dist: {
					artifacts: {
						node: { 'node-collision.mjs': 'export const owner = "dependency"\n' },
					},
				},
			},
		})

		await expect(
			assembleNodeModuleDeploymentArtifacts({
				destinationRoot: fixture.getPath('application/artifacts/node'),
				dependencyRoots: [fixture.getPath('dependency/dist/artifacts/node')],
				requiredArtifactKeys: [],
			}),
		).rejects.toThrow('Node artifact content collision for node-collision.mjs')
	})

	it('rejects a required key missing from application and reachable package outputs', async () => {
		await using fixture = await createDiskFixture({ application: { artifacts: { node: {} } } })

		await expect(
			assembleNodeModuleDeploymentArtifacts({
				destinationRoot: fixture.getPath('application/artifacts/node'),
				dependencyRoots: [fixture.getPath('missing/dist/artifacts/node')],
				requiredArtifactKeys: ['node-0000000000000000'],
			}),
		).rejects.toThrow('Required Node artifact was not found')
	})
})
