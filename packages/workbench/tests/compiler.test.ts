import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import {
	WorkbenchArtifactCoordinator,
	WorkbenchArtifactService,
	WorkbenchContentArtifactService,
	WorkbenchProducerStatusService,
} from '@pluxel/workbench/internal'
import { createWorkbenchContentSet, serializeWorkbenchContentSet } from '@pluxel/core/internal'
import {
	createWorkbenchFederationCompatibilitySet,
	createWorkbenchFederationProducerPlan,
	type WorkbenchFederationProducerPlan,
} from '@pluxel/core/federation'
import { createCoreInternalTestHost } from '@pluxel/core/internal/test'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { join } from 'pathe'
import * as React from 'react'
import * as ReactDom from 'react-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { version as runtimeVersion } from '@pluxel/workbench/package.json'

const producerBuildMocks = vi.hoisted(() => ({
	buildWorkbenchFederationProducer: vi.fn(
		async (input: { plan: WorkbenchFederationProducerPlan; outDir: string }) => {
			await writeProducer(input.plan, input.outDir)
		},
	),
}))

vi.mock('@pluxel/rolldown/vite/workbench-ui', () => ({
	buildWorkbenchFederationProducer: producerBuildMocks.buildWorkbenchFederationProducer,
}))

import { PluginArtifactCompiler } from '@pluxel/workbench/dev'

const definition = {
	entry: { kind: 'package-root', packageName: '@example/fonts' },
	exportName: 'FontsPlugin',
} as const
const compatibility = createWorkbenchFederationCompatibilitySet({
	react: React.version,
	reactDom: ReactDom.version,
	workbench: runtimeVersion,
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
		],
	})
}

function createContentCompilation(root: string, heading: string) {
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
								children: [{ type: 'text', value: heading }],
							},
						],
					},
				},
			},
		],
	})
	const bytes = new TextEncoder().encode(serializeWorkbenchContentSet(contentSet))
	return {
		contentSet,
		digest: createHash('sha256').update(bytes).digest('hex'),
		bytes,
		root,
		sources: [],
	}
}

function createWorkbenchStores(host: ReturnType<typeof createCoreInternalTestHost>) {
	const federation = new WorkbenchArtifactService(host.ctx)
	const content = new WorkbenchContentArtifactService(host.ctx)
	const coordinator = new WorkbenchArtifactCoordinator(host.ctx, federation, content)
	const producerStatus = new WorkbenchProducerStatusService()
	return { federation, content, coordinator, producerStatus }
}

