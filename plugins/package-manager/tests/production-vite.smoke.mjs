import assert from 'node:assert/strict'
import { get } from 'node:http'
import { access, writeFile, readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { runViteApplication } from '../../../packages/host-vite/dist/run.mjs'
import { requirePluginService } from '../../../packages/core/dist/internal.mjs'
import {
	readHostPluginStatusOverview,
	readHostRecentUpdates,
} from '../../../packages/host/dist/internal.mjs'
import { requirePluginSource } from '../../../packages/host/dist/sources.mjs'

const root = process.argv[2]
const port = process.env.PLUXEL_HOST_PORT
const url = `http://127.0.0.1:${port}`
const address = (name, exportName) => ({
	definition: { entry: { kind: 'package-root', packageName: name }, exportName },
	variant: 'default',
})
const a = address('fixture-a', 'A'),
	b = address('fixture-b', 'B'),
	p = address('fixture-p', 'P'),
	manager = address('@pluxel/package-manager', 'PackageManagerPlugin')
let session
let initial
let beforeProvider
let previousHost
let socket
let unrelatedB
let mutationStarted
const samples = []
const processResources = () =>
	process
		._getActiveHandles()
		.filter(
			(handle) =>
				handle.constructor.name === 'FSWatcher' ||
				handle.constructor.name === 'StatWatcher' ||
				(handle.constructor.name === 'Server' && handle.listening),
		).length
const initialResources = processResources()
const sample = (stage, started) =>
	samples.push({
		stage,
		durationMs: Math.round(performance.now() - started),
		rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024),
	})
