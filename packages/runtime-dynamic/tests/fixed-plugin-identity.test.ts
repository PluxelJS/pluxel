import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { describe, expect, it } from 'vitest'
import { workspaceRoot } from './hmr/_paths.ts'

const execFileAsync = promisify(execFile)

describe('dynamic fixed plugin module identity', () => {
	it('evaluates config fixed providers and mutable consumers in one real Vite namespace', async () => {
		await using fixture = await createDiskFixture(
			{
				'pnpm-workspace.yaml': 'packages: []\n',
				'pluxel.loader.hmr.jsonc': JSON.stringify({
					version: 2,
					profile: 'test',
					defaults: { roots: [] },
					profiles: { test: { enabled: [] } },
				}),
				'fixed-provider.ts': [
					"import { BasePlugin, Plugin } from '@pluxel/runtime'",
					"@Plugin({ displayName: 'Fixed provider' })",
					'export class FixedProvider extends BasePlugin { readonly value = 42 }',
					'',
				].join('\n'),
				'entries/mutable-consumer.ts': [
					"import { BasePlugin, Plugin } from '@pluxel/runtime'",
					"import { FixedProvider } from '../fixed-provider'",
					"@Plugin({ displayName: 'Mutable consumer' })",
					'export class MutableConsumer extends BasePlugin {',
					'  constructor(readonly provider: FixedProvider) { super() }',
					'}',
					'',
				].join('\n'),
			},
			{ tempDir: resolve(workspaceRoot, 'packages/runtime-dynamic/tests') },
		)
		const root = fixture.path
		const configPath = resolve(root, 'pluxel.dynamic.ts')
		await fixture.writeFile(
			'pluxel.dynamic.ts',
			[
				"import { defineDynamicRuntimeConfig } from '@pluxel/runtime-dynamic'",
				"import { FixedProvider } from './fixed-provider'",
				'export default defineDynamicRuntimeConfig({',
				`  root: ${JSON.stringify(root)},`,
				"  configPath: 'pluxel.loader.hmr.jsonc',",
				"  profile: 'test',",
				'  plugins: [FixedProvider],',
				"  sources: [{ kind: 'directory', path: 'entries', include: ['*.ts'] }],",
				"  runtimeState: { mode: 'memory' },",
				"  configService: { mode: 'memory' },",
				'  logging: false,',
				'  printUrls: false,',
				'})',
				'',
			].join('\n'),
		)

		const runner = resolve(root, 'verify.mts')
		const viteEntry = pathToFileURL(
			resolve(workspaceRoot, 'packages/runtime-dynamic/src/vite.ts'),
		).href
		const contextPlanEntry = pathToFileURL(
			resolve(workspaceRoot, 'packages/runtime-dynamic/src/context-plan.ts'),
		).href
		await fixture.writeFile(
			'verify.mts',
			[
				"import assert from 'node:assert/strict'",
				"import { resolve } from 'node:path'",
				"import { requirePluginService } from '@pluxel/core/internal'",
				"import { requireRuntimePluginGraphCoordinator } from '@pluxel/runtime/internal'",
				"import { createServer } from 'vite'",
				`import { requireLoaderService } from ${JSON.stringify(contextPlanEntry)}`,
				`import { dynamicRuntimeVitePlugin } from ${JSON.stringify(viteEntry)}`,
				`const root = ${JSON.stringify(root)}`,
				`const workspaceRoot = ${JSON.stringify(workspaceRoot)}`,
				'const server = await createServer({',
				'  configFile: false,',
				"  root: resolve(workspaceRoot, 'packages/runtime-dynamic'),",
				"  cacheDir: resolve(root, '.vite-cache'),",
				'  optimizeDeps: { noDiscovery: true, include: [] },',
				`  plugins: dynamicRuntimeVitePlugin({ config: ${JSON.stringify(configPath)} }),`,
				'  server: { middlewareMode: true, watch: { usePolling: true, interval: 20 } },',
				'})',
				'try {',
				"  const controller = server[Symbol.for('pluxel.dynamicRuntimeController')]",
				'  assert.ok(controller)',
				'  const loader = requireLoaderService(controller.booted.ctx)',
				'  const fixedPlugins = controller.booted.hmr.config?.fixedPlugins',
				'  assert.equal(fixedPlugins?.length, 1, `unexpected fixed plugin count ${fixedPlugins?.length}`)',
				'  const catalog = loader.api.registry.listRegistered()',
				'  const commonCatalog = requireRuntimePluginGraphCoordinator(controller.booted.ctx).catalogSnapshot().entries',
				"  assert.ok(commonCatalog.length > 0, 'common coordinator catalog is empty')",
				"  const fixedEntry = catalog.find(entry => entry.rootExportName === 'FixedProvider')",
				"  const consumerEntry = catalog.find(entry => entry.rootExportName === 'MutableConsumer')",
				"  assert.ok(fixedEntry, `missing FixedProvider in ${catalog.map(entry => entry.rootExportName).join(', ')}`)",
				"  assert.ok(consumerEntry, `missing MutableConsumer in ${catalog.map(entry => entry.rootExportName).join(', ')}`)",
				'  const fixed = fixedEntry.ctor',
				'  const consumer = consumerEntry.ctor',
				"  assert.equal(typeof fixed, 'function')",
				"  assert.equal(typeof consumer, 'function')",
				'  await loader.api.control.start(fixedEntry.address)',
				'  await loader.api.control.start(consumerEntry.address)',
				'  const instance = requirePluginService(controller.booted.ctx).getInstance(consumerEntry.address)',
				'  assert.ok(instance)',
				'  assert.ok(instance.provider instanceof fixed)',
				'} finally {',
				'  await server.close()',
				'}',
				'',
			].join('\n'),
		)

		await expect(
			execFileAsync(process.execPath, ['--import', 'tsx', runner], {
				cwd: resolve(workspaceRoot, 'packages/runtime-dynamic'),
				env: { ...process.env, CI: '1', CHOKIDAR_USEPOLLING: '1' },
				timeout: 90_000,
			}),
		).resolves.toBeDefined()
	}, 120_000)
})
