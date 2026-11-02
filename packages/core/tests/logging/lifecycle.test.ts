import { mkdtemp, rm } from 'node:fs/promises'
import * as nodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { configure, getConfig, reset, type Config, type LogRecord } from '@logtape/logtape'
import { BasePlugin, Plugin, type RootContext } from '@pluxel/core'
import { logtape, zenfs } from '@pluxel/core/config'
import { Passthrough } from '@pluxel/core/fs'
import { createCoreContextHost, prepareCoreContext } from '@pluxel/core/host'
import { requireHostDocuments } from '@pluxel/core/internal'
import {
	Logging,
	createPluginLogPolicyStore,
	parsePluginLogPolicySnapshot,
} from '@pluxel/core/logging'
import { createHost, defineHostService } from '@pluxel/host'
import { expect, it } from 'vitest'

@Plugin()
class LifecycleLogger extends BasePlugin {
	init() {
		this.ctx.logger.info('plugin init')
		this.ctx.effects.defer(() => this.ctx.logger.info('plugin runtime'), { phase: 'runtime' })
		this.ctx.effects.defer(() => this.ctx.logger.info('plugin final'), { phase: 'final' })
	}
}

it('prepares Core-only logging once and disposes its native resources with the root', async () => {
	let factories = 0
	let disposals = 0
	const records: LogRecord[] = []
	const sink = Object.assign((record: LogRecord) => records.push(record), {
		[Symbol.dispose]() {
			disposals++
		},
	})
	const shape = createCoreContextHost({
		logtape: logtape(() => {
			factories++
			void prepareCoreContext(root)
			return { sinks: { native: sink }, loggers: [{ category: ['pluxel'], sinks: ['native'] }] }
		}),
	})
	const root: RootContext = shape.createRoot()
	try {
		expect(root.require(Logging)).toBe(root.logging)
		expect(factories).toBe(0)
		expect(getConfig()).toBeNull()
		await Promise.all([prepareCoreContext(root), prepareCoreContext(root)])
		await prepareCoreContext(root)
		expect(factories).toBe(1)
		root.logger.info('Core-only prepared')
		expect(records.some((record) => record.message.join('') === 'Core-only prepared')).toBe(true)
	} finally {
		await root.effects.dispose()
	}
	expect(disposals).toBe(1)
	expect(getConfig()).toBeNull()
})

it.each(['resolved', 'rejected'] as const)(
	'waits for accepted Core-only policy preparation before closing (%s load)',
	async (outcome) => {
		let releaseLoad!: () => void
		const heldLoad = new Promise<void>((resolve) => {
			releaseLoad = resolve
		})
		let loadStarted!: () => void
		const pendingLoad = new Promise<void>((resolve) => {
			loadStarted = resolve
		})
		const failure = new Error('policy load rejected during close')
		let disposals = 0
		const sink = Object.assign((_record: LogRecord): void => undefined, {
			[Symbol.dispose]() {
				disposals++
			},
		})
		const root = createCoreContextHost({
			logtape: logtape(
				{ sinks: { native: sink }, loggers: [] },
				{
					policyLoadFailure: 'fail',
					policyStore: () => ({
						async load() {
							loadStarted()
							await heldLoad
							if (outcome === 'rejected') throw failure
							return { version: 3, defaultLevel: 'debug', overrides: [] }
						},
						async save() {},
					}),
				},
			),
		}).createRoot()
		const manager = root.require(Logging)
		const initialLevel = manager.policy.snapshot().defaultLevel
		const preparation = prepareCoreContext(root).then(
			() => ({ ok: true as const }),
			(error: unknown) => ({ ok: false as const, error }),
		)
		await pendingLoad
		let closed = false
		const closing = root.effects.dispose()
		void closing.then(
			(): undefined => {
				closed = true
				return undefined
			},
			(): undefined => {
				closed = true
				return undefined
			},
		)
		try {
			await setImmediate()
			expect(manager.state).toBe('disposing')
			expect(manager.describe().root.state).toBe('initializing')
			expect(closed).toBe(false)
			expect(disposals).toBe(0)
			expect(getConfig()).not.toBeNull()
		} finally {
			releaseLoad()
			await Promise.all([preparation, closing])
		}
		const expectedPreparation =
			outcome === 'rejected' ? { ok: false, error: failure } : { ok: true }
		expect(await preparation).toEqual(expectedPreparation)
		expect(manager.policy.snapshot().defaultLevel).toBe(
			outcome === 'resolved' ? 'debug' : initialLevel,
		)
		expect(manager.state).toBe('disposed')
		expect(manager.describe().root.state).toBe('disposed')
		expect(disposals).toBe(1)
		expect(getConfig()).toBeNull()
		await expect(prepareCoreContext(root)).rejects.toThrow('after its root has closed')
	},
)

