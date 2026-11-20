import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { controlHmr, runScript } from '@pluxel/agent-sdk/client'
import { host } from '@pluxel/host-vite'
import { createServer } from 'vite'
import { openProjectControl } from './script-control.fixture.mjs'

const workspace = fileURLToPath(new URL('../../../', import.meta.url))
const require = createRequire(import.meta.url)
const root = await mkdtemp(join(tmpdir(), 'pluxel-hmr-control-'))
const target = { root }
const entries = ['probe', 'neighbor']
const pluginFile = (name) => join(root, 'entries', name + '.entry.ts')
const artifactFile = join(root, 'content.txt')
const appFile = join(root, 'app.ts')
const offsetFile = join(root, 'entries/offset.mjs')
const scriptFile = join(root, 'read.ts')
const entry = (name) => ({
	kind: 'source-entry',
	sourceSpace: 'app',
	path: 'entries/' + name + '.entry.ts',
})
const metrics = { evaluated: [], started: [], stopped: [], artifact: null, gate: null }
const errors = []
globalThis.__pluxelHmrTest = metrics
let server
let instance

function plugin(name, version) {
	const generation = name + ':' + version
	return `
import { BasePlugin, Plugin } from '@pluxel/core'
import { offset } from './offset.mjs'
import { metrics } from '../metrics.ts'
metrics.evaluated.push('${generation}')
@Plugin()
export class Probe extends BasePlugin {
  readonly version: ${version} = ${version}
  readonly value = this.version + offset
  async init() {
    metrics.started.push('${generation}')
    ${name === 'probe' ? 'await metrics.gate?.promise' : ''}
    return () => { metrics.stopped.push('${generation}') }
  }
}
`
}

function application(name) {
	return `
import { defineHostApplication } from '@pluxel/host'
export default defineHostApplication(() => ({
  name: '${name}',
  sources: [{ directory: './entries', include: ['*.entry.ts'] }],
  pluginNodes: ${JSON.stringify(
		entries.map((label) => ({
			definition: { entry: entry(label), exportName: 'Probe' },
			autoStart: true,
		})),
	)},
}))
`
}

async function status() {
	using client = await openProjectControl(instance)
	return await client.describe()
}

async function until(check, description) {
	const deadline = Date.now() + 10_000
	while (Date.now() < deadline) {
		const result = await check()
		if (result) return result
		await delay(25)
	}
	throw new Error(
		description + ': ' + JSON.stringify({ status: await status(), errors: errors.slice(-2) }),
	)
}

async function observed(change) {
	const { hmr } = await status()
	const before = hmr.observedRevision
	await change()
	return until(async () => {
		const current = await status()
		return current.hmr.observedRevision > before && current
	}, 'Expected the watcher to admit the file change')
}

async function control(action) {
	const { run } = await controlHmr({ target, action, timeoutMs: 60_000 })
	assert.equal(run.state, 'succeeded', JSON.stringify({ run, errors: errors.slice(-2) }))
	return run.value
}

async function readPlugin(expected) {
	const { run } = await runScript({ target, file: scriptFile })
	assert.equal(run.state, 'succeeded', JSON.stringify(run))
	assert.equal(run.value, expected)
	return run
}

async function materials() {
	using client = await openProjectControl(instance)
	const index = await client.materials()
	const selected = index.definitions.find(
		({ definition }) => definition.entry.path === entry('probe').path,
	)
	assert.ok(selected, JSON.stringify(index))
	const manifest = []
	let offset = 0
	for (;;) {
		const chunk = await client.materialFile({
			snapshot: selected.snapshot,
			path: 'manifest.json',
			offset,
		})
		manifest.push(Buffer.from(chunk.data, 'base64'))
		if (chunk.done) break
		offset = chunk.nextOffset
	}
	const material = JSON.parse(Buffer.concat(manifest).toString('utf8'))
	const contract = (name) =>
		material.definitions.find(({ definition }) => definition.entry.path === entry(name).path)
			.contracts.instance
	return { snapshot: selected.snapshot, probe: contract('probe'), neighbor: contract('neighbor') }
}

