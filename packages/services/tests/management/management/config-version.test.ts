import { pluginNodeAddressOf } from '@pluxel/core'
import { BasePlugin, Plugin } from '@pluxel/core/internal/test'
import { createHost, type HostConfigSyncOptions } from '@pluxel/host'
import { RpcStub } from 'capnweb'
import * as v from 'valibot'
import { expect, it } from 'vitest'
import { RuntimeManagementTargetImpl } from '../../../src/management/services/management/RuntimeManagementTarget.ts'
import { createRuntimeManagementClient } from '../../../src/management/web/client.ts'

@Plugin({ forkable: true })
class Configured extends BasePlugin {
	readonly config = this.configs.use(v.object({ value: v.optional(v.string(), 'initial') }))
}

const configSync = {
	role: 'writer',
	scope: 'management-tests',
	artifact: { name: '@fixture/management-version', catalogHash: 'a'.repeat(64) },
	identity: 'writer',
	replicas: [],
} as const satisfies HostConfigSyncOptions

it('returns saved config versions and passes the original expected version through the client and RPC', async () => {
	const host = await createHost({ plugins: [Configured], configSync })
	try {
		await host.start()
		using target = new RpcStub(new RuntimeManagementTargetImpl(host.ctx))
		const client = createRuntimeManagementClient(target)
		const owner = pluginNodeAddressOf(Configured)
		const state = await client.config.status()
		expect(state).toEqual({ version: host.config.status().version, readonly: false })
		const read = await client.config.get(owner)
		expect(read).toMatchObject({ ok: true, version: state.version, readonly: false })
		const saved = await client.config.patch(owner, { value: 'first' }, state.version!)
		expect(saved).toMatchObject({ ok: true, version: { seq: 1 } })
		await expect(
			client.config.patch(owner, { value: 'stale' }, state.version!),
		).resolves.toMatchObject({
			ok: false,
			code: 'version_conflict',
			state: 'unchanged',
			version: { seq: 1 },
		})
		await expect(client.config.patch(owner, { value: 'missing-version' })).resolves.toMatchObject({
			ok: false,
			code: 'version_conflict',
			state: 'unchanged',
		})
		const latest = await client.config.status()
		await expect(
			client.config.patchField(owner, { fieldPath: 'value', value: 'second' }, latest.version!),
		).resolves.toMatchObject({
			ok: true,
			config: { value: 'second' },
			version: { seq: 2 },
		})
	} finally {
		await host.close()
	}
})

it('rejects stale fork removal before stopping the Plugin and accepts the exact refreshed version', async () => {
	const host = await createHost({ plugins: [Configured], configSync })
	try {
		await host.start()
		using target = new RpcStub(new RuntimeManagementTargetImpl(host.ctx))
		const client = createRuntimeManagementClient(target)
		const owner = pluginNodeAddressOf(Configured)
		const created = await client.forks.ensure({ base: owner, forkId: 'retain', autoStart: false })
		if (created.ok === false) throw new Error(created.error)
		await host.startNode(created.fork)
		const old = await client.config.status()
		await client.config.patch(created.fork, { value: 'saved' }, old.version!)
		await expect(
			client.forks.remove({ base: owner, forkId: 'retain', expected: old.version! }),
		).resolves.toMatchObject({
			ok: false,
			code: 'version_conflict',
			state: 'unchanged',
			version: { seq: 1 },
		})
		expect(await client.plugins.status(created.fork)).toMatchObject({
			ok: true,
			value: { lifecycleState: 'running' },
		})
		const current = await client.config.status()
		await expect(
			client.forks.remove({ base: owner, forkId: 'retain', expected: current.version! }),
		).resolves.toMatchObject({
			ok: true,
			status: 'removed',
		})
		expect(await client.plugins.status(created.fork)).toMatchObject({ ok: true, value: null })
	} finally {
		await host.close()
	}
})
