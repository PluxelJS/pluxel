import { execFile } from 'node:child_process'
import { mkdir, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url))
const runner = fileURLToPath(new URL('./support/vite-runtime-runner.mts', import.meta.url))

describe('static Vite runtime', () => {
	it('consumes package-root lowering across built toolchain/runtime packages', async () => {
		await using fixture = await createDiskFixture(
			{ 'pnpm-workspace.yaml': 'packages: []\n' },
			{ tempDir: resolve(workspaceRoot, 'packages/runtime-static/tests') },
		)
		const entryPath = fixture.getPath('pluxel.static.ts')
		const pluginPath = fixture.getPath('packages/vite-static/src/index.ts')
		const pluginRoot = fixture.getPath('packages/vite-static')
		const pluginLink = fixture.getPath('node_modules/@fixture/vite-static')
		await mkdir(fixture.getPath('packages/vite-static/src'), { recursive: true })
		await fixture.writeFile(
			'packages/vite-static/package.json',
			JSON.stringify({
				name: '@fixture/vite-static',
				type: 'module',
				exports: {
					'.': {
						'@pluxel/hmr': './src/index.ts',
						default: './dist/index.mjs',
					},
				},
			}),
		)
		await fixture.writeFile('packages/vite-static/src/index.ts', pluginSource('v1', true))
		await mkdir(fixture.getPath('node_modules/@fixture'), { recursive: true })
		await symlink(pluginRoot, pluginLink, 'dir')
		await fixture.writeFile(
			'pluxel.static.ts',
			[
				"import { pluginNodeAddressOf } from '@pluxel/runtime'",
				"import { defineStaticRuntime } from '@pluxel/runtime-static'",
				"import { runtimePlugins } from '@fixture/vite-static'",
				'export default defineStaticRuntime({',
				"  name: 'static-vite-smoke',",
				'  plugins: runtimePlugins,',
				'  configure() {',
				'    const implementation = runtimePlugins[0]',
				'    const defaultNode = implementation ? pluginNodeAddressOf(implementation) : undefined',
				'    const definition = defaultNode?.definition',
				"    const east = definition ? { definition, variant: 'fork', forkId: 'east' } : undefined",
				"    const west = definition ? { definition, variant: 'fork', forkId: 'west' } : undefined",
				'    return {',
				'      workbench: false,',
				'      logging: false,',
				"      configService: { mode: 'memory' },",
				"      runtimeState: { mode: 'memory', snapshot: {",
				'        enabled: defaultNode && east && west ? [defaultNode, east, west] : [],',
				"        forks: definition ? [{ definition, forkIds: ['east', 'west'] }] : [],",
				'      } },',
				'    }',
				'  },',
				'  prepare({ host, startup }) {',
				'    const capture = startup.bindings.capture',
				"    if (typeof capture === 'function') capture(host, runtimePlugins[0])",
				'  },',
				'})',
				'',
			].join('\n'),
		)

		await expect(
			execFileAsync(process.execPath, ['--import', 'tsx', runner], {
				cwd: resolve(workspaceRoot, 'packages/runtime-static'),
				env: {
					...process.env,
					CI: '1',
					PLUXEL_VITE_SMOKE_ROOT: fixture.path,
					PLUXEL_VITE_SMOKE_ENTRY: entryPath,
					PLUXEL_VITE_SMOKE_PLUGIN: pluginPath,
					PLUXEL_VITE_SMOKE_CACHE: fixture.getPath('.vite-cache'),
				},
				timeout: 45_000,
			}),
		).resolves.toBeDefined()
	}, 60_000)
})

function pluginSource(version: string, available: boolean): string {
	return [
		"import { BasePlugin, Plugin } from '@pluxel/runtime'",
		"@Plugin({ displayName: 'Vite static', forkable: true })",
		'export class ViteStatic extends BasePlugin {',
		`  readonly version = ${JSON.stringify(version)}`,
		'}',
		`export const runtimePlugins = ${available ? '[ViteStatic]' : '[]'}`,
		'',
	].join('\n')
}