const current = (node) => requirePluginService(globalThis.__productionHost.ctx).getInstance(node)
const latestUpdate = () => readHostRecentUpdates(globalThis.__productionHost.ctx)?.latestUpdate()
async function until(check) {
	const deadline = Date.now() + 15000
	while (!(await check())) {
		if (Date.now() > deadline)
			throw new Error(
				`Vite update timed out: ${JSON.stringify({
					update: latestUpdate(),
					status: await globalThis.__productionHost.status(),
				})}`,
			)
		await delay(30)
	}
}
async function openSocket() {
	const value = new WebSocket(`${url.replace('http:', 'ws:')}/a/socket`)
	const first = new Promise((resolve, reject) => {
		value.addEventListener('message', (event) => resolve(String(event.data)), { once: true })
		value.addEventListener('error', reject, { once: true })
	})
	assert.equal(await first, current(a).version)
	return value
}
try {
	const cold = performance.now()
	session = await runViteApplication({ root, configFile: 'vite.config.mjs' })
	sample('cold', cold)
	const installed = await current(manager).snapshot()
	assert.ok(current(manager))
	assert.equal(installed.packages.length, 2)
	assert.equal(current(a).version, '1.0.0')
	assert.equal(current(b).version, '1.0.0')
	assert.equal(current(a).provider.constructor, current(b).provider.constructor)
	assert.equal(current(a).workerValue, '1.0.0')
	assert.equal(current(b).workerValue, '1.0.0')
	const consumption = await requirePluginSource(globalThis.__productionHost.ctx, {
		kind: 'directory',
		path: `${root}/managed/entries`,
		include: ['*.mjs'],
	})
	assert.equal(consumption.updates, 'live')
	const statuses = await readHostPluginStatusOverview(globalThis.__productionHost.ctx)
	initial = {
		b: current(b),
		a: current(a),
		host: globalThis.__productionHost,
		provider: current(p),
		statusB: statuses.statuses.find((status) => status.address.definition.exportName === 'B'),
	}
	assert.deepEqual(initial.statusB.execution, {
		kind: 'vite',
		origin: 'source',
		artifact: { kind: 'built-module' },
		update: { kind: 'definition-hmr' },
	})
	assert.equal(await fetch(`${url}/a`).then((response) => response.text()), '1.0.0')
	for (const path of [
		'/@vite/client',
		'/@fs/etc/passwd',
		'/node_modules/x',
		'/__pluxel/dev-console',
	]) {
		const response = await fetch(url + path)
		assert.equal(response.status, 404)
	}
	await assert.rejects(access(`${root}/.pluxel/dev-console`), { code: 'ENOENT' })
	socket = await openSocket()
	process.send({ ready: true })
	for await (const command of commands()) {
		try {
			if (typeof command === 'object') {
				mutationStarted = performance.now()
				const started = mutationStarted
				const result = await current(manager)[command.operation](command.specs)
				sample(`${command.operation}:${command.specs.join(',')}`, started)
				process.send({ result })
				continue
			}
			if (command === 'a2') {
				await until(() => current(a)?.version === '2.0.0' && current(a)?.workerValue === '2.0.0')
				assert.equal(globalThis.__productionHost, initial.host)
				assert.equal(current(b), initial.b)
				assert.equal(current(b).constructor, initial.b.constructor)
				assert.equal(current(a).provider.constructor, initial.b.provider.constructor)
				assert.equal(current(b).workerValue, '1.0.0')
				assert.equal(current(p), initial.provider)
				const updatedStatuses = await readHostPluginStatusOverview(globalThis.__productionHost.ctx)
				assert.deepEqual(
					updatedStatuses.statuses.find((status) => status.address.definition.exportName === 'B')
						.recentUpdate,
					initial.statusB.recentUpdate,
				)
				assert.equal(await fetch(`${url}/a`).then((response) => response.text()), '2.0.0')
				const firstLate = await initial.a.late()
				assert.equal(firstLate.version, '1.0.0')
				assert.equal(await initial.a.resource(), '1.0.0')
				await until(() => socket.readyState === WebSocket.CLOSED)
				socket = await openSocket()
				beforeProvider = { a: current(a), b: current(b) }
			} else if (command === 'p2') {
				await until(
					() =>
						current(a)?.version === '3.0.0' &&
						current(b)?.version === '2.0.0' &&
						current(b)?.workerValue === '2.0.0',
				)
				assert.notEqual(current(a), beforeProvider.a)
				assert.notEqual(current(b), beforeProvider.b)
				assert.equal(current(a).provider.constructor, current(b).provider.constructor)
				assert.equal(current(a).provider.version, '2.0.0')
				assert.notEqual(current(a).provider.constructor, initial.a.provider.constructor)
				previousHost = globalThis.__productionHost
				const unaffectedB = current(b)
				// An ordinary ESM package is observed even though Vite normally ignores node_modules.
				await writeFile(
					`${root}/node_modules/fixture-plain/index.mjs`,
					"export const value = 'plain-v2'",
				)
				await until(() => current(a)?.plain === 'plain-v2')
				assert.equal(globalThis.__productionHost, previousHost)
				assert.equal(current(b), unaffectedB)
				assert.equal(current(a).provider.constructor, current(b).provider.constructor)
				await writeFile(`${root}/fixed.mjs`, "export const value = 'fixed-v2'")
				await until(
					() =>
						globalThis.__productionHost !== previousHost &&
						current(a)?.workerValue === '3.0.0' &&
						latestUpdate()?.state === 'settled' &&
						latestUpdate()?.outcome === 'applied',
				)
				const app = await readFile(`${root}/app.mjs`, 'utf8')
				const retained = globalThis.__productionHost
				const beforeRejection = latestUpdate().sequence
				await writeFile(`${root}/app.mjs`, 'export const broken = ;')
				await until(() => {
					const update = latestUpdate()
					return (
						update?.sequence > beforeRejection &&
						update.state === 'settled' &&
						update.outcome === 'retained-previous' &&
						update.trigger === 'app.mjs'
					)
				})
				const rejected = latestUpdate()
				assert.equal(rejected.phase, 'evaluate')
				assert.ok(rejected.error)
				assert.equal(globalThis.__productionHost, retained)
				assert.equal(await fetch(`${url}/a`).then((response) => response.text()), '3.0.0')
				await writeFile(`${root}/app.mjs`, app)
				await until(
					() =>
						globalThis.__productionHost !== retained &&
						current(a)?.workerValue === '3.0.0' &&
						current(b)?.workerValue === '2.0.0' &&
						latestUpdate()?.sequence > rejected.sequence &&
						latestUpdate()?.state === 'settled' &&
						latestUpdate()?.outcome === 'applied',
				)
			} else if (command === 'b3') {
				await until(() => current(b)?.version === '3.0.0' && current(b)?.workerValue === '3.0.0')
				// Core can expose the new instance before the Host publishes its settlement report.
				await until(async () => {
					const overview = await readHostPluginStatusOverview(globalThis.__productionHost.ctx)
					const batch = overview.statuses.find(
						(status) => status.address.definition.exportName === 'B',
					)?.recentUpdate?.batch
					return batch?.scope === 'definitions' && batch.outcome === 'applied'
				})
				const currentStatuses = await readHostPluginStatusOverview(globalThis.__productionHost.ctx)
				unrelatedB = {
					instance: current(b),
					host: globalThis.__productionHost,
					status: currentStatuses.statuses.find(
						(status) => status.address.definition.exportName === 'B',
					),
				}
			} else if (command === 'p3') {
				await until(() => current(a)?.version === '4.0.0' && current(a)?.workerValue === '4.0.0')
				assert.equal(current(a).provider.version, '3.0.0')
				assert.equal(current(b), unrelatedB.instance)
				assert.equal(current(b).workerValue, '3.0.0')
				assert.equal(globalThis.__productionHost, unrelatedB.host)
				const currentStatuses = await readHostPluginStatusOverview(globalThis.__productionHost.ctx)
				assert.deepEqual(
					currentStatuses.statuses.find((status) => status.address.definition.exportName === 'B')
						.recentUpdate,
					unrelatedB.status.recentUpdate,
				)
			} else if (command === 'remove') {
				await until(() => !current(a) && current(b)?.workerValue === '3.0.0')
				assert.equal(current(b).version, '3.0.0')
				const removed = await fetch(`${url}/a`)
				assert.equal(removed.status, 404)
				const removedFirstLate = await initial.a.late()
				assert.equal(removedFirstLate.version, '1.0.0')
				assert.equal(await initial.a.resource(), '1.0.0')
				const removedSecondLate = await beforeProvider.a.late()
				assert.equal(removedSecondLate.version, '2.0.0')
				assert.equal(await beforeProvider.a.resource(), '2.0.0')
			} else if (command === 'close') {
				socket.close()
				await session.close()
				await session.close()
				await until(() => processResources() === initialResources)
				const app = await readFile(`${root}/app.mjs`, 'utf8')
				await writeFile(
					`${root}/app.mjs`,
					"import {workbenchService} from '@pluxel/workbench/service'; import {workbenchHttp} from '@pluxel/workbench/http';\n" +
						app.replace(
							"services:standardServices({persistence:{mode:'memory'}})",
							"services:[...standardServices({persistence:{mode:'memory'}}),workbenchService(),workbenchHttp({uiBasePath:'/admin'})]",
						),
				)
				const controller = new AbortController()
				session = await runViteApplication({
					root,
					configFile: 'vite.config.mjs',
					signal: controller.signal,
				})
				assert.equal(current(b).workerValue, '3.0.0')
				assert.ok(current(manager))
				const { WorkbenchHost } = await import('@pluxel/workbench/server')
				const compiledView = globalThis.__productionHost.ctx
					.require(WorkbenchHost)
					.artifacts.getCurrent(manager.definition)
				assert.ok(compiledView)
				assert.ok(compiledView.entries.length > 0)
				const html = await new Promise((resolve, reject) => {
					get(
						`${url}/admin/`,
						{ headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' } },
						(response) => {
							assert.equal(response.statusCode, 200)
							let body = ''
							response.on('data', (chunk) => {
								body += String(chunk)
							})
							response.on('end', () => resolve(body))
						},
					).on('error', reject)
				})
				assert.match(html, /<!doctype html>/i)
				assert.doesNotMatch(html, /@vite\/client|src\/main\.tsx/)
				const asset = /(?:src|href)="([^"]+\.js)"/.exec(html)?.[1]
				assert.ok(asset)
				const compiledAsset = await fetch(new URL(asset, url + '/admin/'))
				assert.equal(compiledAsset.status, 200)
				controller.abort()
				await session.close()
				await until(() => processResources() === initialResources)
				await assert.rejects(fetch(`${url}/b`))
				console.log('PRODUCTION_VITE_SAMPLES ' + JSON.stringify(samples))
				process.send({ command, ok: true, samples })
				break
			}
			sample(`applied:${command}`, mutationStarted)
			process.send({ command, ok: true })
		} catch (error) {
			process.send({ command, error: error.stack })
			throw error
		}
	}
} finally {
	socket?.close()
	await session?.close()
}
process.disconnect()

async function* commands() {
	const queue = [],
		waiters = []
	process.on('message', (value) => {
		const resolve = waiters.shift()
		if (resolve) resolve(value)
		else queue.push(value)
	})
	while (true)
		yield queue.length > 0 ? queue.shift() : await new Promise((resolve) => waiters.push(resolve))
}
