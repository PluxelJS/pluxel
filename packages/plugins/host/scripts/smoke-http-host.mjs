import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { dirname, resolve } from 'pathe'

const here = dirname(fileURLToPath(import.meta.url))
const hostDir = resolve(here, '..')

const mode = process.argv[2]
if (mode !== 'managed' && mode !== 'frozen') {
	throw new Error('Usage: node scripts/smoke-http-host.mjs <managed|frozen>')
}

const scriptByMode = {
	managed: 'managed-start.mjs',
	frozen: 'frozen-start.mjs',
}

const portByMode = {
	managed: '3410',
	frozen: '3411',
}

const baseUrl = `http://127.0.0.1:${portByMode[mode]}`
const child = spawn(process.execPath, [resolve(hostDir, 'scripts', scriptByMode[mode])], {
	cwd: hostDir,
	stdio: 'inherit',
	env: {
		...process.env,
		PLUXEL_HOST_BIND: '127.0.0.1',
		PLUXEL_HOST_PORT: portByMode[mode],
	},
})

let childExit = null
let expectedSignal = false

child.once('error', (error) => {
	childExit = error
})

child.once('exit', (code, signal) => {
	if (expectedSignal && signal === 'SIGTERM') {
		childExit = null
		return
	}
	childExit = new Error(
		signal
			? `child exited before ready via signal ${signal}`
			: `child exited before ready with code ${code ?? 0}`,
	)
})

function fail(message) {
	throw new Error(`[pluxel/plugins-host smoke:${mode}] ${message}`)
}

async function waitForReady(url, timeoutMs = 20000) {
	const deadline = Date.now() + timeoutMs
	let lastError
	while (Date.now() < deadline) {
		if (childExit) throw childExit
		try {
			const response = await fetch(`${url}/__pluxel/hmr/meta`, {
				headers: { accept: 'application/json' },
			})
			if (response.ok) return
			lastError = new Error(`unexpected status ${response.status}`)
		} catch (error) {
			lastError = error
		}
		await new Promise((resolve) => setTimeout(resolve, 400))
	}
	throw lastError ?? new Error('timed out waiting for control plane')
}

try {
	await waitForReady(baseUrl)

	console.log(`[pluxel/plugins-host smoke:${mode}] ready at ${baseUrl}`)
	expectedSignal = true
	child.kill('SIGTERM')

	const exitCode = await new Promise((resolve, reject) => {
		child.once('exit', (code, signal) => {
			if (signal && signal !== 'SIGTERM') {
				reject(new Error(`child exited via unexpected signal ${signal}`))
				return
			}
			resolve(code ?? 0)
		})
	})

	if (exitCode !== 0) fail(`child exited with code ${exitCode}`)
} catch (error) {
	child.kill('SIGTERM')
	throw error
}