it('keeps logging through service and Plugin cleanup, and commits policy before closing storage', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'pluxel-core-logging-order-'))
	const events: string[] = []
	let releasePolicy!: () => void
	const policyHeld = new Promise<void>((resolve) => {
		releasePolicy = resolve
	})
	let policyStarted!: () => void
	const pendingPolicy = new Promise<void>((resolve) => {
		policyStarted = resolve
	})
	let finalReached!: () => void
	const pendingFinal = new Promise<void>((resolve) => {
		finalReached = resolve
	})
	const sink = Object.assign(
		(record: LogRecord) => {
			events.push(record.message.join(''))
		},
		{
			async [Symbol.asyncDispose]() {
				events.push('native disposed')
			},
		},
	)
	const storage = zenfs({
		mounts: { '/': { backend: Passthrough, fs: nodeFs, prefix: directory } },
		durableMounts: ['/'],
	})
	try {
		const host = await createHost({
			plugins: [LifecycleLogger],
			runtime: {
				zenfs: storage,
				logtape: logtape(
					{
						sinks: { native: sink },
						loggers: [{ category: ['pluxel'], sinks: ['native'], lowestLevel: 'trace' }],
					},
					{
						policyStore(root) {
							const store = createPluginLogPolicyStore(requireHostDocuments(root, 'logging'))
							return {
								load: store.load,
								async save(profile, snapshot) {
									policyStarted()
									await policyHeld
									await store.save(profile, snapshot)
									events.push('policy saved')
								},
							}
						},
					},
				),
			},
			services: [
				defineHostService({
					name: 'LoggingLifecycleProbe',
					capabilities: [],
					prepare({ ctx, effects }) {
						ctx.logger.info('service prepare')
						effects.defer(() => ctx.logger.info('service runtime'), { phase: 'runtime' })
						effects.defer(() => ctx.logger.info('service final'), { phase: 'final' })
						ctx.effects.defer(
							() => {
								ctx.logger.info('root final')
								finalReached()
							},
							{ phase: 'final' },
						)
					},
				}),
			],
		})
		await host.startNode(LifecycleLogger.nodeAddress())
		host.ctx.logging!.policy.setDefaultLevel('debug')
		const closing = host.close()
		try {
			await Promise.all([pendingPolicy, pendingFinal])
			expect(events).not.toContain('native disposed')
		} finally {
			releasePolicy()
			await closing
		}
		const expected = [
			'service prepare',
			'plugin init',
			'plugin runtime',
			'plugin final',
			'service runtime',
			'service final',
			'root final',
			'policy saved',
		]
		expect(events).toEqual(expect.arrayContaining(expected))
		const disposal = events.indexOf('native disposed')
		for (const event of expected) expect(events.indexOf(event)).toBeLessThan(disposal)
		expect(events.filter((event) => event === 'native disposed')).toHaveLength(1)
		expect(getConfig()).toBeNull()
		const reopened = await createHost({ plugins: [], runtime: { zenfs: storage }, services: [] })
		try {
			const raw = await requireHostDocuments(reopened.ctx, 'logging').getText(
				'plugin-policy/pluxel.json',
			)
			expect(parsePluginLogPolicySnapshot(raw!).defaultLevel).toBe('debug')
		} finally {
			await reopened.close()
		}
	} finally {
		releasePolicy()
		await rm(directory, { recursive: true, force: true })
	}
})

it('leaves an existing native configuration untouched when logging is omitted', async () => {
	const foreign: Config<string, string> = { sinks: {}, loggers: [] }
	await configure(foreign)
	try {
		const host = await createHost({ plugins: [], services: [] })
		try {
			expect(host.ctx.logging).toBeUndefined()
			expect(getConfig()).toBe(foreign)
		} finally {
			await host.close()
		}
		expect(getConfig()).toBe(foreign)
	} finally {
		await reset()
	}
})

it('rolls back native resources when strict policy preparation fails before service preparation', async () => {
	const failure = new Error('policy load failed')
	let disposals = 0
	let servicePreparations = 0
	const sink = Object.assign((_record: LogRecord): void => undefined, {
		async [Symbol.asyncDispose]() {
			disposals++
		},
	})
	await expect(
		createHost({
			plugins: [],
			runtime: {
				logtape: logtape(
					{ sinks: { native: sink }, loggers: [] },
					{
						policyLoadFailure: 'fail',
						policyStore: () => ({
							async load() {
								throw failure
							},
							async save() {},
						}),
					},
				),
			},
			services: [
				defineHostService({
					name: 'NeverPrepared',
					capabilities: [],
					prepare() {
						servicePreparations++
					},
				}),
			],
		}),
	).rejects.toBe(failure)
	expect(disposals).toBe(1)
	expect(servicePreparations).toBe(0)
	expect(getConfig()).toBeNull()
})
