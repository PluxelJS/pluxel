import { pluginNodeAddressOf } from '@pluxel/core'
import {
	notifyRunningPluginConfigUpdate,
	requireConfigService,
	requirePluginService,
} from '@pluxel/core/internal'
import {
	BasePlugin,
	createRuntimeContext,
	createRuntimeHost,
	Plugin,
	PluginPart,
	type RuntimeHost,
} from '@pluxel/runtime/test'
import { afterEach, describe, expect, it } from 'vitest'
import { SuperJSON } from 'superjson'
import { v } from '../../src/config'
import {
	pluginConfigGet,
	pluginConfigPatch,
	pluginConfigPatchField,
} from '../../src/api/usecases/pluginConfig'
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
let defaultUpdates: Array<{ applied: string; desired: string }> = []
let forkUpdates = new Map<string, string[]>()
let failingStarts = 0
let singleValidationRuns = 0
let singleValidationStarts: string[] = []
let retryAttempts: Array<{ applied: string; desired: string }> = []
let concurrentOwnerConfig: Readonly<{ value: string }> | undefined
let concurrentOwnerReady = deferred<void>()
let concurrentBorrowerDone = deferred<void>()
let crossOwnerRegistrationError: unknown
let withdrawalListenerEntered = deferred<void>()
let withdrawalListenerAborted = deferred<void>()

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

const PartSchema = v.object({ value: v.optional(v.string(), 'part-initial') })
const PartOwnerSchema = v.object({ value: v.optional(v.string(), 'root-initial') })

let partUpdateOrder: string[] = []

class ConfigUpdatePart extends PluginPart<ConfigPartOwner> {
	readonly config = this.configs.use(PartSchema)
	runtimeValue = ''

	override init() {
		this.runtimeValue = this.config.value
		this.configs.onUpdate(this.config, ({ desired }) => {
			partUpdateOrder.push('part')
			this.runtimeValue = desired.value
		})
	}
}

@Plugin()
class ConfigPartOwner extends BasePlugin {
	readonly part = this.parts.use(ConfigUpdatePart)
	readonly config = this.configs.use(PartOwnerSchema)
	runtimeValue = ''

	override init() {
		this.runtimeValue = this.config.value
		this.configs.onUpdate(this.config, ({ desired }) => {
			partUpdateOrder.push('root')
			this.runtimeValue = desired.value
		})
	}
}

let incompleteRootNotifications = 0

class ConfigWithoutPartListener extends PluginPart<IncompleteConfigOwner> {
	readonly config = this.configs.use(PartSchema)
}

@Plugin()
class IncompleteConfigOwner extends BasePlugin {
	readonly part = this.parts.use(ConfigWithoutPartListener)
	readonly config = this.configs.use(PartOwnerSchema)

	override init() {
		this.configs.onUpdate(this.config, () => {
			incompleteRootNotifications++
		})
	}
}

let partialPartRuntimeValue = 'part-initial'

class PartiallyAppliedPart extends PluginPart<PartiallyAppliedOwner> {
	readonly config = this.configs.use(PartSchema)

	override init() {
		this.configs.onUpdate(this.config, ({ desired }) => {
			partialPartRuntimeValue = desired.value
		})
	}
}

@Plugin()
class PartiallyAppliedOwner extends BasePlugin {
	readonly part = this.parts.use(PartiallyAppliedPart)
	readonly config = this.configs.use(PartOwnerSchema)

	override init() {
		this.configs.onUpdate(this.config, () => {
			throw new Error('root listener rejected')
		})
	}
}

@Plugin()
class ConfigOwner extends BasePlugin {
	readonly config = this.configs.use(ConfigSchema)
	runtimeValue = ''

	override init() {
		defaultStarts.push(this.config.value)
		this.runtimeValue = this.config.value
		this.configs.onUpdate(this.config, ({ applied, desired }) => {
			defaultUpdates.push({ applied: applied.value, desired: desired.value })
			this.runtimeValue = desired.value
		})
	}

	registerLate() {
		this.configs.onUpdate(this.config, () => {})
	}

	registerForged() {
		this.configs.onUpdate({ value: this.config.value }, () => {})
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
		this.configs.onUpdate(this.config, ({ desired }) => {
			const updates = forkUpdates.get(key) ?? []
			updates.push(desired.value)
			forkUpdates.set(key, updates)
		})
	}
}

