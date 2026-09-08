import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer, type Plugin, type PluginOption } from 'vite'
import type {
	DevConsoleInstance,
	DevConsoleResponse,
	DevConsoleRunSnapshot,
} from '../../src/console/protocol.ts'

/** Runs in its own Node process: LogTape and the production host bridge each have one owner. */
export async function exerciseViteConsole(options: {
	route: 'static' | 'dynamic'
	root: string
	plugins(entry: string, enabled: boolean): PluginOption[]
	dynamicConfigImport?: string
}): Promise<void> {
	const { route } = options
	const workspaceRoot = options.root
	const root = resolve(workspaceRoot, 'app')
	await mkdir(root, { recursive: true })
	const entry = resolve(root, `pluxel.${route}.ts`)
	const script = resolve(root, 'dev/actions.ts')
	const helper = resolve(root, 'dev/helper.ts')
	const counterSource = resolve(workspaceRoot, 'packages/counter/src/index.ts')
	const node = (exportName: string, packageName: string) => ({
		definition: { entry: { kind: 'package-root', packageName }, exportName },
		variant: 'default',
	})
	const counterAddress = node('Counter', '@fixture/console-counter')
	const stableAddress = node('Stable', '@fixture/console-stable')
	await mkdir(resolve(root, 'dev'), { recursive: true })
	await mkdir(resolve(root, 'entries'), { recursive: true })
	await mkdir(resolve(root, 'node_modules/@fixture'), { recursive: true })
	for (const [name, packageName, source] of [
		['counter', '@fixture/console-counter', counter('v1')],
		[
			'stable',
			'@fixture/console-stable',
			"import { BasePlugin, Plugin } from '@pluxel/runtime'\n@Plugin()\nexport class Stable extends BasePlugin { count = 0; add() { return ++this.count } }\n",
		],
	]) {
		const directory = resolve(workspaceRoot, 'packages', name!)
		await mkdir(resolve(directory, 'src'), { recursive: true })
		await writeFile(
			resolve(directory, 'package.json'),
			JSON.stringify({
				name: packageName,
				type: 'module',
				exports: { '.': { '@pluxel/hmr': './src/index.ts', default: './src/index.ts' } },
			}),
		)
		await writeFile(resolve(directory, 'src/index.ts'), source!)
		await symlink(directory, resolve(root, 'node_modules', packageName!), 'dir')
	}
	await writeFile(
		resolve(root, 'entries/plugins.ts'),
		"export { Counter } from '@fixture/console-counter'\nexport { Stable } from '@fixture/console-stable'\n",
	)
	await writeFile(
		resolve(root, 'pluxel.loader.hmr.jsonc'),
		JSON.stringify({
			version: 2,
			profile: 'test',
			defaults: { roots: [] },
			profiles: { test: { enabled: [] } },
		}),
	)
	const services = `workbench: false, configService: { mode: 'memory' }, runtimeState: { mode: 'memory', snapshot: { autoStart: ${JSON.stringify([counterAddress, stableAddress])} } }`
	const application =
		route === 'static'
			? `import { defineStaticRuntime } from '@pluxel/runtime-static'\nimport { Counter } from '@fixture/console-counter'\nimport { Stable } from '@fixture/console-stable'\nexport default defineStaticRuntime({ name: 'console-smoke', plugins: [Counter, Stable], configure() { return { ${services} } } })\n`
			: `import { defineDynamicRuntimeConfig } from ${JSON.stringify(options.dynamicConfigImport)}\nexport default defineDynamicRuntimeConfig({ root: ${JSON.stringify(root)}, profile: 'test', configPath: 'pluxel.loader.hmr.jsonc', sources: [{ kind: 'file', path: 'entries/plugins.ts' }], printUrls: false, ${services} })\n`
	await writeFile(entry, application)
	await writeFile(helper, 'export const increment = 2\n')
	await writeFile(script, actions())
	const plugins = options.plugins(entry, true)
	const routePlugin = plugins.at(-1) as Plugin
	let observedWatch: ((file: string) => void) | undefined
	const server = await createServer({
		configFile: false,
		root,
		cacheDir: resolve(root, '.vite-cache'),
		logLevel: 'silent',
		optimizeDeps: { noDiscovery: true, include: [] },
		plugins: [
			...plugins,
			{
				name: 'fixture:no-physical-watcher',
				enforce: 'post',
				config: (config) => {
					config.server = { ...config.server, watch: null }
				},
				handleHotUpdate: ({ file }) => {
					observedWatch?.(file)
				},
			},
		],
		server: { middlewareMode: true, watch: null },
	})
	// Vite's EventEmitter watcher still exercises its real handlers; physical polling is disabled.
	assert.equal(server.config.server.watch, null)
	const descriptorDirectory = resolve(root, '.pluxel/dev-console')
	const descriptors = await readdir(descriptorDirectory)
	assert.equal(descriptors.length, 1)
	const instance = JSON.parse(
		await readFile(resolve(descriptorDirectory, descriptors[0]!), 'utf8'),
	) as DevConsoleInstance
	assert.equal(instance.pid, process.pid)
	const run = async (
		exportName = 'default',
		input?: unknown,
		onSubmitted?: (runId: string) => void,
	) => {
		const runId = randomUUID()
		const submitted = (await request(instance, {
			method: 'run',
			runId,
			file: script,
			sourceHash: createHash('sha256')
				.update(await readFile(script))
				.digest('hex'),
			exportName,
			...(input === undefined ? {} : { input }),
		})) as DevConsoleRunSnapshot
		assert.equal(submitted.runId, runId)
		onSubmitted?.(runId)
		return await terminal(instance, runId)
	}
	const success = (result: DevConsoleRunSnapshot): any => {
		assert.equal(result.state, 'succeeded', JSON.stringify(result))
		return (result as Extract<DevConsoleRunSnapshot, { state: 'succeeded' }>).value
	}
	const hotUpdate = async (file: string) => {
		const hook = routePlugin.hotUpdate ?? routePlugin.handleHotUpdate
		const handler = typeof hook === 'function' ? hook : hook?.handler
		assert.ok(handler)
		await handler.call(
			{ environment: server.environments.ssr } as never,
			{
				type: 'update',
				file,
				server,
				modules: [
					...((routePlugin.hotUpdate
						? server.environments.ssr.moduleGraph
						: server.moduleGraph
					).getModulesByFile(file) ?? []),
				],
				timestamp: Date.now(),
				read: () => readFile(file, 'utf8'),
			} as never,
		)
	}
	const watchUpdate = async (file: string) => {
		const completed = Promise.withResolvers<void>()
		const timeout = setTimeout(
			() => completed.reject(new Error('Vite watcher did not settle')),
			10_000,
		)
		observedWatch = (changed) => {
			if (changed === file) completed.resolve()
		}
		try {
			server.watcher.emit('change', file)
			await completed.promise
		} finally {
			clearTimeout(timeout)
			observedWatch = undefined
		}
	}
	try {
		const first = await run()
		success(first)
		assert.ok(first.revisions?.before)
		assert.ok(first.revisions?.after)
		assert.ok(first.logs?.before)
		assert.ok(first.logs?.after)
		assert.deepEqual(success(first), {
			count: 2,
			version: 'v1',
			identity: true,
			stable: 1,
			stableIdentity: true,
			pid: process.pid,
		})
		const second = await run()
		assert.equal(second.hostEpoch, first.hostEpoch)
		assert.deepEqual(success(second), {
			count: 4,
			version: 'v1',
			identity: true,
			stable: 2,
			stableIdentity: true,
			pid: process.pid,
		})

		const config = success(await run('configure', { label: 'agent-edited' }))
		assert.equal(config.patched.ok, true)
		assert.equal(config.current.ok, true)
		assert.equal(config.current.config.label, 'agent-edited')
		assert.equal(success(await run('invalidConfig')).ok, false)

		const logs = success(await run('logs'))
		assert.equal(logs.ok, true)
		assert.ok(
			logs.lines.some((line: { msg: string }) => line.msg === 'console-agent-log'),
			JSON.stringify(logs),
		)

		// Submission before Vite observes an edit waits for that exact file revision.
		const beforeHelper = success(await run('inspect'))
		await writeFile(helper, 'export const increment = 5\n')
		const submittedHelper = Promise.withResolvers<string>()
		const pendingHelper = run('default', undefined, submittedHelper.resolve)
		const helperId = await submittedHelper.promise
		await until(
			async () =>
				((await request(instance, { method: 'result', runId: helperId })) as DevConsoleRunSnapshot)
					.state === 'preparing',
		)
		await watchUpdate(helper)
		const helperRun = await pendingHelper
		assert.equal(helperRun.hostEpoch, first.hostEpoch)
		assert.equal(success(helperRun).count, beforeHelper.count + 5)
		assert.equal(success(helperRun).identity, true)
		assert.equal(success(helperRun).stableIdentity, true)

		// Add an export to the same entry; new code is available without restarting its world.
		await writeFile(
			script,
			actions() +
				'\nexport async function added(dev) { return (await dev.plugins.list()).map(item => item.address.definition.exportName).sort() }\n',
		)
		await watchUpdate(script)
		assert.deepEqual(success(await run('added')), ['Counter', 'Stable'])

		// Workspace Plugins outside Vite root keep typed identity after the normal HMR barrier,
		// while the unchanged Stable constructor and object remain intact.
		const beforeReplacement = success(await run('inspect'))
		await writeFile(counterSource, counter('v2'))
		await watchUpdate(counterSource)
		const replaced = await run()
		const replacement = success(replaced)
		assert.equal(replaced.hostEpoch, first.hostEpoch)
		assert.equal(replacement.version, 'v2')
		assert.equal(replacement.identity, true)
		assert.equal(replacement.stableIdentity, true)
		assert.equal(replacement.stable, beforeReplacement.stable + 1)

		const publication = Symbol.for('pluxel.fixture.console.counter')

		// The watcher has already replaced Counter. A subsequent script must not replay that update.
		await writeFile(counterSource, counter('v3'))
		await watchUpdate(counterSource)
		await until(async () => Reflect.get(globalThis, publication)?.version === 'v3')
		const observed = Reflect.get(globalThis, publication)
		observed.add(100)
		const afterObserved = success(await run())
		assert.equal(afterObserved.count, 105)
		assert.equal(afterObserved.identity, true)
		assert.equal(Reflect.get(globalThis, publication), observed)

		// Full-host replacement aborts the active cooperative script before disposing its old root.
		const activeId = randomUUID()
		await request(instance, {
			method: 'run',
			runId: activeId,
			file: script,
			sourceHash: createHash('sha256')
				.update(await readFile(script))
				.digest('hex'),
			exportName: 'hold',
		})
		await until(
			async () =>
				((await request(instance, { method: 'result', runId: activeId })) as DevConsoleRunSnapshot)
					.state === 'running',
		)
		await writeFile(entry, application + '\n// application revision\n')
		await hotUpdate(entry)
		const cancelled = await terminal(instance, activeId)
		assert.equal(cancelled.state, 'cancelled', JSON.stringify(cancelled))
		const nextHost = await run()
		assert.notEqual(nextHost.hostEpoch, first.hostEpoch)
		assert.equal(success(nextHost).identity, true)
		assert.equal(success(nextHost).stableIdentity, true)
	} finally {
		await server.close()
	}
	assert.deepEqual(await readdir(descriptorDirectory), [])

	for (const logging of [
		'false',
		"{ root: { profile: 'console-custom' }, sinks: {}, routes: { runtime: [], plugins: [], debug: [], meta: [] } }",
	]) {
		// Explicit custom and silent logging still win over the console's headless-store default.
		await writeFile(
			entry,
			application.replace('workbench: false', `workbench: false, logging: ${logging}`),
		)
		const silent = await createServer({
			configFile: false,
			root,
			cacheDir: resolve(root, '.vite-silent'),
			logLevel: 'silent',
			optimizeDeps: { noDiscovery: true, include: [] },
			plugins: options.plugins(entry, true),
			server: { middlewareMode: true, watch: null },
		})
		try {
			const [descriptor] = await readdir(descriptorDirectory)
			const current = JSON.parse(
				await readFile(resolve(descriptorDirectory, descriptor!), 'utf8'),
			) as DevConsoleInstance
			const runId = randomUUID()
			await request(current, {
				method: 'run',
				runId,
				file: script,
				sourceHash: createHash('sha256')
					.update(await readFile(script))
					.digest('hex'),
				exportName: 'logs',
			})
			const result = await terminal(current, runId)
			assert.equal(result.state, 'failed')
			assert.equal(
				(result as Extract<DevConsoleRunSnapshot, { state: 'failed' | 'cancelled' }>).error.code,
				'logs_unavailable',
			)
			const identityId = randomUUID()
			await request(current, {
				method: 'run',
				runId: identityId,
				file: script,
				sourceHash: createHash('sha256')
					.update(await readFile(script))
					.digest('hex'),
				exportName: 'logAvailability',
			})
			assert.deepEqual(success(await terminal(current, identityId)), {
				available: false,
				identity: true,
				code: 'logs_unavailable',
			})
		} finally {
			await silent.close()
		}
	}

	const disabled = await createServer({
		configFile: false,
		root,
		cacheDir: resolve(root, '.vite-disabled'),
		logLevel: 'silent',
		optimizeDeps: { noDiscovery: true, include: [] },
		plugins: options.plugins(entry, false),
		server: { middlewareMode: true, watch: null },
	})
	try {
		assert.deepEqual(await readdir(descriptorDirectory), [])
	} finally {
		await disabled.close()
	}
}

