import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('controls real Vite update batches through the console socket across edits and Host replacement', async () => {
	// Both watcher scenarios generate native control materials across repeated updates.
	// Keep the smoke's per-step deadlines while budgeting for the complete sequence.
	const result = await promisify(execFile)(
		process.execPath,
		[fileURLToPath(new URL('./hmr-control.smoke.mjs', import.meta.url))],
		{ timeout: 120000 },
	)
	expect(result.stdout).toContain('HMR_CONTROL_SMOKE_OK')
	expect(result.stdout).toContain('HMR_UNAVAILABLE_RECOVERY_OK')
}, 130000)