@Plugin()
class StoppedConfigOwner extends BasePlugin {
	readonly config = this.configs.use(ConfigSchema)
}

@Plugin()
class ConfigWithoutListener extends BasePlugin {
	readonly config = this.configs.use(ConfigSchema)
}

@Plugin()
class FailingConfigOwner extends BasePlugin {
	readonly config = this.configs.use(ConfigSchema)

	override init() {
		failingStarts++
		this.configs.onUpdate(this.config, () => {
			throw new Error('listener rejected')
		})
	}
}

@Plugin()
class SingleValidationOwner extends BasePlugin {
	readonly config = this.configs.use(SingleValidationSchema)

	override init() {
		singleValidationStarts.push(this.config.value)
		this.configs.onUpdate(this.config, ({ desired }) => {
			singleValidationStarts.push(desired.value)
		})
	}
}

@Plugin()
class RetryConfigOwner extends BasePlugin {
	readonly config = this.configs.use(ConfigSchema)

	override init() {
		this.configs.onUpdate(this.config, ({ applied, desired }) => {
			retryAttempts.push({ applied: applied.value, desired: desired.value })
			if (desired.value === 'reject') throw new Error('reject this revision')
		})
	}
}

@Plugin()
class DuplicateConfigListenerOwner extends BasePlugin {
	readonly config = this.configs.use(ConfigSchema)

	override init() {
		this.configs.onUpdate(this.config, () => {})
		this.configs.onUpdate(this.config, () => {})
	}
}

@Plugin()
class ConcurrentConfigOwner extends BasePlugin {
	readonly config = this.configs.use(ConfigSchema)

	override async init() {
		concurrentOwnerConfig = this.config
		concurrentOwnerReady.resolve()
		await concurrentBorrowerDone.promise
		this.configs.onUpdate(this.config, () => {})
	}
}

@Plugin()
class ConcurrentConfigBorrower extends BasePlugin {
	readonly config = this.configs.use(ConfigSchema)

	override async init() {
		await concurrentOwnerReady.promise
		try {
			this.configs.onUpdate(concurrentOwnerConfig!, () => {})
		} catch (error) {
			crossOwnerRegistrationError = error
		} finally {
			concurrentBorrowerDone.resolve()
		}
		this.configs.onUpdate(this.config, () => {})
	}
}

@Plugin()
class WithdrawnConfigOwner extends BasePlugin {
	readonly config = this.configs.use(ConfigSchema)

	override init() {
		this.configs.onUpdate(this.config, async ({ signal }) => {
			withdrawalListenerEntered.resolve()
			if (!signal.aborted) {
				await new Promise<void>((resolve) => {
					signal.addEventListener('abort', () => resolve(), { once: true })
				})
			}
			withdrawalListenerAborted.resolve()
		})
	}
}

const hosts: RuntimeHost[] = []

afterEach(async () => {
	for (const host of hosts.splice(0)) await host.dispose()
	defaultStarts = []
	forkStarts = new Map()
	defaultUpdates = []
	forkUpdates = new Map()
	failingStarts = 0
	singleValidationRuns = 0
	singleValidationStarts = []
	partUpdateOrder = []
	incompleteRootNotifications = 0
	partialPartRuntimeValue = 'part-initial'
	retryAttempts = []
	concurrentOwnerConfig = undefined
	concurrentOwnerReady = deferred<void>()
	concurrentBorrowerDone = deferred<void>()
	crossOwnerRegistrationError = undefined
	withdrawalListenerEntered = deferred<void>()
	withdrawalListenerAborted = deferred<void>()
})

