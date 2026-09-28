import { BasePlugin, Plugin, pluginNodeAddressOf } from '@pluxel/core'
import { getContextLoggerRootId } from '@pluxel/core/host'
import { createHost } from '@pluxel/host'
import { expect, it } from 'vitest'
import {
	logging,
	markLogs,
	readLogs,
	waitForLogs,
	type PluginLogPolicyStore,
	type RuntimeLoggingInput,
} from '../../src/logging/index'

@Plugin({ forkable: true })
class LoggedOwner extends BasePlugin {
	init() {
		this.ctx.logger.info('owner started')
	}
}
const plan: RuntimeLoggingInput = {
	root: { profile: 'host' },
	sinks: { memory: { kind: 'store', caller: false, bufferSize: 1, flushIntervalMs: 0 } },
	routes: {
		runtime: [{ sink: 'memory', minLevel: 'trace' }],
		plugins: [{ sink: 'memory', minLevel: 'trace' }],
		debug: [],
		meta: [],
	},
}
it('bounds log cursors to their Host and stream, and releases waits on delivery, reset and abort', async () => {
	const host = await createHost({ plugins: [], services: [logging(plan)] })
	try {
		const manager = host.ctx.logging
		const empty = markLogs(manager)
		expect(readLogs(manager, empty)).toMatchObject({ ok: true, lines: [] })
		expect(() => markLogs(manager, 'not-configured')).toThrow('Log store is not installed')
		host.ctx.logger.info('before mark')
		const cursor = markLogs(manager)
		const store = manager.stores.get('default')!
		const controller = new AbortController()
		const pending = waitForLogs(manager, cursor, { signal: controller.signal })
		expect(store.subscriberCount).toBe(1)
		host.ctx.logger.info('after mark')
		const delivered = await pending
		expect(delivered.ok && delivered.lines.map((line) => line.msg)).toEqual(['after mark'])
		expect(store.subscriberCount).toBe(0)
		expect(readLogs(manager, { ...cursor, rootId: 'another-host' })).toMatchObject({
			code: 'root_mismatch',
		})
		expect(readLogs(manager, { ...cursor, bootId: 'another-stream' })).toMatchObject({
			code: 'stream_replaced',
		})
		expect(readLogs(manager, { ...cursor, streamId: 'missing' })).toMatchObject({
			code: 'store_unavailable',
		})
		const reset = waitForLogs(manager, markLogs(manager), { signal: controller.signal })
		store.reset()
		await expect(reset).resolves.toMatchObject({ code: 'epoch_mismatch' })
		expect(store.subscriberCount).toBe(0)
		const aborted = waitForLogs(manager, markLogs(manager), { signal: controller.signal })
		const reason = new Error('operation cancelled')
		controller.abort(reason)
		await expect(aborted).rejects.toBe(reason)
		expect(store.subscriberCount).toBe(0)
		await expect(waitForLogs(manager, cursor, { signal: controller.signal })).rejects.toBe(reason)
	} finally {
		await host.close()
	}
})

it('binds the Core identity and retries durable fork policy cleanup through the installed service', async () => {
	let failWrite = false
	const writes: Parameters<PluginLogPolicyStore['save']>[1][] = []
	const store: PluginLogPolicyStore = {
		async load() {
			return undefined
		},
		async save(_profile, snapshot) {
			if (failWrite) throw new Error('policy unavailable')
			writes.push(snapshot)
		},
	}
	const host = await createHost({
		plugins: [LoggedOwner],
		config: { logger: { rootId: 'fixed-host-root' } },
		services: [logging(plan, { policyStore: store })],
	})
	const manager = host.ctx.logging
	try {
		expect(manager.resolved.root.id).toBe(getContextLoggerRootId(host.ctx))
		expect(manager.resolved.root.id).toBe('fixed-host-root')
		await expect(createHost({ plugins: [], services: [logging(plan)] })).rejects.toThrow(
			'Another RuntimeLogging instance',
		)
		const base = pluginNodeAddressOf(LoggedOwner)
		const ensured = await host.forks.ensure(base, 'policy', { autoStart: true })
		expect(ensured.ok).toBe(true)
		if (!ensured.ok) throw new Error('fork creation failed')
		const fork = { ...base, variant: 'fork' as const, forkId: 'policy' }
		await host.startNode(fork)
		expect(
			manager.stores
				.getOrCreate('default')
				.tailWindow(10)
				.some((line) => line.msg.includes('owner started')),
		).toBe(true)
		manager.policy.setPluginLevel(fork, 'debug')
		await manager.policy.flush()
		failWrite = true
		await expect(host.forks.remove(base, 'policy')).resolves.toMatchObject({ ok: false })
		expect(manager.policy.persistence).toBe('failed')
		failWrite = false
		await expect(host.forks.remove(base, 'policy')).resolves.toMatchObject({ ok: true })
		expect(writes.at(-1)?.overrides).toEqual([])
	} finally {
		failWrite = false
		await host.close()
	}
	expect(manager.state).toBe('disposed')
})
