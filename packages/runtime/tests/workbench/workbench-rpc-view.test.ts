import { describe, expect, it } from 'vitest'
import { createWorkbenchRpcClient } from '../../src/web/rpc'

describe('createWorkbenchRpcClient', () => {
	it('caches method wrappers', async () => {
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

		const rpc = createWorkbenchRpcClient(raw as any, 'demo-grant') as any

		expect(rpc.hello).toBe(rpc.hello)
		expect(rpc.then).toBeUndefined()
		await expect(Promise.resolve(rpc)).resolves.toBe(rpc)

		const value = await rpc.hello()
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

		const rpc = createWorkbenchRpcClient(raw as any, 'demo-grant') as any
		expect(rpc.ping()).toBe(123)
		expect(disposeCalls).toBe(1)
	})

	it('disposes a session when dynamic namespace lookup throws', () => {
		let disposeCalls = 0
		const raw = () =>
			({
				workbenchRpc: () => {
					throw new Error('namespace failed')
				},
				dispose: () => {
					disposeCalls++
				},
			}) as any
		const rpc = createWorkbenchRpcClient(raw as any, 'demo-grant') as any

		expect(() => rpc.ping()).toThrow('namespace failed')
		expect(disposeCalls).toBe(1)
	})
})
