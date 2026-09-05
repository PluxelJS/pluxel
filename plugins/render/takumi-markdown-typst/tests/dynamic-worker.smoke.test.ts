import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const runner = fileURLToPath(new URL('./support/typst-dynamic-runner.mts', import.meta.url))
const entry = fileURLToPath(new URL('./support/typst.dynamic.ts', import.meta.url))

describe('@pluxel/takumi-markdown-typst dynamic worker artifact', () => {
	it('runs generated formula SVG assets through the dynamic runtime and final Takumi renderer', async () => {
		const packageRoot = fileURLToPath(new URL('../', import.meta.url))
		await expect(
			execFileAsync(process.execPath, ['--import', 'tsx', runner], {
				cwd: packageRoot,
				env: {
					...process.env,
					CI: '1',
					PLUXEL_TAKUMI_MARKDOWN_TYPST_DYNAMIC_ENTRY: entry,
				},
				timeout: 120_000,
			}),
		).resolves.toBeDefined()
	}, 150_000)
})