try {
	await mkdir(join(root, 'node_modules/@pluxel'), { recursive: true })
	for (const name of ['host', 'core', 'agent-sdk']) {
		await symlink(
			join(workspace, 'packages', name),
			join(root, 'node_modules/@pluxel', name),
			'dir',
		)
	}
	await mkdir(join(root, 'entries'))
	const files = {
		'package.json': JSON.stringify({ type: 'module' }),
		'tsconfig.json': JSON.stringify({
			compilerOptions: {
				target: 'ESNext',
				module: 'ESNext',
				moduleResolution: 'Bundler',
				strict: true,
				skipLibCheck: true,
				experimentalDecorators: true,
				allowImportingTsExtensions: true,
				allowJs: true,
				noEmit: true,
				types: ['node'],
				typeRoots: [dirname(dirname(require.resolve('@types/node/package.json')))],
				lib: ['ESNext', 'DOM'],
			},
			include: ['*.ts', 'entries/*'],
		}),
		'metrics.ts': `
export const metrics = (globalThis as unknown as { __pluxelHmrTest: {
  evaluated: string[], started: string[], stopped: string[],
  gate: PromiseWithResolvers<void> | null
} }).__pluxelHmrTest
`,
		'app.ts': application('original'),
		'content.txt': 'initial',
		'entries/offset.mjs': 'export const offset = 0',
		'entries/probe.entry.ts': 'export const invalid = ;',
		'entries/neighbor.entry.ts': plugin('neighbor', 0),
		'read.ts': `
import type { Script } from '@pluxel/agent-sdk/host'
import { Probe } from './entries/probe.entry.ts'
export default (async (sdk) => {
  const { instance } = await sdk.plugin(Probe.nodeAddress()).instance()
  return instance.value
}) satisfies Script
`,
	}
	for (const [file, content] of Object.entries(files)) await writeFile(join(root, file), content)

	server = await createServer({
		root,
		configFile: false,
		server: { port: 0, host: '127.0.0.1' },
		plugins: [
			...host({ entry: 'app.ts', scripts: true }),
			{
				name: 'fixture:content',
				api: {
					pluxelHost: {
						attach({ server: vite }) {
							vite.watcher.add(artifactFile)
							return {
								tracks: (file) => file === artifactFile,
								async prepareCandidate() {
									const content = await readFile(artifactFile, 'utf8')
									return {
										commit() {
											metrics.artifact = content
										},
										rollback() {},
									}
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
	const discovery = join(root, '.pluxel/dev-console')
	const [record] = await readdir(discovery)
	instance = JSON.parse(await readFile(join(discovery, record), 'utf8'))

	// HMR belongs to the Vite instance and can repair an unavailable Host.
	const initialStatus = await status()
	assert.equal(initialStatus.application.state, 'unavailable')
	assert.ok(
		metrics.evaluated.includes('neighbor:0'),
		'the valid sibling was evaluated before failure',
	)
	const paused = await control('pause')
	assert.equal(paused.hmr.mode, 'paused')
	await observed(() => writeFile(pluginFile('probe'), plugin('probe', 0)))
	assert.deepEqual(metrics.started, [])
	const recovered = await control('apply')
	assert.equal(recovered.application.state, 'ready')
	const original = await readPlugin(0)
	const accepted = await materials()

	// Intermediate saves stay out of the running catalog and its control materials.
	await observed(() => writeFile(pluginFile('probe'), 'export const stillInvalid = ;'))
	const dirty = await runScript({ target, file: scriptFile })
	assert.equal(dirty.run.error?.code, 'hmr_pending', JSON.stringify(dirty.run))
	const failed = await controlHmr({ target, action: 'apply' })
	assert.equal(failed.run.state, 'failed')
	const rejectedStatus = await status()
	assert.equal(rejectedStatus.application.latestUpdate.outcome, 'retained-previous')
	const retained = await materials()
	assert.equal(retained.snapshot, accepted.snapshot)
	assert.deepEqual(metrics.stopped, [])

	await observed(() => writeFile(pluginFile('probe'), plugin('probe', 1)))
	const applied = await control('apply')
	assert.equal(applied.hmr.mode, 'paused')
	await readPlugin(1)
	const next = await materials()
	assert.notEqual(next.snapshot, accepted.snapshot)
	assert.notEqual(next.probe, accepted.probe)
	assert.equal(next.neighbor, accepted.neighbor)
	assert.deepEqual(metrics.stopped, ['probe:0'])

	// A real watcher event arriving during initialization waits for the next apply.
	const gate = Promise.withResolvers()
	metrics.gate = gate
	await observed(() => writeFile(pluginFile('probe'), plugin('probe', 2)))
	const applying = control('apply')
	try {
		await until(async () => {
			const current = await status()
			return current.hmr.running && metrics.started.includes('probe:2')
		}, 'Expected the next Plugin generation to enter while applying')
		await observed(() => writeFile(pluginFile('probe'), plugin('probe', 3)))
	} finally {
		metrics.gate = null
		gate.resolve()
		await applying
	}
	assert.equal(metrics.started.at(-1), 'probe:2')
	await control('apply')
	await readPlugin(3)

	await observed(() => writeFile(artifactFile, 'updated content'))
	await control('apply')
	assert.equal(metrics.artifact, 'updated content')
	assert.equal(metrics.started.filter((item) => item === 'probe:3').length, 1)

	await observed(() => writeFile(appFile, application('replacement')))
	await control('apply')
	const replacement = await status()
	assert.equal(replacement.instanceId, instance.instanceId)
	assert.notEqual(replacement.hostEpoch, original.hostEpoch)
	await readPlugin(3)

	// Matching bytes cannot bypass validation of the physical source owner.
	const linkedSource = join(root, 'same-bytes.ts')
	await writeFile(linkedSource, plugin('probe', 3))
	await observed(() => writeFile(pluginFile('probe'), plugin('probe', 3)))
	await rm(pluginFile('probe'))
	await symlink(linkedSource, pluginFile('probe'))
	const invalidOwner = await controlHmr({ target, action: 'apply' })
	assert.equal(invalidOwner.run.state, 'failed')
	assert.match(invalidOwner.run.error?.message ?? '', /symbolic link/)
	await observed(async () => {
		await rm(pluginFile('probe'))
		await writeFile(pluginFile('probe'), plugin('probe', 3))
	})
	await control('resume')
	await readPlugin(3)

	// In auto mode a dependency edit reaches the Plugin and the next script import.
	await observed(() => writeFile(offsetFile, 'export const offset = 10'))
	await until(async () => {
		const current = await status()
		return current.hmr.mode === 'auto' && !current.hmr.running && current.hmr.pending.files === 0
	}, 'Expected the automatic dependency update to settle')
	await readPlugin(13)

	await server.close()
	assert.deepEqual([...metrics.stopped].sort(), [...metrics.started].sort())
	assert.deepEqual(await readdir(discovery), [])
	console.log('HMR_CONTROL_SMOKE_OK')
} finally {
	metrics.gate?.resolve()
	try {
		await server?.close()
	} finally {
		delete globalThis.__pluxelHmrTest
		await rm(root, { recursive: true, force: true })
	}
}
