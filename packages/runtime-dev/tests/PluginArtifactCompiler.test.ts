import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { defineNodeModule } from '@pluxel/runtime'
import { dirname, join } from 'pathe'
import { createHost, type Context, type Host } from '@pluxel/test'
import { createDiskFixture as createFixture } from '@pluxel/test/fixtures'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pluginBuildMocks = vi.hoisted(() => ({
	buildWorkbenchUiRemote: vi.fn(
		async (input: { outDir: string; entryPath: string; root: string }) => {
			await mkdir(input.outDir, { recursive: true })
			await writeFile(
				join(input.outDir, 'remoteEntry.js'),
				'export const init = () => {}\n',
				'utf-8',
			)
			await writeFile(join(input.outDir, 'ui.js'), 'export default {}\n', 'utf-8')
			await writeFile(
				join(input.outDir, 'mf-manifest.json'),
				JSON.stringify({
					metaData: { remoteEntry: { name: 'remoteEntry.js' } },
					exposes: [{ name: 'ui-module', assets: { js: { sync: ['ui.js'], async: [] } } }],
				}),
				'utf-8',
			)
		},
	),
	resolveWorkbenchFederationShared: vi.fn(() => ({ signature: 'shared-signature' })),
	resolveWorkbenchUiBuildSignature: vi.fn(() => 'ui-build-signature'),
}))

const nodeBuildMocks = vi.hoisted(() => ({
	buildNodeModule: vi.fn(),
	validateNodeModuleArtifact: vi.fn(),
}))

vi.mock('@pluxel/rolldown/vite/workbench-ui', () => ({
	buildWorkbenchUiRemote: pluginBuildMocks.buildWorkbenchUiRemote,
	resolveWorkbenchFederationShared: pluginBuildMocks.resolveWorkbenchFederationShared,
	resolveWorkbenchUiBuildSignature: pluginBuildMocks.resolveWorkbenchUiBuildSignature,
}))

vi.mock('@pluxel/rolldown/vite/node-module', () => nodeBuildMocks)

import {
	PluginArtifactCompiler,
	type PluginArtifactCompilerWorkbenchStore,
} from '../src/workbench/PluginArtifactCompiler'

function createPluginContext(
	host: Host,
	pluginName: string,
	overrides: Record<string, unknown> = {},
): Context {
	const ctx = host.ctx.extend({ name: pluginName }) as Context
	defineTestProperty(ctx, 'pluginInfo', { id: pluginName })
	for (const [key, value] of Object.entries(overrides)) defineTestProperty(ctx, key, value)
	return ctx
}

function defineTestProperty(target: object, key: string, value: unknown) {
	Object.defineProperty(target, key, {
		value,
		writable: true,
		configurable: true,
		enumerable: true,
	})
}

