import { symlink, writeFile } from 'node:fs/promises'
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

const definition = {
	entry: { kind: 'package-root', packageName: '@example/fonts' },
	exportName: 'FontsPlugin',
} as const
const compatibility = createWorkbenchFederationCompatibilitySet({
	react: React.version,
	reactDom: ReactDom.version,
	runtime: runtimeVersion,
})

function createPlan(buildRevision: string): WorkbenchFederationProducerPlan {
	return createWorkbenchFederationProducerPlan({
		definition,
		buildRevision,
		entries: [
			{
				descriptor: { kind: 'view', owner: definition, key: 'manager' },
				bridgeEntryPath: 'generated/manager.tsx',
			},
			{
				descriptor: { kind: 'attachment', owner: definition, key: 'picker' },
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

function createService() {
	return new WorkbenchArtifactService({
		logger: { error: vi.fn() },
	} as never)
}

describe('WorkbenchArtifactService', () => {
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

	it('atomically commits one exact standard Manifest revision and serves its raw bytes', async () => {
		const plan = createPlan('revision-a')
		const rawManifest = `${JSON.stringify(manifest(plan), null, 2)}\n`
		await using fixture = await createDiskFixture({
			artifact: candidateFiles(plan, rawManifest),
		})
		const artifacts = createService()
		const commits: unknown[] = []
		artifacts.subscribe((commit) => commits.push(commit))

		const committed = await artifacts.commitCandidate({
			plan,
			artifactRoot: fixture.getPath('artifact'),
		})

		expect(artifacts.revision).toBe(1)
		expect(commits).toHaveLength(1)
		expect(committed).toMatchObject({
			profile: 1,
			producer: plan.producer,
			buildRevision: 'revision-a',
			manifestUrl: `/__pluxel/runtime/federation/${plan.producer}/revision-a/mf-manifest.json`,
		})
		expect(committed.entries.map((entry) => entry.expose)).toEqual([
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
		const artifacts = createService()
		await artifacts.commitCandidate({
			plan: first,
			artifactRoot: fixture.getPath('first'),
		})

		for (const candidate of ['missingShared', 'extraShared']) {
			await expect(
				artifacts.commitCandidate({
					plan: rejected,
					artifactRoot: fixture.getPath(candidate),
				}),
			).rejects.toThrow('shared inventory mismatch')
		}
		await expect(
			artifacts.commitCandidate({
				plan: rejected,
				artifactRoot: fixture.getPath('wrongSharedVersion'),
			}),
		).rejects.toThrow('expected exact singleton')
		await expect(
			artifacts.commitCandidate({
				plan: rejected,
				artifactRoot: fixture.getPath('rejected'),
			}),
		).rejects.toThrow('expose inventory mismatch')
		await symlink('../../outside.js', fixture.getPath('escaping/assets/unlisted.js'))
		await expect(
			artifacts.commitCandidate({
				plan: rejected,
				artifactRoot: fixture.getPath('escaping'),
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
		const artifacts = createService()
		await artifacts.commitCandidate({ plan, artifactRoot: fixture.getPath('first') })

		await expect(
			artifacts.commitCandidate({ plan, artifactRoot: fixture.getPath('collision') }),
		).rejects.toThrow('immutable federation revision collision')
		expect(artifacts.revision).toBe(1)
	})

	it('detects mutation of a committed asset instead of serving changed bytes', async () => {
		const plan = createPlan('revision-a')
		await using fixture = await createDiskFixture({ artifact: candidateFiles(plan) })
		const artifacts = createService()
		await artifacts.commitCandidate({
			plan,
			artifactRoot: fixture.getPath('artifact'),
		})
		await writeFile(fixture.getPath('artifact/remoteEntry.js'), 'export const changed = true\n')

		await expect(
			artifacts.readArtifactFile(plan.producer, plan.buildRevision, 'remoteEntry.js'),
		).rejects.toThrow('committed federation artifact changed')
	})
})
