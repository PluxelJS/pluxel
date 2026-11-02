import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
	ConfigError,
	configure,
	getConfig,
	getLogger,
	lazy,
	reset,
	withContext,
	type Config,
	type LogRecord,
	type Sink,
} from '@logtape/logtape'
import { createHost } from '@pluxel/host'
import { afterEach, expect, it } from 'vitest'
import type { RuntimeLogging } from '@pluxel/core/logging'
import { logtape } from '@pluxel/core/config'
import { createRuntimeLogging } from '../../src/logging/internal'

let manager: RuntimeLogging | undefined
afterEach(async () => {
	await manager?.dispose()
	manager = undefined
	if (getConfig()) await reset()
})

it('preserves native contexts, filter inheritance, forward sinks and source capture for application categories', async () => {
	const parent: LogRecord[] = []
	const child: LogRecord[] = []
	const storage = new AsyncLocalStorage<Record<string, unknown>>()
	const tenant = (record: LogRecord) => record.properties.tenant === 'blue'
	const config: Config<string, string> = {
		contextLocalStorage: storage,
		sinks: { parent: (record) => parent.push(record), child: (record) => child.push(record) },
		filters: { deny: () => false, tenant, debug: 'debug' },
		loggers: [
			{ category: [], filters: ['deny'] },
			{ category: 'application', sinks: ['parent'], lowestLevel: 'fatal' },
			{
				category: ['application', 'child'],
				sinks: ['child'],
				parentSinks: 'forward',
				lowestLevel: 'debug',
				filters: ['tenant', 'debug'],
				captureSourceLocation: true,
			},
			{ category: ['application', 'child', 'leaf'], filters: [] },
			{ category: ['logtape', 'meta'], lowestLevel: null },
		],
	}
	manager = createRuntimeLogging(config)
	await manager.install()
	expect(getConfig()?.contextLocalStorage).toBe(storage)
	expect(getConfig()?.sinks).toBe(config.sinks)
	expect(getConfig()?.filters?.tenant).toBe(tenant)
	expect(config.loggers[0]?.filters).toEqual(['deny'])
	expect(config.loggers[2]?.filters).toEqual(['tenant', 'debug'])
	await withContext({ tenant: 'blue' }, async () => {
		await Promise.resolve()
		getLogger(['application', 'child', 'leaf']).debug('forwarded')
	})
	getLogger(['application', 'child', 'leaf']).debug('tenant rejected')
	getLogger('application').fatal('ancestor filter rejected')
	expect(parent.map((record) => record.message.join(''))).toEqual(['forwarded'])
	expect(child).toEqual(parent)
	expect(child[0]?.properties).toMatchObject({ tenant: 'blue' })
	expect(
		getConfig()?.loggers.find(
			(logger) => Array.isArray(logger.category) && logger.category[1] === 'child',
		)?.captureSourceLocation,
	).toBe(true)
})

it('captures native source locations in a fresh Node process', async () => {
	// Vitest's evaluated module frames are intentionally rejected by LogTape's stack parser.
	const child = await promisify(execFile)(
		process.execPath,
		[
			'--import',
			import.meta.resolve('tsx'),
			'--input-type=module',
			'-e',
			`
import assert from 'node:assert/strict';
import { getLogger } from ${JSON.stringify(import.meta.resolve('@logtape/logtape'))};
import { createRuntimeLogging } from ${JSON.stringify(new URL('../../src/logging/logging.ts', import.meta.url).href)};
const records = [];
const manager = createRuntimeLogging({sinks:{output:record=>records.push(record)},loggers:[{category:'application',sinks:['output'],captureSourceLocation:true},{category:['logtape','meta'],lowestLevel:null}]});
await manager.install();
try {
 getLogger('application').info('source location');
 assert.ok(records[0].sourceLocation);
 console.log('NATIVE_SOURCE_CAPTURED');
} finally { await manager.dispose(); }
`,
		],
		{ timeout: 15000 },
	)
	expect(child.stdout).toContain('NATIVE_SOURCE_CAPTURED')
})

