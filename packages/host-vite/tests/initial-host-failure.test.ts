import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('exits the Vite CLI without a ready banner when the initial Host cannot initialize', async () => {
	const result = await promisify(execFile)(
		process.execPath,
		[fileURLToPath(new URL('./initial-host-failure.smoke.mjs', import.meta.url))],
		{ timeout: 35000 },
	)
	expect(result.stdout).toContain('INITIAL_HOST_FAILURE_OK service')
	expect(result.stdout).toContain('INITIAL_HOST_FAILURE_OK application')
}, 40000)
