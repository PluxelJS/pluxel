// Exercise the published plugin, real filesystem observers and the authenticated console socket.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { host } from '../dist/index.mjs'

const workspace = fileURLToPath(new URL('../../../', import.meta.url))
const require = createRequire(new URL('../package.json', import.meta.url))
const { createServer } = await import(require.resolve('vite'))
const count = 8
const address = (index) => ({
	definition: {
		entry: { kind: 'source-entry', sourceSpace: 'fixture', path: `probe-${index}.mjs` },
		exportName: 'Probe',
	},
	variant: 'default',
})

async function scenario(initiallyInvalid, run) {
	const resourcesBefore = process.getActiveResourcesInfo()
	const root = await mkdtemp(join(tmpdir(), 'pluxel-hmr-control-'))
	const key = `__hmrControl_${randomUUID()}`
	const metrics = {
		evaluations: [],
		starts: [],
		stops: [],
		prepared: [],
		gate: undefined,
		artifactPreparations: 0,
		artifacts: [],
		attachments: 0,
		attachmentDisposals: 0,
	}
	globalThis[key] = metrics
	const errors = []
	let server
	let instance
	const sourcePath = (index) => join(root, 'entries', `probe-${index}.entry.mjs`)
	const source = (index, value) => `
import { BasePlugin, Plugin } from '@pluxel/core';
import { __setPluginDefinition } from '@pluxel/core/toolchain';
const metrics = globalThis[${JSON.stringify(key)}];
metrics.evaluations.push(${JSON.stringify(`${index}:${value}`)});
export class Probe extends BasePlugin {
	value = ${value};
	async init() {
		metrics.starts.push(${JSON.stringify(`${index}:${value}`)});
		if (metrics.gate?.index === ${index}) {
			const gate = metrics.gate;
			metrics.gate = undefined;
			await gate.release.promise;
		}
		return () => metrics.stops.push(${JSON.stringify(`${index}:${value}`)});
	}
}
Plugin()(Probe);
__setPluginDefinition(Probe, ${JSON.stringify({ abiVersion: 2, kind: 'plugin', definition: address(index).definition })});
`
	const app = (version) => `
import { defineHostApplication } from '@pluxel/host';
import { pluginSource } from '@pluxel/host/sources';
export default defineHostApplication(() => ({
	plugins: [],
	sources: [pluginSource({kind:'directory',path:'./entries',include:['*.entry.mjs']})],
	state: { initial: { autoStart: ${JSON.stringify(Array.from({ length: count }, (_, index) => address(index)))} } },
	prepare() { globalThis[${JSON.stringify(key)}].prepared.push(${version}); }
}));
`
	const request = (payload) =>
		new Promise((resolve, reject) => {
			const socket = createConnection(instance.socketPath)
			let response = ''
			socket.setTimeout(10000, () => socket.destroy(new Error('Console request timed out')))
			socket.on('error', reject)
			socket.once('connect', () =>
				socket.write(
					JSON.stringify({
						protocol: instance.protocol,
						instanceId: instance.instanceId,
						nonce: instance.nonce,
						...payload,
					}) + '\n',
				),
			)
			socket.on('data', (chunk) => {
				response += chunk.toString()
			})
			socket.once('end', () => {
				try {
					const packet = JSON.parse(response)
					assert.equal(packet.ok, true, JSON.stringify(packet))
					resolve(packet.value)
				} catch (error) {
					reject(error)
				}
			})
		})
	const inspect = () => request({ method: 'inspect' })
	async function until(check, label) {
		const deadline = Date.now() + 10000
		while (true) {
			const matched = await check()
			if (matched) return matched
			if (Date.now() >= deadline) throw new Error(`${label}: ${errors.slice(-3).join('; ')}`)
			await delay(20)
		}
	}
	async function result(runId) {
		return until(async () => {
			const snapshot = await request({ method: 'result', runId })
			return ['succeeded', 'failed', 'cancelled'].includes(snapshot.state) && snapshot
		}, `run ${runId} must settle`)
	}
	async function submit(action) {
		const runId = randomUUID()
		await request({ method: 'hmr', runId, action })
		return runId
	}
	async function control(action) {
		const outcome = await result(await submit(action))
		assert.equal(outcome.state, 'succeeded', JSON.stringify(outcome))
		return outcome.value
	}
	async function writeObserved(file, text) {
		const before = await inspect()
		await writeFile(file, text)
		return until(async () => {
			const status = await inspect()
			return status.hmr.observedRevision > before.hmr.observedRevision && status
		}, `${file} must reach HMR admission`)
	}
	async function script(name = 'inspect.ts') {
		const file = join(root, name)
		const bytes = await readFile(file)
		const runId = randomUUID()
		await request({
			method: 'run',
			runId,
			file,
			sourceHash: createHash('sha256').update(bytes).digest('hex'),
			exportName: 'default',
		})
		return result(runId)
	}
	try {
		await mkdir(join(root, 'node_modules/@pluxel'), { recursive: true })
		for (const name of ['host', 'core'])
			await symlink(
				join(workspace, 'packages', name),
				join(root, 'node_modules/@pluxel', name),
				'dir',
			)
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({ name: 'hmr-control-fixture', type: 'module' }),
		)
		await mkdir(join(root, 'entries'))
		await writeFile(join(root, 'app.ts'), app(0))
		const artifactFile = join(root, 'view.txt')
		await writeFile(artifactFile, 'initial')
		await writeFile(
			join(root, 'inspect.ts'),
			"import { Probe } from './entries/probe-0.entry.mjs'; export default (dev) => dev.plugins.require(Probe).value",
		)
		await writeFile(join(root, 'fresh.ts'), await readFile(join(root, 'inspect.ts')))
		await Promise.all(
			Array.from({ length: count }, (_, index) =>
				writeFile(
					sourcePath(index),
					initiallyInvalid && index === 0 ? 'export const invalid = ;' : source(index, 0),
				),
			),
		)
		server = await createServer({
			root,
			configFile: false,
			server: { port: 0, host: '127.0.0.1' },
			plugins: [
				...host({ entry: 'app.ts', devConsole: true }),
				{
					name: 'fixture:artifact',
					api: {
						pluxelHost: {
							attach({ server: vite }) {
								metrics.attachments++
								vite.watcher.add(artifactFile)
								return {
									tracks: (file) => file === artifactFile,
									async prepareCandidate() {
										metrics.artifactPreparations++
										const content = await readFile(artifactFile, 'utf8')
										return {
											commit() {
												metrics.artifacts.push(content)
											},
											rollback() {},
										}
									},
									dispose() {
										metrics.attachmentDisposals++
									},
								}
							},
						},
					},
				},
			],
			customLogger: {
				hasWarned: false,
				info() {},
				warn() {},
				warnOnce() {},
				clearScreen() {},
				hasErrorLogged() {
					return false
				},
				error(message, details) {
					errors.push(details?.error?.stack ?? message)
				},
			},
		})
		await server.listen()
		const [file] = await readdir(join(root, '.pluxel/dev-console'))
		instance = JSON.parse(await readFile(join(root, '.pluxel/dev-console', file), 'utf8'))
		await run({
			root,
			metrics,
			sourcePath,
			source,
			app,
			request,
			inspect,
			until,
			result,
			submit,
			control,
			writeObserved,
			script,
		})
	} finally {
		metrics.gate?.release.resolve()
		await server?.close()
		assert.equal(
			metrics.stops.length,
			metrics.starts.length,
			'every initialized generation must release',
		)
		assert.equal(metrics.attachmentDisposals, metrics.attachments)
		if (server) {
			assert.equal(server.httpServer.listening, false)
			assert.deepEqual(server.watcher.getWatched(), {})
			assert.deepEqual(await readdir(join(root, '.pluxel/dev-console')), [])
		}
		delete globalThis[key]
		await rm(root, { recursive: true, force: true })
		await delay(0)
		console.log(
			'HMR_RESOURCES_AFTER_CLOSE',
			JSON.stringify({
				initiallyInvalid,
				resourcesBefore,
				resourcesAfter: process.getActiveResourcesInfo(),
				started: metrics.starts.length,
				released: metrics.stops.length,
			}),
		)
	}
}

