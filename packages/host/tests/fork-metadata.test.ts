import { BasePlugin, Plugin } from '@pluxel/core'
import { defineContextCapability, installRootCapability } from '@pluxel/core/host'
import { expect, it } from 'vitest'
import { createHost, defineHostService } from '../src/index'

@Plugin({ forkable: true })
class ForkOwner extends BasePlugin {}

it('rejects non-fork and malformed addresses without creating nodes or deleting metadata', async () => {
	let metadataRemovals = 0
	const host = await createHost({
		plugins: [ForkOwner],
		services: [
			defineHostService({
				name: 'Metadata',
				capabilities: [],
				removeNodeMetadata() {
					metadataRemovals++
				},
			}),
		],
	})
	try {
		for (const input of [
			null,
			ForkOwner.nodeAddress(),
			{ ...ForkOwner.nodeAddress('tenant'), forkId: '' },
			{ base: ForkOwner.nodeAddress(), forkId: 'tenant' },
		]) {
			for (const action of [host.forks.ensure, host.forks.remove]) {
				await expect(action(input as never)).resolves.toMatchObject({
					ok: false,
					code: 'invalid_fork_address',
					state: 'unchanged',
				})
			}
		}
		expect(metadataRemovals).toBe(0)
		const status = await host.status()
		expect(status.statuses.every((item) => item.address.variant === 'default')).toBe(true)
	} finally {
		await host.close()
	}
})

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
		const fork = ForkOwner.nodeAddress('tenant')
		const ensured = await host.forks.ensure(fork)
		expect(ensured.ok).toBe(true)
		await expect(host.forks.remove(fork)).resolves.toMatchObject({
			ok: false,
			code: 'persistence_failed',
			state: 'stopped-retained',
		})
		const status1 = await host.status()
		expect(status1.statuses.some((item) => item.address.variant === 'fork')).toBe(true)
		fail = false
		await expect(host.forks.remove(fork)).resolves.toMatchObject({
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

it('rejects declared fork policy writes before stopping or deleting metadata', async () => {
	let metadataRemovals = 0
	const host = await createHost({
		plugins: [ForkOwner],
		policy: { forks: [ForkOwner.nodeAddress('tenant')] },
		services: [
			defineHostService({
				name: 'Metadata',
				capabilities: [],
				removeNodeMetadata() {
					metadataRemovals++
				},
			}),
		],
		runtime: { documents: { state: false } },
	})
	try {
		await expect(host.forks.ensure(ForkOwner.nodeAddress('tenant'))).resolves.toMatchObject({
			ok: true,
			report: { persistence: { status: 'unchanged' } },
		})
		await expect(host.forks.remove(ForkOwner.nodeAddress('tenant'))).resolves.toMatchObject({
			ok: false,
			code: 'policy_shadowed',
			state: 'unchanged',
		})
		expect(metadataRemovals).toBe(0)
		const status = await host.status()
		expect(status.statuses.some((item) => item.address.variant === 'fork')).toBe(true)
	} finally {
		await host.close()
	}
})