describe('Plugin config application scope', () => {
	it('serializes a config patch requested during fork removal after final durable removal', async () => {
		const host = runtimeHost()
		const fork = host.fork(ConfigFork, 'exclusive-remove')
		host.cfg(fork).setAutoStart(true)
		host.start(fork)
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
		host.cfg(ConfigOwner).setAutoStart(true)
		host.start(ConfigOwner)
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

	it('durably saves and notifies one running default generation', async () => {
		const host = runtimeHost()
		host.add(ConfigOwner)
		host.cfg(ConfigOwner).setAutoStart(true)
		host.start(ConfigOwner)
		await host.commit()

		const owner = pluginNodeAddressOf(ConfigOwner)
		const generation = host.require(ConfigOwner)
		const result = await pluginConfigPatch(host.ctx, owner, { value: 'changed' })
		expect(result).toMatchObject({
			ok: true,
			saved: true,
			application: 'applied',
			report: { core: { status: 'unchanged' } },
			config: { value: 'changed' },
		})
		if (!result.ok) throw new Error(result.message)
		expect(result.appliedRevision).toBe(result.desiredRevision)
		expect(host.require(ConfigOwner)).toBe(generation)
		expect(defaultStarts).toEqual(['initial'])
		expect(defaultUpdates).toEqual([{ applied: 'initial', desired: 'changed' }])
		expect(generation.runtimeValue).toBe('changed')
		expect(generation.config.value).toBe('changed')
	})

	it('reports a successfully started generation as the applied desired revision', async () => {
		const host = runtimeHost()
		host.add(ConfigOwner)
		host.cfg(ConfigOwner).setAutoStart(true)
		host.start(ConfigOwner)
		await host.commit()

		const result = await pluginConfigGet(host.ctx, pluginNodeAddressOf(ConfigOwner))
		expect(result).toMatchObject({ ok: true, saved: false, application: 'applied' })
		if (!result.ok) throw new Error(result.message)
		expect(result.appliedRevision).toBe(result.desiredRevision)
	})

	it('notifies only the addressed fork and keeps sibling config isolated', async () => {
		const host = runtimeHost()
		const East = host.fork(ConfigFork, 'east')
		const West = host.fork(ConfigFork, 'west')
		host.cfg(East).setAutoStart(true)
		host.start(East)
		host.cfg(West).setAutoStart(true)
		host.start(West)
		await host.commit()

		const east = East
		const west = West
		await expect(pluginConfigPatch(host.ctx, east, { value: 'east-only' })).resolves.toMatchObject({
			ok: true,
			application: 'applied',
		})

		expect(forkStarts.get('east')).toEqual(['initial'])
		expect(forkStarts.get('west')).toEqual(['initial'])
		expect(forkUpdates.get('east')).toEqual(['east-only'])
		expect(forkUpdates.get('west')).toBeUndefined()
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
			appliedRevision: null,
			report: {},
			config: { value: 'later' },
		})
		expect(host.isRunning(StoppedConfigOwner)).toBe(false)
	})

	it('keeps desired config after a listener failure and reports it as not applied', async () => {
		const host = runtimeHost()
		host.add(FailingConfigOwner)
		host.cfg(FailingConfigOwner).setAutoStart(true)
		host.start(FailingConfigOwner)
		await host.commit()

		const owner = pluginNodeAddressOf(FailingConfigOwner)
		const appliedBefore = requireConfigService(host.ctx).getAppliedConfigRevision(owner)
		await expect(pluginConfigPatch(host.ctx, owner, { value: 'desired' })).resolves.toMatchObject({
			ok: true,
			saved: true,
			application: 'saved-not-applied',
			appliedRevision: appliedBefore,
			report: { core: { status: 'unchanged' } },
			applyFailure: { code: 'listener_failed' },
			config: { value: 'desired' },
		})
		expect(requireConfigService(host.ctx).getRawConfig(owner)).toEqual({
			value: 'desired',
		})
		expect(host.isRunning(FailingConfigOwner)).toBe(true)
		expect(failingStarts).toBe(1)
	})

	it('saves without notifying when a running declaration has no listener', async () => {
		const host = runtimeHost()
		host.add(ConfigWithoutListener)
		host.cfg(ConfigWithoutListener).setAutoStart(true)
		host.start(ConfigWithoutListener)
		await host.commit()
		const owner = pluginNodeAddressOf(ConfigWithoutListener)
		const generation = host.require(ConfigWithoutListener)
		const appliedBefore = requireConfigService(host.ctx).getAppliedConfigRevision(owner)

		await expect(pluginConfigPatch(host.ctx, owner, { value: 'desired' })).resolves.toMatchObject({
			ok: true,
			saved: true,
			application: 'saved-not-applied',
			appliedRevision: appliedBefore,
			applyFailure: { code: 'listener_not_registered' },
		})
		expect(host.require(ConfigWithoutListener)).toBe(generation)
		expect(generation.config.value).toBe('initial')
		expect(host.isRunning(ConfigWithoutListener)).toBe(true)
	})

	it('notifies nested Part declarations before the owner and advances one revision', async () => {
		const host = runtimeHost()
		host.add(ConfigPartOwner)
		host.cfg(ConfigPartOwner).setAutoStart(true)
		host.start(ConfigPartOwner)
		await host.commit()
		const owner = pluginNodeAddressOf(ConfigPartOwner)
		const generation = host.require(ConfigPartOwner)

		const result = await pluginConfigPatch(host.ctx, owner, {
			value: 'root-desired',
			part: { value: 'part-desired' },
		})
		expect(result).toMatchObject({ ok: true, application: 'applied' })
		if (!result.ok) throw new Error(result.message)
		expect(result.appliedRevision).toBe(result.desiredRevision)
		expect(host.require(ConfigPartOwner)).toBe(generation)
		expect(partUpdateOrder).toEqual(['part', 'root'])
		expect(generation.runtimeValue).toBe('root-desired')
		expect(generation.part.runtimeValue).toBe('part-desired')
		expect(generation.config.value).toBe('root-desired')
		expect(generation.part.config.value).toBe('part-desired')
	})

	it('does not notify any declaration when one changed Part has no listener', async () => {
		const host = runtimeHost()
		host.add(IncompleteConfigOwner)
		host.cfg(IncompleteConfigOwner).setAutoStart(true)
		host.start(IncompleteConfigOwner)
		await host.commit()
		const owner = pluginNodeAddressOf(IncompleteConfigOwner)
		const generation = host.require(IncompleteConfigOwner)

		await expect(
			pluginConfigPatch(host.ctx, owner, {
				value: 'root-desired',
				part: { value: 'part-desired' },
			}),
		).resolves.toMatchObject({
			ok: true,
			application: 'saved-not-applied',
			applyFailure: { code: 'listener_not_registered' },
		})
		expect(incompleteRootNotifications).toBe(0)
		expect(generation.config.value).toBe('root-initial')
		expect(generation.part.config.value).toBe('part-initial')
	})

	it('keeps framework fields unconfirmed while allowing earlier listener side effects', async () => {
		const host = runtimeHost()
		host.add(PartiallyAppliedOwner)
		host.cfg(PartiallyAppliedOwner).setAutoStart(true)
		host.start(PartiallyAppliedOwner)
		await host.commit()
		const owner = pluginNodeAddressOf(PartiallyAppliedOwner)
		const generation = host.require(PartiallyAppliedOwner)
		const appliedBefore = requireConfigService(host.ctx).getAppliedConfigRevision(owner)

		await expect(
			pluginConfigPatch(host.ctx, owner, {
				value: 'root-desired',
				part: { value: 'part-desired' },
			}),
		).resolves.toMatchObject({
			ok: true,
			application: 'saved-not-applied',
			appliedRevision: appliedBefore,
			applyFailure: { code: 'listener_failed' },
		})
		expect(partialPartRuntimeValue).toBe('part-desired')
		expect(generation.config.value).toBe('root-initial')
		expect(generation.part.config.value).toBe('part-initial')
	})

	it('rejects update listener registration outside init or with a forged object', async () => {
		const host = runtimeHost()
		host.add(ConfigOwner)
		host.cfg(ConfigOwner).setAutoStart(true)
		host.start(ConfigOwner)
		await host.commit()
		const generation = host.require(ConfigOwner)

		expect(() => generation.registerLate()).toThrow(/only available during the owner init/i)
		expect(() => generation.registerForged()).toThrow(/injected config field/i)
	})

	it('rejects cross-owner registration while independent init windows overlap', async () => {
		const host = runtimeHost({ plugins: { startConcurrency: 2 } })
		host.add([ConcurrentConfigOwner, ConcurrentConfigBorrower])
		host.cfg(ConcurrentConfigOwner).setAutoStart(true)
		host.start(ConcurrentConfigOwner)
		host.cfg(ConcurrentConfigBorrower).setAutoStart(true)
		host.start(ConcurrentConfigBorrower)
		await host.commit()

		expect(crossOwnerRegistrationError).toBeInstanceOf(Error)
		expect((crossOwnerRegistrationError as Error).message).toMatch(/another Plugin\/Part owner/i)
		expect(host.isRunning(ConcurrentConfigOwner)).toBe(true)
		expect(host.isRunning(ConcurrentConfigBorrower)).toBe(true)
		await expect(
			pluginConfigPatch(host.ctx, pluginNodeAddressOf(ConcurrentConfigOwner), {
				value: 'owner-update',
			}),
		).resolves.toMatchObject({ ok: true, application: 'applied' })
	})

	it('aborts an admitted listener and rejects its acknowledgement after replacement', async () => {
		const host = runtimeHost()
		host.add(WithdrawnConfigOwner)
		host.cfg(WithdrawnConfigOwner).setAutoStart(true)
		host.start(WithdrawnConfigOwner)
		await host.commit()
		const owner = pluginNodeAddressOf(WithdrawnConfigOwner)
		const generation = host.require(WithdrawnConfigOwner)
		const configService = requireConfigService(host.ctx)

		const notification = notifyRunningPluginConfigUpdate(
			requirePluginService(host.ctx),
			owner,
			Object.freeze({ value: 'unconfirmed' }),
			configService.getConfigRevision(owner),
		)
		await withdrawalListenerEntered.promise
		host.restart(WithdrawnConfigOwner)
		const replacement = host.commit()

		await withdrawalListenerAborted.promise
		await expect(notification).resolves.toEqual({ status: 'generation_changed' })
		await replacement
		expect(host.require(WithdrawnConfigOwner)).not.toBe(generation)
		expect(host.require(WithdrawnConfigOwner).config.value).toBe('initial')
		expect(configService.getAppliedConfigRevision(owner)).toBe(
			configService.getConfigRevision(owner),
		)
	})

	it('fails generation init on duplicate listener registration', async () => {
		const host = runtimeHost()
		host.add(DuplicateConfigListenerOwner)
		host.cfg(DuplicateConfigListenerOwner).setAutoStart(true)
		host.start(DuplicateConfigListenerOwner)
		const summary = await host.commitAllowFail()

		expect(host.isRunning(DuplicateConfigListenerOwner)).toBe(false)
		expect(summary.lifecycleReport.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					phase: 'start',
					message: expect.stringMatching(/already registered/i),
				}),
			]),
		)
	})

	it('retries from the last confirmed snapshot after an earlier listener failure', async () => {
		const host = runtimeHost()
		host.add(RetryConfigOwner)
		host.cfg(RetryConfigOwner).setAutoStart(true)
		host.start(RetryConfigOwner)
		await host.commit()
		const owner = pluginNodeAddressOf(RetryConfigOwner)
		const generation = host.require(RetryConfigOwner)

		await expect(pluginConfigPatch(host.ctx, owner, { value: 'reject' })).resolves.toMatchObject({
			ok: true,
			application: 'saved-not-applied',
			applyFailure: { code: 'listener_failed' },
		})
		await expect(pluginConfigPatch(host.ctx, owner, { value: 'accepted' })).resolves.toMatchObject({
			ok: true,
			application: 'applied',
		})
		expect(retryAttempts).toEqual([
			{ applied: 'initial', desired: 'reject' },
			{ applied: 'initial', desired: 'accepted' },
		])
		expect(generation.config.value).toBe('accepted')
	})

	it('confirms an equivalent normalized snapshot without invoking the listener', async () => {
		const host = runtimeHost()
		host.add(ConfigOwner)
		host.cfg(ConfigOwner).setAutoStart(true)
		host.start(ConfigOwner)
		await host.commit()
		const owner = pluginNodeAddressOf(ConfigOwner)

		const result = await pluginConfigPatch(host.ctx, owner, { value: 'initial' })
		expect(result).toMatchObject({ ok: true, application: 'applied' })
		if (!result.ok) throw new Error(result.message)
		expect(result.appliedRevision).toBe(result.desiredRevision)
		expect(defaultUpdates).toEqual([])
	})

	it('reuses one pre-persistence validation output when notifying a running node', async () => {
		const host = runtimeHost()
		host.add(SingleValidationOwner)
		host.cfg(SingleValidationOwner).set({ value: 'initial' })
		host.cfg(SingleValidationOwner).setAutoStart(true)
		host.start(SingleValidationOwner)
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
		host.cfg(ConfigOwner).setAutoStart(true)
		host.start(ConfigOwner)
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
