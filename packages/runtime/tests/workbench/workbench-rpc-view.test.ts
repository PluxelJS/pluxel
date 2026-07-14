import { describe, expect, it } from 'vitest'
import { createWorkbenchRpcView } from '../../src/web/rpc'

describe('createWorkbenchRpcView', () => {
	it('caches grant and method wrappers', async () => {
		let disposeCalls = 0
		const raw = () =>
			({
				workbenchRpc: (grant: string) =>
					grant === 'demo-grant'
						? {
								// Return a thenable without `.finally()` to ensure we normalize via Promise.resolve().
								hello: () => ({
									// oxlint-disable-next-line unicorn/no-thenable -- test fixture intentionally simulates a bare thenable
									then: (resolve: (value: string) => void) => resolve('ok'),
								}),
							}
						: undefined,
				dispose: () => {
					disposeCalls++
				},
			}) as any

		const rpc = createWorkbenchRpcView(raw as any) as any

		expect(rpc['demo-grant']).toBe(rpc['demo-grant'])
		expect(rpc['demo-grant'].hello).toBe(rpc['demo-grant'].hello)

		const value = await rpc['demo-grant'].hello()
		expect(value).toBe('ok')
		expect(disposeCalls).toBe(1)
	})

	it('disposes clients for sync returns', () => {
		let disposeCalls = 0
		const raw = () =>
			({
				workbenchRpc: (grant: string) =>
					grant === 'demo-grant'
						? {
								ping: () => 123,
							}
						: undefined,
				dispose: () => {
					disposeCalls++
				},
			}) as any

		const rpc = createWorkbenchRpcView(raw as any) as any
		expect(rpc['demo-grant'].ping()).toBe(123)
		expect(disposeCalls).toBe(1)
	})
})
