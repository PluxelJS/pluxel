import { BasePlugin, Plugin, pluginNodeAddressOf } from '@pluxel/core'
import { defineContextCapability, installRootCapability } from '@pluxel/core/host'
import { expect, it } from 'vitest'
import { createHost, defineHostService } from '../src/index'

@Plugin({ forkable: true })
class ForkOwner extends BasePlugin {}

it('retains a stopped fork after service metadata cleanup fails and retries before removing its policy', async () => {
	let fail = true
	let attempts = 0
	const Metadata = defineContextCapability<object>('test.metadata')
	const host = await createHost({
		plugins: [ForkOwner],
		services: [
			defineHostService({
				name: 'Metadata',
				capabilities: [installRootCapability(Metadata, { create: () => ({}) })],
				removeNodeMetadata() {
					attempts++
					if (fail) throw new Error('storage unavailable')
				},
			}),
		],
	})
	try {
		const base = pluginNodeAddressOf(ForkOwner)
		const ensured = await host.forks.ensure(base, 'tenant')
		expect(ensured.ok).toBe(true)
		await expect(host.forks.remove(base, 'tenant')).resolves.toMatchObject({
			ok: false,
			code: 'persistence_failed',
			state: 'stopped-retained',
		})
		const status1 = await host.status()
		expect(status1.statuses.some((item) => item.address.variant === 'fork')).toBe(true)
		fail = false
		await expect(host.forks.remove(base, 'tenant')).resolves.toMatchObject({
			ok: true,
			status: 'removed',
		})
		const status2 = await host.status()
		expect(status2.statuses.some((item) => item.address.variant === 'fork')).toBe(false)
		expect(attempts).toBe(2)
	} finally {
		await host.close()
	}
})
