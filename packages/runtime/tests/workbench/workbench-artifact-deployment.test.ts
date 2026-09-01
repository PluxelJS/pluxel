import { createHash } from 'node:crypto'
import { symlink, writeFile } from 'node:fs/promises'
import { pluginDefinitionIndexKey, type PluginDefinitionAddress } from '@pluxel/core'
import {
	WORKBENCH_PAGE_ARTIFACT_FILE,
	WORKBENCH_PAGE_DEPLOYMENT_INVENTORY_FILE,
	createWorkbenchPageSet,
	createWorkbenchPageDeploymentInventory,
	serializeWorkbenchPageDefinition,
	serializeWorkbenchPageSet,
	workbenchPageArtifactRoot,
} from '@pluxel/core/internal'
import {
	WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE,
	createWorkbenchFederationCompatibilitySet,
	createWorkbenchFederationDeploymentInventory,
	createWorkbenchFederationProducerPlan,
	type WorkbenchFederationProducerPlan,
} from '@pluxel/core/federation'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { withRuntimeHost } from '@pluxel/runtime/test'
import * as React from 'react'
import * as ReactDom from 'react-dom'
import { describe, expect, it, vi } from 'vitest'

import { version as runtimeVersion } from '../../package.json'
import { requireWorkbench } from '../../src/services/workbench.ts'
import { WorkbenchArtifactService } from '../../src/services/workbench/WorkbenchArtifactService.ts'
import { WorkbenchArtifactCoordinator } from '../../src/services/workbench/WorkbenchArtifactCoordinator.ts'
import { WorkbenchPageArtifactService } from '../../src/services/workbench/WorkbenchPageArtifactService.ts'
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
	const pages = new WorkbenchPageArtifactService(root)
	const coordinator = new WorkbenchArtifactCoordinator(root, artifacts, pages)
	return { artifacts, pages, coordinator }
}

function createPageArtifact(value: string) {
	const pageSet = createWorkbenchPageSet({
		definition,
		entries: [
			{
				key: 'guide',
				page: {
					version: 1,
					kind: 'standard-page',
					document: {
						version: 1,
						blocks: [
							{
								type: 'paragraph',
								children: [{ type: 'text', value }],
							},
						],
					},
				},
			},
		],
	})
	const bytes = serializeWorkbenchPageSet(pageSet)
	return Object.freeze({
		bytes,
		candidate: Object.freeze({
			definition,
			definitionDigest: sha256(serializeWorkbenchPageDefinition(definition)),
			digest: sha256(bytes),
		}),
	})
}

function sha256(input: string | Uint8Array): string {
	return createHash('sha256').update(input).digest('hex')
}