describe('PluginArtifactCompiler', () => {
	beforeEach(() => {
		pluginBuildMocks.buildWorkbenchUiRemote.mockClear()
		pluginBuildMocks.resolveWorkbenchFederationShared.mockClear()
		pluginBuildMocks.resolveWorkbenchUiBuildSignature.mockClear()
		nodeBuildMocks.buildNodeModule
			.mockReset()
			.mockImplementation(async (input: { outFile: string }) => {
				await mkdir(dirname(input.outFile), { recursive: true })
				await writeFile(input.outFile, 'export const ready = true\n')
			})
		nodeBuildMocks.validateNodeModuleArtifact.mockReset().mockResolvedValue(undefined)
	})

	it('shares Node builds, reports failed rebuilds, and keeps the last good artifact', async () => {
		await using fixture = await createFixture({
			'plugin.ts': 'export const plugin = true\n',
			'task.ts': 'export const version = 1\n',
		})
		const host = createHost()
		const service = new PluginArtifactCompiler(
			host.ctx,
			{},
			{ cacheDir: fixture.getPath('.pluxel/artifacts') },
		)
		const declaration = defineNodeModule(pathToFileURL(fixture.getPath('plugin.ts')), './task.ts')
		const updates: URL[][] = [[], []]
		const errors: unknown[][] = [[], []]
		const consumers = await Promise.all(
			[0, 1].map((index) =>
				service.watchNodeModule(
					declaration,
					(url) => void updates[index]!.push(url),
					(error) => errors[index]!.push(error),
				),
			),
		)
		expect(nodeBuildMocks.buildNodeModule).toHaveBeenCalledTimes(1)
		expect(consumers[0]!.url).toEqual(consumers[1]!.url)

		const internals = service as unknown as {
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
		expect(updates[0]![0]).toEqual(updates[1]![0])
		expect(nodeBuildMocks.buildNodeModule).toHaveBeenCalledTimes(3)

		await Promise.all(consumers.map((consumer) => consumer.dispose()))
		service.dispose()
		await host.dispose()
	})

	it('resolves relative UI entries from the declaring plugin source file', async () => {
		await using fixture = await createFixture({
			'packages/plugins/host/package.json': JSON.stringify({
				name: '@pluxel/plugins-host',
				private: true,
				type: 'module',
			}),
			'packages/plugins/host/src/demo/PluginWithUI.ts': 'export const marker = true\n',
			'packages/plugins/host/src/demo/PluginWithUI/ui/index.tsx': 'export default {}\n',
		})

		const committed: Parameters<PluginArtifactCompilerWorkbenchStore['commitCompiledModule']>[0][] =
			[]
		const artifactRoots: string[] = []
		let currentModule: ReturnType<PluginArtifactCompilerWorkbenchStore['getCompiledModule']>
		const host = createHost()
		const store: PluginArtifactCompilerWorkbenchStore = {
			getCompiledModule: () => currentModule,
			async commitCompiledModule(module, options) {
				currentModule = module
				committed.push(module)
				if (options?.artifactRoot) artifactRoots.push(options.artifactRoot)
			},
			async markCompiling() {},
			async markCompileError(_pluginName, error) {
				throw error
			},
			async removePlugin() {},
		}

		const service = new PluginArtifactCompiler(
			host.ctx,
			{ store },
			{
				cacheDir: fixture.getPath('.pluxel/workbench'),
				cacheKeep: 1,
				vite: {
					plugins: [{ name: 'test:ui-transform' }],
					resolve: {
						alias: {
							'@generated/workbench-ui': fixture.getPath('generated/workbench-ui.ts'),
						},
					},
				},
			},
		)

		const dispose = service.bindDeclaration(
			createPluginContext(host, 'PluginWithUI', {
				loader: {
					api: {
						registry: {
							findModuleIdByName: () =>
								fixture.getPath('packages/plugins/host/src/demo/PluginWithUI.ts'),
						},
						anchors: {
							list: () => [],
						},
					},
				},
			}),
			{ entryPath: './PluginWithUI/ui/index.tsx', declarationKey: 'PluginWithUI' },
		)

		await Promise.all([
			service.requestCompile('PluginWithUI'),
			service.requestCompile('PluginWithUI'),
		])

		expect(committed.length).toBeGreaterThanOrEqual(1)
		expect(artifactRoots).toHaveLength(1)
		expect(artifactRoots[0]).toContain('.pluxel/workbench/PluginWithUI')
		expect(pluginBuildMocks.buildWorkbenchUiRemote).toHaveBeenCalledWith(
			expect.objectContaining({
				root: fixture.getPath('packages/plugins/host'),
				entryPath: fixture.getPath('packages/plugins/host/src/demo/PluginWithUI/ui/index.tsx'),
				pluginName: 'PluginWithUI',
				vite: {
					plugins: [{ name: 'test:ui-transform' }],
					resolve: {
						alias: {
							'@generated/workbench-ui': fixture.getPath('generated/workbench-ui.ts'),
						},
					},
				},
			}),
		)
		expect(pluginBuildMocks.resolveWorkbenchUiBuildSignature).toHaveBeenCalledWith(
			expect.objectContaining({
				plugins: [{ name: 'test:ui-transform' }],
			}),
			undefined,
		)
		expect(pluginBuildMocks.buildWorkbenchUiRemote).toHaveBeenCalledTimes(1)

		dispose()
		service.dispose()
		await host.dispose()
	})

	it('resolves static Vite host UI entries from Vite root without a loader', async () => {
		await using fixture = await createFixture({
			'apps/static-host/package.json': JSON.stringify({
				name: '@example/static-host',
				private: true,
				type: 'module',
			}),
			'apps/static-host/web/client/main.tsx': 'export default {}\n',
		})
		const host = createHost()
		const store: PluginArtifactCompilerWorkbenchStore = {
			getCompiledModule: () => undefined,
			async commitCompiledModule() {},
			async markCompiling() {},
			async markCompileError(_pluginName, error) {
				throw error
			},
			async removePlugin() {},
		}

		const service = new PluginArtifactCompiler(
			host.ctx,
			{
				store,
				viteServer: {
					config: {
						root: fixture.getPath('apps/static-host'),
					},
				},
			},
			{
				cacheDir: fixture.getPath('.pluxel/workbench'),
				cacheKeep: 1,
			},
		)

		const dispose = service.bindDeclaration(createPluginContext(host, 'StaticCommercialPlugin'), {
			entryPath: './web/client/main.tsx',
			declarationKey: 'StaticCommercialPlugin',
		})

		await service.requestCompile('StaticCommercialPlugin')

		expect(pluginBuildMocks.buildWorkbenchUiRemote).toHaveBeenCalledWith(
			expect.objectContaining({
				root: fixture.getPath('apps/static-host'),
				entryPath: fixture.getPath('apps/static-host/web/client/main.tsx'),
				pluginName: 'StaticCommercialPlugin',
			}),
		)

		dispose()
		service.dispose()
		await host.dispose()
	})

	it('hashes sources in package names containing build and always retains the active artifact', async () => {
		await using fixture = await createFixture({
			'packages/plugin-builder/package.json': JSON.stringify({
				name: '@example/plugin-builder',
				private: true,
				type: 'module',
			}),
			'packages/plugin-builder/src/plugin.ts': 'export const plugin = true\n',
			'packages/plugin-builder/src/ui/index.tsx': 'export default { version: 1 }\n',
		})
		const host = createHost()
		let currentModule: ReturnType<PluginArtifactCompilerWorkbenchStore['getCompiledModule']>
		const store: PluginArtifactCompilerWorkbenchStore = {
			getCompiledModule: () => currentModule,
			async commitCompiledModule(module) {
				currentModule = module
			},
			async markCompiling() {},
			async markCompileError(_pluginName, error) {
				throw error
			},
			async removePlugin() {},
		}
		const service = new PluginArtifactCompiler(
			host.ctx,
			{ store },
			{
				cacheDir: fixture.getPath('.pluxel/workbench'),
				cacheKeep: 0,
			},
		)
		const dispose = service.bindDeclaration(
			createPluginContext(host, 'BuilderPlugin', {
				loader: {
					api: {
						registry: {
							findModuleIdByName: () => fixture.getPath('packages/plugin-builder/src/plugin.ts'),
						},
						anchors: { list: () => [] },
					},
				},
			}),
			{ entryPath: './ui/index.tsx', declarationKey: 'BuilderPlugin' },
		)

		await service.requestCompile('BuilderPlugin')
		const firstHash = currentModule?.sourceHash
		await writeFile(
			fixture.getPath('packages/plugin-builder/src/ui/index.tsx'),
			'export default { version: 2 }\n',
		)
		await service.requestCompile('BuilderPlugin')

		expect(pluginBuildMocks.buildWorkbenchUiRemote).toHaveBeenCalledTimes(2)
		expect(currentModule?.sourceHash).not.toBe(firstHash)

		dispose()
		service.dispose()
		await host.dispose()
	})

	it('does not let an old replacement cleanup remove the active declaration', async () => {
		await using fixture = await createFixture({
			'plugin/package.json': JSON.stringify({ name: 'replacement-plugin', type: 'module' }),
			'plugin/src/old.tsx': 'export default {}\n',
			'plugin/src/new.tsx': 'export default {}\n',
		})
		const host = createHost()
		const removed: string[] = []
		const store: PluginArtifactCompilerWorkbenchStore = {
			getCompiledModule: () => undefined,
			async commitCompiledModule() {},
			async markCompiling() {},
			async markCompileError(_pluginName, error) {
				throw error
			},
			async removePlugin(pluginName) {
				removed.push(pluginName)
			},
		}
		const service = new PluginArtifactCompiler(
			host.ctx,
			{ store },
			{
				cacheDir: fixture.getPath('.pluxel/workbench'),
				cacheKeep: 1,
				pluginDirs: { ReplacementPlugin: fixture.getPath('plugin') },
			},
		)
		const disposeOld = service.bindDeclaration(createPluginContext(host, 'ReplacementPlugin'), {
			entryPath: './src/old.tsx',
			declarationKey: 'ReplacementPlugin-old',
		})
		const disposeNew = service.bindDeclaration(createPluginContext(host, 'ReplacementPlugin'), {
			entryPath: './src/new.tsx',
			declarationKey: 'ReplacementPlugin',
		})

		disposeOld()
		await service.requestCompile('ReplacementPlugin')

		expect(removed).toEqual([])
		expect(pluginBuildMocks.buildWorkbenchUiRemote).toHaveBeenCalledWith(
			expect.objectContaining({ entryPath: fixture.getPath('plugin/src/new.tsx') }),
		)

		disposeNew()
		expect(removed).toEqual(['ReplacementPlugin'])
		service.dispose()
		await host.dispose()
	})
})
