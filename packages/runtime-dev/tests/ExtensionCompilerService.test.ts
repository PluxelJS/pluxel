import { mkdir, writeFile } from 'node:fs/promises'
import type { ExtensionModuleStore } from '@pluxel/runtime/internal'
import { join } from 'pathe'
import { createHost, type Context, type Host } from '@pluxel/test'
import { createDiskFixture as createFixture } from '@pluxel/test/fixtures'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pluginBuildMocks = vi.hoisted(() => ({
	buildPluginUiRemote: vi.fn(async (input: { outDir: string; entryPath: string; root: string }) => {
		await mkdir(input.outDir, { recursive: true })
		await writeFile(join(input.outDir, 'mf-manifest.json'), JSON.stringify({}), 'utf-8')
	}),
	resolveExtensionFederationShared: vi.fn(() => ({ signature: 'shared-signature' })),
	resolvePluginUiBuildSignature: vi.fn(() => 'ui-build-signature'),
}))

vi.mock('@pluxel/rolldown/vite/plugin-ui', () => ({
	buildPluginUiRemote: pluginBuildMocks.buildPluginUiRemote,
	resolveExtensionFederationShared: pluginBuildMocks.resolveExtensionFederationShared,
	resolvePluginUiBuildSignature: pluginBuildMocks.resolvePluginUiBuildSignature,
}))

import { ExtensionCompilerService } from '../src/extensions/ExtensionCompilerService'

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

		const committed: Parameters<ExtensionModuleStore['commitCompiledModule']>[0][] = []
		const artifactRoots: string[] = []
		let currentModule: ReturnType<ExtensionModuleStore['getCompiledModule']>
		const host = createHost()
		const store: ExtensionModuleStore = {
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

		const service = new ExtensionCompilerService(
			host.ctx,
			{ store, enabled: true },
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
		const store: ExtensionModuleStore = {
			getCompiledModule: () => undefined,
			async commitCompiledModule() {},
			async markCompiling() {},
			async markCompileError(_pluginName, error) {
				throw error
			},
			async removePlugin() {},
		}

		const service = new ExtensionCompilerService(
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
				cacheDir: fixture.getPath('.pluxel/extensions'),
				cacheKeep: 1,
			},
		)

		const dispose = service.bindDeclaration(createPluginContext(host, 'StaticCommercialPlugin'), {
			entryPath: './web/client/main.tsx',
		})

		await service.requestCompile('StaticCommercialPlugin')

		expect(pluginBuildMocks.buildPluginUiRemote).toHaveBeenCalledWith(
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
})