function counter(version: string): string {
	return `import { BasePlugin, Plugin, v } from '@pluxel/runtime'
export const CounterConfig = v.object({ label: v.optional(v.string(), 'default') })
@Plugin()
export class Counter extends BasePlugin {
  private readonly settings = this.configs.use(CounterConfig)
  count = 0
  readonly version = ${JSON.stringify(version)}
  add(value: number) { this.count += value; return this.count }
  emit() { this.ctx.logger.info('console-agent-log') }
  protected override init() { Reflect.set(globalThis, Symbol.for('pluxel.fixture.console.counter'), this) }
}
`
}
function actions(): string {
	return `import { DevConsoleError, type DevConsole } from '@pluxel/runtime/dev'
import { Counter } from '@fixture/console-counter'
import { Stable } from '@fixture/console-stable'
import { increment } from './helper.ts'
export default async function(dev: DevConsole) {
  const counter = dev.plugins.require(Counter)
  const stable = dev.plugins.require(Stable)
  return { count: counter.add(increment), version: counter.version, identity: counter.constructor === Counter, stable: stable.add(), stableIdentity: stable.constructor === Stable, pid: process.pid }
}
export function inspect(dev: DevConsole) { return { count: dev.plugins.require(Counter).count, stable: dev.plugins.require(Stable).count } }
export async function configure(dev: DevConsole, run) { return { patched: await dev.config.patch(Counter, run.input), current: await dev.config.get(Counter) } }
export async function invalidConfig(dev: DevConsole) { return await dev.config.patch(Counter, { label: 123 }) }
export async function logs(dev: DevConsole) { const cursor = await dev.logs.mark(); dev.plugins.require(Counter).emit(); return await dev.logs.read({ cursor, target: Counter }) }
export async function logAvailability(dev: DevConsole) { try { await dev.logs.mark(); return { available: true } } catch (error) { return { available: false, identity: error instanceof DevConsoleError, code: error.code } } }
export async function hold(dev: DevConsole, run) { await new Promise((_, reject) => { run.signal.addEventListener('abort', () => reject(run.signal.reason), { once: true }) }) }
`
}
async function request(
	instance: DevConsoleInstance,
	operation: Record<string, unknown>,
): Promise<unknown> {
	return await new Promise((resolveRequest, reject) => {
		const socket = connect(instance.socketPath)
		let data = ''
		socket.setEncoding('utf8')
		socket.setTimeout(10_000, () => socket.destroy(new Error('console test request timed out')))
		socket.once('error', reject)
		socket.once('connect', () =>
			socket.write(
				JSON.stringify({
					protocol: instance.protocol,
					instanceId: instance.instanceId,
					nonce: instance.nonce,
					...operation,
				}) + '\n',
			),
		)
		socket.on('data', (chunk) => {
			data += chunk
		})
		socket.once('end', () => {
			try {
				const response = JSON.parse(data) as DevConsoleResponse
				if (!response.ok) throw new Error(JSON.stringify(response.error))
				resolveRequest(response.value)
			} catch (error) {
				reject(error)
			}
		})
	})
}
async function terminal(
	instance: DevConsoleInstance,
	runId: string,
): Promise<DevConsoleRunSnapshot> {
	let result: DevConsoleRunSnapshot | undefined
	await until(async () => {
		result = (await request(instance, { method: 'result', runId })) as DevConsoleRunSnapshot
		return ['succeeded', 'failed', 'cancelled'].includes(result.state)
	})
	return result!
}
async function until(condition: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 30_000
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error('Console operation did not settle')
		await delay(10)
	}
}
