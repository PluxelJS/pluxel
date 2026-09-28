import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const runner = fileURLToPath(new URL('./support/vite-recovery-runner.mts', import.meta.url))

it('recovers failed new files, unresolved imports and package installs through real watchers', async () => {
	await using fixture = await createDiskFixture(
		{ 'pnpm-workspace.yaml': 'packages: []\n' },
		{ tempDir: resolve(packageRoot, 'tests') },
	)
	await expect(
		execFileAsync(process.execPath, ['--import', 'tsx', runner], {
			cwd: packageRoot,
			env: { ...process.env, CI: '1', PLUXEL_WORKBENCH_HMR_ROOT: fixture.path },
			timeout: 150_000,
			maxBuffer: 4 * 1024 * 1024,
		}),
	).resolves.toBeDefined()
}, 180_000)
