import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url))
const runner = fileURLToPath(new URL('./support/vite-runtime-runner.mts', import.meta.url))

describe('dynamic Vite runtime', () => {
	it('keeps mutable-source HMR atomic and watches managed entries in the outer Vite route', async () => {
		const managedPackageName = '@fixture/vite-managed-external'
		const managedExportName = 'ManagedExternalPlugin'
		const managedRuntimeBridgeName = 'pluxel.test.runtime-dynamic.vite-managed-external'
		const managedWrapper = [
			`export * from ${JSON.stringify(managedPackageName)}`,
			`import * as pluginModule from ${JSON.stringify(managedPackageName)}`,
			'export default pluginModule.default',
			'',
		].join('\n')
		await using fixture = await createDiskFixture(
			{
				'pnpm-workspace.yaml': 'packages: []\n',
				'pluxel.loader.hmr.jsonc': JSON.stringify({
					version: 2,
					profile: 'test',
					defaults: { roots: [] },
					profiles: { test: { enabled: [] } },
				}),
				'.pluxel/managed-plugins/entries/managed.mjs': managedWrapper,
				'.pluxel/managed-plugins/node_modules/@fixture/vite-managed-external/package.json':
					JSON.stringify({
						name: managedPackageName,
						type: 'module',
						exports: './dist/index.mjs',
					}),
				'.pluxel/managed-plugins/node_modules/@fixture/vite-managed-external/dist/index.mjs': [
					`const fixtureRuntime = globalThis[Symbol.for(${JSON.stringify(managedRuntimeBridgeName)})]`,
					"if (!fixtureRuntime) throw new Error('managed external fixture runtime is unavailable')",
					'const { BasePlugin, Plugin, setPluginDefinition } = fixtureRuntime',
					`class ${managedExportName} extends BasePlugin {}`,
					`Plugin({ displayName: 'Managed external' })(${managedExportName})`,
					`setPluginDefinition(${managedExportName}, {`,
					'  abiVersion: 2,',
					"  kind: 'plugin',",
					`  definition: { entry: { kind: 'package-root', packageName: ${JSON.stringify(managedPackageName)} }, exportName: ${JSON.stringify(managedExportName)} },`,
					'  constructorRequires: [],',
					'  optional: [],',
					'})',
					`export { ${managedExportName} }`,
					'',
				].join('\n'),
			},
			{ tempDir: resolve(workspaceRoot, 'packages/runtime-dynamic/tests') },
		)
		await mkdir(fixture.getPath('entries'), { recursive: true })
		await fixture.writeFile(
			'pluxel.dynamic.ts',
			[
				`import { defineDynamicRuntimeConfig } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)}`,
				'export default defineDynamicRuntimeConfig({',
				`  root: ${JSON.stringify(fixture.path)},`,
				"  configPath: 'pluxel.loader.hmr.jsonc',",
				"  profile: 'test',",
				'  sources: [',
				"    { kind: 'file', path: 'entries/dynamic-http.ts' },",
				"    { kind: 'directory', path: '.pluxel/managed-plugins/entries', include: ['*.mjs'] },",
				'  ],',
				"  configService: { mode: 'memory' },",
				"  runtimeState: { mode: 'memory' },",
				'  workbench: false,',
				'  logging: false,',
				'  printUrls: false,',
				'})',
				'',
			].join('\n'),
		)

		await expect(
			execFileAsync(process.execPath, ['--import', 'tsx', runner], {
				cwd: resolve(workspaceRoot, 'packages/runtime-dynamic'),
				env: {
					...process.env,
					CHOKIDAR_USEPOLLING: '1',
					CI: '1',
					PLUXEL_DYNAMIC_VITE_ROOT: fixture.path,
					PLUXEL_DYNAMIC_VITE_CONFIG: fixture.getPath('pluxel.dynamic.ts'),
					PLUXEL_DYNAMIC_VITE_PLUGIN: fixture.getPath('entries/dynamic-http.ts'),
					PLUXEL_DYNAMIC_VITE_CACHE: fixture.getPath('.vite-cache'),
				},
				timeout: 90_000,
			}),
		).resolves.toBeDefined()
	}, 120_000)
})
