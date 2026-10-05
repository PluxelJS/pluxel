import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'vitest'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const nativeEntry = new URL('../start.mjs', import.meta.url).href
const nativeScript = String.raw`
import { registerHooks } from 'node:module'
registerHooks({ resolve(id, context, next) {
  if (/^(?:vite|@pluxel\/host-vite|@pluxel\/rolldown|rolldown|oxc-parser|oxc-resolver|tsdown|tsx|typescript|chokidar)(?:$|\/)/.test(id))
    throw new Error('Native imported execution tools: ' + id)
  return next(id, context)
} })
await import(process.argv[1])
`

for (const mode of ['native', 'production-vite']) {
	test(`${mode}: compiled official catalog, Workbench assets and natural SIGTERM`, async () => {
		const manifest = JSON.parse(await readFile(join(root, 'dist/pluxel-deployment.json'), 'utf8'))
		assert.equal(manifest.kind, 'pluxel-modules-application')
		assert.equal(manifest.capabilities.workbench.included, true)
		const dataRoot = await mkdtemp(join(tmpdir(), 'pluxel-official-host-'))
		const port = await reservePort()
		const args =
			mode === 'native'
				? ['--input-type=module', '--eval', nativeScript, nativeEntry]
				: ['start-vite.mjs']
		const child = spawn(process.execPath, args, {
			cwd: root,
			env: {
				...process.env,
				NODE_ENV: 'production',
				PLUXEL_HOST_BIND: '127.0.0.1',
				PLUXEL_HOST_PORT: String(port),
				PLUXEL_DATA_ROOT: dataRoot,
				PLUXEL_WORKBENCH: 'true',
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		let output = ''
		for (const stream of [child.stdout, child.stderr])
			stream.setEncoding('utf8').on('data', (chunk) => {
				output = (output + chunk).slice(-64_000)
			})
		const exited = new Promise((resolveExit, reject) => {
			child.once('error', reject)
			child.once('exit', (code, signal) => resolveExit({ code, signal }))
		})
		const origin = `http://127.0.0.1:${port}`
		try {
			const status = await waitForStatus(origin, child)
			assert.match(status.rendererProvider, /EChartsShowcaseRenderer/)
			assert.match(status.storageProvider, /S3Plugin/)
			assert.deepEqual(status.artifacts, [])
			const shell = await requestDocument(`${origin}/__pluxel/workbench/plugins`)
			assert.equal(shell.status, 200)
			assert.match(shell.text, /content="\/__pluxel\/workbench"/)
			const script = shell.text.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)?.[1]
			assert.ok(script?.startsWith('/__pluxel/workbench/assets/'), script)
			const asset = await fetch(new URL(script, origin))
			assert.equal(asset.status, 200)
			assert.match(asset.headers.get('content-type'), /javascript/)
			const assetSource = await asset.text()
			assert.ok(assetSource.length > 0)
			const developmentRoute = await fetch(`${origin}/__pluxel/dev`)
			assert.equal(developmentRoute.status, 404)
		} catch (error) {
			throw new Error(`${mode} failed:\n${output}`, { cause: error })
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
			try {
				const result = await Promise.race([
					exited,
					delay(10_000, undefined, { ref: false }).then(() => {
						child.kill('SIGKILL')
						throw new Error(`${mode} did not drain after SIGTERM:\n${output}`)
					}),
				])
				assert.deepEqual(result, { code: 0, signal: null }, output)
			} finally {
				await rm(dataRoot, { recursive: true, force: true })
			}
		}
	}, 60_000)
}

async function reservePort() {
	const server = createServer()
	await new Promise((resolveListen, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', resolveListen)
	})
	const { port } = server.address()
	await new Promise((resolveClose, reject) =>
		server.close((error) => (error ? reject(error) : resolveClose())),
	)
	return port
}

async function waitForStatus(origin, child) {
	const deadline = Date.now() + 45_000
	while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
		try {
			const response = await fetch(`${origin}/showcase/status`, {
				signal: AbortSignal.timeout(1000),
			})
			if (response.ok) return await response.json()
			await response.body?.cancel()
		} catch (error) {
			if (!['TypeError', 'TimeoutError'].includes(error.name)) throw error
		}
		await delay(100)
	}
	throw new Error('Official showcase HTTP route did not become ready')
}

function requestDocument(url) {
	return new Promise((resolveResponse, reject) => {
		const client = request(
			url,
			{
				signal: AbortSignal.timeout(5000),
				headers: {
					accept: 'text/html',
					'sec-fetch-mode': 'navigate',
					'sec-fetch-dest': 'document',
				},
			},
			(response) => {
				const chunks = []
				response.on('data', (chunk) => chunks.push(chunk))
				response.once('error', reject)
				response.once('end', () =>
					resolveResponse({
						status: response.statusCode,
						text: Buffer.concat(chunks).toString('utf8'),
					}),
				)
			},
		)
		client.once('error', reject)
		client.end()
	})
}
