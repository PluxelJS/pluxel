import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('operates a source-free standalone application using an independently installed CLI and SDK', async () => {
	const result = await promisify(execFile)(process.execPath, ['tests/agent-installed.smoke.mjs'], {
		cwd: new URL('../', import.meta.url),
		timeout: 180_000,
		maxBuffer: 4 * 1024 * 1024,
	})
	expect(result.stdout).toContain('INSTALLED_AGENT_CLI_NODE_OK')
}, 190_000)
