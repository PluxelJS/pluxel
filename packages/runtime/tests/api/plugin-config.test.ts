import { pluginNodeAddressOf } from '@pluxel/core'
import { requireConfigService } from '@pluxel/core/internal'
import {
	BasePlugin,
	createRuntimeContext,
	createRuntimeHost,
	Plugin,
	type RuntimeHost,
} from '@pluxel/runtime/test'
import { afterEach, describe, expect, it } from 'vitest'
import { SuperJSON } from 'superjson'
import { v } from '../../src/config'
import { pluginConfigPatch, pluginConfigPatchField } from '../../src/api/usecases/pluginConfig'
import { removeFork } from '../../src/api/usecases/pluginForks'
import {
	createMemoryPersistenceBackend,
	type PersistenceBackend,
} from '../../src/services/persistence/PersistenceService'
import { lowerTestPlugin } from '../helpers/lowered-plugin'

const ConfigSchema = v.object({
	value: v.optional(v.string(), 'initial'),
})

let defaultStarts: string[] = []
let forkStarts = new Map<string, string[]>()
let failingStarts = 0
let singleValidationRuns = 0
let singleValidationStarts: string[] = []

const SingleValidationSchema = v.object({
	value: v.pipe(
		v.string(),
		v.transform((value) => {
			singleValidationRuns++
			if (singleValidationRuns > 1) throw new Error('schema executed twice')
			return `${value}:validated`
		}),
	),
})

@Plugin()
class ConfigOwner extends BasePlugin {
	readonly config = this.configs.use(ConfigSchema)

	override init() {
		defaultStarts.push(this.config.value)
	}
}

@Plugin({ forkable: true })
class ConfigFork extends BasePlugin {
	readonly config = this.configs.use(ConfigSchema)

	override init() {
		const address = this.ctx.pluginInfo.nodeAddress
		const key = address.variant === 'fork' ? address.forkId : 'default'
		const values = forkStarts.get(key) ?? []
		values.push(this.config.value)
		forkStarts.set(key, values)
	}
}

@Plugin()
class StoppedConfigOwner extends BasePlugin {
	readonly config = this.configs.use(ConfigSchema)
}

@Plugin()
class FailingConfigOwner extends BasePlugin {
	readonly config = this.configs.use(ConfigSchema)

	override init() {
		failingStarts++
		if (failingStarts > 1) throw new Error('restart rejected')
	}
}

@Plugin()
class SingleValidationOwner extends BasePlugin {
	readonly config = this.configs.use(SingleValidationSchema)

	override init() {
		singleValidationStarts.push(this.config.value)
	}
}

const hosts: RuntimeHost[] = []

afterEach(async () => {
	for (const host of hosts.splice(0)) await host.dispose()
	defaultStarts = []
	forkStarts = new Map()
	failingStarts = 0
	singleValidationRuns = 0
	singleValidationStarts = []
})

