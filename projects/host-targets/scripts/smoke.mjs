import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
	cp,
	mkdir,
	mkdtempDisposable,
	readdir,
	readFile,
	rename,
	symlink,
	writeFile,
} from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
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

async function prepareAppFixture(directory, plugins) {
	for (const path of [
		'src',
		'public',
		'index.html',
		'package.json',
		'tsconfig.json',
		'wrangler.jsonc',
		'vite.config.ts',
		'vite.dev.ts',
	]) {
		await cp(join(root, path), join(directory, path), { recursive: true })
	}
	await symlink(join(root, 'plugins/node_modules'), join(plugins, 'node_modules'), 'dir')
	const modules = join(directory, 'node_modules')
	const scope = join(modules, '@pluxel-example')
	await mkdir(scope, { recursive: true })
	for (const name of await readdir(join(root, 'node_modules'))) {
		if (name.startsWith('.') || name === '@pluxel-example') continue
		await symlink(join(root, 'node_modules', name), join(modules, name), 'dir')
	}
	await symlink(plugins, join(scope, 'host-targets-plugins'), 'dir')
}

async function editPlugin(file, source) {
	await writeFile(file + '.next', source)
	await rename(file + '.next', file)
}

process.env.CLOUDFLARE_CF_FETCH_ENABLED ??= 'false'

const browser = process.env.PLAYWRIGHT_WS_ENDPOINT
	? await chromium.connect(process.env.PLAYWRIGHT_WS_ENDPOINT)
	: await chromium.launch({ headless: true })

