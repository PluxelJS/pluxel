import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { defineNodeModule } from '@pluxel/runtime'
import { WorkbenchArtifactService } from '@pluxel/runtime/internal'
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
		const artifacts = new WorkbenchArtifactService(host.ctx)
		const compiler = new PluginArtifactCompiler(
			host.ctx,
			{ store: artifacts },
			{ cacheDir: fixture.getPath('.pluxel/artifacts'), packageMode: 'development' },
		)
		const plan = createPlan('semantic-revision-a')
		const input = { plan, root: fixture.getPath('plugin') }

		const [first, second] = await Promise.all([
			compiler.publishWorkbenchProducer(input),
			compiler.publishWorkbenchProducer(input),
		])
		const third = await compiler.publishWorkbenchProducer(input)

		expect(first).toBe(second)
		expect(third).toBe(first)
		expect(first?.buildRevision).toBe('semantic-revision-a')
		expect(artifacts.getCurrent(definition)).toBe(first)
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
		compiler.dispose()
		await host.dispose()
	})

	it('does not commit a failed candidate over the previous immutable revision', async () => {
		await using fixture = await createDiskFixture({
			'plugin/package.json': JSON.stringify({ name: '@example/fonts', type: 'module' }),
		})
		const host = createHost()
		const artifacts = new WorkbenchArtifactService(host.ctx)
		const compiler = new PluginArtifactCompiler(
			host.ctx,
			{ store: artifacts },
			{ cacheDir: fixture.getPath('.pluxel/artifacts'), packageMode: 'development' },
		)
		await compiler.publishWorkbenchProducer({
			plan: createPlan('revision-a'),
			root: fixture.getPath('plugin'),
		})
		producerBuildMocks.buildWorkbenchFederationProducer.mockRejectedValueOnce(
			new Error('candidate build failed'),
		)

		await expect(
			compiler.publishWorkbenchProducer({
				plan: createPlan('revision-b'),
				root: fixture.getPath('plugin'),
			}),
		).rejects.toThrow('candidate build failed')
		expect(artifacts.getCurrent(definition)?.buildRevision).toBe('revision-a')
		expect(artifacts.getPinned(createPlan('revision-b').producer, 'revision-b')).toBeUndefined()

		compiler.dispose()
		await host.dispose()
	})

	it('lets a newer semantic plan supersede an older in-flight candidate', async () => {
		await using fixture = await createDiskFixture({
			'plugin/package.json': JSON.stringify({ name: '@example/fonts', type: 'module' }),
		})
		const host = createHost()
		const artifacts = new WorkbenchArtifactService(host.ctx)
		const compiler = new PluginArtifactCompiler(
			host.ctx,
			{ store: artifacts },
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
		const first = compiler.publishWorkbenchProducer({
			plan: firstPlan,
			root: fixture.getPath('plugin'),
		})
		await vi.waitFor(() => {
			expect(producerBuildMocks.buildWorkbenchFederationProducer).toHaveBeenCalledOnce()
		})
		const second = compiler.publishWorkbenchProducer({
			plan: secondPlan,
			root: fixture.getPath('plugin'),
		})
		firstGate.resolve()

		await expect(first).resolves.toBeNull()
		await expect(second).resolves.toMatchObject({ buildRevision: 'revision-b' })
		expect(artifacts.getCurrent(definition)?.buildRevision).toBe('revision-b')
		expect(artifacts.getPinned(firstPlan.producer, 'revision-a')).toBeUndefined()

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
