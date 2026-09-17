import { BasePlugin, Plugin, pluginNodeAddressOf } from '@pluxel/core'
import { getContextLoggerRootId } from '@pluxel/core/host'
import { createHost } from '@pluxel/host'
import { expect, it } from 'vitest'
import { logging, type PluginLogPolicyStore, type RuntimeLoggingInput } from '../src/index'

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
