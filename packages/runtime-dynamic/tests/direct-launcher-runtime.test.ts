import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const runner = fileURLToPath(new URL('./support/direct-launcher-runner.mts', import.meta.url))

describe('dynamic direct launcher runtime', () => {
	it('returns only after the physical Vite listener is ready and closes it idempotently', async () => {
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
			{ tempDir: process.cwd() },
		)
		await fixture.writeFile(
			'pluxel.dynamic.ts',
			[
				`import { defineDynamicRuntimeConfig } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)}`,
				'export default defineDynamicRuntimeConfig({',
				`  root: ${JSON.stringify(fixture.path)},`,
				"  configPath: 'pluxel.loader.hmr.jsonc',",
				"  profile: 'test',",
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
				cwd: fixture.path,
				env: {
					...process.env,
					CI: '1',
					PLUXEL_DYNAMIC_DIRECT_ENTRY: fixture.getPath('pluxel.dynamic.ts'),
				},
				timeout: 60_000,
			}),
		).resolves.toBeDefined()
	}, 90_000)
})
