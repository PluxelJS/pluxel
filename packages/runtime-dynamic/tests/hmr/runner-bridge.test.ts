import { mkdir, symlink } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { join, resolve } from 'pathe'
import { createServer, mergeConfig, normalizePath } from 'vite'
import { createDiskFixture as createFixture } from '@pluxel/test/fixtures'
import { workspaceRoot } from './_paths'
import {
	buildLoaderHmrViteConfig,
	LOADER_HMR_BRIDGE_MODULES,
	LOADER_HMR_OPTIONAL_BRIDGE_MODULES,
	LOADER_HMR_BRIDGE_PROVIDERS,
	resolveFsAllowList,
} from '../../src/hmr/engine/config'
import { LoaderHmrService } from '../../src/hmr/engine/LoaderHmrService'
import { HmrRunner } from '../../src/hmr/engine/runner'
import { withTestDynamicContext } from '../support/context'
import { inspectHmrRunner } from '../support/white-box'

describe('HMR runner bridge', () => {
	it('reuses host Core and installed standalone Context entries in the runner', async () => {
		expect(LOADER_HMR_BRIDGE_MODULES).toContain('@pluxel/core/internal')
		expect(LOADER_HMR_BRIDGE_MODULES).toContain('@pluxel/core/toolchain')
		expect(LOADER_HMR_BRIDGE_MODULES).toContain('@pluxel/runtime/toolchain')
		expect(LOADER_HMR_BRIDGE_MODULES).toContain('@pluxel/runtime/internal')
		expect(LOADER_HMR_OPTIONAL_BRIDGE_MODULES).toEqual([
			'@pluxel/context',
			'@pluxel/context/internal',
		])
		const cwd = workspaceRoot
		const contextPackageRoot = resolve(workspaceRoot, 'packages/context')
		const contextSource = normalizePath(resolve(contextPackageRoot, 'src/index.ts'))
		const contextInternalSource = normalizePath(resolve(contextPackageRoot, 'src/internal.ts'))
		await using fixture = await createFixture({
			'package.json': JSON.stringify({ name: '@fixture/context-hmr-host', private: true }),
			'PluginWithUI.ts': [
				"import { BasePlugin, Plugin } from '@pluxel/core'",
				"import * as context from '@pluxel/context'",
				"import * as contextInternal from '@pluxel/context/internal'",
				`import * as contextSource from ${JSON.stringify(`/@fs/${contextSource}`)}`,
				`import * as contextInternalSource from ${JSON.stringify(`/@fs/${contextInternalSource}`)}`,
				'',
				"@Plugin({ displayName: 'Plugin with UI' })",
				'export class PluginWithUI extends BasePlugin {}',
				'export { context, contextInternal, contextSource, contextInternalSource }',
				'',
			].join('\n'),
		})
		await mkdir(fixture.getPath('node_modules/@pluxel'), { recursive: true })
		await symlink(contextPackageRoot, fixture.getPath('node_modules/@pluxel/context'), 'dir')
		const fixturesDir = fixture.path
		const pluginFile = join(fixturesDir, 'PluginWithUI.ts')

		const fsAllow = resolveFsAllowList({
			cwd,
			cwdNormalized: normalizePath(cwd),
			scanRoots: [normalizePath(fixturesDir)],
		})

		const serverConfig = mergeConfig(
			buildLoaderHmrViteConfig({
				viteRoot: cwd,
				sourceRoot: fixturesDir,
				fsAllow,
				runnerPlugin: { name: 'noop' },
				httpPlugin: { name: 'noop' },
			}),
			{
				server: {
					port: 0,
					hmr: false,
					ws: false,
					middlewareMode: true,
					fs: { allow: fsAllow },
				},
			},
		)
		// Imports are triggered directly below. Assign after mergeConfig because null overrides are ignored.
		serverConfig.server = { ...serverConfig.server, watch: null }
		const server = await createServer(serverConfig)
		expect(server.config.server.watch).toBeNull()
		const fetchModule = vi.spyOn(server.environments.ssr, 'fetchModule')
		try {
			await withTestDynamicContext(async (ctx) => {
				const hmr = new LoaderHmrService(ctx, {
					roots: [fixturesDir],
					entries: [],
				})
				hmr.setServerRoot(cwd)

				const runner = new HmrRunner()
				runner.init(server, {
					hostCwd: fixturesDir,
					bridgeModules: LOADER_HMR_BRIDGE_MODULES,
					optionalBridgeModules: [...LOADER_HMR_OPTIONAL_BRIDGE_MODULES, '@pluxel/not-installed'],
					bridgeProviders: LOADER_HMR_BRIDGE_PROVIDERS,
				})
				await runner.bridgeHostModules(
					[...LOADER_HMR_BRIDGE_MODULES, '@pluxel/not-installed'],
					hmr.path,
					{
						warn: () => {},
					},
				)
				const runnerBox = inspectHmrRunner(runner)
				expect(runnerBox.bridgedRunnerUrls?.has('/packages/core/src/index.ts')).toBe(true)
				expect(runnerBox.bridgedRunnerUrls?.has('/packages/context/src/index.ts')).toBe(true)
				expect(runnerBox.bridgedHostExports?.has('@pluxel/not-installed')).toBe(false)
				expect(
					fetchModule.mock.calls.some(([specifier]) => specifier === '@pluxel/not-installed'),
				).toBe(false)
				await runner.assertBridgedSingletons(LOADER_HMR_BRIDGE_MODULES)

				const hostCore = runnerBox.bridgedHostExports?.get('@pluxel/core') as
					| { BasePlugin?: unknown }
					| undefined
				expect(hostCore).toBeTruthy()

				const mod = (await runner.import(pluginFile)) as Record<string, unknown>
				const ctor = mod.PluginWithUI as unknown
				expect(typeof ctor).toBe('function')

				const BasePlugin = hostCore?.BasePlugin as unknown
				expect(typeof BasePlugin).toBe('function')

				const pluginCtor = ctor as unknown as { prototype?: unknown }
				expect(Object.getPrototypeOf(pluginCtor)).toBe(BasePlugin)
				expect(mod.context).toBe(runnerBox.bridgedHostExports?.get('@pluxel/context'))
				expect(mod.contextSource).toBe(runnerBox.bridgedHostExports?.get('@pluxel/context'))
				expect(mod.contextInternal).toBe(
					runnerBox.bridgedHostExports?.get('@pluxel/context/internal'),
				)
				expect(mod.contextInternalSource).toBe(
					runnerBox.bridgedHostExports?.get('@pluxel/context/internal'),
				)
				const { consumePluginDefinitionCandidate } = await import('@pluxel/core/internal')
				expect(consumePluginDefinitionCandidate(pluginCtor as never).implementation).toBe(
					pluginCtor,
				)
			})
		} finally {
			await server.close()
		}
	}, 60_000)
})
