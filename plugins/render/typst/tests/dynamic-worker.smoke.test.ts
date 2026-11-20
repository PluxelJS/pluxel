import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const verify = fileURLToPath(new URL('./fixtures/dynamic-worker/verify.mts', import.meta.url))
const cwd = new URL('../', import.meta.url)

it('compiles session PDF and stateless SVG through Vite-extracted native artifacts', async () => {
	await expect(
		promisify(execFile)(process.execPath, ['--import', 'tsx', verify], {
			cwd,
			env: { ...process.env, CI: '1' },
			timeout: 120_000,
		}),
	).resolves.toMatchObject({ stdout: expect.stringContaining('Verified Typst PDF and SVG') })
}, 150_000)
