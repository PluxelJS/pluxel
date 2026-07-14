import { mkdir, writeFile } from 'node:fs/promises'
import type { WorkbenchArtifactStore } from '@pluxel/runtime/internal'
import { join } from 'pathe'
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

vi.mock('@pluxel/rolldown/vite/workbench-ui', () => ({
	buildWorkbenchUiRemote: pluginBuildMocks.buildWorkbenchUiRemote,
	resolveWorkbenchFederationShared: pluginBuildMocks.resolveWorkbenchFederationShared,
	resolveWorkbenchUiBuildSignature: pluginBuildMocks.resolveWorkbenchUiBuildSignature,
}))

import { WorkbenchCompilerService } from '../src/workbench/WorkbenchCompilerService'

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

describe('WorkbenchCompilerService', () => {
	beforeEach(() => {
		pluginBuildMocks.buildWorkbenchUiRemote.mockClear()
		pluginBuildMocks.resolveWorkbenchFederationShared.mockClear()
		pluginBuildMocks.resolveWorkbenchUiBuildSignature.mockClear()
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

		const committed: Parameters<WorkbenchArtifactStore['commitCompiledModule']>[0][] = []
		const artifactRoots: string[] = []
		let currentModule: ReturnType<WorkbenchArtifactStore['getCompiledModule']>
		const host = createHost()
		const store: WorkbenchArtifactStore = {
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

		const service = new WorkbenchCompilerService(
			host.ctx,
			{ store, enabled: true },
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
			{ entryPath: './PluginWithUI/ui/index.tsx' },
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
		const store: WorkbenchArtifactStore = {
			getCompiledModule: () => undefined,
			async commitCompiledModule() {},
			async markCompiling() {},
			async markCompileError(_pluginName, error) {
				throw error
			},
			async removePlugin() {},
		}

		const service = new WorkbenchCompilerService(
			host.ctx,
			{
				store,
				enabled: true,
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
		let currentModule: ReturnType<WorkbenchArtifactStore['getCompiledModule']>
		const store: WorkbenchArtifactStore = {
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
		const service = new WorkbenchCompilerService(
			host.ctx,
			{ store, enabled: true },
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
			{ entryPath: './ui/index.tsx' },
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
		const store: WorkbenchArtifactStore = {
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
		const service = new WorkbenchCompilerService(
			host.ctx,
			{ store, enabled: true },
			{
				cacheDir: fixture.getPath('.pluxel/workbench'),
				cacheKeep: 1,
				pluginDirs: { ReplacementPlugin: fixture.getPath('plugin') },
			},
		)
		const disposeOld = service.bindDeclaration(createPluginContext(host, 'ReplacementPlugin'), {
			entryPath: './src/old.tsx',
		})
		const disposeNew = service.bindDeclaration(createPluginContext(host, 'ReplacementPlugin'), {
			entryPath: './src/new.tsx',
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