describe('Plugin config application scope', () => {
	it('serializes a config patch requested during fork removal after final durable removal', async () => {
		const host = runtimeHost()
		const fork = host.fork(ConfigFork, 'exclusive-remove')
		host.cfg(fork).enable()
		await host.commit()
		const configService = requireConfigService(host.ctx)
		const originalFlush = configService.flush.bind(configService)
		const entered = deferred<void>()
		const release = deferred<void>()
		let flushes = 0
		configService.flush = async (options) => {
			if (++flushes === 1) {
				entered.resolve()
				await release.promise
			}
			await originalFlush(options)
		}

		const removal = removeFork(
			host.ctx,
			{ definition: fork.definition, variant: 'default' },
			'exclusive-remove',
		)
		await entered.promise
		const patch = pluginConfigPatch(host.ctx, fork, { value: 'too-late' })
		release.resolve()

		await expect(removal).resolves.toMatchObject({ ok: true, status: 'removed' })
		await expect(patch).resolves.toMatchObject({ ok: false, code: 'node_unavailable' })
		expect(configService.getRawConfig(fork)).toEqual({})
	})

	it('keeps catalog replacement outside config validation, persistence, and restart', async () => {
		const host = runtimeHost()
		host.add(ConfigOwner)
		host.cfg(ConfigOwner).enable()
		await host.commit()
		const owner = pluginNodeAddressOf(ConfigOwner)
		const configService = requireConfigService(host.ctx)
		const originalFlush = configService.flush.bind(configService)
		const entered = deferred<void>()
		const release = deferred<void>()
		let flushes = 0
		configService.flush = async (options) => {
			if (++flushes === 1) {
				entered.resolve()
				await release.promise
			}
			await originalFlush(options)
		}

		const patch = pluginConfigPatch(host.ctx, owner, { value: 'before-unlink' })
		await entered.promise
		host.remove(ConfigOwner)
		const unlink = host.commit()
		release.resolve()

		await expect(patch).resolves.toMatchObject({ ok: true, application: 'applied' })
		await unlink
		expect(host.isRunning(ConfigOwner)).toBe(false)
		expect(configService.getRawConfig(owner)).toEqual({ value: 'before-unlink' })
	})

	it('durably saves and restarts one running default node', async () => {
		const host = runtimeHost()
		host.add(ConfigOwner)
		host.cfg(ConfigOwner).enable()
		await host.commit()

		const owner = pluginNodeAddressOf(ConfigOwner)
		await expect(pluginConfigPatch(host.ctx, owner, { value: 'changed' })).resolves.toMatchObject({
			ok: true,
			saved: true,
			application: 'applied',
			report: { core: { status: 'committed' } },
			config: { value: 'changed' },
		})
		expect(defaultStarts).toEqual(['initial', 'changed'])
	})

	it('restarts only the addressed fork and keeps sibling config isolated', async () => {
		const host = runtimeHost()
		const East = host.fork(ConfigFork, 'east')
		const West = host.fork(ConfigFork, 'west')
		host.cfg(East).enable()
		host.cfg(West).enable()
		await host.commit()

		const east = East
		const west = West
		await expect(pluginConfigPatch(host.ctx, east, { value: 'east-only' })).resolves.toMatchObject({
			ok: true,
			application: 'applied',
		})

		expect(forkStarts.get('east')).toEqual(['initial', 'east-only'])
		expect(forkStarts.get('west')).toEqual(['initial'])
		const configService = requireConfigService(host.ctx)
		expect(configService.getRawConfig(east)).toEqual({
			value: 'east-only',
		})
		expect(configService.getRawConfig(west)).toEqual({
			value: 'initial',
		})
	})

	it('defers application for a stopped node', async () => {
		const host = runtimeHost()
		host.add(StoppedConfigOwner)
		await host.commit()

		const owner = pluginNodeAddressOf(StoppedConfigOwner)
		await expect(pluginConfigPatch(host.ctx, owner, { value: 'later' })).resolves.toMatchObject({
			ok: true,
			saved: true,
			application: 'deferred',
			report: {},
			config: { value: 'later' },
		})
		expect(host.isRunning(StoppedConfigOwner)).toBe(false)
	})

	it('keeps desired config after a restart failure and reports it as not applied', async () => {
		const host = runtimeHost()
		host.add(FailingConfigOwner)
		host.cfg(FailingConfigOwner).enable()
		await host.commit()

		const owner = pluginNodeAddressOf(FailingConfigOwner)
		await expect(pluginConfigPatch(host.ctx, owner, { value: 'desired' })).resolves.toMatchObject({
			ok: true,
			saved: true,
			application: 'saved-not-applied',
			report: {
				core: { status: 'committed', summary: { lifecycleReport: { ok: false } } },
			},
			applyFailure: { code: 'plugin_not_running_after_restart' },
			config: { value: 'desired' },
		})
		expect(requireConfigService(host.ctx).getRawConfig(owner)).toEqual({
			value: 'desired',
		})
		expect(host.isRunning(FailingConfigOwner)).toBe(false)
	})

	it('reuses one pre-persistence validation output when restarting a running node', async () => {
		const host = runtimeHost()
		host.add(SingleValidationOwner)
		host.cfg(SingleValidationOwner).set({ value: 'initial' })
		host.cfg(SingleValidationOwner).enable()
		await host.commit()
		expect(host.isRunning(SingleValidationOwner)).toBe(true)
		expect(singleValidationStarts).toEqual(['initial:validated'])
		singleValidationRuns = 0

		const owner = pluginNodeAddressOf(SingleValidationOwner)
		await expect(pluginConfigPatch(host.ctx, owner, { value: 'desired' })).resolves.toMatchObject({
			ok: true,
			saved: true,
			application: 'applied',
			config: { value: 'desired:validated' },
		})
		expect(singleValidationRuns).toBe(1)
		expect(singleValidationStarts).toEqual(['initial:validated', 'desired:validated'])
		expect(requireConfigService(host.ctx).getRawConfig(owner)).toEqual({
			value: 'desired:validated',
		})
	})

	it('rejects dangerous field paths without mutating object prototypes', async () => {
		const host = runtimeHost()
		host.add(StoppedConfigOwner)
		await host.commit()
		const owner = pluginNodeAddressOf(StoppedConfigOwner)
		const pollutionKey = '__pluxelPolluted'

		await expect(
			pluginConfigPatchField(host.ctx, owner, {
				fieldPath: `__proto__.${pollutionKey}`,
				value: true,
			}),
		).resolves.toMatchObject({
			ok: false,
			code: 'invalid_input',
			state: 'unchanged',
		})
		expect((Object.prototype as Record<string, unknown>)[pollutionKey]).toBeUndefined()
		expect(requireConfigService(host.ctx).getRawConfig(owner)).toEqual({})
	})
})