try {
	// Match the example's directory depth so its config can import the repository tasks.
	const temporary = resolve(root, '../../.tmp')
	await mkdir(temporary, { recursive: true })
	await using release = await mkdtempDisposable(join(temporary, 'host-targets-release-'))
	const archive = join(release.path, 'plugins.tgz')
	await run('vp', ['pm', 'pack', '--out', archive], { cwd: join(root, 'plugins') })
	await run('tar', ['-xzf', archive, '-C', release.path])
	const packagedPlugins = join(release.path, 'package')
	const packagedFiles = await readdir(packagedPlugins)
	assert.ok(!packagedFiles.includes('src'))
	await prepareAppFixture(release.path, packagedPlugins)
	await run('vp', ['build'], {
		cwd: release.path,
		env: { ...process.env, VITE_HOST_PROBE: 'fixture-binding' },
	})
	await run('vp', ['build', '--mode', 'node'], { cwd: release.path })

	const { stdout } = await run(process.execPath, ['dist/node/node-main.js'], {
		cwd: release.path,
		env: { ...process.env, HOST_PROBE: 'fixture-binding' },
	})
	const nodeArtifact = JSON.parse(stdout)
	assert.equal(nodeArtifact.host, 'node')
	assert.equal(nodeArtifact.visits, 3)
	assert.equal(nodeArtifact.source, 'Node Fetch transport')
	assert.equal(nodeArtifact.message, 'Hello, Pluxel!')
	assert.equal(nodeArtifact.plugin, 'package:@pluxel-example/host-targets-plugins::Consumer')

	const built = await preview({ root: release.path, preview: { host: '127.0.0.1', port: 0 } })
	try {
		const page = await browser.newPage()
		try {
			await page.goto(targetAddress(built.httpServer))
			const web = await waitForResult(page, 'browser', nodeArtifact.message)
			const edge = await waitForResult(page, 'cloudflare', nodeArtifact.message)
			assert.equal(web.source, 'Browser Fetch')
			assert.equal(edge.source, 'workerd Service Binding')
			assert.ok(web.visits >= 3 && edge.visits >= 3, 'Each released Host ran the shared probe')
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
	await using fixture = await mkdtempDisposable(join(temporary, 'host-targets-smoke-'))
	const plugins = join(fixture.path, 'plugins')
	await cp(join(root, 'plugins'), plugins, {
		recursive: true,
		filter: (source) => basename(source) !== 'node_modules',
	})
	await prepareAppFixture(fixture.path, plugins)
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
			assert.ok(edge.visits >= 1)
			await page.evaluate(() => {
				window.hostTargetsSmoke = true
			})

			const file = join(fixture.path, 'plugins/src/index.ts')
			const source = await readFile(file, 'utf8')
			const updated = source.replace('Hello, ', 'Updated, ')
			assert.notEqual(updated, source)
			await editPlugin(file, updated)
			const immediate = await fetch(`${address}/api/node`, {
				method: 'POST',
				signal: AbortSignal.timeout(10_000),
			})
			assert.ok(immediate.ok, await immediate.text())

			const updatedMessage = 'Updated, Pluxel!'
			const [nodeResult, browserResult, edgeResult] = await Promise.all([
				waitForResult(page, 'node', updatedMessage),
				waitForResult(page, 'browser', updatedMessage),
				waitForResult(page, 'cloudflare', updatedMessage),
			])
			assert.equal(browserResult.plugin, before.plugin)
			assert.ok(
				browserResult.visits > web.visits,
				'Browser HMR retains the worker and its plugin state',
			)
			assert.notEqual(browserResult.generation, web.generation)
			assert.equal(await page.evaluate(() => window.hostTargetsSmoke), true)
			assert.equal(nodeResult.plugin, before.plugin)
			assert.ok(nodeResult.visits > before.visits, 'Node HMR retains the plugin state')
			assert.notEqual(nodeResult.generation, before.generation)
			assert.equal(edgeResult.plugin, before.plugin)
			assert.ok(
				edgeResult.visits > edge.visits,
				'Cloudflare HMR retains the isolate Host and plugin state',
			)
			assert.notEqual(edgeResult.generation, edge.generation)

			const rejection = 'Rejected demo edit'
			await editPlugin(file, `${updated}\nthrow new Error(${JSON.stringify(rejection)})\n`)
			await Promise.all(
				Object.entries({
					node: rejection,
					browser: 'Worker plugin module failed to evaluate',
					cloudflare: 'Worker plugin module failed to evaluate',
				}).map(([host, hasText]) =>
					page.locator(`[data-host="${host}"]`).filter({ hasText }).waitFor(),
				),
			)
			const retained = await fetch(`${address}/api/node`, {
				method: 'POST',
				signal: AbortSignal.timeout(10_000),
			})
			assert.ok(retained.ok)
			const retainedResult = await retained.json()
			assert.equal(retainedResult.generation, nodeResult.generation)
			const lastGood = await fetch(`${address}/api/cloudflare`, {
				method: 'POST',
				signal: AbortSignal.timeout(10_000),
			})
			assert.equal(lastGood.status, 200)
			const retainedEdge = await lastGood.json()
			assert.equal(retainedEdge.message, updatedMessage)
			assert.equal(retainedEdge.generation, edgeResult.generation)
			assert.ok(retainedEdge.visits > edgeResult.visits)
			await page.locator('button').click()
			const retainedBrowser = await waitForResult(page, 'browser', updatedMessage)
			assert.equal(retainedBrowser.generation, browserResult.generation)
			assert.ok(retainedBrowser.visits > browserResult.visits)

			const recovered = 'Recovered, Pluxel!'
			await editPlugin(file, source.replace('Hello, ', 'Recovered, '))
			await Promise.all(
				['node', 'browser', 'cloudflare'].map((host) => waitForResult(page, host, recovered)),
			)

			const configFile = join(fixture.path, 'src/demo-plugins.ts')
			const config = await readFile(configFile, 'utf8')
			const configured = config.replace(
				'{ plugin: Provider, ...provider }',
				"{ plugin: Provider, config: { ...provider.config, name: 'App reload' } }",
			)
			assert.notEqual(configured, config)
			await editPlugin(configFile, configured)
			const configuredResult = await waitForResult(page, 'browser', 'Recovered, App reload!')
			assert.equal(configuredResult.visits, 1, 'A declaration change starts a fresh browser Host')
			const configuredEdge = await waitForResult(page, 'cloudflare', 'Recovered, App reload!')
			assert.equal(configuredEdge.visits, 1, 'A declaration change starts a fresh Cloudflare Host')

			const bootstrap = join(fixture.path, 'src/browser.worker.ts')
			const workerSource = await readFile(bootstrap, 'utf8')
			const changedWorker = workerSource.replace(
				"{ kind: 'result', value } satisfies BrowserReply",
				"{ kind: 'result', value: { ...value, message: 'New worker: ' + value.message } } satisfies BrowserReply",
			)
			assert.notEqual(changedWorker, workerSource)
			await editPlugin(bootstrap, changedWorker)
			const restarted = await waitForResult(page, 'browser', 'New worker: Recovered, App reload!')
			assert.equal(restarted.visits, 1, 'An edit to the worker bootstrap starts a fresh Host')
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
