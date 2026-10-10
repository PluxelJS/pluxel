import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

it('compiles through the Vite-extracted native Worker artifact and returns PDF over HTTP', async () => {
	await expect(
		execFileAsync(
			process.execPath,
			[
				'--import',
				'tsx',
				fileURLToPath(new URL('./support/typst-dynamic-runner.mts', import.meta.url)),
			],
			{
				cwd: fileURLToPath(new URL('../', import.meta.url)),
				env: {
					...process.env,
					CI: '1',
					PLUXEL_TYPST_DYNAMIC_ENTRY: fileURLToPath(
						new URL('./support/typst.dynamic.ts', import.meta.url),
					),
				},
				timeout: 120_000,
			},
		),
	).resolves.toBeDefined()
}, 150_000)
