import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'pathe'
import { createDiskFixture as createFixture } from '@pluxel/test/fixtures'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pluginBuildMocks = vi.hoisted(() => ({
	buildPluginUiRemote: vi.fn(
		async (input: { outDir: string; entryPath: string; root: string }) => {
			await mkdir(input.outDir, { recursive: true })
			await writeFile(join(input.outDir, 'mf-manifest.json'), JSON.stringify({}), 'utf-8')
		},
	),
	resolveExtensionFederationShared: vi.fn(() => ({ signature: 'shared-signature' })),
	resolvePluginUiBuildSignature: vi.fn(() => 'ui-build-signature'),
}))

vi.mock('@pluxel/rolldown/vite/plugin-ui', () => ({
	buildPluginUiRemote: pluginBuildMocks.buildPluginUiRemote,
	resolveExtensionFederationShared: pluginBuildMocks.resolveExtensionFederationShared,
	resolvePluginUiBuildSignature: pluginBuildMocks.resolvePluginUiBuildSignature,
}))

import { ExtensionCompilerService } from '../src/extensions/ExtensionCompilerService'

describe('ExtensionCompilerService', () => {
	beforeEach(() => {
		pluginBuildMocks.buildPluginUiRemote.mockClear()
		pluginBuildMocks.resolveExtensionFederationShared.mockClear()
		pluginBuildMocks.resolvePluginUiBuildSignature.mockClear()
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

		const committed: Array<{ pluginName: string; sourceHash: string }> = []
		const artifactRoots: string[] = []
		let currentModule: { pluginName: string; sourceHash: string } | undefined

		const service = new ExtensionCompilerService(
			{
				config: {},
				logger: { error: vi.fn() },
				name: 'test',
			} as any,
			{ enabled: true },
			{
				cacheDir: fixture.getPath('.pluxel/extensions'),
				cacheKeep: 1,
				vite: {
					plugins: [{ name: 'test:ui-transform' }],
					resolve: {
						alias: {
							'@generated/plugin-ui': fixture.getPath('generated/plugin-ui.ts'),
						},
					},
				},
			},
		)

		service.attachStore({
			getCompiledModule: () => currentModule as any,
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
		})

		const dispose = service.bindDeclaration(
			{
				pluginInfo: { id: 'PluginWithUI' },
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
				effects: {
					defer: (fn: () => void | Promise<void>) => ({ dispose: fn }),
				},
			} as any,
			{ entryPath: './PluginWithUI/ui/index.tsx' },
		)

		await service.requestCompile('PluginWithUI')

		expect(committed.length).toBeGreaterThanOrEqual(1)
		expect(artifactRoots).toHaveLength(1)
		expect(artifactRoots[0]).toContain('.pluxel/extensions/PluginWithUI')
		expect(pluginBuildMocks.buildPluginUiRemote).toHaveBeenCalledWith(
			expect.objectContaining({
				root: fixture.getPath('packages/plugins/host'),
				entryPath: fixture.getPath('packages/plugins/host/src/demo/PluginWithUI/ui/index.tsx'),
				pluginName: 'PluginWithUI',
				vite: {
					plugins: [{ name: 'test:ui-transform' }],
					resolve: {
						alias: {
							'@generated/plugin-ui': fixture.getPath('generated/plugin-ui.ts'),
						},
					},
				},
			}),
		)
		expect(pluginBuildMocks.resolvePluginUiBuildSignature).toHaveBeenCalledWith(
			expect.objectContaining({
				plugins: [{ name: 'test:ui-transform' }],
			}),
		)

		dispose()
		service.dispose()
	})

	it('resolves static Vite host UI entries from Vite root without a loader', async () => {
		await using fixture = await createFixture({
			'packages/plugins/static-commercial-demo/package.json': JSON.stringify({
				name: '@pluxel/plugins-static-commercial-demo',
				private: true,
				type: 'module',
			}),
			'packages/plugins/static-commercial-demo/web/client/main.tsx': 'export default {}\n',
		})

		const service = new ExtensionCompilerService(
			{
				config: {},
				logger: { error: vi.fn() },
				name: 'test',
			} as any,
			{
				enabled: true,
				viteServer: {
					config: {
						root: fixture.getPath('packages/plugins/static-commercial-demo'),
					},
				} as any,
			},
			{
				cacheDir: fixture.getPath('.pluxel/extensions'),
				cacheKeep: 1,
			},
		)

		service.attachStore({
			getCompiledModule: () => undefined,
			async commitCompiledModule() {},
			async markCompiling() {},
			async markCompileError(_pluginName, error) {
				throw error
			},
			async removePlugin() {},
		})

		const dispose = service.bindDeclaration(
			{
				pluginInfo: { id: 'StaticCommercialPlugin' },
				effects: {
					defer: (fn: () => void | Promise<void>) => ({ dispose: fn }),
				},
			} as any,
			{ entryPath: './web/client/main.tsx' },
		)

		await service.requestCompile('StaticCommercialPlugin')

		expect(pluginBuildMocks.buildPluginUiRemote).toHaveBeenCalledWith(
			expect.objectContaining({
				root: fixture.getPath('packages/plugins/static-commercial-demo'),
				entryPath: fixture.getPath(
					'packages/plugins/static-commercial-demo/web/client/main.tsx',
				),
				pluginName: 'StaticCommercialPlugin',
			}),
		)

		dispose()
		service.dispose()
	})
})
