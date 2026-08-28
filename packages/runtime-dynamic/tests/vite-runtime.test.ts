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
	it('keeps business HTTP and WebSocket publication atomic across mutable-source HMR', async () => {
		await using fixture = await createDiskFixture(
			{
				'pnpm-workspace.yaml': 'packages: []\n',
				'pluxel.loader.hmr.jsonc': JSON.stringify({
					version: 2,
					profile: 'test',
					defaults: { roots: [] },
					profiles: { test: { enabled: [] } },
				}),
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
				"  sources: [{ kind: 'file', path: 'entries/dynamic-http.ts' }],",
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
				timeout: 45_000,
			}),
		).resolves.toBeDefined()
	}, 60_000)
})
