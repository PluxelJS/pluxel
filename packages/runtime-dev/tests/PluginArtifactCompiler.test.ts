import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { defineNodeModule } from '@pluxel/runtime'
import {
	WorkbenchArtifactCoordinator,
	WorkbenchArtifactService,
	WorkbenchContentArtifactService,
} from '@pluxel/runtime/internal'
import { createWorkbenchContentSet, serializeWorkbenchContentSet } from '@pluxel/core/internal'
import {
	createWorkbenchFederationCompatibilitySet,
	createWorkbenchFederationProducerPlan,
	type WorkbenchFederationProducerPlan,
} from '@pluxel/core/federation'
import { createHost } from '@pluxel/test'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { dirname, join } from 'pathe'
import * as React from 'react'
import * as ReactDom from 'react-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { version as runtimeVersion } from '../../runtime/package.json'

const producerBuildMocks = vi.hoisted(() => ({
	buildWorkbenchFederationProducer: vi.fn(
		async (input: { plan: WorkbenchFederationProducerPlan; outDir: string }) => {
			await writeProducer(input.plan, input.outDir)
		},
	),
}))

const nodeBuildMocks = vi.hoisted(() => ({
	buildNodeModule: vi.fn(),
	validateNodeModuleArtifact: vi.fn(),
}))

vi.mock('@pluxel/rolldown/vite/workbench-ui', () => ({
	buildWorkbenchFederationProducer: producerBuildMocks.buildWorkbenchFederationProducer,
}))

vi.mock('@pluxel/rolldown/vite/node-module', () => nodeBuildMocks)

import { PluginArtifactCompiler } from '../src/workbench/PluginArtifactCompiler'

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

function createWorkbenchStores(host: ReturnType<typeof createHost>) {
	const federation = new WorkbenchArtifactService(host.ctx)
	const content = new WorkbenchContentArtifactService(host.ctx)
	const coordinator = new WorkbenchArtifactCoordinator(host.ctx, federation, content)
	return { federation, content, coordinator }
}

