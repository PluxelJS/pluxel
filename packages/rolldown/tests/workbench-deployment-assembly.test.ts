import { createHash } from 'node:crypto'
import { pluginDefinitionIndexKey } from '@pluxel/core'
import { readFile, stat } from 'node:fs/promises'
import {
	WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE,
	createWorkbenchFederationDeploymentInventory,
	createWorkbenchFederationProducerPlan,
	type WorkbenchFederationProducerPlan,
} from '@pluxel/core/federation'
import { createDiskFixture } from '@pluxel/test/fixtures'
import {
	WORKBENCH_CONTENT_ARTIFACT_FILE,
	WORKBENCH_CONTENT_DEPLOYMENT_INVENTORY_FILE,
	createWorkbenchContentDeploymentInventory,
	createWorkbenchContentSet,
	serializeWorkbenchContentDefinition,
	serializeWorkbenchContentSet,
	workbenchContentArtifactRoot,
} from '@pluxel/core/internal'
import { describe, expect, it } from 'vitest'

import {
	assembleWorkbenchDeploymentArtifacts,
	assembleWorkbenchContentDeploymentArtifacts,
	collectWorkbenchDeploymentArtifacts,
	collectWorkbenchContentDeploymentArtifacts,
} from '../src/workbench/deployment-assembly.ts'

