import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('recovers an initial dynamic entry when its missing import appears', async () => {
	const result = await promisify(execFile)(
		process.execPath,
		[fileURLToPath(new URL('./initial-source-recovery.smoke.mjs', import.meta.url))],
		{ timeout: 30000 },
	)
	expect(result.stdout).toContain('INITIAL_SOURCE_RECOVERY_SMOKE_OK')
}, 35000)