describe('WorkbenchArtifactService', () => {
	it('commits and resolves one bounded immutable Standard Page set', async () => {
		const page = createPageArtifact('Guide')
		await using fixture = await createDiskFixture({
			page: { [WORKBENCH_PAGE_ARTIFACT_FILE]: page.bytes },
			overBudget: { [WORKBENCH_PAGE_ARTIFACT_FILE]: 'x'.repeat(512 * 1_024 + 2) },
		})
		const { pages, coordinator } = createArtifactServices()
		const committed = await coordinator.commitCandidate({
			definition,
			pages: { ...page.candidate, artifactRoot: fixture.getPath('page') },
		})

		expect(committed.pages).toMatchObject({ digest: page.candidate.digest })
		expect(
			pages.resolvePage(definition, { kind: 'page', owner: definition, key: 'guide' }),
		).toMatchObject({
			plan: {
				kind: 'standard-page',
				document: { blocks: [{ type: 'paragraph' }] },
			},
		})
		expect(() => pages.withdrawCurrent(Symbol('unauthorized'), definition)).toThrow(
			'coordinator authority',
		)
		expect(pages.getCurrent(definition)?.digest).toBe(page.candidate.digest)
		await expect(
			coordinator.commitCandidate({
				definition,
				pages: {
					...page.candidate,
					digest: sha256('x'.repeat(512 * 1_024 + 2)),
					artifactRoot: fixture.getPath('overBudget'),
				},
			}),
		).rejects.toThrow('serialized byte budget')
	})

	it('rejects malformed optional sides and invalid UTF-8 Page artifacts before mutation', async () => {
		const invalidBytes = Buffer.from([0xff])
		await using fixture = await createDiskFixture({
			invalidUtf8: { [WORKBENCH_PAGE_ARTIFACT_FILE]: invalidBytes },
		})
		const { artifacts, pages, coordinator } = createArtifactServices()

		await expect(
			coordinator.commitCandidate({ definition, federation: false } as never),
		).rejects.toThrow('federation must be an object')
		await expect(coordinator.commitCandidate({ definition, pages: null } as never)).rejects.toThrow(
			'pages must be an object',
		)
		await expect(
			coordinator.commitCandidate({
				definition,
				pages: {
					definition,
					definitionDigest: sha256(serializeWorkbenchPageDefinition(definition)),
					digest: sha256(invalidBytes),
					artifactRoot: fixture.getPath('invalidUtf8'),
				},
			}),
		).rejects.toThrow('not valid UTF-8')

		expect(coordinator.revision).toBe(0)
		expect(artifacts.getCurrent(definition)).toBeUndefined()
		expect(pages.getCurrent(definition)).toBeUndefined()
	})

	it('commits a full desired artifact tuple atomically and withdraws absent sides', async () => {
		const federationA = createPlan('transaction-a')
		const federationB = createPlan('transaction-b')
		const pageA = createPageArtifact('A')
		const pageB = createPageArtifact('B')
		await using fixture = await createDiskFixture({
			federationA: candidateFiles(federationA),
			federationB: candidateFiles(federationB),
			pageA: { [WORKBENCH_PAGE_ARTIFACT_FILE]: pageA.bytes },
			pageB: { [WORKBENCH_PAGE_ARTIFACT_FILE]: pageB.bytes },
		})
		const root = { logger: { error: vi.fn() } } as never
		const federation = new WorkbenchArtifactService(root)
		const pages = new WorkbenchPageArtifactService(root)
		const coordinator = new WorkbenchArtifactCoordinator(root, federation, pages)
		const commits = vi.fn()
		coordinator.subscribe(commits)

		await coordinator.commitCandidate({
			definition,
			federation: { plan: federationA, artifactRoot: fixture.getPath('federationA') },
			pages: { ...pageA.candidate, artifactRoot: fixture.getPath('pageA') },
		})
		expect(commits).toHaveBeenCalledTimes(1)
		expect(federation.getCurrent(definition)?.buildRevision).toBe('transaction-a')
		expect(pages.getCurrent(definition)?.digest).toBe(pageA.candidate.digest)

		const commitPrepared = pages.commitPrepared.bind(pages)
		vi.spyOn(pages, 'commitPrepared').mockImplementationOnce((...args) => {
			commitPrepared(...args)
			throw new Error('simulated post-commit Page failure')
		})
		await expect(
			coordinator.commitCandidate({
				definition,
				federation: { plan: federationB, artifactRoot: fixture.getPath('federationB') },
				pages: { ...pageB.candidate, artifactRoot: fixture.getPath('pageB') },
			}),
		).rejects.toThrow('simulated post-commit Page failure')
		expect(commits).toHaveBeenCalledTimes(1)
		expect(coordinator.revision).toBe(1)
		expect(federation.revision).toBe(1)
		expect(pages.revision).toBe(1)
		expect(federation.getCurrent(definition)?.buildRevision).toBe('transaction-a')
		expect(federation.getPinned(federationB.producer, federationB.buildRevision)).toBeUndefined()
		expect(pages.getCurrent(definition)?.digest).toBe(pageA.candidate.digest)
		expect(
			pages.getPinned(pageB.candidate.definitionDigest, pageB.candidate.digest),
		).toBeUndefined()

		const pageOnly = await coordinator.commitCandidate({
			definition,
			pages: { ...pageB.candidate, artifactRoot: fixture.getPath('pageB') },
		})
		expect(pageOnly.federation).toBeNull()
		expect(pageOnly.pages?.digest).toBe(pageB.candidate.digest)
		expect(federation.getCurrent(definition)).toBeUndefined()

		const federationOnly = await coordinator.commitCandidate({
			definition,
			federation: { plan: federationB, artifactRoot: fixture.getPath('federationB') },
		})
		expect(federationOnly.federation?.buildRevision).toBe('transaction-b')
		expect(federationOnly.pages).toBeNull()
		expect(pages.getCurrent(definition)).toBeUndefined()

		const withdrawn = await coordinator.commitCandidate({ definition })
		expect(withdrawn).toMatchObject({ federation: null, pages: null })
		expect(federation.getCurrent(definition)).toBeUndefined()
		expect(pages.getCurrent(definition)).toBeUndefined()
		expect(commits).toHaveBeenCalledTimes(4)
	})

	it('rolls back commits that fail after withdrawing an absent side', async () => {
		const federationA = createPlan('absent-rollback-a')
		const federationB = createPlan('absent-rollback-b')
		const pageA = createPageArtifact('A')
		const pageB = createPageArtifact('B')
		await using fixture = await createDiskFixture({
			federationA: candidateFiles(federationA),
			federationB: candidateFiles(federationB),
			pageA: { [WORKBENCH_PAGE_ARTIFACT_FILE]: pageA.bytes },
			pageB: { [WORKBENCH_PAGE_ARTIFACT_FILE]: pageB.bytes },
		})
		const { artifacts, pages, coordinator } = createArtifactServices()
		const commits = vi.fn()
		coordinator.subscribe(commits)
		await coordinator.commitCandidate({
			definition,
			federation: { plan: federationA, artifactRoot: fixture.getPath('federationA') },
			pages: { ...pageA.candidate, artifactRoot: fixture.getPath('pageA') },
		})

		const commitPages = pages.commitPrepared.bind(pages)
		const pageCommitSpy = vi.spyOn(pages, 'commitPrepared').mockImplementationOnce((...args) => {
			commitPages(...args)
			throw new Error('simulated Page commit failure after federation withdraw')
		})
		await expect(
			coordinator.commitCandidate({
				definition,
				pages: { ...pageB.candidate, artifactRoot: fixture.getPath('pageB') },
			}),
		).rejects.toThrow('after federation withdraw')
		pageCommitSpy.mockRestore()

		expect(coordinator.revision).toBe(1)
		expect(artifacts.revision).toBe(1)
		expect(pages.revision).toBe(1)
		expect(commits).toHaveBeenCalledTimes(1)
		expect(artifacts.getCurrent(definition)?.buildRevision).toBe(federationA.buildRevision)
		expect(artifacts.getPinned(federationA.producer, federationA.buildRevision)).toBeDefined()
		expect(pages.getCurrent(definition)?.digest).toBe(pageA.candidate.digest)
		expect(
			pages.getPinned(pageB.candidate.definitionDigest, pageB.candidate.digest),
		).toBeUndefined()

		const withdrawPages = pages.withdrawCurrent.bind(pages)
		const pageWithdrawSpy = vi.spyOn(pages, 'withdrawCurrent').mockImplementationOnce((...args) => {
			withdrawPages(...args)
			throw new Error('simulated Page withdraw failure after federation commit')
		})
		await expect(
			coordinator.commitCandidate({
				definition,
				federation: { plan: federationB, artifactRoot: fixture.getPath('federationB') },
			}),
		).rejects.toThrow('after federation commit')
		pageWithdrawSpy.mockRestore()

		expect(coordinator.revision).toBe(1)
		expect(artifacts.revision).toBe(1)
		expect(pages.revision).toBe(1)
		expect(commits).toHaveBeenCalledTimes(1)
		expect(artifacts.getCurrent(definition)?.buildRevision).toBe(federationA.buildRevision)
		expect(artifacts.getPinned(federationB.producer, federationB.buildRevision)).toBeUndefined()
		expect(pages.getCurrent(definition)?.digest).toBe(pageA.candidate.digest)
		expect(pages.getPinned(pageA.candidate.definitionDigest, pageA.candidate.digest)).toBeDefined()
	})

	it('invalidates an active session once for one coordinated Page commit', async () => {
		const page = createPageArtifact('Session update')
		await using fixture = await createDiskFixture({
			page: { [WORKBENCH_PAGE_ARTIFACT_FILE]: page.bytes },
		})

		await withRuntimeHost(async (host) => {
			await host.commit()
			const backend = requireWorkbench(host.ctx)
			const coordinatorEvents = vi.fn()
			const invalidated = vi.fn()
			const unsubscribe = backend.artifactCoordinator.subscribe(coordinatorEvents)
			const session = backend.createSession(
				{ provider: 'test', subject: 'session-page-update' },
				invalidated,
			)

			try {
				await backend.artifactCoordinator.commitCandidate({
					definition,
					pages: { ...page.candidate, artifactRoot: fixture.getPath('page') },
				})

				expect(coordinatorEvents).toHaveBeenCalledTimes(1)
				expect(invalidated).toHaveBeenCalledTimes(1)
				expect(session.signal.aborted).toBe(true)
			} finally {
				unsubscribe()
				session.dispose()
			}
		})
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

		await withRuntimeHost(
			async (host) => {
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
			},
			{ workbenchArtifactRoot: fixture.getPath('workbench') },
		)
	})

	it('loads a Page-only production inventory from its canonical Workbench path', async () => {
		const page = createPageArtifact('Packaged guide')
		const artifactRoot = workbenchPageArtifactRoot(
			page.candidate.definitionDigest,
			page.candidate.digest,
		)
		const pageInventory = createWorkbenchPageDeploymentInventory([
			{
				...page.candidate,
				artifactRoot,
			},
		])
		await using fixture = await createDiskFixture({
			workbench: {
				[WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE]: `${JSON.stringify(
					createWorkbenchFederationDeploymentInventory([]),
				)}\n`,
				[WORKBENCH_PAGE_DEPLOYMENT_INVENTORY_FILE]: `${JSON.stringify(pageInventory)}\n`,
				pages: {
					[page.candidate.definitionDigest]: {
						[page.candidate.digest]: { [WORKBENCH_PAGE_ARTIFACT_FILE]: page.bytes },
					},
				},
			},
		})

		await withRuntimeHost(
			async (host) => {
				await host.commit()
				const pages = requireWorkbench(host.ctx).pages
				expect(pages.getCurrent(definition)).toMatchObject({
					definitionDigest: page.candidate.definitionDigest,
					digest: page.candidate.digest,
				})
				expect(
					pages.resolvePage(definition, {
						kind: 'page',
						owner: definition,
						key: 'guide',
					}),
				).toMatchObject({ plan: { document: { blocks: [{ type: 'paragraph' }] } } })
			},
			{ workbenchArtifactRoot: fixture.getPath('workbench') },
		)
	})

	it('merges packaged federation and Page inventories into one definition commit', async () => {
		const plan = createPlan('production-mixed')
		const page = createPageArtifact('Mixed packaged guide')
		const pageArtifactRoot = workbenchPageArtifactRoot(
			page.candidate.definitionDigest,
			page.candidate.digest,
		)
		const federationInventory = createWorkbenchFederationDeploymentInventory([plan])
		const pageInventory = createWorkbenchPageDeploymentInventory([
			{ ...page.candidate, artifactRoot: pageArtifactRoot },
		])
		await using fixture = await createDiskFixture({
			workbench: {
				[WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE]: `${JSON.stringify(federationInventory)}\n`,
				[WORKBENCH_PAGE_DEPLOYMENT_INVENTORY_FILE]: `${JSON.stringify(pageInventory)}\n`,
				[plan.producer]: { [plan.buildRevision]: candidateFiles(plan) },
				pages: {
					[page.candidate.definitionDigest]: {
						[page.candidate.digest]: { [WORKBENCH_PAGE_ARTIFACT_FILE]: page.bytes },
					},
				},
			},
		})

		await withRuntimeHost(
			async (host) => {
				const backend = requireWorkbench(host.ctx)
				const commits = vi.fn()
				backend.artifactCoordinator.subscribe(commits)
				await host.commit()

				expect(commits).toHaveBeenCalledTimes(1)
				expect(backend.artifacts.getCurrent(definition)?.buildRevision).toBe('production-mixed')
				expect(backend.pages.getCurrent(definition)?.digest).toBe(page.candidate.digest)
			},
			{ workbenchArtifactRoot: fixture.getPath('workbench') },
		)
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
		const { artifacts, pages, coordinator } = createArtifactServices()
		const commits = vi.fn()
		coordinator.subscribe(commits)

		await expect(
			loadPackagedWorkbenchDeployment(coordinator, fixture.getPath('workbench')),
		).rejects.toThrow('expose inventory mismatch')

		expect(commits).not.toHaveBeenCalled()
		expect(coordinator.revision).toBe(0)
		expect(artifacts.getCurrent(valid.definition)).toBeUndefined()
		expect(artifacts.getCurrent(rejected.definition)).toBeUndefined()
		expect(pages.revision).toBe(0)
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
