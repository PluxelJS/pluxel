import { BasePlugin, Plugin, PluginPart } from '@pluxel/core'
import {
	notifyRunningPluginConfigUpdate,
	requireConfigService,
	requirePluginService,
} from '@pluxel/core/internal'
import * as v from 'valibot'
import { expect, it } from 'vitest'
import { createHost } from '../../src/index'

const target = v.object({ target: v.optional(v.string(), 'initial') })
const changes: string[] = []
let validations = 0

class DeliverySettings extends PluginPart<Pipeline> {
	readonly config = this.configs.use(target)

	init() {
		this.configs.onUpdate(this.config, ({ applied, desired }) => {
			changes.push(`delivery ${applied.target} -> ${desired.target}`)
		})
	}
}

const route = v.object({
	route: v.optional(
		v.pipe(
			v.string(),
			v.trim(),
			v.transform((value) => {
				validations++
				return value
			}),
		),
		'initial',
	),
})

@Plugin()
class Pipeline extends BasePlugin {
	readonly delivery = this.parts.use(DeliverySettings)
	readonly config = this.configs.use(route)

	init() {
		this.configs.onUpdate(this.config, ({ applied, desired }) => {
			changes.push(`pipeline ${applied.route} -> ${desired.route}`)
			if (desired.route === 'offline') throw new Error('routing is unavailable')
		})
	}
}

it('notifies the part before the owner and retries from the last confirmed configuration', async () => {
	await using host = await createHost({ plugins: [{ plugin: Pipeline, autoStart: true }] })
	await host.start()
	const node = Pipeline.nodeAddress()
	const before = await host.config.get(node)
	if (before.ok === false) throw new Error(before.message)
	changes.length = 0
	validations = 0
	const failed = await host.config.patch(node, {
		set: { route: 'offline', delivery: { target: 'edge' } },
	})
	expect(failed).toMatchObject({
		application: 'saved-not-applied',
		appliedRevision: before.appliedRevision,
		applyFailure: { code: 'listener_failed' },
	})
	expect(validations).toBe(1)
	const instance = requirePluginService(host.ctx).getInstance(node) as Pipeline
	expect(instance.config.route).toBe('initial')
	expect(instance.delivery.config.target).toBe('initial')
	const accepted = await host.config.patch(node, { set: { route: 'online' } })
	expect(accepted).toMatchObject({ ok: true, application: 'applied' })
	expect(changes).toEqual([
		'delivery initial -> edge',
		'pipeline initial -> offline',
		'delivery initial -> edge',
		'pipeline initial -> online',
	])
	expect([instance.config.route, instance.delivery.config.target]).toEqual(['online', 'edge'])
	changes.length = 0
	expect(await host.config.patch(node, { set: { route: ' online ' } })).toMatchObject({
		ok: true,
		application: 'applied',
		managedInput: { route: ' online ' },
	})
	expect(changes).toEqual([])
})

class StaticEndpoint extends PluginPart<StaticPipeline> {
	readonly config = this.configs.use(target)
}

let ownerNotifications = 0

@Plugin()
class StaticPipeline extends BasePlugin {
	readonly endpoint = this.parts.use(StaticEndpoint)
	readonly config = this.configs.use(target)

	init() {
		this.configs.onUpdate(this.config, () => {
			ownerNotifications++
		})
	}
}

it('checks all changed declarations for listeners before notifying any of them', async () => {
	await using host = await createHost({ plugins: [{ plugin: StaticPipeline, autoStart: true }] })
	await host.start()
	const node = StaticPipeline.nodeAddress()
	const output = await host.config.patch(node, {
		set: { target: 'root', endpoint: { target: 'child' } },
	})
	expect(output).toMatchObject({
		ok: true,
		application: 'saved-not-applied',
		applyFailure: { code: 'listener_not_registered' },
	})
	expect(ownerNotifications).toBe(0)
})

const offered = Promise.withResolvers<Readonly<v.InferOutput<typeof target>>>()
const inspected = Promise.withResolvers<void>()

@Plugin()
class Sender extends BasePlugin {
	readonly config = this.configs.use(target)

	async init() {
		offered.resolve(this.config)
		await inspected.promise
		this.configs.onUpdate(this.config, () => {})
	}
}

@Plugin()
class Receiver extends BasePlugin {
	readonly config = this.configs.use(target)

	async init() {
		try {
			const foreign = await offered.promise
			expect(() => this.configs.onUpdate(foreign, () => {})).toThrow(/another Plugin\/Part owner/i)
			expect(() => this.configs.onUpdate({ ...this.config }, () => {})).toThrow(
				/injected config field/i,
			)
			this.registerListener()
			expect(() => this.registerListener()).toThrow(/already registered/i)
		} finally {
			inspected.resolve()
		}
	}

	registerListener() {
		this.configs.onUpdate(this.config, () => {})
	}
}

it('binds listener registration to the exact config field and its own init window', async () => {
	await using host = await createHost({
		plugins: [
			{ plugin: Sender, autoStart: true },
			{ plugin: Receiver, autoStart: true },
		],
		policy: { execution: { startConcurrency: 2 } },
	})
	const started = await host.start()
	expect(started).toMatchObject({ core: { summary: { lifecycleReport: { issues: [] } } } })
	const receiver = requirePluginService(host.ctx).getInstance(Receiver.nodeAddress()) as Receiver
	expect(() => receiver.registerListener()).toThrow(/only available during the owner init/i)
})

const admitted = Promise.withResolvers<AbortSignal>()

@Plugin()
class Stream extends BasePlugin {
	readonly config = this.configs.use(target)

	init() {
		this.configs.onUpdate(this.config, async ({ signal }) => {
			await new Promise<void>((resolve) => {
				signal.addEventListener('abort', () => resolve(), { once: true })
				admitted.resolve(signal)
			})
		})
	}
}

it('discards an update acknowledgement when its listener’s generation has been withdrawn', async () => {
	await using host = await createHost({ plugins: [{ plugin: Stream, autoStart: true }] })
	await host.start()
	const node = Stream.nodeAddress()
	const registry = requirePluginService(host.ctx)
	const config = requireConfigService(host.ctx)
	const old = registry.getInstance(node)
	// Adjacent Host config edits are serialized. Exercise the notification already admitted by Core.
	const notifying = notifyRunningPluginConfigUpdate(
		registry,
		node,
		{ target: 'discard' },
		config.getConfigRevision(node),
	)
	const signal = await admitted.promise
	const restarting = host.restartNode(node)
	await expect(notifying).resolves.toEqual({ status: 'generation_changed' })
	await restarting
	expect(signal.aborted).toBe(true)
	const current = registry.getInstance(node) as Stream
	expect(current).not.toBe(old)
	expect(current.config.target).toBe('initial')
	expect(config.getAppliedConfigRevision(node)).toBe(config.getConfigRevision(node))
})