describe('PluginArtifactCompiler', () => {
	beforeEach(() => {
		producerBuildMocks.buildWorkbenchFederationProducer.mockClear()
		producerBuildMocks.buildWorkbenchFederationProducer.mockImplementation(
			async (input: { plan: WorkbenchFederationProducerPlan; outDir: string }) => {
				await writeProducer(input.plan, input.outDir)
			},
		)
		nodeBuildMocks.buildNodeModule
			.mockReset()
			.mockImplementation(async (input: { outFile: string }) => {
				await mkdir(dirname(input.outFile), { recursive: true })
				await writeFile(input.outFile, 'export const ready = true\n')
			})
		nodeBuildMocks.validateNodeModuleArtifact.mockReset().mockResolvedValue(undefined)
	})

	it('builds and commits one semantic producer plan without recomputing its revision', async () => {
		await using fixture = await createDiskFixture({
			'plugin/package.json': JSON.stringify({ name: '@example/fonts', type: 'module' }),
		})
		const host = createHost()
		const { federation, coordinator } = createWorkbenchStores(host)
		const infoLog = vi.spyOn(host.ctx.logger, 'info')
		const compiler = new PluginArtifactCompiler(
			host.ctx,
			{ coordinator },
			{ cacheDir: fixture.getPath('.pluxel/artifacts'), packageMode: 'development' },
		)
		const plan = createPlan('semantic-revision-a')
		const input = { plan, root: fixture.getPath('plugin') }

		const [first] = await compiler.publishWorkbenchArtifacts({ producers: [input], content: [] })
		const [second] = await compiler.publishWorkbenchArtifacts({ producers: [input], content: [] })

		expect(first?.federation?.buildRevision).toBe('semantic-revision-a')
		expect(second?.federation).toBe(first?.federation)
		expect(federation.getCurrent(definition)).toBe(first?.federation)
		expect(producerBuildMocks.buildWorkbenchFederationProducer).toHaveBeenCalledOnce()
		expect(producerBuildMocks.buildWorkbenchFederationProducer).toHaveBeenCalledWith(
			expect.objectContaining({
				plan,
				root: fixture.getPath('plugin'),
				packageMode: 'development',
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
		compiler.dispose()
		await host.dispose()
	})

	it('reports a reusable disk producer without logging the in-memory fast path', async () => {
		await using fixture = await createDiskFixture({
			'plugin/package.json': JSON.stringify({ name: '@example/fonts', type: 'module' }),
		})
		const host = createHost()
		const { coordinator } = createWorkbenchStores(host)
		const infoLog = vi.spyOn(host.ctx.logger, 'info')
		const options = {
			cacheDir: fixture.getPath('.pluxel/artifacts'),
			packageMode: 'development',
		} as const
		const input = { plan: createPlan('disk-revision'), root: fixture.getPath('plugin') }
		const firstCompiler = new PluginArtifactCompiler(host.ctx, { coordinator }, options)

		await firstCompiler.publishWorkbenchArtifacts({ producers: [input], content: [] })
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
		const host = createHost()
		const { federation, coordinator } = createWorkbenchStores(host)
		const errorLog = vi.spyOn(host.ctx.logger, 'error')
		const compiler = new PluginArtifactCompiler(
			host.ctx,
			{ coordinator },
			{ cacheDir: fixture.getPath('.pluxel/artifacts'), packageMode: 'development' },
		)
		await compiler.publishWorkbenchArtifacts({
			producers: [{ plan: createPlan('revision-a'), root: fixture.getPath('plugin') }],
			content: [],
		})
		producerBuildMocks.buildWorkbenchFederationProducer.mockRejectedValueOnce(
			new Error('candidate build failed'),
		)

		await expect(
			compiler.publishWorkbenchArtifacts({
				producers: [{ plan: createPlan('revision-b'), root: fixture.getPath('plugin') }],
				content: [],
			}),
		).rejects.toThrow('candidate build failed')
		expect(federation.getCurrent(definition)?.buildRevision).toBe('revision-a')
		expect(federation.getPinned(createPlan('revision-b').producer, 'revision-b')).toBeUndefined()
		expect(errorLog).toHaveBeenCalledWith('Workbench {definition}: failed after {durationMs} ms', {
			definition: createPlan('revision-b').definition.exportName,
			revision: 'revision',
			producer: createPlan('revision-b').producer,
			buildRevision: 'revision-b',
			durationMs: expect.any(Number),
			error: expect.objectContaining({ message: 'candidate build failed' }),
		})

		await expect(
			compiler.publishWorkbenchArtifacts({
				producers: [{ plan: createPlan('revision-b'), root: fixture.getPath('plugin') }],
				content: [],
			}),
		).resolves.toEqual([
			expect.objectContaining({
				federation: expect.objectContaining({ buildRevision: 'revision-b' }),
			}),
		])
		expect(producerBuildMocks.buildWorkbenchFederationProducer).toHaveBeenCalledTimes(3)

		compiler.dispose()
		await host.dispose()
	})

	it('lets a newer semantic plan supersede an older in-flight candidate', async () => {
		await using fixture = await createDiskFixture({
			'plugin/package.json': JSON.stringify({ name: '@example/fonts', type: 'module' }),
		})
		const host = createHost()
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
		await expect(second).resolves.toEqual([
			expect.objectContaining({
				federation: expect.objectContaining({ buildRevision: 'revision-b' }),
			}),
		])
		firstGate.resolve()

		await expect(first).resolves.toEqual([])
		expect(federation.getCurrent(definition)?.buildRevision).toBe('revision-b')
		expect(federation.getPinned(firstPlan.producer, 'revision-a')).toBeUndefined()

		compiler.dispose()
		await host.dispose()
	})

	it('publishes a Content-only snapshot without invoking the federation builder', async () => {
		await using fixture = await createDiskFixture({
			'plugin/package.json': JSON.stringify({ name: '@example/fonts', type: 'module' }),
		})
		const host = createHost()
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

		compiler.dispose()
		await host.dispose()
	})

	it('commits mixed Content and federation candidates once and withdraws stale tuple sides', async () => {
		await using fixture = await createDiskFixture({
			'plugin/package.json': JSON.stringify({ name: '@example/fonts', type: 'module' }),
		})
		const host = createHost()
		const { federation, content, coordinator } = createWorkbenchStores(host)
		const commitCandidate = vi.spyOn(coordinator, 'commitCandidate')
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
		expect(commitCandidate).toHaveBeenCalledOnce()
		expect(commitCandidate).toHaveBeenCalledWith({
			definition,
			federation: expect.objectContaining({
				plan: expect.objectContaining({ buildRevision: 'mixed-a' }),
			}),
			content: expect.objectContaining({ digest: compilation.digest }),
		})

		await compiler.publishWorkbenchArtifacts({ producers: [], content: [compilation] })
		expect(federation.getCurrent(definition)).toBeUndefined()
		expect(content.getCurrent(definition)?.digest).toBe(compilation.digest)

		await compiler.publishWorkbenchArtifacts({
			producers: [{ plan: createPlan('mixed-b'), root }],
			content: [compilation],
		})
		await compiler.publishWorkbenchArtifacts({
			producers: [{ plan: createPlan('mixed-b'), root }],
			content: [],
		})
		expect(federation.getCurrent(definition)?.buildRevision).toBe('mixed-b')
		expect(content.getCurrent(definition)).toBeUndefined()

		await compiler.publishWorkbenchArtifacts({ producers: [], content: [] })
		expect(federation.getCurrent(definition)).toBeUndefined()
		expect(content.getCurrent(definition)).toBeUndefined()
		expect(commitCandidate).toHaveBeenLastCalledWith({ definition })

		compiler.dispose()
		await host.dispose()
	})

	it('keeps the prior mixed tuple when Content materialization fails', async () => {
		await using fixture = await createDiskFixture({
			'plugin/package.json': JSON.stringify({ name: '@example/fonts', type: 'module' }),
		})
		const host = createHost()
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

		compiler.dispose()
		await host.dispose()
	})

	it('shares Node builds, reports failed rebuilds, and keeps the last good artifact', async () => {
		await using fixture = await createDiskFixture({
			'plugin.ts': 'export const plugin = true\n',
			'task.ts': 'export const version = 1\n',
		})
		const host = createHost()
		const compiler = new PluginArtifactCompiler(
			host.ctx,
			{},
			{ cacheDir: fixture.getPath('.pluxel/artifacts'), packageMode: 'development' },
		)
		const declaration = defineNodeModule(pathToFileURL(fixture.getPath('plugin.ts')), './task.ts')
		const updates: URL[][] = [[], []]
		const errors: unknown[][] = [[], []]
		const consumers = await Promise.all(
			[0, 1].map((index) =>
				compiler.watchNodeModule(
					declaration,
					(url) => void updates[index]!.push(url),
					(error) => errors[index]!.push(error),
				),
			),
		)
		expect(nodeBuildMocks.buildNodeModule).toHaveBeenCalledTimes(1)
		expect(nodeBuildMocks.validateNodeModuleArtifact).not.toHaveBeenCalled()
		expect(consumers[0]!.url).toEqual(consumers[1]!.url)

		const internals = compiler as unknown as {
			nodeEntries: Map<string, { dirty: boolean }>
			compileNodeEntry(entry: { dirty: boolean }, initial: boolean): Promise<void>
		}
		const entry = [...internals.nodeEntries.values()][0]!
		const rebuildError = new Error('broken rebuild')
		nodeBuildMocks.buildNodeModule.mockRejectedValueOnce(rebuildError)
		await writeFile(fixture.getPath('task.ts'), 'export const version = 2\n')
		entry.dirty = true
		await internals.compileNodeEntry(entry, false)
		expect(errors).toEqual([[rebuildError], [rebuildError]])
		expect(updates).toEqual([[], []])

		await writeFile(fixture.getPath('task.ts'), 'export const version = 3\n')
		entry.dirty = true
		await internals.compileNodeEntry(entry, false)
		expect(updates.map((items) => items.length)).toEqual([1, 1])
		expect(nodeBuildMocks.buildNodeModule).toHaveBeenCalledTimes(3)

		await Promise.all(consumers.map((consumer) => consumer.dispose()))
		compiler.dispose()
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
