import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const runner = fileURLToPath(new URL('./support/vite-console-runner.mts', import.meta.url))

it('executes consecutive typed console operations in the current dynamic Vite world', async () => {
	await using fixture = await createDiskFixture(
		{ 'pnpm-workspace.yaml': 'packages: []\n' },
		{ tempDir: resolve(packageRoot, 'tests') },
	)
	await expect(
		execFileAsync(process.execPath, ['--import', 'tsx', runner], {
			cwd: packageRoot,
			env: { ...process.env, CI: '1', PLUXEL_CONSOLE_FIXTURE_ROOT: fixture.path },
			timeout: 120_000,
			maxBuffer: 4 * 1024 * 1024,
		}),
	).resolves.toBeDefined()
}, 150_000)
