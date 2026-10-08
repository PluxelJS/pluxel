import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const result = spawnSync('pnpm', ['exec', 'turbo', ...process.argv.slice(2)], {
	cwd: root,
	stdio: 'inherit',
	env: {
		...process.env,
		PNPM_CONFIG_PM_ON_FAIL: 'ignore',
		PNPM_CONFIG_WORKSPACE_DIR: root,
	},
})
if (result.error) console.error(result.error.message)
process.exit(result.status ?? 1)
