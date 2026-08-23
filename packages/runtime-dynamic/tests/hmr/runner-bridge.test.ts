import { describe, expect, it } from 'vitest'
import { join } from 'pathe'
import { createServer, mergeConfig, normalizePath } from 'vite'
import { createDiskFixture as createFixture } from '@pluxel/test/fixtures'
import { workspaceRoot } from './_paths'
import {
	buildLoaderHmrViteConfig,
	LOADER_HMR_BRIDGE_MODULES,
	LOADER_HMR_BRIDGE_PROVIDERS,
	resolveFsAllowList,
} from '../../src/hmr/engine/config'
import { LoaderHmrService } from '../../src/hmr/engine/LoaderHmrService'
import { HmrRunner } from '../../src/hmr/engine/runner'
import { withTestDynamicContext } from '../support/context'
import { inspectHmrRunner } from '../support/white-box'

describe('HMR runner bridge', () => {
	it('reuses host @pluxel/core singletons in the runner', async () => {
		expect(LOADER_HMR_BRIDGE_MODULES).toContain('@pluxel/core/internal')
		expect(LOADER_HMR_BRIDGE_MODULES).toContain('@pluxel/core/toolchain')
		expect(LOADER_HMR_BRIDGE_MODULES).toContain('@pluxel/runtime/toolchain')
		expect(LOADER_HMR_BRIDGE_MODULES).toContain('@pluxel/runtime/internal')
		const cwd = workspaceRoot
		await using fixture = await createFixture({
			'PluginWithUI.ts': [
				"import { BasePlugin, Plugin } from '@pluxel/core'",
				'',
				"@Plugin({ displayName: 'Plugin with UI' })",
				'export class PluginWithUI extends BasePlugin {}',
				'',
			].join('\n'),
		})
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
		try {
			await withTestDynamicContext(async (ctx) => {
				const hmr = new LoaderHmrService(ctx, {
					roots: [fixturesDir],
					entries: [],
				})
				hmr.setServerRoot(cwd)

				const runner = new HmrRunner()
				runner.init(server, {
					hostCwd: cwd,
					bridgeProviders: LOADER_HMR_BRIDGE_PROVIDERS,
				})
				await runner.bridgeHostModules(LOADER_HMR_BRIDGE_MODULES, hmr.path, {
					warn: () => {},
				})
				const runnerBox = inspectHmrRunner(runner)
				expect(runnerBox.bridgedRunnerUrls?.has('/packages/core/src/index.ts')).toBe(true)
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