it('runs the Pluxel guard before explicit native filters and lazy fields', async () => {
	let filterCalls = 0
	let propertyReads = 0
	const records: LogRecord[] = []
	manager = createRuntimeLogging({
		sinks: { output: (record) => records.push(record) },
		filters: {
			user: () => {
				filterCalls++
				return true
			},
		},
		loggers: [
			{ category: ['pluxel'], sinks: ['output'], filters: ['user'] },
			{ category: ['pluxel', 'runtime', 'foreign'], filters: ['user'], parentSinks: 'forward' },
			{ category: ['logtape', 'meta'], lowestLevel: null },
		],
	})
	await manager.install()
	getLogger(['pluxel', 'runtime', 'foreign']).info('rejected', {
		secret: lazy(() => {
			propertyReads++
			return 'never read'
		}),
	})
	expect(records).toHaveLength(0)
	expect(filterCalls).toBe(0)
	expect(propertyReads).toBe(0)
	expect(manager.describe().diagnostics.wrongRootRecords).toBe(1)
	getLogger(['pluxel', 'runtime', manager.resolved.root.id]).info('accepted')
	expect(records).toHaveLength(1)
	expect(filterCalls).toBe(1)
})

it('retains native drain and asynchronous disposal with shared resource identities', async () => {
	const disposed: string[] = []
	let drains = 0
	const sink: Sink & AsyncDisposable & { drain(): Promise<void> } = Object.assign(() => {}, {
		async drain() {
			drains++
		},
		async [Symbol.asyncDispose]() {
			await Promise.resolve()
			disposed.push('sink')
		},
	})
	const filter = Object.assign(() => true, {
		async [Symbol.asyncDispose]() {
			await Promise.resolve()
			disposed.push('filter')
		},
	})
	manager = createRuntimeLogging({
		sinks: { first: sink, second: sink },
		filters: { first: filter, second: filter },
		loggers: [
			{ category: 'application', sinks: ['first'], filters: ['first'] },
			{ category: ['logtape', 'meta'], lowestLevel: null },
		],
	})
	await manager.install()
	await manager.flush()
	expect(drains).toBe(1)
	expect(disposed).toEqual([])
	await Promise.all([manager.dispose(), manager.dispose()])
	expect(drains).toBe(2)
	expect(disposed.sort()).toEqual(['filter', 'sink'])
	expect(getConfig()).toBeNull()
})

it('still disposes every installed resource when native drain fails', async () => {
	const failure = new Error('sink drain failed')
	let disposed = false
	const sink = Object.assign(() => {}, {
		async drain() {
			throw failure
		},
		async [Symbol.asyncDispose]() {
			disposed = true
		},
	})
	manager = createRuntimeLogging({ sinks: { output: sink }, loggers: [] })
	await manager.install()
	const closing = manager.dispose()
	manager = undefined
	await expect(closing).rejects.toBe(failure)
	expect(disposed).toBe(true)
	expect(getConfig()).toBeNull()
})

it('leaves a foreign configuration untouched on rejected install or external replacement', async () => {
	const foreign: Config<string, string> = { sinks: {}, loggers: [] }
	await configure(foreign)
	manager = createRuntimeLogging({ sinks: {}, loggers: [], reset: true })
	await expect(manager.install()).rejects.toThrow('foreign owner')
	await manager.dispose()
	expect(getConfig()).toBe(foreign)
	await reset()
	manager = createRuntimeLogging({ sinks: {}, loggers: [] })
	await manager.install()
	await configure({ ...foreign, reset: true })
	const replaced = getConfig()
	await expect(manager.flush()).rejects.toThrow('configuration changed outside its Host owner')
	expect(getConfig()).toBe(replaced)
	const closing = manager.dispose()
	manager = undefined
	await expect(closing).rejects.toThrow('refusing to reset another configuration')
	expect(getConfig()).toBe(replaced)
})