describe('PluginArtifactCompiler', () => {
	beforeEach(() => {
		producerBuildMocks.buildWorkbenchFederationProducer.mockClear()
		producerBuildMocks.buildWorkbenchFederationProducer.mockImplementation(
			async (input: { plan: WorkbenchFederationProducerPlan; outDir: string }) => {
				await writeProducer(input.plan, input.outDir)
			},
		)
	})

	it('does not activate rejected catalog artifacts or cancel the accepted producer build', async () => {
		await using fixture = await createDiskFixture({
			'plugin/package.json': JSON.stringify({ name: '@example/fonts', type: 'module' }),
		})
		const host = createCoreInternalTestHost()
		const { federation, content, coordinator, producerStatus } = createWorkbenchStores(host)
		const compiler = new PluginArtifactCompiler(
			host.ctx,
			{ coordinator, producerStatus },
			{
				cacheDir: fixture.getPath('.pluxel/artifacts'),
				packageMode: 'development',
			},
		)
		const root = fixture.getPath('plugin')
		const previous = createContentCompilation(root, 'Accepted Content')
		let releaseBuild!: () => void
		const gate = new Promise<void>((resolve) => {
			releaseBuild = resolve
		})
		producerBuildMocks.buildWorkbenchFederationProducer.mockImplementationOnce(async (input) => {
			await gate
			await writeProducer(input.plan, input.outDir)
		})
		await compiler.publishWorkbenchArtifacts({
			producers: [{ plan: createPlan('accepted'), root }],
			content: [previous],
		})
		await vi.waitFor(() =>
			expect(producerBuildMocks.buildWorkbenchFederationProducer).toHaveBeenCalledOnce(),
		)
		const revision = coordinator.revision
		const rejected = await compiler.prepareWorkbenchArtifacts({
			producers: [{ plan: createPlan('rejected'), root }],
			content: [createContentCompilation(root, 'Rejected Content')],
		})
		expect(content.getCurrent(definition)?.digest).toBe(previous.digest)
		expect(coordinator.revision).toBe(revision)
		expect(producerStatus.getStatus(definition)).toMatchObject({ buildRevision: 'accepted' })
		rejected.rollback()
		rejected.commit()
		releaseBuild()
		await vi.waitFor(() =>
			expect(federation.getCurrent(definition)?.buildRevision).toBe('accepted'),
		)
		expect(content.getCurrent(definition)?.digest).toBe(previous.digest)
		expect(producerBuildMocks.buildWorkbenchFederationProducer).toHaveBeenCalledOnce()

		const next = createContentCompilation(root, 'Next accepted Content')
		const prepared = await compiler.prepareWorkbenchArtifacts({ producers: [], content: [next] })
		expect(content.getCurrent(definition)?.digest).toBe(previous.digest)
		prepared.commit()
		expect(content.getCurrent(definition)?.digest).toBe(next.digest)
		expect(federation.getCurrent(definition)).toBeUndefined()
		prepared.rollback()
		expect(content.getCurrent(definition)?.digest).toBe(next.digest)
		await compiler.dispose()
		await host.dispose()
	})

	it('rejects a late validation result from a superseded accepted generation', async () => {
		await using fixture = await createDiskFixture({
			'plugin/package.json': JSON.stringify({ name: '@example/fonts', type: 'module' }),
		})
		const host = createCoreInternalTestHost()
		const { federation, coordinator } = createWorkbenchStores(host)
		let releaseValidation!: () => void
		let validationEntered!: () => void
		const gate = new Promise<void>((resolve) => {
			releaseValidation = resolve
		})
		const entered = new Promise<void>((resolve) => {
			validationEntered = resolve
		})
		const originalPrepare = coordinator.prepareCandidate.bind(coordinator)
		vi.spyOn(coordinator, 'prepareCandidate').mockImplementation(async (candidate) => {
			const prepared = await originalPrepare(candidate)
			if (candidate.federation?.plan.buildRevision === 'previous') {
				validationEntered()
				await gate
			}
			return prepared
		})
		const compiler = new PluginArtifactCompiler(
			host.ctx,
			{ coordinator },
			{
				cacheDir: fixture.getPath('.pluxel/artifacts'),
				packageMode: 'development',
			},
		)
		const root = fixture.getPath('plugin')
		await compiler.publishWorkbenchArtifacts({
			producers: [{ plan: createPlan('previous'), root }],
			content: [],
		})
		await entered
		await compiler.publishWorkbenchArtifacts({
			producers: [],
			content: [createContentCompilation(root, 'Content only')],
		})
		releaseValidation()
		await vi.waitFor(() => expect(Reflect.get(compiler, 'producerBackgroundCommits').size).toBe(0))
		expect(federation.getCurrent(definition)).toBeUndefined()
		await compiler.dispose()
		await host.dispose()
	})

	it('publishes a development producer snapshot before the cold producer build finishes', async () => {
		await using fixture = await createDiskFixture({
			'plugin/package.json': JSON.stringify({ name: '@example/fonts', type: 'module' }),
		})
		const host = createCoreInternalTestHost()
		const { federation, coordinator, producerStatus } = createWorkbenchStores(host)
		const infoLog = vi.spyOn(host.ctx.logger, 'info')
		const compiler = new PluginArtifactCompiler(
			host.ctx,
			{ coordinator, producerStatus },
			{ cacheDir: fixture.getPath('.pluxel/artifacts'), packageMode: 'development' },
		)
		expect(producerStatus.pendingProducerBuildsEnabled).toBe(true)
		const plan = createPlan('semantic-revision-a')
		const input = { plan, root: fixture.getPath('plugin') }

		const [first] = await compiler.publishWorkbenchArtifacts({ producers: [input], content: [] })
		expect(first).toMatchObject({ federation: null, content: null })
		expect(federation.getCurrent(definition)).toBeUndefined()
		expect(producerStatus.getStatus(definition)).toMatchObject({
			state: 'building',
			producer: plan.producer,
			buildRevision: 'semantic-revision-a',
		})
		expect(producerBuildMocks.buildWorkbenchFederationProducer).not.toHaveBeenCalled()

		await vi.waitFor(() =>
			expect(federation.getCurrent(definition)?.buildRevision).toBe('semantic-revision-a'),
		)
		expect(producerStatus.getStatus(definition)).toBeUndefined()
		const committed = federation.getCurrent(definition)
		const [second] = await compiler.publishWorkbenchArtifacts({ producers: [input], content: [] })

		expect(second?.federation).toBe(committed)
		expect(federation.getCurrent(definition)).toBe(committed)
		expect(producerBuildMocks.buildWorkbenchFederationProducer).toHaveBeenCalledOnce()
		expect(producerBuildMocks.buildWorkbenchFederationProducer).toHaveBeenCalledWith(
			expect.objectContaining({
				plan,
				root: fixture.getPath('plugin'),
				packageMode: 'development',
				typeAssets: 'optional',
				minify: false,
				sourcemap: true,
			}),
		)
		expect(infoLog).toHaveBeenCalledTimes(2)
		expect(infoLog).toHaveBeenNthCalledWith(1, 'Workbench {definition}: build start', {
			definition: plan.definition.exportName,
			revision: plan.buildRevision.slice(0, 8),
			producer: plan.producer,
			buildRevision: plan.buildRevision,
		})
		expect(infoLog).toHaveBeenNthCalledWith(
			2,
			'Workbench {definition}: {cache} in {durationMs} ms',
			{
				definition: plan.definition.exportName,
				revision: plan.buildRevision.slice(0, 8),
				producer: plan.producer,
				buildRevision: plan.buildRevision,
				cache: 'built',
				durationMs: expect.any(Number),
			},
		)
		await compiler.dispose()
		expect(producerStatus.pendingProducerBuildsEnabled).toBe(false)
		await host.dispose()
	})

	it('keeps distribution producer publication synchronous and strict', async () => {
		await using fixture = await createDiskFixture({
			'plugin/package.json': JSON.stringify({ name: '@example/fonts', type: 'module' }),
		})
		const host = createCoreInternalTestHost()
		const { federation, coordinator } = createWorkbenchStores(host)
		const compiler = new PluginArtifactCompiler(
			host.ctx,
			{ coordinator },
			{ cacheDir: fixture.getPath('.pluxel/artifacts'), packageMode: 'distribution' },
		)
		const plan = createPlan('distribution-revision')
		const input = { plan, root: fixture.getPath('plugin') }

		const [commit] = await compiler.publishWorkbenchArtifacts({ producers: [input], content: [] })

		expect(commit?.federation?.buildRevision).toBe('distribution-revision')
		expect(federation.getCurrent(definition)).toBe(commit?.federation)
		expect(producerBuildMocks.buildWorkbenchFederationProducer).toHaveBeenCalledWith(
			expect.objectContaining({
				plan,
				packageMode: 'distribution',
				typeAssets: 'required',
			}),
		)

		await compiler.dispose()
		await host.dispose()
	})

	it('reports a reusable disk producer without logging the in-memory fast path', async () => {
		await using fixture = await createDiskFixture({
			'plugin/package.json': JSON.stringify({ name: '@example/fonts', type: 'module' }),
		})
		const host = createCoreInternalTestHost()
		const { coordinator } = createWorkbenchStores(host)
		const infoLog = vi.spyOn(host.ctx.logger, 'info')
		const options = {
			cacheDir: fixture.getPath('.pluxel/artifacts'),
			packageMode: 'development',
		} as const
		const input = { plan: createPlan('disk-revision'), root: fixture.getPath('plugin') }
		const firstCompiler = new PluginArtifactCompiler(host.ctx, { coordinator }, options)

		await firstCompiler.publishWorkbenchArtifacts({ producers: [input], content: [] })
		await vi.waitFor(() =>
			expect(infoLog).toHaveBeenCalledWith(
				'Workbench {definition}: {cache} in {durationMs} ms',
				expect.objectContaining({ cache: 'built' }),
			),
		)
		await firstCompiler.publishWorkbenchArtifacts({ producers: [input], content: [] })
		expect(infoLog).toHaveBeenCalledTimes(2)
		firstCompiler.dispose()

		const secondCompiler = new PluginArtifactCompiler(host.ctx, { coordinator }, options)
		await secondCompiler.publishWorkbenchArtifacts({ producers: [input], content: [] })

		expect(infoLog).toHaveBeenCalledTimes(3)
		expect(infoLog).toHaveBeenNthCalledWith(
			3,
			'Workbench {definition}: {cache} in {durationMs} ms',
			{
				definition: input.plan.definition.exportName,
				revision: input.plan.buildRevision.slice(0, 8),
				producer: input.plan.producer,
				buildRevision: input.plan.buildRevision,
				cache: 'reused',
				durationMs: expect.any(Number),
			},
		)

		secondCompiler.dispose()
		await host.dispose()
	})

	it('does not commit a failed candidate over the previous immutable revision', async () => {
		await using fixture = await createDiskFixture({
			'plugin/package.json': JSON.stringify({ name: '@example/fonts', type: 'module' }),
		})
		const host = createCoreInternalTestHost()
		const { federation, coordinator, producerStatus } = createWorkbenchStores(host)
		const errorLog = vi.spyOn(host.ctx.logger, 'error')
		const compiler = new PluginArtifactCompiler(
			host.ctx,
			{ coordinator, producerStatus },
			{ cacheDir: fixture.getPath('.pluxel/artifacts'), packageMode: 'development' },
		)
		await compiler.publishWorkbenchArtifacts({
			producers: [{ plan: createPlan('revision-a'), root: fixture.getPath('plugin') }],
			content: [],
		})
		await vi.waitFor(() =>
			expect(federation.getCurrent(definition)?.buildRevision).toBe('revision-a'),
		)
		producerBuildMocks.buildWorkbenchFederationProducer.mockRejectedValueOnce(
			new Error('candidate build failed'),
		)

		await expect(
			compiler.publishWorkbenchArtifacts({
				producers: [{ plan: createPlan('revision-b'), root: fixture.getPath('plugin') }],
				content: [],
			}),
		).resolves.toEqual([expect.objectContaining({ federation: null, content: null })])
		expect(federation.getCurrent(definition)).toBeUndefined()
		expect(federation.getPinned(createPlan('revision-b').producer, 'revision-b')).toBeUndefined()
		await vi.waitFor(() =>
			expect(errorLog).toHaveBeenCalledWith(
				'Workbench {definition}: failed after {durationMs} ms',
				{
					definition: createPlan('revision-b').definition.exportName,
					revision: 'revision',
					producer: createPlan('revision-b').producer,
					buildRevision: 'revision-b',
					durationMs: expect.any(Number),
					error: expect.objectContaining({ message: 'candidate build failed' }),
				},
			),
		)
		expect(producerStatus.getStatus(definition)).toMatchObject({
			state: 'failed',
			producer: createPlan('revision-b').producer,
			buildRevision: 'revision-b',
			message: 'candidate build failed',
		})

		await compiler.publishWorkbenchArtifacts({
			producers: [{ plan: createPlan('revision-b'), root: fixture.getPath('plugin') }],
			content: [],
		})
		expect(producerStatus.getStatus(definition)).toMatchObject({
			state: 'building',
			producer: createPlan('revision-b').producer,
			buildRevision: 'revision-b',
		})
		await vi.waitFor(() =>
			expect(federation.getCurrent(definition)?.buildRevision).toBe('revision-b'),
		)
		expect(producerStatus.getStatus(definition)).toBeUndefined()
		expect(producerBuildMocks.buildWorkbenchFederationProducer).toHaveBeenCalledTimes(3)

		await compiler.dispose()
		await host.dispose()
	})

	it('lets a newer semantic plan supersede an older in-flight candidate', async () => {
		await using fixture = await createDiskFixture({
			'plugin/package.json': JSON.stringify({ name: '@example/fonts', type: 'module' }),
		})
		const host = createCoreInternalTestHost()
		const { federation, coordinator } = createWorkbenchStores(host)
		const compiler = new PluginArtifactCompiler(
			host.ctx,
			{ coordinator },
			{ cacheDir: fixture.getPath('.pluxel/artifacts'), packageMode: 'development' },
		)
		const firstGate = deferred<void>()
		producerBuildMocks.buildWorkbenchFederationProducer.mockImplementationOnce(
			async (input: { plan: WorkbenchFederationProducerPlan; outDir: string }) => {
				await firstGate.promise
				await writeProducer(input.plan, input.outDir)
			},
		)
		const firstPlan = createPlan('revision-a')
		const secondPlan = createPlan('revision-b')
		const first = compiler.publishWorkbenchArtifacts({
			producers: [{ plan: firstPlan, root: fixture.getPath('plugin') }],
			content: [],
		})
		await vi.waitFor(() => {
			expect(producerBuildMocks.buildWorkbenchFederationProducer).toHaveBeenCalledOnce()
		})
		const second = compiler.publishWorkbenchArtifacts({
			producers: [{ plan: secondPlan, root: fixture.getPath('plugin') }],
			content: [],
		})
		await expect(second).resolves.toEqual([expect.objectContaining({ federation: null })])
		await vi.waitFor(() =>
			expect(federation.getCurrent(definition)?.buildRevision).toBe('revision-b'),
		)
		firstGate.resolve()

		await expect(first).resolves.toEqual([expect.objectContaining({ federation: null })])
		expect(federation.getCurrent(definition)?.buildRevision).toBe('revision-b')
		expect(federation.getPinned(firstPlan.producer, 'revision-a')).toBeUndefined()

		await compiler.dispose()
		await host.dispose()
	})

	it('publishes a Content-only snapshot without invoking the federation builder', async () => {
		await using fixture = await createDiskFixture({
			'plugin/package.json': JSON.stringify({ name: '@example/fonts', type: 'module' }),
		})
		const host = createCoreInternalTestHost()
		const { federation, content, coordinator } = createWorkbenchStores(host)
		const addWatchFiles = vi.fn()
		const compiler = new PluginArtifactCompiler(
			host.ctx,
			{
				coordinator,
				viteServer: {
					config: { root: fixture.path },
					watcher: { add: addWatchFiles },
				},
			},
			{ cacheDir: fixture.getPath('.pluxel/artifacts'), packageMode: 'development' },
		)
		const compilation = {
			...createContentCompilation(fixture.getPath('plugin'), 'Guide'),
			sources: [fixture.getPath('plugin/guide.md')],
		}

		const [commit] = await compiler.publishWorkbenchArtifacts({
			producers: [],
			content: [compilation],
		})

		expect(commit).toMatchObject({ federation: null, content: { digest: compilation.digest } })
		expect(federation.getCurrent(definition)).toBeUndefined()
		expect(content.getCurrent(definition)?.digest).toBe(compilation.digest)
		expect(producerBuildMocks.buildWorkbenchFederationProducer).not.toHaveBeenCalled()
		expect(addWatchFiles).toHaveBeenCalledWith(compilation.sources)

		await compiler.dispose()
		await host.dispose()
	})

	it('commits mixed Content and federation candidates once and withdraws stale tuple sides', async () => {
		await using fixture = await createDiskFixture({
			'plugin/package.json': JSON.stringify({ name: '@example/fonts', type: 'module' }),
		})
		const host = createCoreInternalTestHost()
		const { federation, content, coordinator } = createWorkbenchStores(host)
		const prepareCandidate = vi.spyOn(coordinator, 'prepareCandidate')
		const compiler = new PluginArtifactCompiler(
			host.ctx,
			{ coordinator },
			{ cacheDir: fixture.getPath('.pluxel/artifacts'), packageMode: 'development' },
		)
		const root = fixture.getPath('plugin')
		const compilation = createContentCompilation(root, 'Mixed')

		await compiler.publishWorkbenchArtifacts({
			producers: [{ plan: createPlan('mixed-a'), root }],
			content: [compilation],
		})
		expect(prepareCandidate).toHaveBeenCalledOnce()
		expect(prepareCandidate).toHaveBeenCalledWith({
			definition,
			content: expect.objectContaining({ digest: compilation.digest }),
		})
		await vi.waitFor(() => expect(federation.getCurrent(definition)?.buildRevision).toBe('mixed-a'))
		expect(content.getCurrent(definition)?.digest).toBe(compilation.digest)

		await compiler.publishWorkbenchArtifacts({ producers: [], content: [compilation] })
		expect(federation.getCurrent(definition)).toBeUndefined()
		expect(content.getCurrent(definition)?.digest).toBe(compilation.digest)

		await compiler.publishWorkbenchArtifacts({
			producers: [{ plan: createPlan('mixed-b'), root }],
			content: [compilation],
		})
		await vi.waitFor(() => expect(federation.getCurrent(definition)?.buildRevision).toBe('mixed-b'))
		await compiler.publishWorkbenchArtifacts({
			producers: [{ plan: createPlan('mixed-b'), root }],
			content: [],
		})
		expect(federation.getCurrent(definition)?.buildRevision).toBe('mixed-b')
		expect(content.getCurrent(definition)).toBeUndefined()

		await compiler.publishWorkbenchArtifacts({ producers: [], content: [] })
		expect(federation.getCurrent(definition)).toBeUndefined()
		expect(content.getCurrent(definition)).toBeUndefined()
		expect(prepareCandidate).toHaveBeenLastCalledWith({ definition })

		await compiler.dispose()
		await host.dispose()
	})

	it('keeps the prior mixed tuple when Content materialization fails', async () => {
		await using fixture = await createDiskFixture({
			'plugin/package.json': JSON.stringify({ name: '@example/fonts', type: 'module' }),
		})
		const host = createCoreInternalTestHost()
		const { federation, content, coordinator } = createWorkbenchStores(host)
		const compiler = new PluginArtifactCompiler(
			host.ctx,
			{ coordinator },
			{ cacheDir: fixture.getPath('.pluxel/artifacts'), packageMode: 'development' },
		)
		const root = fixture.getPath('plugin')
		const currentContent = createContentCompilation(root, 'Current')
		await compiler.publishWorkbenchArtifacts({
			producers: [{ plan: createPlan('mixed-current'), root }],
			content: [currentContent],
		})
		await vi.waitFor(() =>
			expect(federation.getCurrent(definition)?.buildRevision).toBe('mixed-current'),
		)
		const invalidContent = createContentCompilation(root, 'Invalid')
		invalidContent.bytes[0] = invalidContent.bytes[0]! ^ 1

		await expect(
			compiler.publishWorkbenchArtifacts({
				producers: [{ plan: createPlan('mixed-next'), root }],
				content: [invalidContent],
			}),
		).rejects.toThrow('digest does not match')
		expect(federation.getCurrent(definition)?.buildRevision).toBe('mixed-current')
		expect(content.getCurrent(definition)?.digest).toBe(currentContent.digest)

		await compiler.dispose()
		await host.dispose()
	})
})

async function writeProducer(plan: WorkbenchFederationProducerPlan, outDir: string): Promise<void> {
	await mkdir(join(outDir, 'assets'), { recursive: true })
	await mkdir(join(outDir, 'types'), { recursive: true })
	await writeFile(join(outDir, 'remoteEntry.js'), 'export const ready = true\n')
	await writeFile(join(outDir, 'assets/view.js'), 'export const view = true\n')
	await writeFile(join(outDir, 'types/index.d.ts'), 'export {}\n')
	await writeFile(join(outDir, '@mf-types.zip'), 'zip-placeholder')
	await writeFile(
		join(outDir, 'mf-manifest.json'),
		JSON.stringify({
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
				assets: assetGroup([]),
			})),
			exposes: plan.entries.map((entry) => ({
				name: entry.expose.slice(2),
				path: entry.expose.slice(2),
				assets: assetGroup(['assets/view.js']),
			})),
		}),
	)
}

function assetGroup(js: string[]) {
	return {
		js: { sync: js, async: [] },
		css: { sync: [], async: [] },
	}
}

function deferred<T>() {
	let resolvePromise!: (value: T | PromiseLike<T>) => void
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve
	})
	return { promise, resolve: resolvePromise }
}
