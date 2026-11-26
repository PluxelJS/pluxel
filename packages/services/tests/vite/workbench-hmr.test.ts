import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL('../../', import.meta.url))

it.each([
	{
		name: 'recovers Workbench definitions and dependents through the physical Vite watcher',
		runner: './workbench-hmr-runner.mts',
		// Enable the native federation build in this test subprocess.
		env: { MFE_VITE_NO_TEST_ENV_CHECK: 'true' },
	},
	{
		name: 'recovers failed new files, unresolved imports and package installs through real watchers',
		runner: './recovery-runner.mts',
		env: {},
	},
])(
	'$name',
	async ({ runner, env }) => {
		await using fixture = await createDiskFixture(
			{ 'pnpm-workspace.yaml': 'packages: []\n' },
			{ tempDir: resolve(packageRoot, 'tests') },
		)
		await expect(
			execFileAsync(
				process.execPath,
				['--import', 'tsx', fileURLToPath(new URL(runner, import.meta.url))],
				{
					cwd: packageRoot,
					env: { ...process.env, ...env, CI: '1', PLUXEL_WORKBENCH_HMR_ROOT: fixture.path },
					timeout: 150_000,
					maxBuffer: 4 * 1024 * 1024,
				},
			),
		).resolves.toBeDefined()
	},
	180_000,
)