it('preserves native configuration errors and rejects reset:true without silent coercion', async () => {
	manager = createRuntimeLogging({
		sinks: {},
		loggers: [{ category: 'application', sinks: ['missing'] }],
	})
	await expect(manager.install()).rejects.toBeInstanceOf(ConfigError)
	await manager.dispose()
	manager = createRuntimeLogging({ sinks: {}, loggers: [], reset: true })
	await expect(manager.install()).rejects.toThrow('reset:true is not allowed')
})

it('evaluates the bounded-store factory at preparation and prevents later sink creation', async () => {
	let factories = 0
	let lateCreate: (() => Sink) | undefined
	const descriptor = logtape(({ createRuntimeLogSink }) => {
		factories++
		lateCreate = createRuntimeLogSink
		return {
			sinks: { memory: createRuntimeLogSink({ bufferSize: 1 }) },
			loggers: [
				{ category: ['pluxel'], sinks: ['memory'] },
				{ category: ['logtape', 'meta'], lowestLevel: null },
			],
		}
	})
	expect(factories).toBe(0)
	const host = await createHost({ plugins: [], runtime: { logtape: descriptor }, services: [] })
	try {
		expect(factories).toBe(1)
		expect(() => lateCreate!()).toThrow('during logging configuration')
		host.ctx.logger.info('stored natively')
		expect(host.ctx.logging!.stores.get('default')?.tailWindow(1)[0]?.msg).toBe('stored natively')
	} finally {
		await host.close()
	}
})

it('waits for native installation before closing and retains ownership through async disposal', async () => {
	let releaseResource!: () => void
	const held = new Promise<void>((resolve) => {
		releaseResource = resolve
	})
	let resourceDisposing!: () => void
	const started = new Promise<void>((resolve) => {
		resourceDisposing = resolve
	})
	let disposals = 0
	const sink = Object.assign((_record: LogRecord): void => undefined, {
		async [Symbol.asyncDispose](): Promise<void> {
			disposals++
			resourceDisposing()
			await held
		},
	})
	manager = createRuntimeLogging({ sinks: { output: sink }, loggers: [] })
	const opening = manager.install()
	const closing = manager.dispose()
	try {
		await opening
		expect(manager.state).toBe('disposing')
		expect(() => manager!.install()).toThrow('state: disposing')
		expect(manager.dispose()).toBe(closing)
		await started
		const contender = createRuntimeLogging({ sinks: {}, loggers: [] })
		await expect(contender.install()).rejects.toThrow('already owns this process')
		await contender.dispose()
		expect(disposals).toBe(1)
	} finally {
		releaseResource()
		await closing
	}
	expect(manager.state).toBe('disposed')
	expect(() => manager!.install()).toThrow('state: disposed')
	expect(getConfig()).toBeNull()
	expect(disposals).toBe(1)
	manager = createRuntimeLogging({ sinks: {}, loggers: [] })
	await manager.install()
})

it('validates the options object before separating framework policy settings', () => {
	const invalidOptions: unknown[] = [null, 1, false, '', []]
	for (const options of invalidOptions) {
		expect(() => logtape({ sinks: {}, loggers: [] }, options as never)).toThrow(
			'options must be an object',
		)
	}
})

it('waits for installation when a synchronous native config factory closes reentrantly', async () => {
	let closing: Promise<void> | undefined
	let disposals = 0
	const sink = Object.assign((_record: LogRecord): void => undefined, {
		[Symbol.dispose](): void {
			disposals++
		},
	})
	manager = createRuntimeLogging(() => {
		closing = manager!.dispose()
		return { sinks: { output: sink }, loggers: [] }
	})
	await manager.install()
	expect(closing).toBeDefined()
	await closing
	expect(manager.state).toBe('disposed')
	expect(getConfig()).toBeNull()
	expect(disposals).toBe(1)
})