describe('ConfigService persistence', () => {
	it('reports a stable unknown persistence state without attempting application', async () => {
		const delegate = createMemoryPersistenceBackend()
		let rejectConfigWrite = false
		const backend: PersistenceBackend = {
			capability: delegate.capability,
			preflight: delegate.preflight,
			namespace(name) {
				const storage = delegate.namespace(name)
				return {
					...storage,
					async put(key, value, options) {
						if (rejectConfigWrite && name === 'config' && key === 'config.json') {
							throw new Error('config persistence outcome unknown')
						}
						await storage.put(key, value, options)
					},
				}
			},
		}
		const host = runtimeHost({
			persistence: { mode: 'custom', backend },
			configService: { mode: 'file' },
		})
		host.add(ConfigOwner)
		await host.commit()
		rejectConfigWrite = true

		await expect(
			pluginConfigPatch(host.ctx, pluginNodeAddressOf(ConfigOwner), { value: 'desired' }),
		).resolves.toMatchObject({
			ok: false,
			code: 'persistence_failed',
			state: 'unknown',
			config: { value: 'desired' },
		})
		host.cfg(ConfigOwner).enable()
		const unconfirmed = await host.commitAllowFail()
		expect(unconfirmed.lifecycleReport.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					phase: 'config',
					kind: 'config-failed',
					message: expect.stringMatching(/awaiting durable persistence/i),
				}),
			]),
		)
		expect(host.isRunning(ConfigOwner)).toBe(false)
	})

	it('loads existing config through a readonly backend and rejects mutation', async () => {
		const backend = createMemoryPersistenceBackend()
		const owner = pluginNodeAddressOf(ConfigOwner)
		const persisted = SuperJSON.stringify({
			version: 3,
			plugins: [{ owner, config: { value: 'persisted' } }],
		})
		await backend.namespace('config').put('config.json', persisted)
		const runtime = createRuntimeContext({
			persistence: { mode: 'readonly', backend },
			configService: { environment: false },
		})
		try {
			const configService = requireConfigService(runtime.ctx)
			await configService.ready
			expect(configService.getRawConfig(owner)).toEqual({ value: 'persisted' })
			expect(() => configService.patchConfig(owner, { value: 'changed' })).toThrow(/readonly mode/i)
			expect(await backend.namespace('config').getText('config.json')).toBe(persisted)
		} finally {
			await runtime.dispose()
		}
	})

	it('keeps the startup config snapshot when a readonly file is absent', async () => {
		const backend = createMemoryPersistenceBackend()
		const owner = pluginNodeAddressOf(ConfigOwner)
		const runtime = createRuntimeContext({
			persistence: { mode: 'readonly', backend },
			configService: {
				environment: false,
				snapshot: { plugins: [{ owner, config: { value: 'startup' } }] },
			},
		})
		try {
			const configService = requireConfigService(runtime.ctx)
			await configService.ready
			expect(configService.getRawConfig(owner)).toEqual({ value: 'startup' })
			expect(await backend.namespace('config').stat('config.json')).toBeUndefined()
		} finally {
			await runtime.dispose()
		}
	})

	it.each([
		['malformed', '{'],
		['unsupported version', SuperJSON.stringify({ version: 2, plugins: [] })],
	])('fails fast on %s readonly config without isolating or rewriting it', async (_case, text) => {
		const backend = createMemoryPersistenceBackend()
		await backend.namespace('config').put('config.json', text)
		const runtime = createRuntimeContext({
			persistence: { mode: 'readonly', backend },
			configService: { environment: false },
		})
		try {
			await expect(requireConfigService(runtime.ctx).ready).rejects.toThrow(/ConfigService/)
			expect(await backend.namespace('config').getText('config.json')).toBe(text)
			const keys: string[] = []
			for await (const entry of backend.namespace('config').list()) keys.push(entry.key)
			expect(keys).toEqual(['config.json'])
		} finally {
			await runtime.dispose()
		}
	})

	it('uses atomic writes, surfaces failure, and retries the desired snapshot', async () => {
		const delegate = createMemoryPersistenceBackend()
		const writes: Array<{ namespace: string; key: string; atomic: boolean }> = []
		let rejectConfigWrite = false
		const backend: PersistenceBackend = {
			capability: delegate.capability,
			preflight: delegate.preflight,
			namespace(name) {
				const storage = delegate.namespace(name)
				return {
					...storage,
					async put(key, value, options) {
						writes.push({ namespace: name, key, atomic: options?.atomic === true })
						if (rejectConfigWrite && name === 'config' && key === 'config.json') {
							throw new Error('config storage unavailable')
						}
						await storage.put(key, value, options)
					},
				}
			},
		}
		const host = runtimeHost({
			persistence: { mode: 'custom', backend },
			configService: { mode: 'file' },
		})
		const configService = requireConfigService(host.ctx)
		await configService.ready
		writes.length = 0

		@Plugin()
		class PersistedConfigOwner extends BasePlugin {}

		lowerTestPlugin(PersistedConfigOwner)
		const owner = pluginNodeAddressOf(PersistedConfigOwner)
		configService.patchConfig(owner, { value: 'desired' })
		rejectConfigWrite = true

		await expect(configService.flush()).rejects.toThrow('config storage unavailable')
		expect(writes).toEqual([{ namespace: 'config', key: 'config.json', atomic: true }])

		rejectConfigWrite = false
		await configService.flush()
		expect(writes.at(-1)).toEqual({
			namespace: 'config',
			key: 'config.json',
			atomic: true,
		})
	})
})

function runtimeHost(config: Parameters<typeof createRuntimeHost>[0] = {}): RuntimeHost {
	const host = createRuntimeHost({ workbench: false, ...config })
	hosts.push(host)
	return host
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}
