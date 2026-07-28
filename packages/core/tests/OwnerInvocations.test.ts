import { BasePlugin, Plugin, withCoreHost } from '@pluxel/core/test'
import { closeOwnerInvocations, enterOwnerInvocation } from '../src/internal'
import { describe, expect, it } from 'vitest'

describe('owner invocations', () => {
	it('closes admission, aborts active leases, and waits for their release', async () => {
		await withCoreHost(async (host) => {
			const owner = host.ctx.extend({ name: 'owner' })
			const lease = enterOwnerInvocation(owner)
			const reason = new Error('owner stopped')
			const closing = closeOwnerInvocations(owner, reason)

			expect(lease.signal.aborted).toBe(true)
			expect(lease.signal.reason).toBe(reason)
			await expect(
				Promise.race([closing.then(() => 'closed'), Promise.resolve('pending')]),
			).resolves.toBe('pending')
			expect(() => enterOwnerInvocation(owner)).toThrow(reason)

			lease.dispose()
			lease.dispose()
			await closing
		})
	})

	it('combines call cancellation without closing the owner gate', async () => {
		await withCoreHost(async (host) => {
			const owner = host.ctx.extend({ name: 'owner' })
			const call = new AbortController()
			const lease = enterOwnerInvocation(owner, call.signal)
			call.abort(new Error('request cancelled'))

			expect(lease.signal.aborted).toBe(true)
			lease.dispose()
			const next = enterOwnerInvocation(owner)
			expect(next.signal.aborted).toBe(false)
			next.dispose()
		})
	})

	it('closes and drains owner invocations before the plugin stop hook', async () => {
		await withCoreHost(async (host) => {
			const order: string[] = []
			let lease: ReturnType<typeof enterOwnerInvocation> | undefined

			@Plugin({ name: 'InvokedPlugin' })
			class InvokedPlugin extends BasePlugin {
				override init(): void {
					lease = enterOwnerInvocation(this.ctx)
					lease.signal.addEventListener(
						'abort',
						() => {
							order.push('abort')
							lease?.dispose()
						},
						{ once: true },
					)
				}

				override stop(): void {
					order.push('stop')
				}
			}

			host.add(InvokedPlugin)
			await host.commit()
			host.remove(InvokedPlugin)
			await host.commit()
			expect(order).toEqual(['abort', 'stop'])
		})
	})
})
