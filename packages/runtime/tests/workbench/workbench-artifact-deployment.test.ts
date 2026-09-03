import { createHash } from 'node:crypto'
import { symlink, writeFile } from 'node:fs/promises'
import { pluginDefinitionIndexKey, type PluginDefinitionAddress } from '@pluxel/core'
import {
	WORKBENCH_CONTENT_ARTIFACT_FILE,
	WORKBENCH_CONTENT_DEPLOYMENT_INVENTORY_FILE,
	createWorkbenchContentSet,
	createWorkbenchContentDeploymentInventory,
	serializeWorkbenchContentDefinition,
	serializeWorkbenchContentSet,
	workbenchContentArtifactRoot,
} from '@pluxel/core/internal'
import {
	WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE,
	createWorkbenchFederationCompatibilitySet,
	createWorkbenchFederationDeploymentInventory,
	createWorkbenchFederationProducerPlan,
	type WorkbenchFederationProducerPlan,
} from '@pluxel/core/federation'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { createRuntimeHost } from '@pluxel/runtime/test'
import * as React from 'react'
import * as ReactDom from 'react-dom'
import { describe, expect, it, vi } from 'vitest'

import { version as runtimeVersion } from '../../package.json'
import { requireWorkbench } from '../../src/services/workbench.ts'
import { WorkbenchArtifactService } from '../../src/services/workbench/WorkbenchArtifactService.ts'
import { WorkbenchArtifactCoordinator } from '../../src/services/workbench/WorkbenchArtifactCoordinator.ts'
import { WorkbenchContentArtifactService } from '../../src/services/workbench/WorkbenchContentArtifactService.ts'
import { loadPackagedWorkbenchDeployment } from '../../src/services/workbench/packaged-artifact.ts'

const definition = {
	entry: { kind: 'package-root', packageName: '@example/fonts' },
	exportName: 'FontsPlugin',
} as const
const compatibility = createWorkbenchFederationCompatibilitySet({
	react: React.version,
	reactDom: ReactDom.version,
	runtime: runtimeVersion,
})

function createPlan(
	buildRevision: string,
	owner: PluginDefinitionAddress = definition,
): WorkbenchFederationProducerPlan {
	return createWorkbenchFederationProducerPlan({
		definition: owner,
		buildRevision,
		entries: [
			{
				descriptor: { kind: 'view', owner, key: 'manager' },
				bridgeEntryPath: 'generated/manager.tsx',
			},
			{
				descriptor: { kind: 'attachment', owner, key: 'picker' },
				bridgeEntryPath: 'generated/picker.tsx',
			},
		],
	})
}

function manifest(
	plan: WorkbenchFederationProducerPlan,
	exposes = plan.entries.map((entry) => entry.expose),
) {
	return {
		id: plan.producer,
		name: plan.producer,
		metaData: {
			name: plan.producer,
			globalName: plan.producer,
			buildInfo: { buildVersion: plan.buildRevision, buildName: plan.producer },
			publicPath: 'auto',
			remoteEntry: { name: 'remoteEntry.js', path: '', type: 'module' },
			types: { path: '', name: '', api: 'types/index.d.ts', zip: '@mf-types.zip' },
			type: 'global',
		},
		remotes: [],
		shared: Object.entries(compatibility.shared).map(([name, version]) => ({
			name,
			version,
			requiredVersion: version,
			singleton: true,
			assets: assetGroup(),
		})),
		exposes: exposes.map((expose, index) => ({
			name: expose.slice(2),
			path: expose.slice(2),
			assets: assetGroup([`assets/view-${index}.js`]),
		})),
	}
}

function assetGroup(js: string[] = []) {
	return {
		js: { sync: js, async: [] },
		css: { sync: [], async: [] },
	}
}

function candidateFiles(plan: WorkbenchFederationProducerPlan, rawManifest?: string) {
	return {
		'mf-manifest.json': rawManifest ?? `${JSON.stringify(manifest(plan), null, 2)}\n`,
		'remoteEntry.js': "export { ready } from './assets/remote-runtime.js'\n",
		'assets/remote-runtime.js': 'export const ready = true\n',
		'assets/view-0.js': 'export const manager = true\n',
		'assets/view-1.js': 'export const picker = true\n',
		'types/index.d.ts': 'export {}\n',
		'@mf-types.zip': 'zip-placeholder',
	}
}

