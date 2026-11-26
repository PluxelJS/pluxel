import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const verify = fileURLToPath(new URL('./fixtures/dynamic-worker/verify.mts', import.meta.url))
const cwd = new URL('../', import.meta.url)

describe('@pluxel/plugin-echarts dynamic worker artifact', () => {
	it('runs the built worker through the production dynamic launcher and HTTP boundary', async () => {
		await expect(
			promisify(execFile)(process.execPath, ['--import', 'tsx', verify], {
				cwd,
				env: { ...process.env, CI: '1' },
				timeout: 120_000,
			}),
		).resolves.toMatchObject({
			stdout: expect.stringContaining('Verified ECharts PNG and unsupported input rejection'),
		})
	}, 150_000)
})
