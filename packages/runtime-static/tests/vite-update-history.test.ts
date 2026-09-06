import { mkdir, symlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL('../', import.meta.url))

it('attributes a partial application restart to the failed fork in a real Vite host', async () => {
	await using fixture = await createDiskFixture(
		{
			'package.json': JSON.stringify({
				name: '@fixture/update-history',
				type: 'module',
				exports: './plugin.ts',
			}),
			'pnpm-workspace.yaml': 'packages: []\n',
			'plugin.ts': `import { BasePlugin, Plugin, v } from '@pluxel/runtime'
@Plugin({ forkable: true })
export class Service extends BasePlugin {
	private readonly config = this.configs.use(v.object({ fail: v.optional(v.boolean(), false) }))
	protected override init() { if (this.config.fail) throw new Error('east startup failed') }
}
@Plugin()
export class Healthy extends BasePlugin {}
`,
		},
		{ tempDir: resolve(packageRoot, 'tests') },
	)
	await mkdir(fixture.getPath('node_modules/@pluxel'), { recursive: true })
	await symlink(packageRoot, fixture.getPath('node_modules/@pluxel/runtime-static'), 'dir')
	await expect(
		execFileAsync(
			process.execPath,
			[
				'--import',
				'tsx',
				resolve(packageRoot, 'tests/support/vite-update-history-runner.mts'),
				fixture.path,
			],
			{ cwd: packageRoot, timeout: 60_000 },
		),
	).resolves.toBeDefined()
}, 90_000)
