import { readFile, stat } from 'node:fs/promises'
import {
	WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE,
	createWorkbenchFederationDeploymentInventory,
	createWorkbenchFederationProducerPlan,
	type WorkbenchFederationProducerPlan,
} from '@pluxel/core/federation'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { describe, expect, it } from 'vitest'

import {
	assembleWorkbenchDeploymentArtifacts,
	collectWorkbenchDeploymentArtifacts,
} from '../src/workbench/deployment-assembly.ts'

function createPlan(
	packageName: string,
	buildRevision: string,
	bridgeEntryPath = 'generated/manager.tsx',
): WorkbenchFederationProducerPlan {
	const definition = {
		entry: { kind: 'package-root', packageName },
		exportName: 'FixturePlugin',
	} as const
	return createWorkbenchFederationProducerPlan({
		definition,
		buildRevision,
		entries: [
			{
				descriptor: { kind: 'view', owner: definition, key: 'manager' },
				bridgeEntryPath,
			},
		],
	})
}

function inventoryFile(plans: readonly WorkbenchFederationProducerPlan[]): string {
	return `${JSON.stringify(createWorkbenchFederationDeploymentInventory(plans))}\n`
}

function producerTree(plan: WorkbenchFederationProducerPlan, marker = plan.producer) {
	return {
		[plan.producer]: {
			[plan.buildRevision]: {
				'mf-manifest.json': `${marker}\n`,
				'remoteEntry.js': `export default ${JSON.stringify(marker)}\n`,
			},
		},
	}
}

describe('static Workbench deployment assembly', () => {
	it('merges app and dependency inventories using only producer/revision artifact roots', async () => {
		const local = createPlan('@example/local', 'local-a')
		const dependency = createPlan('@example/dependency', 'dependency-a')
		await using fixture = await createDiskFixture({
			application: {
				workbench: {
					[WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE]: inventoryFile([local]),
					...producerTree(local),
				},
			},
			dependency: {
				dist: {
					workbench: {
						[WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE]: inventoryFile([dependency]),
						...producerTree(dependency),
					},
				},
			},
			legacy: {
				dist: {
					workbench: {
						flat_producer: { 'mf-manifest.json': 'legacy topology must be ignored\n' },
					},
				},
			},
		})
		const destinationRoot = fixture.getPath('application/workbench')
		const inventory = await assembleWorkbenchDeploymentArtifacts({
			destinationRoot,
			dependencyRoots: [
				fixture.getPath('dependency/dist/workbench'),
				fixture.getPath('legacy/dist/workbench'),
			],
		})

		expect(inventory.producers.map(({ plan }) => plan.producer)).toEqual(
			[dependency.producer, local.producer].sort(),
		)
		await expect(
			readFile(
				fixture.getPath(
					`application/workbench/${dependency.producer}/${dependency.buildRevision}/remoteEntry.js`,
				),
				'utf-8',
			),
		).resolves.toContain(dependency.producer)
		await expect(
			stat(fixture.getPath('application/workbench/flat_producer/mf-manifest.json')),
		).rejects.toMatchObject({ code: 'ENOENT' })

		const published = JSON.parse(
			await readFile(
				fixture.getPath(`application/workbench/${WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE}`),
				'utf-8',
			),
		)
		expect(published).toEqual(inventory)
		await expect(collectWorkbenchDeploymentArtifacts(destinationRoot, inventory)).resolves.toEqual(
			inventory.producers.map(({ plan, artifactRoot }) => ({
				producer: plan.producer,
				buildRevision: plan.buildRevision,
				manifest: `${artifactRoot}/mf-manifest.json`,
				sha256: expect.stringMatching(/^[a-f\d]{64}$/),
			})),
		)
	})

	it('deduplicates an identical producer plan only when the complete artifact tree matches', async () => {
		const plan = createPlan('@example/shared', 'revision-a')
		await using fixture = await createDiskFixture({
			application: {
				workbench: {
					[WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE]: inventoryFile([plan]),
					...producerTree(plan),
				},
			},
			dependency: {
				dist: {
					workbench: {
						[WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE]: inventoryFile([plan]),
						...producerTree(plan),
					},
				},
			},
		})

		await expect(
			assembleWorkbenchDeploymentArtifacts({
				destinationRoot: fixture.getPath('application/workbench'),
				dependencyRoots: [fixture.getPath('dependency/dist/workbench')],
			}),
		).resolves.toMatchObject({ producers: [{ plan: { producer: plan.producer } }] })
	})

	it('rejects producer plan, revision, and immutable content collisions', async () => {
		const local = createPlan('@example/collision', 'revision-a')
		const changedPlan = createPlan(
			'@example/collision',
			'revision-a',
			'generated/moved-manager.tsx',
		)
		const changedRevision = createPlan('@example/collision', 'revision-b')
		await using fixture = await createDiskFixture({
			planCollision: {
				application: {
					workbench: {
						[WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE]: inventoryFile([local]),
						...producerTree(local),
					},
				},
				dependency: {
					dist: {
						workbench: {
							[WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE]: inventoryFile([changedPlan]),
							...producerTree(changedPlan),
						},
					},
				},
			},
			revisionCollision: {
				application: {
					workbench: {
						[WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE]: inventoryFile([local]),
						...producerTree(local),
					},
				},
				dependency: {
					dist: {
						workbench: {
							[WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE]: inventoryFile([changedRevision]),
							...producerTree(changedRevision),
						},
					},
				},
			},
			contentCollision: {
				application: {
					workbench: {
						[WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE]: inventoryFile([local]),
						...producerTree(local),
					},
				},
				dependency: {
					dist: {
						workbench: {
							[WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE]: inventoryFile([local]),
							...producerTree(local, 'different bytes'),
						},
					},
				},
			},
		})

		await expect(
			assembleWorkbenchDeploymentArtifacts({
				destinationRoot: fixture.getPath('planCollision/application/workbench'),
				dependencyRoots: [fixture.getPath('planCollision/dependency/dist/workbench')],
			}),
		).rejects.toThrow('producer plan collision')
		await expect(
			assembleWorkbenchDeploymentArtifacts({
				destinationRoot: fixture.getPath('revisionCollision/application/workbench'),
				dependencyRoots: [fixture.getPath('revisionCollision/dependency/dist/workbench')],
			}),
		).rejects.toThrow('producer revision collision')
		await expect(
			assembleWorkbenchDeploymentArtifacts({
				destinationRoot: fixture.getPath('contentCollision/application/workbench'),
				dependencyRoots: [fixture.getPath('contentCollision/dependency/dist/workbench')],
			}),
		).rejects.toThrow('artifact content collision')
	})
})