function createArtifactServices() {
	const root = { logger: { error: vi.fn() } } as never
	const artifacts = new WorkbenchArtifactService(root)
	const content = new WorkbenchContentArtifactService(root)
	const coordinator = new WorkbenchArtifactCoordinator(root, artifacts, content)
	return { artifacts, content, coordinator }
}

function createContentArtifact(value: string) {
	const contentSet = createWorkbenchContentSet({
		definition,
		entries: [
			{
				key: 'guide',
				content: {
					version: 1,
					kind: 'workbench-content',
					document: {
						version: 1,
						blocks: [
							{
								type: 'paragraph',
								children: [{ type: 'text', value }],
							},
						],
					},
					slots: [],
				},
			},
		],
	})
	const bytes = serializeWorkbenchContentSet(contentSet)
	return Object.freeze({
		bytes,
		candidate: Object.freeze({
			definition,
			definitionDigest: sha256(serializeWorkbenchContentDefinition(definition)),
			digest: sha256(bytes),
		}),
	})
}

function sha256(input: string | Uint8Array): string {
	return createHash('sha256').update(input).digest('hex')
}

describe('WorkbenchArtifactService', () => {
	it('commits and resolves one bounded immutable Workbench Content set', async () => {
		const contentArtifact = createContentArtifact('Guide')
		await using fixture = await createDiskFixture({
			content: { [WORKBENCH_CONTENT_ARTIFACT_FILE]: contentArtifact.bytes },
			overBudget: { [WORKBENCH_CONTENT_ARTIFACT_FILE]: 'x'.repeat(512 * 1_024 + 2) },
		})
		const { content, coordinator } = createArtifactServices()
		const committed = await coordinator.commitCandidate({
			definition,
			content: { ...contentArtifact.candidate, artifactRoot: fixture.getPath('content') },
		})

		expect(committed.content).toMatchObject({ digest: contentArtifact.candidate.digest })
		expect(
			content.resolveContent(definition, { kind: 'content', owner: definition, key: 'guide' }),
		).toMatchObject({
			plan: {
				kind: 'workbench-content',
				document: { blocks: [{ type: 'paragraph' }] },
			},
		})
		expect(() => content.withdrawCurrent(Symbol('unauthorized'), definition)).toThrow(
			'coordinator authority',
		)
		expect(content.getCurrent(definition)?.digest).toBe(contentArtifact.candidate.digest)
		await expect(
			coordinator.commitCandidate({
				definition,
				content: {
					...contentArtifact.candidate,
					digest: sha256('x'.repeat(512 * 1_024 + 2)),
					artifactRoot: fixture.getPath('overBudget'),
				},
			}),
		).rejects.toThrow('serialized byte budget')
	})

	it('rejects malformed optional sides and invalid UTF-8 Content artifacts before mutation', async () => {
		const invalidBytes = Buffer.from([0xff])
		await using fixture = await createDiskFixture({
			invalidUtf8: { [WORKBENCH_CONTENT_ARTIFACT_FILE]: invalidBytes },
		})
		const { artifacts, content, coordinator } = createArtifactServices()

		await expect(
			coordinator.commitCandidate({ definition, federation: false } as never),
		).rejects.toThrow('federation must be an object')
		await expect(
			coordinator.commitCandidate({ definition, content: null } as never),
		).rejects.toThrow('content must be an object')
		await expect(
			coordinator.commitCandidate({
				definition,
				content: {
					definition,
					definitionDigest: sha256(serializeWorkbenchContentDefinition(definition)),
					digest: sha256(invalidBytes),
					artifactRoot: fixture.getPath('invalidUtf8'),
				},
			}),
		).rejects.toThrow('not valid UTF-8')

		expect(coordinator.revision).toBe(0)
		expect(artifacts.getCurrent(definition)).toBeUndefined()
		expect(content.getCurrent(definition)).toBeUndefined()
	})

	it('commits a full desired artifact tuple atomically and withdraws absent sides', async () => {
		const federationA = createPlan('transaction-a')
		const federationB = createPlan('transaction-b')
		const contentA = createContentArtifact('A')
		const contentB = createContentArtifact('B')
		await using fixture = await createDiskFixture({
			federationA: candidateFiles(federationA),
			federationB: candidateFiles(federationB),
			contentA: { [WORKBENCH_CONTENT_ARTIFACT_FILE]: contentA.bytes },
			contentB: { [WORKBENCH_CONTENT_ARTIFACT_FILE]: contentB.bytes },
		})
		const root = { logger: { error: vi.fn() } } as never
		const federation = new WorkbenchArtifactService(root)
		const content = new WorkbenchContentArtifactService(root)
		const coordinator = new WorkbenchArtifactCoordinator(root, federation, content)
		const commits = vi.fn()
		coordinator.subscribe(commits)

		await coordinator.commitCandidate({
			definition,
			federation: { plan: federationA, artifactRoot: fixture.getPath('federationA') },
			content: { ...contentA.candidate, artifactRoot: fixture.getPath('contentA') },
		})
		expect(commits).toHaveBeenCalledTimes(1)
		expect(federation.getCurrent(definition)?.buildRevision).toBe('transaction-a')
		expect(content.getCurrent(definition)?.digest).toBe(contentA.candidate.digest)

		const commitPrepared = content.commitPrepared.bind(content)
		vi.spyOn(content, 'commitPrepared').mockImplementationOnce((...args) => {
			commitPrepared(...args)
			throw new Error('simulated post-commit Content failure')
		})
		await expect(
			coordinator.commitCandidate({
				definition,
				federation: { plan: federationB, artifactRoot: fixture.getPath('federationB') },
				content: { ...contentB.candidate, artifactRoot: fixture.getPath('contentB') },
			}),
		).rejects.toThrow('simulated post-commit Content failure')
		expect(commits).toHaveBeenCalledTimes(1)
		expect(coordinator.revision).toBe(1)
		expect(federation.revision).toBe(1)
		expect(content.revision).toBe(1)
		expect(federation.getCurrent(definition)?.buildRevision).toBe('transaction-a')
		expect(federation.getPinned(federationB.producer, federationB.buildRevision)).toBeUndefined()
		expect(content.getCurrent(definition)?.digest).toBe(contentA.candidate.digest)
		expect(
			content.getPinned(contentB.candidate.definitionDigest, contentB.candidate.digest),
		).toBeUndefined()

		const contentOnly = await coordinator.commitCandidate({
			definition,
			content: { ...contentB.candidate, artifactRoot: fixture.getPath('contentB') },
		})
		expect(contentOnly.federation).toBeNull()
		expect(contentOnly.content?.digest).toBe(contentB.candidate.digest)
		expect(federation.getCurrent(definition)).toBeUndefined()

		const federationOnly = await coordinator.commitCandidate({
			definition,
			federation: { plan: federationB, artifactRoot: fixture.getPath('federationB') },
		})
		expect(federationOnly.federation?.buildRevision).toBe('transaction-b')
		expect(federationOnly.content).toBeNull()
		expect(content.getCurrent(definition)).toBeUndefined()

		const withdrawn = await coordinator.commitCandidate({ definition })
		expect(withdrawn).toMatchObject({ federation: null, content: null })
		expect(federation.getCurrent(definition)).toBeUndefined()
		expect(content.getCurrent(definition)).toBeUndefined()
		expect(commits).toHaveBeenCalledTimes(4)
	})

	it('rolls back commits that fail after withdrawing an absent side', async () => {
		const federationA = createPlan('absent-rollback-a')
		const federationB = createPlan('absent-rollback-b')
		const contentA = createContentArtifact('A')
		const contentB = createContentArtifact('B')
		await using fixture = await createDiskFixture({
			federationA: candidateFiles(federationA),
			federationB: candidateFiles(federationB),
			contentA: { [WORKBENCH_CONTENT_ARTIFACT_FILE]: contentA.bytes },
			contentB: { [WORKBENCH_CONTENT_ARTIFACT_FILE]: contentB.bytes },
		})
		const { artifacts, content, coordinator } = createArtifactServices()
		const commits = vi.fn()
		coordinator.subscribe(commits)
		await coordinator.commitCandidate({
			definition,
			federation: { plan: federationA, artifactRoot: fixture.getPath('federationA') },
			content: { ...contentA.candidate, artifactRoot: fixture.getPath('contentA') },
		})

		const commitContent = content.commitPrepared.bind(content)
		const contentCommitSpy = vi
			.spyOn(content, 'commitPrepared')
			.mockImplementationOnce((...args) => {
				commitContent(...args)
				throw new Error('simulated Content commit failure after federation withdraw')
			})
		await expect(
			coordinator.commitCandidate({
				definition,
				content: { ...contentB.candidate, artifactRoot: fixture.getPath('contentB') },
			}),
		).rejects.toThrow('after federation withdraw')
		contentCommitSpy.mockRestore()

		expect(coordinator.revision).toBe(1)
		expect(artifacts.revision).toBe(1)
		expect(content.revision).toBe(1)
		expect(commits).toHaveBeenCalledTimes(1)
		expect(artifacts.getCurrent(definition)?.buildRevision).toBe(federationA.buildRevision)
		expect(artifacts.getPinned(federationA.producer, federationA.buildRevision)).toBeDefined()
		expect(content.getCurrent(definition)?.digest).toBe(contentA.candidate.digest)
		expect(
			content.getPinned(contentB.candidate.definitionDigest, contentB.candidate.digest),
		).toBeUndefined()

		const withdrawContent = content.withdrawCurrent.bind(content)
		const contentWithdrawSpy = vi
			.spyOn(content, 'withdrawCurrent')
			.mockImplementationOnce((...args) => {
				withdrawContent(...args)
				throw new Error('simulated Content withdraw failure after federation commit')
			})
		await expect(
			coordinator.commitCandidate({
				definition,
				federation: { plan: federationB, artifactRoot: fixture.getPath('federationB') },
			}),
		).rejects.toThrow('after federation commit')
		contentWithdrawSpy.mockRestore()

		expect(coordinator.revision).toBe(1)
		expect(artifacts.revision).toBe(1)
		expect(content.revision).toBe(1)
		expect(commits).toHaveBeenCalledTimes(1)
		expect(artifacts.getCurrent(definition)?.buildRevision).toBe(federationA.buildRevision)
		expect(artifacts.getPinned(federationB.producer, federationB.buildRevision)).toBeUndefined()
		expect(content.getCurrent(definition)?.digest).toBe(contentA.candidate.digest)
		expect(
			content.getPinned(contentA.candidate.definitionDigest, contentA.candidate.digest),
		).toBeDefined()
	})

	it('invalidates an active session once for one coordinated Content commit', async () => {
		const content = createContentArtifact('Session update')
		await using fixture = await createDiskFixture({
			content: { [WORKBENCH_CONTENT_ARTIFACT_FILE]: content.bytes },
		})

		{
			await using host = createRuntimeHost()

			await host.commit()
			const backend = requireWorkbench(host.ctx)
			const coordinatorEvents = vi.fn()
			const invalidated = vi.fn()
			const unsubscribe = backend.artifactCoordinator.subscribe(coordinatorEvents)
			const session = backend.createSession(
				{ provider: 'test', subject: 'session-content-update' },
				invalidated,
			)

			try {
				await backend.artifactCoordinator.commitCandidate({
					definition,
					content: { ...content.candidate, artifactRoot: fixture.getPath('content') },
				})

				expect(coordinatorEvents).toHaveBeenCalledTimes(1)
				expect(invalidated).toHaveBeenCalledTimes(1)
				expect(session.signal.aborted).toBe(true)
			} finally {
				unsubscribe()
				session.dispose()
			}
		}
	})

	it('loads the host-owned production inventory before Runtime startup completes', async () => {
		const plan = createPlan('production-a')
		const inventory = createWorkbenchFederationDeploymentInventory([plan])
		await using fixture = await createDiskFixture({
			workbench: {
				[WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE]: `${JSON.stringify(inventory)}\n`,
				[plan.producer]: {
					[plan.buildRevision]: candidateFiles(plan),
				},
			},
		})

		{
			await using host = createRuntimeHost({ workbenchArtifactRoot: fixture.getPath('workbench') })

			await host.commit()
			const artifacts = requireWorkbench(host.ctx).artifacts
			expect(artifacts.getCurrent(definition)).toMatchObject({
				producer: plan.producer,
				buildRevision: plan.buildRevision,
			})
			expect(
				artifacts.resolveEntry(definition, {
					kind: 'attachment',
					owner: definition,
					key: 'picker',
				}),
			).toMatchObject({ entry: { expose: './views/picker' } })
		}
	})

	it('loads a Content-only production inventory from its canonical Workbench path', async () => {
		const contentArtifact = createContentArtifact('Packaged guide')
		const artifactRoot = workbenchContentArtifactRoot(
			contentArtifact.candidate.definitionDigest,
			contentArtifact.candidate.digest,
		)
		const contentInventory = createWorkbenchContentDeploymentInventory([
			{
				...contentArtifact.candidate,
				artifactRoot,
			},
		])
		await using fixture = await createDiskFixture({
			workbench: {
				[WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE]: `${JSON.stringify(
					createWorkbenchFederationDeploymentInventory([]),
				)}\n`,
				[WORKBENCH_CONTENT_DEPLOYMENT_INVENTORY_FILE]: `${JSON.stringify(contentInventory)}\n`,
				content: {
					[contentArtifact.candidate.definitionDigest]: {
						[contentArtifact.candidate.digest]: {
							[WORKBENCH_CONTENT_ARTIFACT_FILE]: contentArtifact.bytes,
						},
					},
				},
			},
		})

		{
			await using host = createRuntimeHost({ workbenchArtifactRoot: fixture.getPath('workbench') })

			await host.commit()
			const contentService = requireWorkbench(host.ctx).content
			expect(contentService.getCurrent(definition)).toMatchObject({
				definitionDigest: contentArtifact.candidate.definitionDigest,
				digest: contentArtifact.candidate.digest,
			})
			expect(
				contentService.resolveContent(definition, {
					kind: 'content',
					owner: definition,
					key: 'guide',
				}),
			).toMatchObject({ plan: { document: { blocks: [{ type: 'paragraph' }] } } })
		}
	})

	it('merges packaged federation and Content inventories into one definition commit', async () => {
		const plan = createPlan('production-mixed')
		const content = createContentArtifact('Mixed packaged guide')
		const contentArtifactRoot = workbenchContentArtifactRoot(
			content.candidate.definitionDigest,
			content.candidate.digest,
		)
		const federationInventory = createWorkbenchFederationDeploymentInventory([plan])
		const contentInventory = createWorkbenchContentDeploymentInventory([
			{ ...content.candidate, artifactRoot: contentArtifactRoot },
		])
		await using fixture = await createDiskFixture({
			workbench: {
				[WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE]: `${JSON.stringify(federationInventory)}\n`,
				[WORKBENCH_CONTENT_DEPLOYMENT_INVENTORY_FILE]: `${JSON.stringify(contentInventory)}\n`,
				[plan.producer]: { [plan.buildRevision]: candidateFiles(plan) },
				content: {
					[content.candidate.definitionDigest]: {
						[content.candidate.digest]: { [WORKBENCH_CONTENT_ARTIFACT_FILE]: content.bytes },
					},
				},
			},
		})

		{
			await using host = createRuntimeHost({ workbenchArtifactRoot: fixture.getPath('workbench') })

			const backend = requireWorkbench(host.ctx)
			const commits = vi.fn()
			backend.artifactCoordinator.subscribe(commits)
			await host.commit()

			expect(commits).toHaveBeenCalledTimes(1)
			expect(backend.artifacts.getCurrent(definition)?.buildRevision).toBe('production-mixed')
			expect(backend.content.getCurrent(definition)?.digest).toBe(content.candidate.digest)
		}
	})

	it('validates every packaged definition before committing the first one', async () => {
		const definitions = [
			{
				entry: { kind: 'package-root', packageName: '@example/prevalidate-a' },
				exportName: 'PrevalidateAPlugin',
			},
			{
				entry: { kind: 'package-root', packageName: '@example/prevalidate-z' },
				exportName: 'PrevalidateZPlugin',
			},
		] as const satisfies readonly PluginDefinitionAddress[]
		const plans = definitions
			.map((owner, index) => createPlan(`prevalidate-${index}`, owner))
			.sort((left, right) =>
				pluginDefinitionIndexKey(left.definition).localeCompare(
					pluginDefinitionIndexKey(right.definition),
				),
			)
		const [valid, rejected] = plans as [
			WorkbenchFederationProducerPlan,
			WorkbenchFederationProducerPlan,
		]
		const inventory = createWorkbenchFederationDeploymentInventory(plans)
		await using fixture = await createDiskFixture({
			workbench: {
				[WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE]: `${JSON.stringify(inventory)}\n`,
				[valid.producer]: {
					[valid.buildRevision]: candidateFiles(valid),
				},
				[rejected.producer]: {
					[rejected.buildRevision]: candidateFiles(
						rejected,
						JSON.stringify(manifest(rejected, [])),
					),
				},
			},
		})
		const { artifacts, content, coordinator } = createArtifactServices()
		const commits = vi.fn()
		coordinator.subscribe(commits)

		await expect(
			loadPackagedWorkbenchDeployment(coordinator, fixture.getPath('workbench')),
		).rejects.toThrow('expose inventory mismatch')

		expect(commits).not.toHaveBeenCalled()
		expect(coordinator.revision).toBe(0)
		expect(artifacts.getCurrent(valid.definition)).toBeUndefined()
		expect(artifacts.getCurrent(rejected.definition)).toBeUndefined()
		expect(content.revision).toBe(0)
	})

	it('atomically commits one exact standard Manifest revision and serves its raw bytes', async () => {
		const plan = createPlan('revision-a')
		const rawManifest = `${JSON.stringify(manifest(plan), null, 2)}\n`
		await using fixture = await createDiskFixture({
			artifact: candidateFiles(plan, rawManifest),
		})
		const { artifacts, coordinator } = createArtifactServices()
		const commits: unknown[] = []
		coordinator.subscribe((commit) => commits.push(commit))

		const committed = await coordinator.commitCandidate({
			definition,
			federation: { plan, artifactRoot: fixture.getPath('artifact') },
		})

		expect(artifacts.revision).toBe(1)
		expect(commits).toHaveLength(1)
		expect(committed.federation).toMatchObject({
			profile: 1,
			producer: plan.producer,
			buildRevision: 'revision-a',
			manifestUrl: `/__pluxel/runtime/federation/${plan.producer}/revision-a/mf-manifest.json`,
		})
		expect(committed.federation?.entries.map((entry) => entry.expose)).toEqual([
			'./views/manager',
			'./views/picker',
		])
		expect(
			artifacts.resolveEntry(definition, {
				kind: 'attachment',
				owner: definition,
				key: 'picker',
			}),
		).toMatchObject({ entry: { expose: './views/picker' } })

		const served = await artifacts.readArtifactFile(
			plan.producer,
			plan.buildRevision,
			'mf-manifest.json',
		)
		expect(Buffer.from(served!.body).toString('utf-8')).toBe(rawManifest)
		expect(served?.contentType).toBe('application/json; charset=utf-8')
		expect(served?.etag).toMatch(/^"sha256-[a-f\d]{64}"$/)
		const remoteRuntime = await artifacts.readArtifactFile(
			plan.producer,
			plan.buildRevision,
			'assets/remote-runtime.js',
		)
		expect(Buffer.from(remoteRuntime!.body).toString('utf-8')).toBe('export const ready = true\n')
		expect(remoteRuntime?.contentType).toBe('application/javascript; charset=utf-8')
		await writeFile(fixture.getPath('artifact/assets/late.js'), 'export const late = true\n')
		expect(
			await artifacts.readArtifactFile(plan.producer, plan.buildRevision, 'assets/late.js'),
		).toBeNull()
		expect(
			await artifacts.readArtifactFile(plan.producer, 'missing-revision', 'remoteEntry.js'),
		).toBeNull()
		expect(
			await artifacts.readArtifactFile(plan.producer, plan.buildRevision, '../remoteEntry.js'),
		).toBeNull()
		expect(artifacts.getPinned(plan.producer, 'missing-revision')).toBeUndefined()
	})

	it('keeps the previous current revision when candidate validation fails', async () => {
		const first = createPlan('revision-a')
		const rejected = createPlan('revision-b')
		const missingShared = manifest(rejected)
		missingShared.shared.pop()
		const extraShared = manifest(rejected)
		extraShared.shared.push({
			name: 'unexpected-shared',
			version: '1.0.0',
			requiredVersion: '1.0.0',
			singleton: true,
			assets: assetGroup(),
		})
		const wrongSharedVersion = manifest(rejected)
		wrongSharedVersion.shared[0]!.requiredVersion = '0.0.0'
		const wrongManifest = JSON.stringify(manifest(rejected, ['./views/not-declared']))
		await using fixture = await createDiskFixture({
			first: candidateFiles(first),
			missingShared: candidateFiles(rejected, JSON.stringify(missingShared)),
			extraShared: candidateFiles(rejected, JSON.stringify(extraShared)),
			wrongSharedVersion: candidateFiles(rejected, JSON.stringify(wrongSharedVersion)),
			rejected: candidateFiles(rejected, wrongManifest),
			escaping: candidateFiles(rejected),
			'outside.js': 'export const outside = true\n',
		})
		const { artifacts, coordinator } = createArtifactServices()
		await coordinator.commitCandidate({
			definition,
			federation: { plan: first, artifactRoot: fixture.getPath('first') },
		})

		for (const candidate of ['missingShared', 'extraShared']) {
			await expect(
				coordinator.commitCandidate({
					definition,
					federation: { plan: rejected, artifactRoot: fixture.getPath(candidate) },
				}),
			).rejects.toThrow('shared inventory mismatch')
		}
		await expect(
			coordinator.commitCandidate({
				definition,
				federation: { plan: rejected, artifactRoot: fixture.getPath('wrongSharedVersion') },
			}),
		).rejects.toThrow('expected exact singleton')
		await expect(
			coordinator.commitCandidate({
				definition,
				federation: { plan: rejected, artifactRoot: fixture.getPath('rejected') },
			}),
		).rejects.toThrow('expose inventory mismatch')
		await symlink('../../outside.js', fixture.getPath('escaping/assets/unlisted.js'))
		await expect(
			coordinator.commitCandidate({
				definition,
				federation: { plan: rejected, artifactRoot: fixture.getPath('escaping') },
			}),
		).rejects.toThrow('must be a regular file')

		expect(artifacts.revision).toBe(1)
		expect(artifacts.getCurrent(definition)?.buildRevision).toBe('revision-a')
		expect(artifacts.getPinned(rejected.producer, 'revision-b')).toBeUndefined()
	})

	it('rejects different bytes under an already committed immutable revision', async () => {
		const plan = createPlan('same-revision')
		await using fixture = await createDiskFixture({
			first: candidateFiles(plan),
			collision: {
				...candidateFiles(plan),
				'remoteEntry.js': 'export const changed = true\n',
			},
		})
		const { artifacts, coordinator } = createArtifactServices()
		await coordinator.commitCandidate({
			definition,
			federation: { plan, artifactRoot: fixture.getPath('first') },
		})

		await expect(
			coordinator.commitCandidate({
				definition,
				federation: { plan, artifactRoot: fixture.getPath('collision') },
			}),
		).rejects.toThrow('immutable federation revision collision')
		expect(artifacts.revision).toBe(1)
	})

	it('detects mutation of a committed asset instead of serving changed bytes', async () => {
		const plan = createPlan('revision-a')
		await using fixture = await createDiskFixture({ artifact: candidateFiles(plan) })
		const { artifacts, coordinator } = createArtifactServices()
		await coordinator.commitCandidate({
			definition,
			federation: { plan, artifactRoot: fixture.getPath('artifact') },
		})
		await writeFile(fixture.getPath('artifact/remoteEntry.js'), 'export const changed = true\n')

		await expect(
			artifacts.readArtifactFile(plan.producer, plan.buildRevision, 'remoteEntry.js'),
		).rejects.toThrow('committed federation artifact changed')
	})
})
