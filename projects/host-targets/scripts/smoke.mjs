import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdtempDisposable, readFile, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import { createServer, preview } from 'vite'

const run = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const targetAddress = (httpServer) => `http://127.0.0.1:${httpServer.address().port}`
const readResult = async (page, host) =>
	JSON.parse(await page.locator(`[data-host="${host}"]`).textContent())

async function waitForResult(page, host, message) {
	const target = page.locator(`[data-host="${host}"]`)
	try {
		await page.waitForFunction(
			({ expectedHost, expectedMessage }) => {
				const output = document.querySelector(`[data-host="${expectedHost}"]`)?.textContent
				try {
					return JSON.parse(output).message === expectedMessage
				} catch {
					return false
				}
			},
			{ expectedHost: host, expectedMessage: message },
		)
	} catch (error) {
		const output = await target.allTextContents()
		throw new Error(
			`${host} did not return ${JSON.stringify(message)}. Output ${JSON.stringify(output)}`,
			{
				cause: error,
			},
		)
	}
	return await readResult(page, host)
}

async function waitForServerResult(origin, host, message) {
	const signal = AbortSignal.timeout(10_000)
	let output
	try {
		for (;;) {
			const response = await fetch(`${origin}/api/${host}`, { method: 'POST', signal })
			output = response.ok ? await response.json() : await response.text()
			if (response.ok && output.message === message) return output
			await setTimeout(50, undefined, { signal })
		}
	} catch (error) {
		throw new Error(
			`${host} did not return ${JSON.stringify(message)}. Output ${JSON.stringify(output)}`,
			{
				cause: error,
			},
		)
	}
}

process.env.CLOUDFLARE_CF_FETCH_ENABLED ??= 'false'

const browser = process.env.PLAYWRIGHT_WS_ENDPOINT
	? await chromium.connect(process.env.PLAYWRIGHT_WS_ENDPOINT)
	: await chromium.launch({ headless: true })

try {
	const { stdout } = await run(process.execPath, ['dist/node/node-main.js'], { cwd: root })
	const nodeArtifact = JSON.parse(stdout)
	assert.equal(nodeArtifact.host, 'node')
	assert.equal(nodeArtifact.message, 'Hello, Pluxel!')

	const built = await preview({ root, preview: { host: '127.0.0.1', port: 0 } })
	try {
		const page = await browser.newPage()
		try {
			await page.goto(targetAddress(built.httpServer))
			const web = await waitForResult(page, 'browser', nodeArtifact.message)
			const edge = await waitForResult(page, 'cloudflare', nodeArtifact.message)
			assert.equal(web.source, 'Browser Fetch')
			assert.equal(edge.source, 'workerd Service Binding')
			assert.equal(web.plugin, nodeArtifact.plugin)
			assert.equal(edge.plugin, nodeArtifact.plugin)
		} finally {
			await page.close()
		}
	} finally {
		await new Promise((done, fail) =>
			built.httpServer.close((error) => (error ? fail(error) : done())),
		)
	}

	// The development update edits only a disposable source tree.
	await using fixture = await mkdtempDisposable(resolve(root, '../.host-targets-smoke-'))
	for (const path of [
		'src',
		'public',
		'index.html',
		'package.json',
		'tsconfig.json',
		'wrangler.jsonc',
		'vite.config.ts',
	]) {
		await cp(join(root, path), join(fixture.path, path), { recursive: true })
	}
	await symlink(join(root, 'node_modules'), join(fixture.path, 'node_modules'), 'dir')
	// Preview initializes Vite's ambient production mode in this test process.
	process.env.NODE_ENV = 'development'
	const dev = await createServer({
		root: fixture.path,
		server: { host: '127.0.0.1', port: 0, strictPort: true },
	})
	try {
		await dev.listen()
		const page = await browser.newPage()
		try {
			const address = targetAddress(dev.httpServer)
			await page.goto(address)
			const before = await waitForResult(page, 'node', nodeArtifact.message)
			const web = await waitForResult(page, 'browser', nodeArtifact.message)
			const edge = await waitForResult(page, 'cloudflare', nodeArtifact.message)
			assert.equal(web.plugin, before.plugin)
			assert.equal(edge.plugin, before.plugin)
			assert.equal(edge.visits, 1)
			await page.evaluate(() => {
				window.hostTargetsSmoke = true
			})

			const file = join(fixture.path, 'src/Provider.ts')
			const source = await readFile(file, 'utf8')
			const updated = source.replace('Hello, ', 'Updated, ')
			assert.notEqual(updated, source)
			await writeFile(file, updated)

			const updatedMessage = 'Updated, Pluxel!'
			const browserResult = await waitForResult(page, 'browser', updatedMessage)
			assert.equal(browserResult.plugin, before.plugin)
			assert.equal(browserResult.visits, 1)
			assert.equal(await page.evaluate(() => window.hostTargetsSmoke), true)
			const nodeResult = await waitForServerResult(address, 'node', updatedMessage)
			assert.equal(nodeResult.plugin, before.plugin)
			assert.ok(nodeResult.visits > before.visits, 'Node HMR retains the plugin state')
			const edgeResult = await waitForServerResult(address, 'cloudflare', updatedMessage)
			assert.equal(edgeResult.plugin, before.plugin)
			assert.equal(edgeResult.visits, 1, 'Cloudflare reads run in distinct request Hosts')
		} finally {
			await page.close()
		}
	} finally {
		await dev.close()
	}
} finally {
	await browser.close()
}

console.log('Node, browser module worker and workerd builds and Vite updates passed.')