function createPlan(
	packageName: string,
	buildRevision: string,
	bridgeEntryPath = 'generated/manager.tsx',
	exportName = 'FixturePlugin',
): WorkbenchFederationProducerPlan {
	const definition = {
		entry: { kind: 'package-root', packageName },
		exportName,
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

function contentArtifact(packageName: string, marker = 'Guide', exportName = 'FixturePlugin') {
	const definition = {
		entry: { kind: 'package-root', packageName },
		exportName,
	} as const
	const contentSet = createWorkbenchContentSet({
		definition,
		entries: [
			{
				key: 'guide',
				content: {
					version: 1,
					kind: 'workbench-content',
					slots: [],
					document: {
						version: 1,
						blocks: [
							{
								type: 'heading',
								level: 1,
								anchor: 'guide',
								children: [{ type: 'text', value: marker }],
							},
						],
					},
				},
			},
		],
	})
	const body = serializeWorkbenchContentSet(contentSet)
	const digest = createHash('sha256').update(body).digest('hex')
	const definitionDigest = createHash('sha256')
		.update(serializeWorkbenchContentDefinition(definition))
		.digest('hex')
	const artifactRoot = workbenchContentArtifactRoot(definitionDigest, digest)
	const inventory = createWorkbenchContentDeploymentInventory([
		{ definition, definitionDigest, digest, artifactRoot },
	])
	return {
		definition,
		digest,
		artifactRoot,
		body,
		inventory: `${JSON.stringify(inventory)}\n`,
		tree: {
			[WORKBENCH_CONTENT_DEPLOYMENT_INVENTORY_FILE]: `${JSON.stringify(inventory)}\n`,
			content: {
				[definitionDigest]: { [digest]: { [WORKBENCH_CONTENT_ARTIFACT_FILE]: body } },
			},
		},
	}
}

describe('static Workbench deployment assembly', () => {
	it('copies only catalog-owned producer and Content trees from a bundled package', async () => {
		const selected = createPlan('@example/mixed', 'selected')
		const unused = createPlan('@example/mixed', 'unused', 'generated/unused.tsx', 'UnusedPlugin')
		const selectedContent = contentArtifact('@example/mixed', 'Selected')
		const unusedContent = contentArtifact('@example/mixed', 'Unused', 'UnusedPlugin')
		await using fixture = await createDiskFixture({
			application: {
				workbench: { [WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE]: inventoryFile([]) },
			},
			dependency: {
				dist: {
					workbench: {
						...producerTree(selected),
						...selectedContent.tree,
						[WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE]: inventoryFile([selected, unused]),
						[WORKBENCH_CONTENT_DEPLOYMENT_INVENTORY_FILE]: JSON.stringify(
							createWorkbenchContentDeploymentInventory(
								[
									...JSON.parse(selectedContent.inventory).entries,
									...JSON.parse(unusedContent.inventory).entries,
								].sort((left, right) =>
									pluginDefinitionIndexKey(left.definition).localeCompare(
										pluginDefinitionIndexKey(right.definition),
									),
								),
							),
						),
					},
				},
			},
		})
		const input = {
			destinationRoot: fixture.getPath('application/workbench'),
			dependencyRoots: [fixture.getPath('dependency/dist/workbench')],
			definitions: new Set([pluginDefinitionIndexKey(selected.definition)]),
		}
		const producers = await assembleWorkbenchDeploymentArtifacts(input)
		const content = await assembleWorkbenchContentDeploymentArtifacts(input)
		expect(producers.producers.map(({ plan }) => plan.definition)).toEqual([selected.definition])
		expect(content.entries.map((entry) => entry.definition)).toEqual([selectedContent.definition])
		await expect(
			stat(fixture.getPath(`application/workbench/${unused.producer}`)),
		).rejects.toMatchObject({ code: 'ENOENT' })
		await expect(
			stat(fixture.getPath(`application/workbench/${unusedContent.artifactRoot}`)),
		).rejects.toMatchObject({ code: 'ENOENT' })
		// Missing unselected trees cost no IO; selecting them must expose the original contract failure.
		const unusedInput = {
			...input,
			definitions: new Set([pluginDefinitionIndexKey(unused.definition)]),
		}
		await expect(assembleWorkbenchDeploymentArtifacts(unusedInput)).rejects.toThrow(
			'artifact directory is missing',
		)
		await expect(assembleWorkbenchContentDeploymentArtifacts(unusedInput)).rejects.toThrow(
			'artifact directory is missing',
		)
	})

	it('merges immutable Content inventories independently from MF producers', async () => {
		const local = contentArtifact('@example/local-content', 'Local')
		const dependency = contentArtifact('@example/dependency-content', 'Dependency')
		await using fixture = await createDiskFixture({
			application: { workbench: local.tree },
			dependency: { dist: { workbench: dependency.tree } },
		})
		const destinationRoot = fixture.getPath('application/workbench')
		const inventory = await assembleWorkbenchContentDeploymentArtifacts({
			destinationRoot,
			definitions: new Set([local.definition, dependency.definition].map(pluginDefinitionIndexKey)),
			dependencyRoots: [fixture.getPath('dependency/dist/workbench')],
		})

		expect(inventory.entries.map((entry) => entry.digest).sort()).toEqual(
			[local.digest, dependency.digest].sort(),
		)
		await expect(
			readFile(
				fixture.getPath(
					`application/workbench/${dependency.artifactRoot}/${WORKBENCH_CONTENT_ARTIFACT_FILE}`,
				),
				'utf-8',
			),
		).resolves.toBe(dependency.body)
		await expect(
			collectWorkbenchContentDeploymentArtifacts(destinationRoot, inventory),
		).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ definition: local.definition, digest: local.digest }),
				expect.objectContaining({
					definition: dependency.definition,
					digest: dependency.digest,
				}),
			]),
		)
	})

	it('rejects a Content artifact whose bytes do not match its inventory digest', async () => {
		const content = contentArtifact('@example/tampered-content')
		await using fixture = await createDiskFixture({
			application: {
				workbench: {
					...content.tree,
					content: {
						[content.artifactRoot.split('/')[1]!]: {
							[content.digest]: { [WORKBENCH_CONTENT_ARTIFACT_FILE]: 'tampered\n' },
						},
					},
				},
			},
		})
		await expect(
			assembleWorkbenchContentDeploymentArtifacts({
				destinationRoot: fixture.getPath('application/workbench'),
				definitions: new Set([pluginDefinitionIndexKey(content.definition)]),
				dependencyRoots: [],
			}),
		).rejects.toThrow('digest mismatch')
	})

	it('rejects extra files and oversized bytes in the single-file Content artifact root', async () => {
		const content = contentArtifact('@example/bounded-content')
		const definitionDigest = content.artifactRoot.split('/')[1]!
		await using fixture = await createDiskFixture({
			extra: {
				workbench: {
					...content.tree,
					content: {
						[definitionDigest]: {
							[content.digest]: {
								[WORKBENCH_CONTENT_ARTIFACT_FILE]: content.body,
								'unexpected.txt': 'not part of the Content artifact\n',
							},
						},
					},
				},
			},
			overBudget: {
				workbench: {
					...content.tree,
					content: {
						[definitionDigest]: {
							[content.digest]: {
								[WORKBENCH_CONTENT_ARTIFACT_FILE]: 'x'.repeat(512 * 1_024 + 2),
							},
						},
					},
				},
			},
		})

		await expect(
			assembleWorkbenchContentDeploymentArtifacts({
				destinationRoot: fixture.getPath('extra/workbench'),
				definitions: new Set([pluginDefinitionIndexKey(content.definition)]),
				dependencyRoots: [],
			}),
		).rejects.toThrow(`must contain only ${WORKBENCH_CONTENT_ARTIFACT_FILE}`)
		await expect(
			assembleWorkbenchContentDeploymentArtifacts({
				destinationRoot: fixture.getPath('overBudget/workbench'),
				definitions: new Set([pluginDefinitionIndexKey(content.definition)]),
				dependencyRoots: [],
			}),
		).rejects.toThrow('exceeds its byte budget')
	})

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
			definitions: new Set([local.definition, dependency.definition].map(pluginDefinitionIndexKey)),
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
				definitions: new Set([pluginDefinitionIndexKey(plan.definition)]),
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
				definitions: new Set([pluginDefinitionIndexKey(local.definition)]),
				dependencyRoots: [fixture.getPath('planCollision/dependency/dist/workbench')],
			}),
		).rejects.toThrow('producer plan collision')
		await expect(
			assembleWorkbenchDeploymentArtifacts({
				destinationRoot: fixture.getPath('revisionCollision/application/workbench'),
				definitions: new Set([pluginDefinitionIndexKey(local.definition)]),
				dependencyRoots: [fixture.getPath('revisionCollision/dependency/dist/workbench')],
			}),
		).rejects.toThrow('producer revision collision')
		await expect(
			assembleWorkbenchDeploymentArtifacts({
				destinationRoot: fixture.getPath('contentCollision/application/workbench'),
				definitions: new Set([pluginDefinitionIndexKey(local.definition)]),
				dependencyRoots: [fixture.getPath('contentCollision/dependency/dist/workbench')],
			}),
		).rejects.toThrow('artifact content collision')
	})
})