await scenario(
	false,
	async ({
		root,
		metrics,
		sourcePath,
		source,
		app,
		inspect,
		until,
		result,
		submit,
		control,
		writeObserved,
		script,
	}) => {
		const initial = await inspect()
		assert.equal(initial.application.state, 'ready')
		assert.equal(metrics.evaluations.length, count)
		assert.equal(metrics.starts.length, count)
		const initialRead = await script()
		assert.equal(initialRead.value, 0)
		const paused = await control('pause')
		assert.equal(paused.hmr.mode, 'paused')

		// Every intermediate edit reaches actual admission while evaluations and lifecycle remain unchanged.
		for (let edit = 0; edit < 4; edit++) {
			const pending = await writeObserved(sourcePath(0), `export const invalid${edit} = ;`)
			assert.equal(pending.hmr.pending.files, 1)
			assert.equal(metrics.evaluations.length, count)
			assert.equal(metrics.starts.length, count)
			assert.equal(metrics.stops.length, 0)
		}
		await writeObserved(sourcePath(0), source(0, 1))
		const dirty = await script()
		assert.equal(dirty.state, 'failed')
		assert.equal(dirty.error.code, 'hmr_pending')
		const freshDirty = await script('fresh.ts')
		assert.equal(freshDirty.state, 'failed')
		assert.equal(freshDirty.error.code, 'hmr_pending')
		assert.equal(
			metrics.evaluations.length,
			count,
			'dirty console admission must precede module evaluation',
		)
		const applied = await control('apply')
		assert.equal(applied.hmr.mode, 'paused')
		assert.equal(applied.hmr.pending.files, 0)
		assert.equal(metrics.evaluations.length, count + 1)
		assert.equal(metrics.starts.at(-1), '0:1')
		const firstRead = await script()
		assert.equal(firstRead.value, 1)
		const sequence = applied.application.latestUpdate.sequence
		const unchanged = await control('apply')
		assert.equal(unchanged.application.latestUpdate.sequence, sequence)
		assert.equal(metrics.evaluations.length, count + 1)

		// A failed explicit batch retains the running generation and stays repairable through the same socket.
		await writeObserved(sourcePath(0), 'export const stillInvalid = ;')
		const failed = await result(await submit('apply'))
		assert.equal(failed.state, 'failed')
		const failedStatus = await inspect()
		assert.equal(failedStatus.hmr.mode, 'paused')
		assert.equal(failedStatus.application.latestUpdate.outcome, 'retained-previous')
		assert.equal(metrics.starts.at(-1), '0:1')
		await writeObserved(sourcePath(0), source(0, 2))
		await control('apply')
		const repairedRead = await script()
		assert.equal(repairedRead.value, 2)

		// Edits observed during lifecycle await belong to the next explicit batch.
		const gate = { index: 0, release: Promise.withResolvers() }
		metrics.gate = gate
		await writeObserved(sourcePath(0), source(0, 3))
		const running = await submit('apply')
		try {
			await until(() => metrics.gate === undefined, 'blocked Plugin initializer must enter')
			const runningStatus = await inspect()
			assert.equal(runningStatus.hmr.running, true)
			await writeObserved(sourcePath(0), source(0, 4))
		} finally {
			gate.release.resolve()
		}
		const runningResult = await result(running)
		assert.equal(runningResult.state, 'succeeded')
		const pendingAfterRun = await inspect()
		assert.equal(pendingAfterRun.hmr.pending.files, 1)
		assert.equal(metrics.starts.at(-1), '0:3')
		await control('apply')
		const latestRead = await script()
		assert.equal(latestRead.value, 4)

		// The control run owns the Vite instance, so full Host replacement must not cancel itself.
		const previousHost = await inspect()
		await writeObserved(join(root, 'app.ts'), app(1))
		await control('apply')
		const replaced = await inspect()
		assert.notEqual(replaced.hostEpoch, previousHost.hostEpoch)
		assert.equal(replaced.instanceId, initial.instanceId)
		assert.equal(replaced.hmr.mode, 'paused')
		assert.deepEqual(metrics.prepared, [0, 1])

		// Content-only changes prepare the real attachment once without replacing Plugin definitions.
		const beforeArtifact = {
			evaluations: metrics.evaluations.length,
			starts: metrics.starts.length,
			preparations: metrics.artifactPreparations,
		}
		await writeObserved(join(root, 'view.txt'), 'intermediate')
		// The Vite watcher may coalesce rapid saves; apply must still read the latest bytes.
		await writeFile(join(root, 'view.txt'), 'final content')
		assert.equal(metrics.artifactPreparations, beforeArtifact.preparations)
		const artifactBatch = await control('apply')
		assert.equal(
			artifactBatch.application.latestUpdate.sequence,
			replaced.application.latestUpdate.sequence + 1,
		)
		assert.equal(metrics.artifactPreparations, beforeArtifact.preparations + 1)
		assert.equal(metrics.artifacts.at(-1), 'final content')
		assert.equal(metrics.evaluations.length, beforeArtifact.evaluations)
		assert.equal(metrics.starts.length, beforeArtifact.starts)

		// Eight independently observed source changes are one batch; repeated cycles leave no queued work.
		const cycles = 5
		const memory = []
		const beforeEvaluations = metrics.evaluations.length
		const beforeCycles = await inspect()
		const beforeSequence = beforeCycles.application.latestUpdate.sequence
		for (let cycle = 0; cycle < cycles; cycle++) {
			await Promise.all(
				Array.from({ length: count }, (_, index) =>
					writeFile(sourcePath(index), source(index, 10 + cycle)),
				),
			)
			await until(async () => {
				const status = await inspect()
				return status.hmr.pending.files === count
			}, 'all burst files must be admitted')
			assert.equal(metrics.evaluations.length, beforeEvaluations + cycle * count)
			const batch = await control('apply')
			assert.equal(batch.hmr.pending.files, 0)
			assert.equal(batch.hmr.running, false)
			assert.equal(batch.application.latestUpdate.sequence, beforeSequence + cycle + 1)
			const { heapUsed, rss } = process.memoryUsage()
			memory.push({ cycle, heapUsed, rss })
		}
		assert.equal(metrics.evaluations.length, beforeEvaluations + count * cycles)
		const repeatedRead = await script()
		assert.equal(repeatedRead.value, 14)
		await control('resume')
		const beforeAutomatic = await inspect()
		const beforeAuto = beforeAutomatic.application.latestUpdate.sequence
		await Promise.all(
			Array.from({ length: count }, (_, index) => writeFile(sourcePath(index), source(index, 20))),
		)
		await until(async () => {
			const status = await inspect()
			return (
				metrics.starts.filter((entry) => entry.endsWith(':20')).length === count &&
				!status.hmr.running
			)
		}, 'automatic burst must finish')
		const automatic = await inspect()
		assert.equal(automatic.hmr.pending.files, 0)
		assert.equal(automatic.application.latestUpdate.sequence, beforeAuto + 1)
		assert.equal(metrics.evaluations.length, beforeEvaluations + count * (cycles + 1))
		const automaticRead = await script()
		assert.equal(automaticRead.value, 20)
		console.log(
			'HMR_CONTROL_SMOKE_OK',
			JSON.stringify({
				cycles,
				filesPerBatch: count,
				evaluations: metrics.evaluations.length,
				updates: automatic.application.latestUpdate.sequence,
				memory,
			}),
		)
	},
)

await scenario(
	true,
	async ({ metrics, sourcePath, source, inspect, control, writeObserved, script }) => {
		const unavailable = await inspect()
		assert.equal(unavailable.application.state, 'unavailable')
		await control('pause')
		await writeObserved(sourcePath(0), source(0, 1))
		assert.equal(metrics.starts.length, 0)
		const recovered = await control('apply')
		assert.equal(recovered.application.state, 'ready')
		assert.equal(recovered.hmr.mode, 'paused')
		assert.equal(recovered.hmr.pending.files, 0)
		const recoveredRead = await script()
		assert.equal(recoveredRead.value, 1)
		console.log('HMR_UNAVAILABLE_RECOVERY_OK')
	},
)
